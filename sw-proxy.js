// Service Worker unique du projet, quatre rôles :
//  1. Proxy HTTP : intercepte /app/* et relaie vers la VM via un MessagePort
//     fourni par la page hôte (qui elle-même pilote la VM v86).
//  1 bis. Magasin de cookies : un Service Worker ne PEUT PAS faire poser de
//     cookie (Set-Cookie est un en-tête interdit sur une Response construite),
//     donc le proxy tient lui-même le bocal — sans quoi la session Rails, et
//     avec elle le jeton CSRF, n'existe tout simplement pas.
//  2. Spoofing COI : ré-injecte les en-têtes COOP/COEP sur les réponses
//     same-origin pour les hébergeurs statiques qui ne les posent pas
//     (équivalent intégré de coi-serviceworker).
//  3. Cache des artefacts immuables (morceaux de disque, noyau, initrd) en
//     Cache Storage, « cache d'abord » — GitHub Pages plafonnant à
//     max-age=600, sans lui un visiteur qui revient retélécharge tout.
//
// Résilience : le navigateur tue et redémarre les SW à volonté, ce qui perd
// l'état en mémoire. Quand le port manque, le SW le redemande à la page hôte
// (message "bridge-port-request") au lieu d'échouer en 503 ; quand l'identité
// des artefacts manque, il la redemande de même ("artifact-config-request")
// en servant les requêtes du réseau entre-temps.
//
// La logique pure (réécriture des Location, en-têtes d'isolation, pages
// d'erreur) vit dans shared/proxy-logic.js ; celle du cache d'artefacts dans
// shared/artifact-cache.js. Les deux sont testées unitairement.
import { sanitizeCookieHeader, sanitizeMethod } from "./shared/request-codec.js";
import {
  appPrefix,
  appRequestRefusal,
  errorPage,
  MESSAGE_CANAL_DEMANDE,
  MESSAGE_CANAL_OK,
  MESSAGE_CANAL_PERDU,
  MESSAGE_CANAL_REFUSE,
  MESSAGE_ETABLIR_CANAL,
  estCommandePrivilegiee,
  purgerDemandesCanal,
  isShellClient,
  verifierReponseCanal,
  parseRootStaticIndex,
  prepareProxyHeaders,
  responseBodyFor,
  rootStaticCandidate,
  ROOT_STATIC_ROOT,
  ROOT_STATIC_INDEX,
  DEFAULT_ROOT_STATIC_FILES,
  staticAssetPath,
} from "./shared/proxy-logic.js";
import {
  cacheNameFor,
  estArtefactCacheable,
  immutableArtifacts,
  isCacheableArtifactUrl,
  isCacheableRequestShape,
  looksLikeImmutableArtifact,
  obsoleteCacheNames,
  staleFormatCacheNames,
} from "./shared/artifact-cache.js";
import {
  createCookieJar,
  extractSetCookie,
  mergeBrowserCookies,
  parseDocumentCookie,
} from "./shared/cookie-jar.js";
import { RESTAUREE, creerRetentionSession, estRefusDeSession } from "./shared/session-privee.js";

// lib.webworker type `self` en WorkerGlobalScope générique : ce fichier est
// un Service Worker, on le déclare une fois pour bénéficier des types
// d'événements (FetchEvent, ExtendableMessageEvent) et de sw.clients.
const sw = /** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (
  /** @type {unknown} */ (self)
);

// Un disque lu par requêtes Range produit des 206 que Cache Storage refuse, et
// un instantané d'un seul tenant est un flux de plusieurs centaines de Mo :
// tous deux restent laissés au navigateur. Seuls les artefacts IMMUABLES lus
// d'un bloc — fichiers-parties de disque ET d'instantané, noyau, initrd —
// passent par le cache ci-dessous, morceau par morceau (4 Mio). L'instantané
// décompressé reste par ailleurs mis en cache par la page dans IndexedDB : le
// visiteur qui revient ne relit donc même pas ces morceaux-là.
// Racine de publication de la coquille, déduite de la portée du Service
// Worker : « / » quand le site est servi à la racine, « /depot/ » sur un Pages
// de projet — le cas de chaque démonstration depuis l'ADR 0004. Tout chemin
// écrit en dur casserait dans le second cas.
const BASE_PATH = new URL(sw.registration.scope).pathname;
const APP_PREFIX = appPrefix(BASE_PATH);
const RAW_ASSET_PREFIX = `${BASE_PATH.replace(/\/+$/, "")}/disks/`;
const REQUEST_TIMEOUT_MS = 120_000;
const PORT_RECOVERY_TIMEOUT_MS = 10_000;
// PLAFOND quand la coquille est VIVANTE mais muette. v86 émule sur le fil
// principal de la page hôte : un rendu lourd le monopolise, et la coquille ne
// peut alors pas répondre — sans être fermée pour autant. Mesuré sur la
// démonstration de woofed-crm, sur un poste 1,5× plus lent que la référence :
// quatre requêtes concurrentes suffisaient à faire tomber les cinq frames
// paresseuses du pipeline en 502 (issue #12).
// Exprimé en TENTATIVES et non en horloge, pour ne pas dépendre d'une mesure de
// temps que rien ne garantit monotone dans un worker que le navigateur réveille.
//
// Ce n'est donc PAS une garantie de durée : chaque tentative attend au moins
// PORT_RECOVERY_TIMEOUT_MS, plus le temps d'interroger les clients, plus ce que
// le fil principal saturé fait attendre. Six tentatives valent « au moins une
// minute », jamais « exactement une minute ».
const PORT_BUSY_RETRIES = 6;
// Fraction du quota de stockage au-delà de laquelle on cesse d'écrire dans le
// cache : le navigateur évincerait l'origine entière (dont l'instantané en
// IndexedDB, bien plus coûteux à reconstituer qu'un morceau de 4 Mio).
const QUOTA_HEADROOM = 0.9;
// L'estimation de stockage coûte un aller-retour : elle est mémoïsée le temps
// d'écrire quelques morceaux, jamais plus.
const STORAGE_ESTIMATE_TTL_MS = 5_000;
// Intervalle minimal entre deux demandes de configuration à la page hôte.
const CONFIG_REQUEST_INTERVAL_MS = 2_000;
// Délai au-delà duquel on cesse d'ATTENDRE la réponse de la coquille sur les
// cookies qu'elle voit : la requête part alors avec le dernier rapport connu.
// Généreux à dessein — le tout premier aller-retour a été mesuré à 1,3 s sur
// Firefox, le temps que le worker démarre. La demande, elle, n'est jamais
// annulée : une réponse tardive rafraîchit l'instantané, dont la requête
// suivante profite. C'est ce qui rend l'à-coup indolore au lieu de le
// propager.
const DOCUMENT_COOKIE_TIMEOUT_MS = 2_000;
// Au-delà de ce nombre d'attentes déçues d'affilée, on demande SANS attendre :
// une coquille durablement muette (page figée, main.js d'une version
// antérieure encore en cache) ne doit pas taxer chaque requête du délai
// ci-dessus. La première réponse qui arrive remet le compteur à zéro.
const DOCUMENT_COOKIE_MAX_ATTENTES = 3;
// Une demande restée sans réponse est oubliée au bout de ce délai : sans quoi
// une coquille muette ferait enfler la table des demandes en vol.
const DOCUMENT_COOKIE_ABANDON_MS = 30_000;
// Marqueur d'attente déçue, distinct de toute valeur de `document.cookie`.
const RETARD = Symbol("retard");
// Magasin de cookies du visiteur (voir shared/cookie-jar.js) : le navigateur
// ne peut pas le tenir pour nous, un Service Worker ne pouvant pas faire poser
// de cookie. Persisté en IndexedDB sous une clé dérivée de la portée — le SW
// est tué dès qu'il est inactif, et perdre le magasin en cours de parcours
// reviendrait à perdre la session Rails du visiteur (donc son jeton CSRF).
// La page hôte, elle, ne peut PAS nous le rendre comme elle rend le port du
// pont : elle n'a jamais vu ces cookies. Attention à ne pas surestimer ce que
// cela protège — cette base vit dans l'origine, donc un XSS de l'application
// (iframe same-origin) peut l'ouvrir. Ce que le dispositif garantit, c'est que
// `document.cookie` reste vide ; le reste tient au filtre du document coquille
// sur les messages et au refus des requêtes inter-origine (SECURITY.md).
const COOKIE_DB_NAME = "railsbox-cookies";
const COOKIE_STORE = "jars";
const COOKIE_KEY = new URL(sw.registration.scope).pathname;

/**
 * État vivant du worker. Il est ANNOTÉ plutôt que déduit : sans cela, chaque
 * champ initialisé à `null` prenait le type `null`, et `tsc --strict` refusait
 * ensuite toute affectation réelle — le contrôle ne portait plus sur rien.
 * @typedef {object} EtatWorker
 * @property {MessagePort | null} bridgePort
 * @property {MessagePort | null} canalCoquille
 * @property {string | null} canalClientId
 * @property {Map<string, { clientId: string | null, at: number }>} demandesCanal
 * @property {Array<{ resolve: (port: MessagePort) => void }>} portWaiters
 * @property {Promise<MessagePort> | null} bridgeRecovery
 * @property {number} bridgeRecoveryGeneration
 * @property {Map<number, { resolve: Function, reject: Function, timer: any }>} pending
 * @property {number} nextId
 * @property {{ name: string, cache: Cache, artifacts: any } | null} artifacts
 * @property {number} lastConfigRequest
 * @property {{ at: number, estimate: StorageEstimate | null } | null} storageEstimate
 * @property {Promise<Set<string>> | null} rootStatic
 * @property {Set<string>} warned
 * @property {Promise<void> | null} cookiesRestored
 * @property {Promise<IDBDatabase> | null} cookieDb
 * @property {string} documentCookie
 * @property {Map<number, (valeur: string) => void>} cookieAsks
 * @property {number} nextCookieAsk
 * @property {number} cookieAskFailures
 */

/** @type {EtatWorker} */
const state = {
  bridgePort: null,
  // Canal de commande PRIVÉ (shared/proxy-logic.js) : le port sur lequel la
  // coquille — et elle seule, parce qu'elle seule le détient — commande le
  // proxy. `canalClientId` retient QUEL client l'a posé : tant que ce client
  // vit, aucun autre canal n'est adopté.
  canalCoquille: null,
  canalClientId: null,
  // Demandes de retablissement en vol : nonce -> { clientId, at }. Un canal
  // n'est adopte qu'en REPONSE a l'une d'elles, et le nonce est consomme.
  demandesCanal: new Map(),
  portWaiters: [],
  // UNE SEULE récupération de pont à la fois, partagée par toutes les requêtes
  // en attente. Sans cela, cinq turbo-frames armaient cinq boucles et
  // sollicitaient la coquille cinq fois par échéance — une rafale de messages
  // au fil principal précisément quand il est saturé.
  bridgeRecovery: null,
  // Jeton d'annulation : une échéance déjà ENGAGÉE dans son `await` ne peut pas
  // être arrêtée par `clearTimeout`. Elle compare sa génération à celle-ci en
  // reprenant, et se retire si elle a été supplantée.
  bridgeRecoveryGeneration: 0,
  pending: new Map(), // id -> { resolve, reject, timer }
  nextId: 1,
  // Cache d'artefacts en service : { name, cache, artifacts }, null tant que
  // la page hôte n'a pas déclaré la configuration qu'elle boote.
  artifacts: null,
  lastConfigRequest: 0,
  storageEstimate: null, // { at, estimate }
  // Inventaire des fichiers racine extraits de l'image, lu une fois par vie du
  // worker : Promise<Set<string>>, null tant qu'aucune requête n'en a besoin.
  rootStatic: null,
  warned: new Set(), // motifs déjà journalisés, pour ne pas inonder la console
  // Restauration du bocal depuis IndexedDB : tentée une seule fois par vie du
  // Service Worker, avant la première requête relayée.
  cookiesRestored: null,
  cookieDb: null, // connexion IndexedDB du bocal, ouverte à la demande
  // Dernier `document.cookie` rapporté par la coquille, et demandes en vol
  // (identifiant -> résolution). L'instantané est ce qui sert quand la réponse
  // tarde : sans lui, un seul à-coup de la page privait de leurs cookies
  // TOUTES les requêtes qui suivaient.
  documentCookie: "",
  cookieAsks: new Map(),
  nextCookieAsk: 1,
  cookieAskFailures: 0,
};

const cookieJar = createCookieJar();

// Rétention des requêtes d'artefacts sur session expirée (shared/session-privee.js).
// Le worker peut être tué pendant une rétention : la promesse meurt avec lui,
// v86 voit un échec réseau et réessaie — le chemin se rattrape de lui-même,
// et c'est pourquoi rien de tout ceci n'est persisté.
const retentionSession = creerRetentionSession();

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (event) =>
  event.waitUntil(Promise.all([sw.clients.claim(), dropStaleFormatCaches()])),
);

// LE CANAL PUBLIC NE PORTE PLUS AUCUNE COMMANDE.
//
// Il a d'abord porté les commandes elles-mêmes, filtrées sur l'URL du client
// émetteur (`isShellClient`). Ce filtre est nécessaire — il écarte l'iframe
// applicative et tout document voisin — mais il ne peut pas être suffisant :
// un XSS de l'application ajoute un `<script src="/app/…">` au DOM du parent,
// ce script s'exécute DANS la coquille, et son message porte donc l'URL de la
// coquille. Rien dans l'émetteur ne le distingue.
//
// Ce qui le distingue, c'est ce qu'il ne détient pas : le port privé, créé par
// la coquille et gardé dans la fermeture de son module.
//
// Il reste ici DEUX messages, et aucun n'accorde de droit :
//  - `coquille-canal-demande` fait ouvrir un tour de rétablissement ;
//  - `coquille-canal` RÉPOND à un tour, avec le nonce qu'il portait.
// `isShellClient` filtre les deux : deux gardes valent mieux qu'une.
sw.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (estCommandePrivilegiee(type)) {
    warnOnce(
      "canal-public",
      `commande « ${type} » refusée sur le canal public : le proxy ne se ` +
        "commande que sur le canal privé de la coquille",
    );
    return;
  }
  if (type !== MESSAGE_ETABLIR_CANAL && type !== MESSAGE_CANAL_DEMANDE) return;
  if (!isShellClient(sourceUrl(event), { origin: sw.location.origin, basePath: BASE_PATH })) {
    warnOnce("client-refuse", "canal refusé : seul le document coquille commande le proxy");
    return;
  }
  if (type === MESSAGE_CANAL_DEMANDE) {
    event.waitUntil(reclamerCanal());
    return;
  }
  event.waitUntil(adopterCanalCoquille(event));
});

/**
 * Adopte le canal privé — SEULEMENT en réponse à un tour de rétablissement.
 *
 * La proposition spontanée est morte, et c'est le fond de la correction : un
 * worker redémarré (le navigateur le tue dès qu'il est inactif) adoptait le
 * premier canal venu. Un script injecté n'avait qu'à réveiller le worker et
 * parler avant la coquille.
 *
 * Désormais il faut un nonce, émis par le worker vers un client donné, à usage
 * unique et périssable. L'intrus voit le même nonce que la coquille — il vit
 * dans le même client — mais il répond APRÈS elle : la coquille a inscrit son
 * écouteur à l'évaluation de son module, avant que le moindre code étranger
 * n'existe, et les écouteurs sont appelés dans leur ordre d'inscription. Quand
 * l'intrus répond, le nonce est déjà consommé.
 * @param {ExtendableMessageEvent} event
 */
async function adopterCanalCoquille(event) {
  const port = event.ports[0];
  if (!port) return;
  const emetteur = /** @type {any} */ (event.source);
  const clientId = typeof emetteur?.id === "string" ? emetteur.id : null;
  const verdict = verifierReponseCanal(state.demandesCanal, {
    nonce: event.data?.nonce,
    clientId,
    maintenant: Date.now(),
  });
  if (!verdict.accepte) {
    warnOnce("canal-refuse", `canal refusé : ${verdict.raison}`);
    emetteur?.postMessage?.({ type: MESSAGE_CANAL_REFUSE, raison: verdict.raison });
    return;
  }
  // CONSOMMÉ, et tous les autres nonces du même tour avec lui : le tour est
  // clos, plus rien de ce qu'il a émis ne vaut.
  state.demandesCanal.clear();

  state.canalCoquille = port;
  state.canalClientId = clientId;
  port.onmessage = (message) => traiterCommande(message);
  port.start?.();
  // ACCUSÉ DE RÉCEPTION. Sans lui, la coquille ne savait pas si son canal avait
  // pris : elle ne pouvait ni relâcher ce qu'elle avait mis de côté, ni
  // redemander. C'est ce qui manquait au passage de relais entre onglets.
  port.postMessage({ type: MESSAGE_CANAL_OK });
  // Une coquille qui vient de (r)établir le canal est prête à répondre : on lui
  // redemande ce que le redémarrage a fait perdre, plutôt que d'attendre que la
  // première requête échoue.
  demanderALaCoquille({ type: "artifact-config-request" });
  if (!state.bridgePort) demanderALaCoquille({ type: "bridge-port-request" });
}

/**
 * Abandonne le canal courant. Appelé quand son porteur a disparu, ou quand il
 * s'est révélé incapable de servir — un onglet qui ne pilote plus la VM tient
 * sinon le proxy en otage.
 */
function abandonnerCanal() {
  if (!state.canalCoquille) return;
  state.canalCoquille.onmessage = null;
  state.canalCoquille = null;
  state.canalClientId = null;
}

/**
 * Une commande arrivée sur le canal privé. Aucun contrôle d'émetteur ici : le
 * port EST le contrôle — le posséder, c'est être la coquille.
 * @param {MessageEvent} event
 */
function traiterCommande(event) {
  const data = event.data;
  if (!estCommandePrivilegiee(data?.type)) return undefined;
  if (data.type === "artifact-config") {
    // La promesse est RENDUE plutôt qu'oubliée : un `MessagePort` n'offre pas
    // de `waitUntil`, et le banc de test n'aurait sinon aucun moyen de savoir
    // quand la configuration a pris.
    return adoptArtifactConfig(data.config);
  }
  if (data.type === "cookies-document") {
    deliverDocumentCookies(data);
    return undefined;
  }
  if (data.type === "session-restauree") {
    const liberees = retentionSession.restaurer();
    if (liberees > 0) console.info(`[sw] session rétablie — ${liberees} lecture(s) rejouée(s)`);
    return undefined;
  }
  if (event.ports[0]) adoptBridgePort(event.ports[0]);
  return undefined;
}

/**
 * Parle à la coquille par le canal privé.
 *
 * Quand il n'y en a pas — worker redémarré — on ne se rabat PAS sur un envoi
 * public de la commande : on ouvre un tour de rétablissement, et c'est la
 * coquille qui reprendra la conversation. Un repli public rouvrirait
 * exactement la porte que ce canal ferme.
 * @param {Record<string, unknown>} message
 * @returns {boolean} vrai si le message est parti par le canal privé
 */
function demanderALaCoquille(message) {
  if (state.canalCoquille) {
    state.canalCoquille.postMessage(message);
    return true;
  }
  reclamerCanal();
  return false;
}

/**
 * Ouvre un tour de rétablissement : un nonce par client coquille, chacun le
 * sien, tous périssables.
 *
 * Le tour n'a lieu QUE si le worker n'a pas de canal utilisable. Tant que le
 * porteur courant vit, aucun nonce n'est émis — c'est ce qui empêche un script
 * injecté d'obtenir un tour à volonté pour tenter sa chance.
 *
 * La disparition du porteur est VÉRIFIÉE ici, pas supposée : un onglet fermé ou
 * rechargé laisse le worker avec un port mort, sur lequel il parlerait dans le
 * vide. C'est ce qui bloquait le passage de relais entre onglets.
 */
async function reclamerCanal() {
  if (state.canalCoquille) {
    const porteur = state.canalClientId
      ? await sw.clients.get(state.canalClientId).catch(() => undefined)
      : undefined;
    if (porteur) return;
    abandonnerCanal();
  }
  const maintenant = Date.now();
  purgerDemandesCanal(state.demandesCanal, maintenant);
  const clientList = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientList) {
    if (!isShellClient(client.url, { origin: sw.location.origin, basePath: BASE_PATH })) continue;
    const nonce = nonceCanal();
    state.demandesCanal.set(nonce, { clientId: client.id ?? null, at: maintenant });
    client.postMessage({ type: MESSAGE_CANAL_PERDU, nonce });
  }
}

/**
 * Nonce de rétablissement. `randomUUID` là où il existe, tirage explicite
 * sinon : ce qui compte est qu'il soit imprévisible, jamais qu'il soit joli.
 * @returns {string}
 */
function nonceCanal() {
  const cryptographie = /** @type {any} */ (globalThis).crypto;
  if (typeof cryptographie?.randomUUID === "function") return cryptographie.randomUUID();
  const octets = cryptographie.getRandomValues(new Uint8Array(16));
  return [...octets].map((octet) => octet.toString(16).padStart(2, "0")).join("");
}

/**
 * URL du client émetteur d'un message. `event.source` peut aussi être un
 * MessagePort ou un autre worker, qui n'en ont pas : sans URL, pas de coquille.
 * @param {ExtendableMessageEvent} event
 * @returns {string | null}
 */
function sourceUrl(event) {
  const source = /** @type {any} */ (event.source);
  return typeof source?.url === "string" ? source.url : null;
}

/** @param {MessagePort} port */
function adoptBridgePort(port) {
  state.bridgePort = port;
  port.onmessage = (event) => resolvePending(event.data);
  // LE PONT EST LÀ : toute récupération en cours est PÉRIMÉE, y compris une
  // échéance déjà engagée dans son `await`. Incrémenter la génération est ce
  // qui l'arrête — elle le constatera en reprenant, et se retirera sans armer
  // de minuterie. Résoudre les attentes ne suffirait pas : la résolution ne
  // peut rien contre du code déjà parti.
  // ORDRE IMPORTANT : résoudre D'ABORD — `clore()` compare les générations, et
  // les invalider avant ferait passer les attentes pour périmées, donc jamais
  // résolues. La génération n'est incrémentée qu'ensuite.
  const waiters = state.portWaiters.splice(0);
  for (const waiter of waiters) waiter.resolve(port);
  state.bridgeRecoveryGeneration += 1;
  state.bridgeRecovery = null;
}

/**
 * Une coquille est-elle encore là pour porter le pont ?
 *
 * C'est la question que le délai posait implicitement, et mal : il concluait de
 * « n'a pas répondu en dix secondes » à « a disparu ». Or v86 émule sur le fil
 * principal de la page hôte, et un rendu lourd l'y monopolise bien plus
 * longtemps. On interroge donc les clients, qui répondent par leur EXISTENCE et
 * non par leur disponibilité — c'est précisément le signal qui manquait.
 * @returns {Promise<boolean>}
 */
async function coquilleVivante() {
  try {
    const clientList = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    return clientList.some((client) =>
      isShellClient(client.url, { origin: sw.location.origin, basePath: BASE_PATH }),
    );
  } catch {
    // Une énumération qui échoue ne doit pas faire conclure à la disparition :
    // on retombe sur le comportement d'avant, qui est le plus prudent.
    return false;
  }
}

function ensureBridgePort() {
  if (state.bridgePort) return Promise.resolve(state.bridgePort);
  // UNE SEULE BOUCLE POUR TOUTES LES REQUÊTES. Cinq turbo-frames paresseuses
  // arrivent ensemble : leur donner une boucle chacune faisait cinq minuteries
  // et cinq sollicitations par échéance, adressées à une coquille déjà saturée.
  if (state.bridgeRecovery) return state.bridgeRecovery;

  const generation = ++state.bridgeRecoveryGeneration;
  let tentatives = 0;
  /** @type {any} */
  let timer = null;

  state.bridgeRecovery = new Promise((resolve, reject) => {
    /**
     * Clôt la récupération courante. Rend faux si elle a été supplantée — une
     * échéance périmée ne doit toucher à rien.
     * @returns {boolean}
     */
    const clore = () => {
      if (state.bridgeRecoveryGeneration !== generation) return false;
      clearTimeout(timer);
      timer = null;
      state.bridgeRecovery = null;
      state.portWaiters = state.portWaiters.filter((w) => w !== attente);
      return true;
    };

    const attente = {
      /** @param {MessagePort} port */
      resolve: (port) => {
        if (!clore()) return;
        resolve(port);
      },
    };

    const echeance = async () => {
      // UNE PAGE OCCUPÉE N'EST PAS UNE PAGE FERMÉE. Tant qu'une coquille
      // existe, on la resollicite : elle finira par rendre la main. Sans cela,
      // les frames paresseuses d'une application partant par cinq tombaient
      // toutes ensemble en 502, sur une machine lente.
      const vivante = await coquilleVivante();
      // REVÉRIFIER APRÈS L'AWAIT, et c'est le point le plus délicat de cette
      // fonction : `clearTimeout` ne peut rien contre une échéance DÉJÀ
      // ENGAGÉE. Si le pont est arrivé pendant l'appel ci-dessus, reprendre
      // ici armerait une minuterie que plus personne ne tient — laquelle
      // finirait par appeler `abandonnerCanal()` sur un pont parfaitement sain.
      if (state.bridgePort || state.bridgeRecoveryGeneration !== generation) return;
      if (vivante && tentatives < PORT_BUSY_RETRIES) {
        tentatives += 1;
        requestPortFromClients();
        timer = setTimeout(echeance, PORT_RECOVERY_TIMEOUT_MS);
        return;
      }
      if (!clore()) return;
      // LE CANAL EST ABANDONNÉ AVEC LA REQUÊTE. Le porteur a été sollicité et
      // n'a pas répondu : soit il a disparu sans que le worker l'ait vu, soit
      // il ne pilote plus la VM. Le garder reviendrait à laisser un onglet
      // muet tenir le proxy en otage — la lecture suivante ouvrira un tour de
      // rétablissement, et l'onglet qui pilote pourra reprendre la main.
      //
      // Cette garde est INCHANGÉE : elle ne s'applique plus qu'aux cas où
      // plus aucune coquille n'existe, ou au-delà du plafond.
      abandonnerCanal();
      reject(
        new Error(
          vivante
            ? "La page hôte est restée occupée trop longtemps (émulation en cours) : requête abandonnée."
            : "La page hôte n'a pas fourni le pont VM (est-elle ouverte ?)",
        ),
      );
    };

    timer = setTimeout(echeance, PORT_RECOVERY_TIMEOUT_MS);
    state.portWaiters.push(attente);
  });
  requestPortFromClients();
  return state.bridgeRecovery;
}

function requestPortFromClients() {
  demanderALaCoquille({ type: "bridge-port-request" });
}

/** @param {any} data */
function resolvePending(data) {
  if (data?.type !== "http-response") return;
  const entry = state.pending.get(data.id);
  if (!entry) return; // requête expirée entre-temps
  state.pending.delete(data.id);
  clearTimeout(entry.timer);
  if (data.error) {
    entry.reject(new Error(data.error));
  } else {
    entry.resolve(data);
  }
}

// --- Cache des artefacts immuables (Cache Storage, « cache d'abord ») ------
//
// AUCUN EN-TÊTE N'EST AJOUTÉ NULLE PART sur ce chemin : les requêtes vers le
// dépôt d'artefacts doivent rester des requêtes « simples » au sens CORS,
// sous peine de déclencher un préflight que GitHub Pages ne sait pas honorer
// (point de vigilance de l'ADR 0001). La requête d'origine est réémise telle
// quelle, la réponse renvoyée telle quelle.

/**
 * Réponse au cas où le SW vient de redémarrer : la page hôte détient
 * l'identité des artefacts qu'elle boote, on la lui redemande. Les requêtes
 * en vol partent au réseau pendant ce temps — dégradation, jamais échec.
 *
 * Étranglée dans le temps : v86 demande ses morceaux par rafales, et une page
 * qui n'a rien à déclarer (aucune configuration lue) recevrait sinon un
 * message par morceau.
 */
function requestArtifactConfigFromClients() {
  const now = Date.now();
  if (now - state.lastConfigRequest < CONFIG_REQUEST_INTERVAL_MS) return;
  state.lastConfigRequest = now;
  demanderALaCoquille({ type: "artifact-config-request" });
}

/**
 * Prend en charge la configuration déclarée par la page hôte : ouvre le cache
 * qui porte l'identité de cette construction et abandonne tous les autres.
 * @param {Record<string, any> | null | undefined} config
 */
async function adoptArtifactConfig(config) {
  try {
    const name = cacheNameFor(config);
    if (name === null) {
      state.artifacts = null;
      return;
    }
    if (state.artifacts?.name === name) return;
    const cache = await caches.open(name);
    state.artifacts = { name, cache, artifacts: immutableArtifacts(config, sw.registration.scope) };
    const names = await caches.keys();
    await Promise.all(obsoleteCacheNames(names, name).map((stale) => caches.delete(stale)));
  } catch (error) {
    // Cache Storage indisponible (mode privé, stockage refusé) : on continue
    // sans cache, tout le reste du Service Worker fonctionne à l'identique.
    state.artifacts = null;
    warnOnce("ouverture", `cache d'artefacts indisponible (${messageErreur(error)}) — réseau seul`);
  }
}

/** Supprime les caches écrits par une version antérieure du format. */
async function dropStaleFormatCaches() {
  try {
    const names = await caches.keys();
    await Promise.all(staleFormatCacheNames(names).map((stale) => caches.delete(stale)));
  } catch (error) {
    warnOnce("purge", `purge des caches obsolètes impossible (${messageErreur(error)})`);
  }
}

/**
 * Décision SYNCHRONE, seule possible dans un gestionnaire fetch : cette
 * requête mérite-t-elle qu'on lui réponde nous-mêmes ? Le verdict définitif
 * (l'URL est-elle un artefact DE CETTE construction ?) est rendu plus tard,
 * dans serveArtifact, où il peut consulter la configuration.
 * @param {Request} request
 * @param {URL} url
 * @returns {boolean}
 */
function isArtifactCandidate(request, url) {
  return (
    isCacheableRequestShape({
      method: request.method,
      rangeHeader: request.headers.get("range"),
    }) && looksLikeImmutableArtifact(url.href)
  );
}

/**
 * Stratégie « cache d'abord » : le morceau déjà téléchargé est resservi sans
 * réseau ; sinon la requête part telle quelle et la réponse est rangée en
 * arrière-plan. Toute défaillance du cache est silencieuse pour l'appelant
 * (mais journalisée) : la requête aboutit dans tous les cas.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function serveArtifact(event) {
  const request = event.request;
  const bucket = artifactBucketFor(request.url);
  if (bucket) {
    // ignoreVary : GitHub Pages peut varier sur Accept-Encoding, ce qui ferait
    // manquer une entrée pourtant valide — le contenu, lui, est immuable.
    const hit = await bucket.cache.match(request.url, { ignoreVary: true }).catch(() => null);
    if (hit) return hit;
  }
  const premiere = await fetch(request);
  // « Suspendre, pas échouer » : rendre un 401 à v86 gèlerait la lecture pour
  // toujours et en silence (libv86.js:10-11 ne réessaie que sur 5xx et ne
  // rappelle `done()` que sur 200/206). On retient donc la promesse — une
  // réponse jamais rendue n'est pas une erreur, c'est une lecture lente — le
  // temps que la coquille suspende la VM et rétablisse la session.
  const response = estRefusDeSession(premiere.status, premiere.headers)
    ? await rejouerApresSession(request, premiere)
    : premiere;
  // Le verdict d'écriture (200 lisible, obtenu sans redirection suivie) est
  // rendu par shared/artifact-cache.js : ici, rien que le câblage.
  if (bucket && estArtefactCacheable(response)) {
    event.waitUntil(storeArtifact(bucket.cache, request.url, response.clone()));
  }
  return response;
}

/**
 * Retient une lecture d'artefact refusée pour session expirée, puis la rejoue.
 *
 * Le refus lui-même n'est JAMAIS rendu tant qu'il reste un espoir : v86 n'en
 * ferait rien. Il n'est rendu qu'au bout du plafond de rétention, quand la
 * coquille a déjà affiché son écran terminal — à ce stade, geler ou échouer
 * revient au même, et le visiteur, lui, sait pourquoi.
 *
 * Le refus n'est pas mis en cache : le test de mise en cache ci-dessus ne
 * retient que les 200, et le bord pose de surcroît `Cache-Control: no-store`.
 * @param {Request} request
 * @param {Response} refus réponse 401 du bord, corps non lu
 * @returns {Promise<Response>}
 */
async function rejouerApresSession(request, refus) {
  const { notifier, attendre } = retentionSession.retenir();
  // Étranglement : v86 demande ses morceaux par rafales, et une notification
  // par morceau vaudrait une pause de VM et un panneau par morceau.
  if (notifier) {
    warnOnce(
      "session",
      "session expirée pendant une lecture de disque — lecture RETENUE, " +
        "la coquille est prévenue (la VM ne perd rien)",
    );
    notifierCoquilles({ type: "session-expiree" });
  }
  const issue = await attendre;
  if (issue !== RESTAUREE) return refus;
  await discardBody(refus);
  return fetch(request);
}

/**
 * Prévient les documents coquille, et EUX SEULS : l'iframe applicative est un
 * client same-origin comme un autre, et rien ne justifie de lui apprendre
 * l'état de la session du visiteur.
 * @param {Record<string, unknown>} message
 */
function notifierCoquilles(message) {
  demanderALaCoquille(message);
}

/**
 * Cache en service si l'URL est bien un artefact de la construction courante,
 * null sinon. Quand l'identité manque (SW redémarré), elle est redemandée à
 * la page hôte et la requête part au réseau sans être mise en cache.
 * @param {string} url
 * @returns {{ name: string, cache: Cache, artifacts: any } | null}
 */
function artifactBucketFor(url) {
  if (!state.artifacts) {
    requestArtifactConfigFromClients();
    return null;
  }
  return isCacheableArtifactUrl(url, state.artifacts.artifacts) ? state.artifacts : null;
}

/**
 * Range un morceau, ou renonce proprement.
 *
 * Le clone qu'on reçoit partage sa source avec la réponse déjà rendue au
 * demandeur : un corps cloné qu'on abandonnerait sans le lire ferait gonfler
 * indéfiniment le tampon de dérivation. Tout chemin qui n'écrit pas ANNULE
 * donc explicitement le corps.
 * @param {Cache} cache
 * @param {string} url
 * @param {Response} response clone, dont le corps n'a pas encore été lu
 */
async function storeArtifact(cache, url, response) {
  try {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (!(await hasStorageRoom(Number.isFinite(declared) ? declared : 0))) {
      warnOnce("quota", "quota de stockage presque atteint — artefacts non mis en cache");
      await discardBody(response);
      return;
    }
    await cache.put(url, response);
  } catch (error) {
    // Quota dépassé, stockage évincé, écriture concurrente : sans effet sur
    // la réponse déjà rendue au demandeur, le morceau sera simplement
    // retéléchargé la prochaine fois.
    warnOnce(
      "ecriture",
      `mise en cache impossible (${messageErreur(error)}) — retéléchargement plus tard`,
    );
    await discardBody(response);
  }
}

/**
 * Libère le corps d'un clone qu'on ne rangera pas.
 * @param {Response} response
 */
async function discardBody(response) {
  try {
    if (response.body && !response.bodyUsed) await response.body.cancel();
  } catch {
    // Corps déjà consommé ou verrouillé : plus rien à libérer.
  }
}

/**
 * Reste-t-il de la place pour `bytes` octets sans frôler le quota d'origine ?
 * Optimiste quand l'estimation n'est pas disponible : mieux vaut un `put` qui
 * échoue proprement qu'un cache jamais alimenté.
 * @param {number} bytes
 * @returns {Promise<boolean>}
 */
async function hasStorageRoom(bytes) {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return true;
  const now = Date.now();
  if (!state.storageEstimate || now - state.storageEstimate.at > STORAGE_ESTIMATE_TTL_MS) {
    const estimate = await navigator.storage.estimate().catch(() => null);
    state.storageEstimate = { at: now, estimate };
  }
  const estimate = state.storageEstimate.estimate;
  if (!estimate?.quota) return true;
  return (estimate.usage ?? 0) + bytes <= estimate.quota * QUOTA_HEADROOM;
}

/**
 * Journalise une fois par motif : un cache saturé produirait sinon une ligne
 * par morceau, ce qui noierait la console au moment où elle sert le plus.
 * @param {string} reason
 * @param {string} message
 */
/**
 * Message lisible d'une valeur attrapée. `catch` reçoit n'importe quoi — une
 * `Error`, mais aussi ce qu'une API du navigateur ou un `fetch` injecté peut
 * lancer. Lire `.message` sans vérifier était une hypothèse, et elle plantait
 * dans la branche qui gère déjà une panne.
 * @param {unknown} error
 * @returns {string}
 */
function messageErreur(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} reason
 * @param {string} message
 */
function warnOnce(reason, message) {
  if (state.warned.has(reason)) return;
  state.warned.add(reason);
  console.warn(`[sw] ${message}`);
}

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Zone des artefacts, décidée par la FORME de la requête et non par son
  // origine : le rootfs mutualisé peut vivre cross-origin (mainteneur tiers,
  // ADR 0004) mais aussi sur un autre chemin du MÊME hôte — le cas de la
  // démonstration de référence, dont le dépôt d'artefacts est un autre Pages
  // de github.io. Un prédicat d'origine y laissait le cache vide, défaut
  // invisible en local. Le verdict définitif reste rendu dans serveArtifact.
  if (isArtifactCandidate(event.request, url)) {
    event.respondWith(serveArtifact(event));
    return;
  }
  // Le reste du cross-origin et du dossier /disks/ (config, instantané,
  // assets extraits hors serveStaticFirst) est laissé au navigateur : ni le
  // proxy /app/* ni la ré-injection COOP/COEP n'ont rien à y faire.
  if (url.origin !== sw.location.origin || url.pathname.startsWith(RAW_ASSET_PREFIX)) {
    return;
  }
  const staticUrl = staticAssetPath(url.pathname, BASE_PATH);
  if (event.request.method === "GET" && staticUrl !== null) {
    event.respondWith(serveStaticFirst(event.request, url, staticUrl));
    return;
  }
  // /favicon.ico, /site.webmanifest, /404.html… : écrits en dur par Rails sans
  // préfixe, ils échappaient au proxy et finissaient en 404 silencieux. La
  // liste des noms servis vient de l'image elle-même (voir rootStaticIndex) :
  // une allowlist en dur ne pouvait pas connaître ceux d'une application
  // tierce. La résolution est donc asynchrone, le temps de lire l'inventaire.
  if (event.request.method === "GET" && rootStaticCandidate(url.pathname, BASE_PATH) !== null) {
    event.respondWith(serveRootStatic(event.request, url));
    return;
  }
  if (url.pathname === APP_PREFIX || url.pathname.startsWith(`${APP_PREFIX}/`)) {
    event.respondWith(proxyToVm(event.request, url));
    return;
  }
  if (event.request.method === "GET") {
    event.respondWith(withIsolationHeaders(event.request));
  }
});

/**
 * Inventaire des fichiers racine réellement extraits de l'image
 * (`/disks/appstatic/index.json`, écrit par tools/extract-assets.sh).
 *
 * Lu UNE fois puis mémoïsé — le Service Worker est tué dès qu'il est inactif,
 * la promesse ne survit donc pas plus longtemps que lui. Absent (sandbox
 * construite avant l'inventaire, ou serveur de développement), on retombe sur
 * la liste de repli : le comportement d'avant, ni plus ni moins.
 * @returns {Promise<Set<string>>}
 */
function rootStaticIndex() {
  if (state.rootStatic === null) {
    const url = `${BASE_PATH.replace(/\/+$/, "")}${ROOT_STATIC_ROOT}${ROOT_STATIC_INDEX}`;
    state.rootStatic = fetch(url)
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (data) => new Set(data === null ? DEFAULT_ROOT_STATIC_FILES : parseRootStaticIndex(data)),
      )
      .catch(() => new Set(DEFAULT_ROOT_STATIC_FILES));
  }
  return state.rootStatic;
}

/**
 * Sert un fichier racine écrit en dur par l'application (/favicon.ico,
 * /404.html, /site.webmanifest…) depuis l'extraction statique de l'image.
 *
 * Rien n'est routé vers un ailleurs : la cible reste une URL same-origin sous
 * /disks/appstatic/, dont le nom a déjà passé le contrôle de forme. Un nom
 * inconnu de l'inventaire retombe exactement là où il tombait avant — la VM
 * sous /app/*, le réseau sinon.
 * @param {Request} request
 * @param {URL} url
 */
async function serveRootStatic(request, url) {
  const bare = rootStaticCandidate(url.pathname, BASE_PATH);
  const known = bare !== null && (await rootStaticIndex()).has(bare);
  if (!known) {
    if (url.pathname === APP_PREFIX || url.pathname.startsWith(`${APP_PREFIX}/`)) {
      return proxyToVm(request, url);
    }
    return withIsolationHeaders(request);
  }
  const staticUrl = `${BASE_PATH.replace(/\/+$/, "")}${ROOT_STATIC_ROOT}${bare}`;
  return serveStaticFirst(request, url, staticUrl);
}

/**
 * Sert un fichier depuis les extractions statiques de l'image
 * (tools/extract-assets.sh) au lieu du pont série. Repli transparent si le
 * fichier n'a pas été extrait (image plus récente, extraction non faite) :
 * vers la VM pour les chemins /app/*, vers le réseau sinon — le comportement
 * d'origine reste garanti.
 * @param {Request} request
 * @param {URL} url
 * @param {string} staticUrl
 */
async function serveStaticFirst(request, url, staticUrl) {
  try {
    const response = await fetch(staticUrl);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(response.body, { status: 200, headers });
    }
  } catch {
    // serveur statique indisponible : le repli ci-dessous décide
  }
  if (url.pathname === APP_PREFIX || url.pathname.startsWith(`${APP_PREFIX}/`)) {
    return proxyToVm(request, url);
  }
  return withIsolationHeaders(request);
}

/** @param {Request} request */
async function withIsolationHeaders(request) {
  const response = await fetch(request);
  if (response.status === 0 || response.type === "opaque") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * @param {Request} request
 * @param {URL} url
 */
async function proxyToVm(request, url) {
  // Frontière de la sandbox, AVANT tout le reste : une navigation initiée par
  // un site tiers arrive bel et bien ici (voir appRequestRefusal), et le bocal
  // y attacherait la session de l'application. Le worker est le seul étage qui
  // connaisse l'origine publique — donc le seul qui puisse trancher.
  //
  // On lui passe la FORME de la requête et pas seulement ses en-têtes : sur
  // Firefox et WebKit, une navigation interceptée n'en porte aucun qui parle
  // d'origine (mesuré), alors que `mode`, `destination` et `referrer` sont
  // renseignés sur les trois moteurs.
  const refus = appRequestRefusal(
    {
      method: request.method,
      mode: request.mode,
      destination: request.destination,
      origin: request.headers.get("origin"),
      referrer: request.referrer,
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    sw.location.origin,
  );
  if (refus !== null) return errorResponse(403, refus);
  try {
    const bridgePort = await ensureBridgePort();
    await ensureCookiesRestored();
    const method = sanitizeMethod(request.method);
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await request.arrayBuffer() : null;
    // Le préfixe /app est conservé de bout en bout : l'application est montée
    // sous /app par Rack::URLMap dans la VM (voir tools/build-v86-image). Elle
    // reçoit donc SCRIPT_NAME=/app et génère des liens déjà préfixés, qui
    // repassent naturellement par ce proxy.
    //
    // La racine de publication est transmise TELLE QUELLE, délibérément. On
    // avait d'abord essayé de la retirer, pour que le guest ignore tout du
    // sous-répertoire de déploiement : Rack répondait bien, mais Rails générait
    // alors ses liens et ses URL d'assets en « /app/… », donc à la racine du
    // domaine — hors du dépôt, et hors de la portée de ce Service Worker, qui
    // ne pouvait même pas les rattraper. L'application doit être montée sur le
    // chemin PUBLIC complet (RAILS_RELATIVE_URL_ROOT, posé à la construction) :
    // c'est la seule façon qu'elle produise des URL qui fonctionnent.
    const descriptor = {
      id: state.nextId++,
      method,
      path: url.pathname + url.search,
      // X-Forwarded-Proto https : les apps en `force_ssl` (jiyufit) verraient
      // sinon une requête http et boucleraient en redirection. Chrome accepte
      // les cookies Secure sur localhost, donc les sessions fonctionnent.
      headers: [...request.headers.entries(), ["x-forwarded-proto", "https"]],
      hasBody: hasBody && body !== null,
      forwardHost: url.host,
      // Le bocal du proxy est la source autoritaire (shared/cookie-jar.js) —
      // mais pas la seule : l'iframe étant same-origin, un `document.cookie =`
      // de l'application crée un VRAI cookie du navigateur (fuseau horaire,
      // locale, consentement, js-cookie…). Il faut donc l'y ajouter, sans quoi
      // ces cookies-là n'atteindraient plus jamais le serveur.
      cookie: await cookieHeaderFor(url.pathname),
    };
    const reply = await sendToBridge(bridgePort, descriptor, body);
    const headers = await harvestCookies(reply.headers, url.pathname);
    return buildResponse(reply, headers);
  } catch (error) {
    return errorResponse(502, `Pont HTTP en erreur: ${messageErreur(error)}`);
  }
}

/**
 * En-tête `Cookie:` complet d'une requête : le bocal du proxy, puis les vrais
 * cookies du navigateur que le bocal ne connaît pas.
 *
 * POURQUOI CE SECOND ÉTAGE. L'iframe est same-origin ; `document.cookie = …`
 * y crée un cookie du navigateur, que le worker ne voit PAS sur la requête
 * (`Cookie` est un en-tête interdit sur une Request de FetchEvent) et dont
 * aucun `Set-Cookie` ne l'a informé. Sans relecture explicite, un motif
 * courant des applications Rails non modifiées — fuseau horaire posé en JS,
 * locale, bandeau de consentement, js-cookie — cessait d'atteindre le serveur.
 * La relecture passe par le document coquille (voir documentCookies), seul
 * chemin qui existe sur les TROIS moteurs.
 *
 * Journalisé quand l'en-tête dépasse ce que la frontière accepte : sans cela,
 * le visiteur perdait TOUTE sa session en silence — soit le 422 que ce
 * dispositif existe pour supprimer.
 * @param {string} requestPath
 * @returns {Promise<string | null>}
 */
async function cookieHeaderFor(requestPath) {
  const header = mergeBrowserCookies(
    cookieJar.headerFor(requestPath),
    await documentCookies(),
    requestPath,
  );
  if (header !== null && sanitizeCookieHeader(header) === null) {
    warnOnce(
      "cookies-abandon",
      "en-tête Cookie refusé à la frontière (trop long ou illisible) — " +
        "la requête part SANS cookie, l'application peut répondre 422",
    );
  }
  return header;
}

/**
 * Cookies que le NAVIGATEUR tient et dont le bocal n'a jamais entendu parler,
 * relus par le seul client habilité à parler au worker : le document coquille.
 *
 * POURQUOI PAS LE COOKIE STORE API. C'était l'implémentation précédente, et
 * elle ne fonctionnait que sur un moteur : `cookieStore` est absent de WebKit
 * (mesuré, tests/e2e/cookies-proxy.e2e.spec.mjs) et n'est arrivé que
 * tardivement dans Firefox. La fusion n'avait donc pas lieu chez deux visiteurs
 * sur trois, et aucun test ne pouvait le voir — celui qui existait s'ignorait
 * là où le manque était. Un Service Worker n'a pas de DOM, mais ses clients en
 * ont un : on demande, ils répondent. Le motif est celui déjà en service pour
 * `bridge-port` et `artifact-config`, à ceci près que le sens de la demande est
 * inversé (c'est le worker qui interroge).
 *
 * CE QUE ÇA NE DONNE À PERSONNE. La demande part sur le CANAL PRIVÉ et la
 * réponse n'est reçue que là : ni l'iframe applicative, ni un script injecté
 * dans la coquille ne peuvent dicter au proxy des cookies que le navigateur ne
 * leur montre pas — ils ne détiennent pas le port. Aucun secret ne
 * circule dans ce sens : la demande est vide, la réponse ne peut porter que ce
 * que le navigateur expose déjà à la page (jamais un `HttpOnly`), le bocal
 * reste autoritaire à la fusion, et `mergeBrowserCookies` rejoue sur ce qui
 * revient les validations d'`ingest` (`isTransmissibleCookie`).
 *
 * Sans canal établi — worker fraîchement redémarré — on ne se rabat pas sur un
 * envoi public : on réclame le canal, et la requête suivante en profitera.
 * @returns {Promise<Array<{ name: string, value: string, path: string }>>}
 */
async function documentCookies() {
  await refreshDocumentCookies();
  return parseDocumentCookie(state.documentCookie);
}

/**
 * Rafraîchit l'instantané des cookies du document. Attend la réponse, mais
 * jamais au-delà du délai : passé celui-ci, la requête part avec le dernier
 * rapport connu plutôt que sans rien. La demande reste en vol, et la réponse
 * qui finit par arriver sert la requête suivante.
 * @returns {Promise<void>}
 */
async function refreshDocumentCookies() {
  if (!state.canalCoquille) {
    reclamerCanal();
    return;
  }
  const id = state.nextCookieAsk++;
  const reponse = new Promise((resolve) => {
    state.cookieAsks.set(id, resolve);
    setTimeout(() => state.cookieAsks.delete(id), DOCUMENT_COOKIE_ABANDON_MS);
  });
  // Une seule coquille commande le proxy : c'est elle, et elle seule, qu'on
  // interroge. La demande part par le canal privé — un document injecté dans la
  // coquille ne peut ni la voir ni y répondre.
  demanderALaCoquille({ type: "cookies-document-request", id });
  if (state.cookieAskFailures >= DOCUMENT_COOKIE_MAX_ATTENTES) return;
  const arrivee = await Promise.race([reponse, retarder(DOCUMENT_COOKIE_TIMEOUT_MS)]);
  if (arrivee !== RETARD) return;
  state.cookieAskFailures += 1;
  warnOnce(
    "cookies-document",
    "la page hôte tarde à rapporter ses cookies — ceux que l'application pose " +
      "en JavaScript peuvent manquer d'une requête",
  );
}

/**
 * @param {number} delai
 * @returns {Promise<symbol>}
 */
function retarder(delai) {
  return new Promise((resolve) => setTimeout(() => resolve(RETARD), delai));
}

/**
 * Rapport d'une coquille sur ses cookies. L'instantané est mis à jour même
 * quand la demande correspondante a expiré : c'est ce qui fait que le
 * dispositif se remet tout seul d'un à-coup de la page.
 * @param {{ id?: unknown, cookie?: unknown }} data
 */
function deliverDocumentCookies(data) {
  if (typeof data.cookie !== "string") return;
  state.documentCookie = data.cookie;
  if (typeof data.id !== "number") return;
  const resoudre = state.cookieAsks.get(data.id);
  if (!resoudre) return;
  state.cookieAsks.delete(data.id);
  state.cookieAskFailures = 0;
  resoudre(data.cookie);
}

/**
 * Retire les `Set-Cookie` de la réponse de la VM, les range dans le bocal et
 * persiste celui-ci s'il a changé. Les rendre au document ne servirait à rien
 * — le constructeur `Response` filtre `Set-Cookie` — et les garder ici est ce
 * qui laisse `document.cookie` vide. Pas davantage : voir shared/cookie-jar.js
 * pour ce que cela protège et ce que cela ne protège pas.
 * @param {Array<[string, string]> | undefined} rawHeaders
 * @param {string} requestPath chemin de la requête, sans chaîne de recherche
 * @returns {Promise<Array<[string, string]>>} en-têtes à rendre au document
 */
async function harvestCookies(rawHeaders, requestPath) {
  const { setCookies, headers } = extractSetCookie(rawHeaders);
  if (cookieJar.ingest(setCookies, requestPath)) {
    // Écriture attendue, pas différée : une réponse rendue dont le cookie
    // n'aurait pas été persisté laisserait le visiteur sans session si le
    // navigateur tuait le worker dans la foulée. Le coût (quelques centaines
    // d'octets) est sans commune mesure avec l'aller-retour série qui précède.
    await persistCookies();
  }
  return headers;
}

/**
 * @param {MessagePort} bridgePort
 * @param {any} descriptor
 * @param {ArrayBuffer | null} body
 */
function sendToBridge(bridgePort, descriptor, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(descriptor.id);
      reject(new Error("Délai dépassé en attendant la VM"));
    }, REQUEST_TIMEOUT_MS);
    state.pending.set(descriptor.id, { resolve, reject, timer });
    const transfer = body ? [body] : [];
    bridgePort.postMessage({ type: "http-request", descriptor, body }, transfer);
  });
}

/**
 * @param {{ status: number, statusText?: string, body?: ArrayBuffer | null }} reply
 * @param {Array<[string, string]>} headers en-têtes déjà débarrassés des cookies
 */
function buildResponse(reply, headers) {
  return new Response(responseBodyFor(reply.status, reply.body), {
    status: reply.status,
    statusText: reply.statusText ?? "",
    headers: prepareProxyHeaders(headers, sw.location, BASE_PATH),
  });
}

// --- Persistance du bocal à cookies (IndexedDB, un enregistrement) ---------

/**
 * Connexion IndexedDB, ouverte une seule fois et réutilisée : le bocal est
 * écrit à chaque réponse porteuse d'un cookie, et rouvrir la base à chaque
 * fois accumulerait les connexions pour rien. La promesse est oubliée en cas
 * d'échec, pour que la tentative suivante reparte proprement.
 * @returns {Promise<IDBDatabase>}
 */
function openCookieDb() {
  state.cookieDb ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(COOKIE_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(COOKIE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    state.cookieDb = null;
    throw error;
  });
  return state.cookieDb;
}

/**
 * Restaure le bocal une seule fois par vie du Service Worker. Toute défaillance
 * du stockage (mode privé, quota, stockage refusé) est sans appel : on repart
 * d'un bocal vide, ce qui est exactement l'état d'un premier visiteur.
 * @returns {Promise<void>}
 */
function ensureCookiesRestored() {
  state.cookiesRestored ??= restoreCookies();
  return state.cookiesRestored;
}

async function restoreCookies() {
  try {
    const db = await openCookieDb();
    const saved = await new Promise((resolve, reject) => {
      const request = db.transaction(COOKIE_STORE).objectStore(COOKIE_STORE).get(COOKIE_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    if (Array.isArray(saved)) cookieJar.load(saved);
  } catch (error) {
    warnOnce(
      "cookies-lecture",
      `bocal à cookies non restauré (${messageErreur(error)}) — session neuve`,
    );
  }
}

/** @returns {Promise<void>} */
async function persistCookies() {
  try {
    const db = await openCookieDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(COOKIE_STORE, "readwrite");
      transaction.objectStore(COOKIE_STORE).put(cookieJar.snapshot(), COOKIE_KEY);
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (error) {
    // Le bocal en mémoire reste valide : seule sa survie au redémarrage du
    // worker est perdue. La requête en cours, elle, aboutit normalement.
    warnOnce("cookies-ecriture", `bocal à cookies non persisté (${messageErreur(error)})`);
  }
}

/**
 * @param {number} status
 * @param {string} message
 */
function errorResponse(status, message) {
  return new Response(errorPage(status, message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
