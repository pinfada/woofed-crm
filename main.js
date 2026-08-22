// Orchestrateur de la page hôte : Service Worker proxy, isolation
// cross-origin, boot de la VM v86, puis câblage du pont HTTP.

import { createEnvironmentRegistry } from "./shared/env-detector.js";
import { createEnvironmentDrawer } from "./env-drawer.js";
import {
  ROLE_PRINCIPAL,
  creerElection,
  nomVerrou,
  verrousDisponibles,
} from "./shared/election-onglet.js";
import {
  GARDE_CONTROLE,
  GARDE_ISOLATION,
  compterTentatives,
  decisionReprise,
  diagnostiquer,
  releverCapacites,
  repriseControle,
  resumerManques,
} from "./shared/prerequis-demarrage.js";
import { creerIndicateurDemarrage } from "./shared/progression-demarrage.js";
import { lireRequetesSql, mesuresDemarrage } from "./shared/bilan-demarrage.js";
import { nomSandbox } from "./shared/nom-sandbox.js";
import { VERSION_RAILSBOX } from "./shared/version.js";
import { createVeilleController } from "./shared/veille.js";
import { PLAFOND_RETENTION_MS } from "./shared/session-privee.js";
import {
  MESSAGE_CANAL_DEMANDE,
  MESSAGE_CANAL_OK,
  MESSAGE_CANAL_PERDU,
  MESSAGE_ETABLIR_CANAL,
} from "./shared/proxy-logic.js";

// Tout est relatif à la page : la coquille est publiée à la racine en
// développement, mais sous « /<depot>/ » sur le Pages de projet de chaque
// démonstration (ADR 0004). Un chemin absolu y sortirait du site.
const APP_URL = new URL("app/", document.baseURI).pathname;
const V86_CONFIG_URL = new URL("disks/v86-config.json", document.baseURI).href;
// Chemin de la coquille elle-même : il nomme le verrou d'élection, pour que
// deux démonstrations publiées sur la même origine ne se bloquent pas.
const SHELL_PATH = new URL("./", document.baseURI).pathname;
// Deuxième chance après réparation : l'application vient d'être relancée
// avec les nouvelles variables, elle doit rebooter (plusieurs minutes).
const MAX_REPAIR_RETRIES = 2;

// --- CANAL DE COMMANDE PRIVÉ ----------------------------------------------
//
// Le port par lequel cette page — et rien d'autre — commande le Service
// Worker. Il vit dans la fermeture de ce module : aucune propriété de `window`,
// aucun objet joignable ne le porte. C'est ce qui le rend non forgeable pour un
// script injecté DANS cette page.
//
// Le scénario contre lequel il existe : l'iframe applicative porte
// `allow-same-origin`, donc un XSS de l'application atteint `parent.document`
// et peut y ajouter un `<script src="/app/…">` — même origine, donc autorisé
// par notre CSP. Ce script s'exécute ici, avec l'URL de cette page : aucun
// filtre sur l'ÉMETTEUR ne le distingue de nous. Il ne peut pas, en revanche,
// obtenir ce port.
let canalCommande = null;
// Le canal a-t-il été CONFIRMÉ par le worker ? Un canal proposé n'est pas un
// canal adopté : le worker peut le refuser (nonce périmé, tour déjà clos).
let canalConfirme = false;
// Commandes émises avant que le canal ne soit confirmé. Sans cette file, une
// configuration d'artefacts déclarée trop tôt était perdue, et le worker
// l'attendait sans jamais la redemander.
const commandesEnAttente = [];

// --- INTRINSÈQUES CAPTURÉS À L'ÉVALUATION DU MODULE ------------------------
//
// Tout ce qui suit est lu MAINTENANT, avant qu'aucun contenu applicatif
// n'existe, et rappelé ensuite par `Reflect.apply` sur la référence d'origine.
//
// Un script injecté s'exécute dans ce realm : il peut remplacer n'importe quel
// intrinsèque. LA LISTE DOIT COUVRIR TOUT CE QUI TOUCHE LE PORT, pas seulement
// l'envoi — c'est l'erreur qu'une relecture a trouvée ici. Il ne suffit pas de
// se méfier de `postMessage` :
//
//   MessagePort.prototype.start = function () { vole(this); return … };
//
// posé AVANT le tour de rétablissement, ce piège reçoit notre port privé en
// `this` au moment même où nous le démarrons. Les accesseurs `port1`/`port2`
// de `MessageChannel`, le setter `onmessage` de `MessagePort` et le getter
// `MessageEvent.data` sont des surfaces identiques. Toutes sont capturées
// ci-dessous et rappelées par `Reflect.apply` : la fonction remplacée n'est
// jamais invoquée, et le port n'apparaît dans aucun `this` observable.
//
// TOUT EST FACULTATIF ICI. Un navigateur sans Service Worker — webview qui le
// refuse, mode restreint — doit obtenir le diagnostic de `checkBrowserSupport`,
// pas une exception à l'évaluation du module. Chaque capture est donc gardée.
const APPLIQUER = Reflect.apply;
const DESCRIPTEUR = Object.getOwnPropertyDescriptor;
const CANAL_MESSAGE = MessageChannel;
const CONSTRUCTEUR_EVENT_TARGET = typeof EventTarget === "function" ? EventTarget : null;
const CONSTRUCTEUR_MESSAGE_EVENT = typeof MessageEvent === "function" ? MessageEvent : null;
const CONSTRUCTEUR_SERVICE_WORKER = typeof ServiceWorker === "function" ? ServiceWorker : null;
const LIRE_PORT1 = DESCRIPTEUR(MessageChannel.prototype, "port1")?.get;
const LIRE_PORT2 = DESCRIPTEUR(MessageChannel.prototype, "port2")?.get;
const POSTER_SUR_PORT = MessagePort.prototype.postMessage;
const DEMARRER_PORT = MessagePort.prototype.start;
const POSER_ONMESSAGE = DESCRIPTEUR(MessagePort.prototype, "onmessage")?.set;
const LIRE_DONNEES_MESSAGE = CONSTRUCTEUR_MESSAGE_EVENT
  ? DESCRIPTEUR(CONSTRUCTEUR_MESSAGE_EVENT.prototype, "data")?.get
  : null;
const POSTER_AU_WORKER = CONSTRUCTEUR_SERVICE_WORKER?.prototype.postMessage ?? null;
const ECOUTER = EventTarget.prototype.addEventListener;
const CONTENEUR_SW = navigator.serviceWorker ?? null;
const LIRE_CONTROLEUR =
  typeof ServiceWorkerContainer === "function"
    ? DESCRIPTEUR(ServiceWorkerContainer.prototype, "controller")?.get
    : null;
// Décidé une fois, avant tout code applicatif. Relire `EventTarget` ou
// `ServiceWorker` dans un `instanceof` au moment du rétablissement permettrait
// à un XSS de forcer la branche de compatibilité, qui utilise volontairement
// les propriétés ordinaires des doubles de test.
const CONTENEUR_SW_NATIF = Boolean(
  CONTENEUR_SW &&
  LIRE_CONTROLEUR &&
  CONSTRUCTEUR_EVENT_TARGET &&
  CONTENEUR_SW instanceof CONSTRUCTEUR_EVENT_TARGET,
);

// Relecture des mêmes intrinsèques, à l'appel : ce qui a changé depuis le
// démarrage signale un realm modifié. Voir `realmIntact`.
const RELECTURES = [
  () => Reflect.apply,
  () => Object.getOwnPropertyDescriptor,
  () => (typeof MessageChannel === "function" ? MessageChannel : null),
  () => (typeof EventTarget === "function" ? EventTarget : null),
  () => (typeof MessageEvent === "function" ? MessageEvent : null),
  () => (typeof ServiceWorker === "function" ? ServiceWorker : null),
  () =>
    typeof MessageChannel === "function"
      ? DESCRIPTEUR(MessageChannel.prototype, "port1")?.get
      : null,
  () =>
    typeof MessageChannel === "function"
      ? DESCRIPTEUR(MessageChannel.prototype, "port2")?.get
      : null,
  () => (typeof MessagePort === "function" ? MessagePort.prototype.postMessage : null),
  () => (typeof MessagePort === "function" ? MessagePort.prototype.start : null),
  () =>
    typeof MessagePort === "function" ? DESCRIPTEUR(MessagePort.prototype, "onmessage")?.set : null,
  () =>
    CONSTRUCTEUR_MESSAGE_EVENT
      ? DESCRIPTEUR(CONSTRUCTEUR_MESSAGE_EVENT.prototype, "data")?.get
      : null,
  () => (typeof EventTarget === "function" ? EventTarget.prototype.addEventListener : null),
];
const CAPTURES = [
  APPLIQUER,
  DESCRIPTEUR,
  CANAL_MESSAGE,
  CONSTRUCTEUR_EVENT_TARGET,
  CONSTRUCTEUR_MESSAGE_EVENT,
  CONSTRUCTEUR_SERVICE_WORKER,
  LIRE_PORT1,
  LIRE_PORT2,
  POSTER_SUR_PORT,
  DEMARRER_PORT,
  POSER_ONMESSAGE,
  LIRE_DONNEES_MESSAGE,
  ECOUTER,
];
let falsificationSignalee = false;

/**
 * Un des intrinsèques dont dépend le canal a-t-il été remplacé depuis le
 * démarrage ?
 *
 * CE N'EST PAS UNE GARDE, C'EST UN SIGNAL, et il faut dire pourquoi. Les
 * opérations ci-dessus passent toutes par les références capturées : un
 * remplacement est déjà inerte, et refuser d'établir le canal ne protégerait
 * rien de plus. Ça casserait en revanche la sandbox chez les visiteurs dont
 * une extension instrumente ces objets — un faux positif coûteux pour un gain
 * nul. Recharger la coquille n'aiderait pas davantage : l'iframe applicative
 * se recharge avec elle et peut réinjecter.
 *
 * Ce que le signal apporte, c'est de le DIRE : sans lui, un realm modifié
 * restait parfaitement silencieux dans le journal de démarrage.
 * @returns {boolean}
 */
function realmIntact() {
  for (let index = 0; index < RELECTURES.length; index += 1) {
    if (RELECTURES[index]() !== CAPTURES[index]) return false;
  }
  return true;
}

/**
 * Crée le canal privé SANS toucher au port par une opération remplaçable :
 * les accesseurs `port1`/`port2`, le setter `onmessage` et `start` passent
 * tous par leur référence d'origine.
 * @param {(event: MessageEvent) => void} surMessage
 * @returns {{ port1: MessagePort, port2: MessagePort }}
 */
function creerCanalPrive(surMessage) {
  const paire = new CANAL_MESSAGE();
  const port1 = LIRE_PORT1 ? APPLIQUER(LIRE_PORT1, paire, []) : paire.port1;
  const port2 = LIRE_PORT2 ? APPLIQUER(LIRE_PORT2, paire, []) : paire.port2;
  if (POSER_ONMESSAGE) APPLIQUER(POSER_ONMESSAGE, port1, [surMessage]);
  else port1.onmessage = surMessage;
  APPLIQUER(DEMARRER_PORT, port1, []);
  return { port1, port2 };
}

/**
 * Lit un `MessageEvent` sans invoquer son getter courant. Ce getter est une
 * surface de capacité à part entière : sur un message de `MessagePort`, il
 * s'exécute pendant la distribution et peut récupérer le port privé via
 * `event.currentTarget`, avant même que notre gestionnaire ne voie les
 * données. Le repli ne sert que les doubles qui appellent directement les
 * gestionnaires avec un objet ordinaire.
 * @param {MessageEvent | { data?: any }} event
 * @returns {any}
 */
function donneesMessage(event) {
  if (LIRE_DONNEES_MESSAGE) {
    try {
      return APPLIQUER(LIRE_DONNEES_MESSAGE, event, []);
    } catch {
      // Un vrai MessageEvent satisfait toujours le brand check du getter.
      // Seuls les doubles de test arrivent ici.
    }
  }
  return event.data;
}

/** Le contrôleur réel, quoi qu'on ait fait à `navigator` depuis. */
function controleurSW() {
  if (!CONTENEUR_SW) return null;
  // La lecture par le descripteur d'origine ignore un `navigator.serviceWorker`
  // masqué par `Object.defineProperty`. Le repli sert les bancs de test, qui
  // remplacent le conteneur par un objet ordinaire.
  if (CONTENEUR_SW_NATIF && LIRE_CONTROLEUR) {
    return APPLIQUER(LIRE_CONTROLEUR, CONTENEUR_SW, []);
  }
  return /** @type {any} */ (CONTENEUR_SW).controller ?? null;
}

/**
 * Poste au contrôleur par la référence d'origine — un
 * `ServiceWorker.prototype.postMessage` remplacé n'est jamais appelé.
 * @param {Record<string, unknown>} message
 * @param {any[]} [transfer]
 */
function posterAuControleur(message, transfer = []) {
  const controleur = controleurSW();
  if (!controleur) return false;
  if (CONTENEUR_SW_NATIF && POSTER_AU_WORKER) {
    APPLIQUER(POSTER_AU_WORKER, controleur, [message, transfer]);
    return true;
  }
  controleur.postMessage(message, transfer);
  return true;
}

/**
 * Envoie une commande au proxy par le canal privé.
 *
 * Tant que le canal n'est pas confirmé, la commande est MISE DE CÔTÉ et un
 * tour de rétablissement est demandé : c'est le réessai qui manquait au
 * passage de relais entre onglets. Les messages porteurs d'un transfert
 * (le pont) ne sont pas mis en file — ils ne sont émis qu'en réponse à une
 * demande du worker, donc canal confirmé.
 * @param {Record<string, unknown>} message
 * @param {any[]} [transfer]
 * @returns {boolean} vrai si le message est parti tout de suite
 */
function commander(message, transfer = []) {
  if (canalCommande && canalConfirme) {
    APPLIQUER(POSTER_SUR_PORT, canalCommande, [message, transfer]);
    return true;
  }
  if (transfer.length === 0) commandesEnAttente.push(message);
  demanderCanal();
  return false;
}

/** Prie le worker d'ouvrir un tour de rétablissement. N'accorde aucun droit. */
function demanderCanal() {
  posterAuControleur({ type: MESSAGE_CANAL_DEMANDE });
}

/**
 * Répond à un tour de rétablissement, avec le nonce qu'il portait.
 *
 * L'écouteur qui appelle ceci est inscrit à l'ÉVALUATION DU MODULE, plus bas :
 * les écouteurs sont appelés dans leur ordre d'inscription, si bien qu'un
 * script injecté — inscrit forcément après — répond après nous, sur un nonce
 * déjà consommé. C'est ce qui fait pencher la course, plutôt que de la laisser
 * au hasard.
 * @param {unknown} nonce
 */
function repondreAuTour(nonce) {
  if (!controleurSW()) return;
  signalerFalsification();
  const { port1, port2 } = creerCanalPrive((event) => onCanalMessage(event));
  canalCommande = port1;
  canalConfirme = false;
  posterAuControleur({ type: MESSAGE_ETABLIR_CANAL, nonce }, [port2]);
}

/** Journalise UNE fois qu'un intrinsèque du canal a été remplacé. */
function signalerFalsification() {
  if (falsificationSignalee || realmIntact()) return;
  falsificationSignalee = true;
  logLine(
    "[sécurité] un intrinsèque du canal de commande a été remplacé dans cette page. " +
      "Le canal reste établi par les références capturées au démarrage, donc hors " +
      "d'atteinte — mais ce realm exécute du code qui n'est pas le nôtre.",
  );
}

/**
 * Messages reçus sur le canal privé : l'accusé de réception d'abord, les
 * demandes du worker ensuite.
 * @param {MessageEvent} event
 */
function onCanalMessage(event) {
  const donnees = donneesMessage(event);
  if (donnees?.type === MESSAGE_CANAL_OK) {
    canalConfirme = true;
    const differees = commandesEnAttente.splice(0);
    for (const message of differees) APPLIQUER(POSTER_SUR_PORT, canalCommande, [message, []]);
    return;
  }
  onWorkerMessage(event);
}

// Inscrit ICI, à l'évaluation du module, et pas dans `demarrer()` : c'est ce
// qui garantit que nous répondons AVANT tout code inscrit plus tard.
if (CONTENEUR_SW) {
  /** @param {Event} evenement */
  const surMessagePublic = (evenement) => {
    const donnees = donneesMessage(/** @type {MessageEvent} */ (evenement));
    if (donnees?.type === MESSAGE_CANAL_PERDU) repondreAuTour(donnees.nonce);
  };
  // Par la référence d'origine quand c'est un vrai `EventTarget` : un
  // `addEventListener` remplacé ne verrait alors jamais notre inscription.
  if (CONTENEUR_SW_NATIF) {
    APPLIQUER(ECOUTER, CONTENEUR_SW, ["message", surMessagePublic]);
  } else {
    /** @type {any} */ (CONTENEUR_SW).addEventListener("message", surMessagePublic);
  }
  // La file de messages du worker vers la page est DÉSACTIVÉE tant qu'on n'a
  // pas posé `onmessage` ou appelé ceci.
  CONTENEUR_SW.startMessages?.();
}

let inspector = null;
// Élection de l'onglet actif ; null tant que Web Locks n'est pas disponible.
let election = null;
// VM et configuration courantes, retenues au niveau du module : le Service
// Worker peut être tué et redémarré à tout moment, et redemande alors l'une
// ou l'autre à la page — hors de toute pile d'appel.
let vmInstance = null;
let artifactConfig = null;
const MAX_LOG_LINES = 800;
const BADGE_IDS = ["sw", "coi", "vm", "http"];

/**
 * État des badges EN TOUTES LETTRES.
 *
 * La classe CSS ne dit rien à personne : la pastille qui la matérialise est un
 * `::before`, et un lecteur d'écran n'annonce pas le contenu généré. Un
 * visiteur non voyant entendait donc « Service Worker » sans jamais savoir si
 * le Service Worker marchait — quatre badges, zéro information.
 */
const ETATS_BADGE = {
  ok: "actif",
  error: "indisponible",
  pending: "en attente",
  neutre: "inactif",
};

// Le titre garde « railsbox » après le nom de l'application : c'est ce qui
// distingue l'onglet d'une application ordinaire, et le test de bout en bout
// de la page hôte le vérifie. Le nom lui-même se déduit dans
// shared/nom-sandbox.js — il vient d'un fichier téléchargé, donc d'une source
// non fiable, et le nettoyage qu'il exige mérite ses propres tests.
const SUFFIXE_TITRE = "propulsée par railsbox";

const TITRE_SECONDAIRE = "Cette démonstration est déjà ouverte dans un autre onglet";
const DETAIL_SECONDAIRE =
  "Une seule sandbox tourne à la fois par navigateur : l'émulation x86 est lourde, et deux " +
  "VM pour un seul service rendu doubleraient la charge du processeur sans rien apporter. " +
  "L'autre onglet garde la main tant que vous ne la reprenez pas ici ; si vous la reprenez, " +
  "il libère sa VM et affiche ce même message.";
const LIBELLE_REPRISE = "Reprendre la sandbox dans cet onglet";

// --- Session expirée en plein boot (distribution privée) -------------------
//
// Le Service Worker a RETENU une lecture de disque refusée pour session
// expirée : rien n'est perdu, rien n'est cassé, mais la VM ne doit surtout pas
// continuer de tourner pendant ce temps. Son délai ATA (30 s par défaut sous
// libata) réinitialiserait le lien puis remonterait « / » en lecture seule —
// destruction irréversible de la sandbox. Arrêter le CPU arrête ses compteurs.
const URL_ETAT_SESSION = new URL("auth/etat", document.baseURI).href;
// Sonde de rétablissement. Trois secondes : assez court pour que la reprise
// suive le retour du visiteur, assez long pour ne pas marteler le bord pendant
// qu'il est parti relire sa boîte mail.
const SONDE_SESSION_MS = 3_000;
const TITRE_SESSION = "Votre session a expiré — la sandbox est en pause";
const DETAIL_SESSION =
  "La lecture du disque a été suspendue avant qu'elle ne puisse échouer : la machine " +
  "virtuelle est arrêtée, sa mémoire est intacte, et tout ce que vous avez saisi est " +
  "toujours là. Reconnectez-vous dans un autre onglet ; cette page le détecte seule et " +
  "reprend exactement où elle en était.";
const LIBELLE_SESSION = "J'ai rouvert ma session — vérifier maintenant";
const TITRE_SESSION_PERDUE = "La session n'a pas été rétablie à temps";
const DETAIL_SESSION_PERDUE =
  "La lecture du disque ne peut pas être retenue indéfiniment. Reconnectez-vous, puis " +
  "rechargez cette page : le boot repartira, et les morceaux déjà téléchargés seront " +
  "resservis depuis le cache.";
// Épisode en cours, ou null. Retenu au niveau du module comme `vmInstance` :
// le Service Worker peut redémarrer et re-notifier hors de toute pile d'appel.
let sessionSuspendue = null;

const logElement = document.getElementById("boot-log");
const frameElement = /** @type {HTMLIFrameElement} */ (document.getElementById("app-frame"));
const diagnosticElement = document.getElementById("diagnostic");
const etatElement = document.getElementById("etat-demarrage");

// --- Jalons du démarrage ---------------------------------------------------
//
// Trois horodatages, tous tenus par CETTE page — aucun n'est déduit du journal.
// Ils répondent à la seule question que se pose vraiment celui qui attend :
// qu'est-ce qui prend une minute ?
//
// Mesuré le 19/08/2026 sur la sandbox jiyufit, démarrage à froid : 55 s en
// tout, dont 24 s passées DANS Rails pour construire la première page
// (« Completed 200 OK in 24292ms », que l'application écrit elle-même). La
// moitié de l'attente n'est donc pas l'émulation. Sans ce partage affiché,
// tout est mis au compte de railsbox — et l'optimisation part chercher les
// secondes là où elles ne sont pas.
const jalons = {
  /** Chargement de la coquille (évaluation de ce module). */
  debut: Date.now(),
  /** Premier aller-retour HTTP réussi jusqu'à la VM. @type {number | null} */
  vmRepond: null,
  /** Cadre effectivement chargé, donc première page RENDUE. @type {number | null} */
  premierRendu: null,
};

// Étape en cours et instant où elle a commencé. L'indicateur partagé compte
// depuis le début du démarrage, ce qui suffit tant que les étapes défilent ;
// la dernière, elle, dure à elle seule la moitié de l'attente (5/5 atteinte à
// 28 s, application visible à 55 s). Un compteur global qui monte pendant 27 s
// sans que rien ne change se lit comme un blocage : celui-ci dit sur QUOI on
// attend, et depuis quand.
let etapeCourante = null;
let debutEtapeMs = Date.now();

/**
 * Compte de requêtes SQL de la dernière page servie, tel que l'application
 * l'écrit dans son propre journal. `null` tant qu'aucune ligne n'a été
 * reconnue — et c'est ce `null` qu'on affiche en n'affichant rien : un
 * « 0 requête » deviné ferait passer une mesure absente pour une mesure nulle.
 * @type {{ requetes: number, cachees: number | null } | null}
 */
let requetesSql = null;

// Le journal de boot est long, gris, et défile : il informe qui le lit, pas qui
// attend. La mesure sous bridage processeur (npm run test:bridage) a chiffré
// cette attente sur la sandbox publiée : 25 s avant que l'application soit
// visible sans bridage, 39 s à 6×, 50 à 54 s à 8×. Cette ligne dit où l'on en
// est, et depuis combien de temps.
const indicateur = creerIndicateurDemarrage({
  afficher: (etat) => {
    if (!etatElement) return;
    etatElement.textContent = etat.texte + suffixePremierRendu();
    etatElement.classList.toggle("tres-lente", etat.lenteur === "tres-lente");
    etatElement.hidden = false;
  },
  terminer: () => {
    if (etatElement) etatElement.hidden = true;
  },
});

/**
 * Déclare l'étape en cours et remet à zéro son chronomètre propre.
 * @param {string} cle clé de shared/progression-demarrage.js
 */
function etape(cle) {
  etapeCourante = cle;
  debutEtapeMs = Date.now();
  indicateur.etape(cle);
}

/**
 * Complément affiché pendant la DERNIÈRE étape, et seulement elle : à ce
 * moment précis railsbox n'a plus rien à faire, c'est l'application qui
 * construit sa page. Le dire évite qu'une attente d'une demi-minute soit mise
 * au compte de la sandbox — et mesurée, c'est bien la moitié du démarrage.
 * @returns {string}
 */
function suffixePremierRendu() {
  if (etapeCourante !== "premierePage") return "";
  const secondes = Math.max(0, Math.floor((Date.now() - debutEtapeMs) / 1000));
  return ` · premier rendu par l'application depuis ${secondes} s`;
}

function logLine(text) {
  // Chaque ligne passe par le détecteur : une variable manquante citée par
  // l'application ouvre l'inspecteur au lieu de se perdre dans le journal.
  inspector?.ingest(text);
  noterRequetesSql(text);
  const stamp = new Date().toLocaleTimeString();
  logElement.textContent += `[${stamp}] ${text}\n`;
  const lines = logElement.textContent.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    logElement.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
  }
  logElement.scrollTop = logElement.scrollHeight;
}

/**
 * Retient le compte de requêtes SQL d'une ligne de journal applicatif.
 *
 * Défensif par construction : une ligne qui ne correspond pas ne change rien,
 * et le bilan omettra simplement cette information. Jamais d'exception ici —
 * cette fonction est sur le chemin de CHAQUE ligne de console de la VM, une
 * levée y arrêterait le journal entier.
 * @param {string} texte
 */
function noterRequetesSql(texte) {
  const lu = lireRequetesSql(texte);
  if (lu) requetesSql = lu;
}

/**
 * Peint un badge : la classe pour l'œil, le texte pour l'oreille.
 *
 * `.badge-etat` peut manquer (coquille plus ancienne, ou remaniée) : on se
 * contente alors de la classe, plutôt que d'écrire par-dessus le nom du badge
 * et de le rendre illisible pour tout le monde.
 * @param {string} id
 * @param {"ok" | "error" | "pending" | "neutre"} etat
 */
function peindreBadge(id, etat) {
  const badge = document.getElementById(`badge-${id}`);
  if (!badge) return;
  badge.classList.remove("pending", "ok", "error");
  if (etat !== "neutre") badge.classList.add(etat);
  const cible = badge.querySelector(".badge-etat");
  if (cible) cible.textContent = ETATS_BADGE[etat];
}

/**
 * @param {string} id
 * @param {boolean} ok
 */
function setBadge(id, ok) {
  peindreBadge(id, ok ? "ok" : "error");
}

/**
 * Remet les quatre badges dans un même état. `null` les laisse neutres : dans
 * un onglet secondaire, rien n'est en cours, et un badge « pending » se lirait
 * comme un chargement qui n'arrive jamais.
 * @param {"pending" | null} etat
 */
function setBadges(etat) {
  for (const id of BADGE_IDS) peindreBadge(id, etat ?? "neutre");
}

/**
 * Renomme un badge SANS détruire sa structure interne. Un
 * `badge.textContent = …` effacerait `.badge-etat`, donc l'état en toutes
 * lettres, donc exactement ce qu'un lecteur d'écran est seul à pouvoir lire.
 * @param {string} id
 * @param {string} nom
 */
function nommerBadge(id, nom) {
  const badge = document.getElementById(`badge-${id}`);
  if (!badge) return;
  const cible = badge.querySelector(".badge-nom");
  if (cible) cible.textContent = nom;
  // Ni `.badge-nom` ni `.badge-etat` : le badge est un simple libellé, on peut
  // l'écrire entier sans rien perdre.
  else if (!badge.querySelector(".badge-etat")) badge.textContent = nom;
}

async function start() {
  if (!checkBrowserSupport()) return;
  await ensureSingleSandbox();

  // Première ligne du journal, et c'est voulu : quand une sandbox publiée se
  // comporte mal des semaines après sa construction, la version qui l'a
  // fabriquée est le premier renseignement à donner. Le journal étant replié
  // par défaut sur une sandbox publiée, le visiteur ne la voit pas.
  logLine(`railsbox ${VERSION_RAILSBOX}`);
  etape("serviceWorker");
  logLine("Enregistrement du Service Worker proxy…");
  // updateViaCache: "none" — le défaut (« imports ») contourne le cache HTTP
  // pour le script du worker MAIS PAS pour ses imports. Or toute la logique du
  // proxy vit dans shared/*.js, et GitHub Pages plafonne à max-age=600 : un
  // worker fraîchement installé pouvait donc tourner avec une copie périmée de
  // sa propre logique. Constaté en production sur une sandbox tierce — le
  // correctif était publié, le worker à jour, et l'application restait cassée
  // jusqu'à une désinstallation manuelle du worker.
  await navigator.serviceWorker.register(new URL("sw-proxy.js", document.baseURI), {
    type: "module",
    updateViaCache: "none",
  });
  await navigator.serviceWorker.ready;
  await ensureControlled();
  setBadge("sw", true);

  // Le canal privé s'obtient en RÉPONDANT à un tour que le worker ouvre :
  // aucune proposition spontanée n'est plus acceptée. L'écouteur qui répond
  // est inscrit tout en haut de ce module, avant tout code étranger.
  demanderCanal();

  etape("isolation");
  await ensureCrossOriginIsolated();
  setBadge("coi", true);

  etape("vm");
  const vm = await bootSelectedEngine();
  vmInstance = vm;
  window.__vm = vm; // hook de diagnostic (DevTools)
  setBadge("vm", true);

  // Le SW peut être tué/redémarré à tout moment par le navigateur : il perd
  // alors le port. On lui en fournit un neuf à chaque demande (onWorkerMessage),
  // et un immédiatement maintenant que la VM sait répondre.
  sendBridgePort(vm);
  await vm.startServer();

  installInspector(vm);

  etape("application");
  logLine("Attente du serveur applicatif à l'intérieur de la VM…");
  await waitForApplication(vm);
  // Jalon : à partir d'ici, railsbox a fini son travail — proxy, isolation,
  // artefacts, VM, serveur. Tout ce qui suit est le temps de l'APPLICATION.
  jalons.vmRepond = Date.now();
  setBadge("http", true);

  // Dernière étape, et la seule que rien ne signalait : la VM doit encore
  // RENDRE cette page. Mesuré sous bridage : 1 s sans bridage, 3,7 à 4,4 s à
  // 4×, 7,3 à 7,6 s à 6×, 12,6 à 14,5 s à 8× — le tout sous une rangée de
  // badges déjà tous verts, donc sans qu'aucun signal ne distingue « ça
  // arrive » de « c'est bloqué ».
  // L'indicateur reste donc jusqu'au chargement effectif du cadre, et non
  // jusqu'à la simple affectation de son adresse.
  etape("premierePage");
  frameElement.addEventListener(
    "load",
    () => {
      // Le démarrage n'est terminé QU'ICI. `load` du cadre, c'est le document
      // de l'application effectivement rendu — pas son adresse affectée, pas
      // une sonde HTTP qui a répondu.
      jalons.premierRendu = Date.now();
      indicateur.fin();
      publierBilan();
    },
    { once: true },
  );
  frameElement.src = APP_URL;
  logLine(`Application disponible → iframe sur ${APP_URL}`);

  // Une fois l'application servie — jamais pendant le boot, qu'un visiteur
  // parti sur un autre onglet a le droit de laisser finir en arrière-plan —
  // la VM se met en veille quand l'onglet est masqué : le processeur du
  // visiteur ne paie plus une émulation que personne ne regarde.
  installBackgroundPause(vm);

  if (typeof vm.metrics === "function") {
    // Débit du canal série : utile pour juger si les assets passent bien.
    setTimeout(() => {
      const { lastTransfer, serial } = vm.metrics();
      logLine(
        `Pont série : ${serial.bytes.toLocaleString("fr-FR")} octets reçus, ` +
          `dernier transfert ${lastTransfer.bytes.toLocaleString("fr-FR")} o en ` +
          `${lastTransfer.milliseconds} ms (${lastTransfer.kilobytesPerSecond} Ko/s)`,
      );
    }, 30_000);
  }

  // v86 : capture l'état mémoire post-boot pour des démarrages en secondes.
  if (typeof vm.persistSnapshot === "function") {
    logLine("Sauvegarde de l'instantané mémoire en arrière-plan…");
    vm.persistSnapshot()
      .then((message) => logLine(message))
      .catch((error) => logLine(`Instantané non sauvegardé: ${error.message}`));
  }
}

// Une seule VM active par navigateur. La promesse rendue ne se résout que
// lorsque CET onglet a la main : dans un onglet secondaire, elle attend le clic
// du visiteur sur « reprendre ici », et rien ne démarre entre-temps — ni
// Service Worker, ni téléchargement d'artefacts, ni VM.
//
// Articulation avec la veille d'arrière-plan (shared/veille.js) : un onglet
// secondaire n'a pas de VM, donc rien à suspendre, et `installBackgroundPause`
// n'y est jamais appelé puisque `start()` s'arrête ici. Une reprise ne peut
// venir que d'un clic, donc d'un onglet visible : aucun onglet masqué ne
// démarre de VM dans le dos du visiteur.
async function ensureSingleSandbox() {
  if (!verrousDisponibles(window)) {
    logLine(
      "Web Locks indisponible : impossible de garantir une seule VM par navigateur — " +
        "un autre onglet ouvert sur cette sandbox ferait tourner sa propre VM.",
    );
    return;
  }
  election = creerElection({
    verrous: navigator.locks,
    nom: nomVerrou(SHELL_PATH),
    onEviction: releaseSandboxToOtherTab,
  });
  if ((await election.candidater()) === ROLE_PRINCIPAL) return;
  logLine("Sandbox déjà active dans un autre onglet — aucune VM démarrée ici.");
  await waitForVisitorTakeover();
}

/** Panneau du rôle secondaire, et attente du geste du visiteur. */
function waitForVisitorTakeover() {
  setBadges(null);
  /** @type {Promise<void>} */
  const reprise = new Promise((resolve) => {
    showDiagnostic(TITRE_SECONDAIRE, DETAIL_SECONDAIRE, {
      ton: "info",
      action: {
        libelle: LIBELLE_REPRISE,
        async onClick(bouton) {
          bouton.disabled = true;
          if ((await election.reprendre()) !== ROLE_PRINCIPAL) {
            // Ne devrait pas arriver : la reprise ARRACHE le verrou. Si cela
            // se produit, le panneau reste affiché et le bouton redevient
            // cliquable — mais sans cette ligne, rien ne le dirait, et le
            // symptôme (« le panneau ne cède pas ») n'aurait aucune cause
            // visible dans le journal.
            logLine("[élection] reprise refusée : le verrou n'a pas été obtenu, réessayez.");
            bouton.disabled = false;
            return;
          }
          hideDiagnostic();
          setBadges("pending");
          logLine("Sandbox reprise dans cet onglet ; l'autre onglet libère la sienne.");
          resolve();
        },
      },
    });
  });
  return reprise;
}

// Un autre onglet vient d'arracher le verrou. On rend le processeur tout de
// suite, puis on recharge : c'est le seul moyen de rendre AUSSI la mémoire de
// la VM, et la coquille rechargée se présentera en secondaire, panneau compris.
// L'onglet qui reprend, lui, ne recharge pas — il tient le verrou de bout en
// bout, donc les deux onglets ne peuvent pas se le disputer.
function releaseSandboxToOtherTab() {
  logLine("Un autre onglet a repris la sandbox : cet onglet libère sa VM.");
  Promise.resolve(vmInstance?.pause?.()).catch(() => {
    // La page se recharge : il n'y a rien à rattraper.
  });
  location.reload();
}

// Suspend la VM d'un onglet masqué après un délai de grâce, la reprend au
// retour (avec recalage d'horloge, fait par resume()). La décision vit dans
// shared/veille.js, testée sans navigateur.
//
// Les deux économies se composent sans se contredire : l'élection supprime les
// VM en trop (un onglet secondaire n'en a pas, donc rien à suspendre ici), la
// veille suspend celle qui reste quand personne ne la regarde.
function installBackgroundPause(vm) {
  if (typeof vm.pause !== "function" || typeof vm.resume !== "function") return;
  const veille = createVeilleController({
    pause: () => {
      Promise.resolve(vm.pause()).catch((error) =>
        logLine(`[veille] pause impossible : ${error.message}`),
      );
      logLine("[veille] onglet masqué — VM suspendue, le processeur est rendu au visiteur");
    },
    resume: () => {
      vm.resume();
      logLine("[veille] onglet visible — VM reprise, horloge recalée");
    },
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) veille.hidden();
    else veille.visible();
  });
}

// L'inspecteur n'a de sens que si la VM sait recevoir des variables : le
// moteur ne l'expose pas, on ne l'affiche donc pas.
function installInspector(vm) {
  if (typeof vm.applyEnvironment !== "function") return;
  const registry = createEnvironmentRegistry();
  inspector = createEnvironmentDrawer({
    registry,
    onLog: (message) => logLine(message),
    onApply: (variables) => vm.applyEnvironment(variables),
  });
  document.getElementById("env-slot").append(inspector.element);
}

/**
 * Ce qu'une sonde HTTP interne inscrit au journal.
 *
 * L'ancienne formulation — « Sonde HTTP interne n°1 — Délai dépassé en
 * attendant la VM v86 » — décrivait comme un échec le déroulement le plus
 * normal du démarrage : la n°2 réussit sept secondes plus tard, à froid comme
 * à chaud. Un visiteur qui lit ça pendant que son écran est vide en conclut
 * que c'est cassé, et ferme l'onglet sept secondes avant l'application.
 *
 * Le mot « OK » est conservé tel quel sur la sonde qui réussit : c'est à lui
 * que `npm run test:bridage` distingue les sondes abouties des autres
 * (tests/bridage/bridage-cpu.spec.mjs), et les mesures publiées reposent
 * dessus. Il ne doit donc apparaître dans AUCUN message d'attente.
 *
 * @param {number} attempt numéro de la sonde, à partir de 1
 * @param {string | null | undefined} error cause de l'attente, absente si la sonde a abouti
 * @returns {string}
 */
function ligneSonde(attempt, error) {
  if (!error) return `Sonde HTTP interne n°${attempt} — OK, la VM répond`;
  return (
    `Sonde HTTP interne n°${attempt} — pas encore de réponse (${error}) : ` +
    "le serveur applicatif démarre encore, nouvelle tentative"
  );
}

// Attend l'application ; si elle ne démarre pas et que des variables
// manquantes ont été détectées, laisse une chance à la réparation avant
// d'abandonner.
async function waitForApplication(vm, repairAttempt = 0) {
  try {
    await vm.waitUntilReady((attempt, error) => logLine(ligneSonde(attempt, error)));
  } catch (error) {
    // Toutes les variables détectées comptent, même déjà remplies : une
    // valeur erronée saisie au tour précédent mérite une chance de correction.
    const detectedCount = inspector ? inspector.detectedCount() : 0;
    if (detectedCount === 0 || repairAttempt >= MAX_REPAIR_RETRIES) throw error;
    logLine("L'application n'a pas démarré : configuration incomplète détectée.");
    inspector.open();
    inspector.announce(
      "L'application n'a pas démarré. Renseignez les variables ci-dessous, puis relancez-la.",
      "erreur",
    );
    // Le panneau signale lui-même la fin d'une réparation réussie : aucun
    // besoin d'observer son DOM, on attend son événement explicite.
    await inspector.nextRepair();
    logLine("Nouvelle tentative après réparation de l'environnement…");
    await waitForApplication(vm, repairAttempt + 1);
  }
}

async function bootSelectedEngine() {
  const params = new URLSearchParams(location.search);
  nommerBadge("vm", "VM v86");
  logLine("Boot de la VM Linux i386 (v86, open source)…");
  logLine(
    "Premier boot à froid : plusieurs minutes. Boots suivants : restaurés depuis l'instantané.",
  );
  // `cache: "reload"` — SANS LUI, REPUBLIER CASSE LA SANDBOX. Cette
  // configuration nomme le cache d'artefacts (son `builtAt` entre dans la
  // signature, artifact-cache.js) et désigne l'instantané. Servie périmée par
  // le cache HTTP de l'hébergeur — GitHub Pages annonce un max-age de plusieurs
  // minutes — elle fait restaurer l'instantané mémoire d'une construction sur
  // le disque d'une autre : Puma ne répond jamais, et rien ne le dit. Mesuré le
  // 19/08/2026 : builtAt 06:47 servi depuis le cache alors que la publication
  // portait 08:09. Ce n'est pas un en-tête ajouté (pas de préflight, ADR 0001),
  // c'est un mode de cache : le contrat des requêtes simples est préservé.
  const configResponse = await fetch(V86_CONFIG_URL, { cache: "reload" });
  if (!configResponse.ok) {
    throw new Error("v86-config.json introuvable — construisez d'abord la sandbox");
  }
  const config = await configResponse.json();
  // Première chose qu'on sait de la sandbox : son nom. Le visiteur est venu
  // pour l'APPLICATION, pas pour railsbox.
  appliquerNomSandbox(config);
  // Le Service Worker met en cache les artefacts immuables (morceaux de
  // disque, noyau, initrd) sous un nom dérivé de CETTE configuration. Il faut
  // qu'il la connaisse avant que v86 ne demande son premier morceau — et il
  // faut qu'elle vienne d'ici, pas d'une relecture du fichier : c'est la seule
  // façon que le cache corresponde exactement aux artefacts effectivement
  // bootés, y compris juste après une reconstruction.
  declareArtifacts(config);
  const { bootVm } = await import("./vm/v86-vm.js");
  return bootVm({
    onConsole: logLine,
    config,
    fresh: params.get("fresh") === "1",
  });
}

function onWorkerMessage(event) {
  const donnees = donneesMessage(event);
  if (donnees?.type === "bridge-port-request" && vmInstance) sendBridgePort(vmInstance);
  if (donnees?.type === "artifact-config-request") declareArtifacts(artifactConfig);
  if (donnees?.type === "cookies-document-request") sendDocumentCookies(donnees.id);
  if (donnees?.type === "session-expiree") traiterSessionExpiree();
}

/**
 * Le worker retient une lecture de disque : suspendre, expliquer, sonder,
 * reprendre.
 *
 * L'INTERFACE DE RECONNEXION VIT DANS CE DOCUMENT, jamais dans une iframe ni
 * une popup same-origin. La raison a changé de nature depuis que les commandes
 * passent par le canal privé : un tel document ne détiendrait pas le port, donc
 * ne pourrait rien commander — il ne pourrait pas non plus REPRENDRE la main,
 * et l'interface de reprise serait muette. Le panneau ci-dessous n'est qu'un
 * `showDiagnostic` de plus.
 *
 * INTERDIT : `location.reload()`. `releaseSandboxToOtherTab` le fait
 * sciemment pour RENDRE la mémoire de la VM ; ici il la détruirait, avec tout
 * ce que le visiteur a saisi — exactement ce que cette manœuvre existe pour
 * éviter.
 */
async function traiterSessionExpiree() {
  // Le worker étrangle déjà ses notifications, mais il peut être tué et
  // redémarré : la garde vit donc des deux côtés.
  if (sessionSuspendue) return;
  sessionSuspendue = { depuis: Date.now() };
  logLine("Session expirée : lecture de disque retenue, VM suspendue — rien n'est perdu.");
  try {
    await vmInstance?.pause?.();
  } catch (error) {
    // La pause a échoué : le panneau reste dû au visiteur, et la reprise
    // ci-dessous n'en sera que plus prudente.
    logLine(`[session] pause impossible : ${error.message}`);
  }
  showDiagnostic(TITRE_SESSION, DETAIL_SESSION, {
    ton: "info",
    action: {
      libelle: LIBELLE_SESSION,
      onClick: (bouton) => {
        bouton.disabled = true;
        sonderSession().finally(() => {
          if (sessionSuspendue) bouton.disabled = false;
        });
      },
    },
  });
  await attendreRetablissement();
}

/**
 * Sonde jusqu'au rétablissement, ou jusqu'au plafond de rétention du worker.
 * Passé ce plafond, le worker aura rendu son 401 à v86 : la lecture est
 * perdue, et le dire est la seule chose honnête qui reste à faire.
 */
async function attendreRetablissement() {
  while (sessionSuspendue) {
    if (Date.now() - sessionSuspendue.depuis > PLAFOND_RETENTION_MS) {
      sessionSuspendue = null;
      logLine("Session non rétablie dans le délai : la lecture retenue a été abandonnée.");
      showDiagnostic(TITRE_SESSION_PERDUE, DETAIL_SESSION_PERDUE);
      return;
    }
    await new Promise((resoudre) => setTimeout(resoudre, SONDE_SESSION_MS));
    await sonderSession();
  }
}

/**
 * Un aller-retour sur /auth/etat. `no-store` : une sonde resservie depuis le
 * cache HTTP dirait « toujours expirée » longtemps après la reconnexion.
 * `credentials: "same-origin"` est le défaut, mais l'écrire ici évite qu'un
 * durcissement ultérieur ne prive la sonde du cookie qu'elle vient vérifier.
 * @returns {Promise<void>}
 */
async function sonderSession() {
  if (!sessionSuspendue) return;
  try {
    const reponse = await fetch(URL_ETAT_SESSION, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!reponse.ok) return;
  } catch {
    // Bord injoignable : la sonde suivante retentera. Ce n'est pas un échec
    // de session, et l'annoncer comme tel serait un message mensonger.
    return;
  }
  reprendreApresSession();
}

/** Session rétablie : reprendre la VM, PUIS libérer les lectures retenues. */
function reprendreApresSession() {
  if (!sessionSuspendue) return;
  sessionSuspendue = null;
  hideDiagnostic();
  // L'ordre compte. `resume()` recale l'horloge invitée, qui a pris le retard
  // exact de la pause — sans quoi cookies de session et jetons CSRF de
  // l'application expireraient. Rejouer les lectures avant que l'invité ne
  // tourne à nouveau lui ferait recevoir des octets qu'il n'attend plus.
  try {
    vmInstance?.resume?.();
  } catch (error) {
    logLine(`[session] reprise de la VM impossible : ${error.message}`);
  }
  commander({ type: "session-restauree" });
  logLine("Session rétablie : VM reprise, horloge recalée, lectures rejouées.");
}

/**
 * Rapporte au Service Worker les cookies VISIBLES DU DOCUMENT.
 *
 * Un worker n'a pas de DOM : `document.cookie` lui est inaccessible, et le
 * navigateur ne lui montre pas non plus l'en-tête `Cookie` des requêtes qu'il
 * intercepte. Sans ce relais, les cookies que l'application se pose elle-même
 * en JavaScript (fuseau horaire, locale, bandeau de consentement, js-cookie)
 * n'atteignent plus jamais le serveur — l'iframe est same-origin, donc cette
 * page voit exactement les mêmes que l'application, aux cookies de chemin
 * `/app` près (vérifié dans tests/e2e/cookies-proxy.e2e.spec.mjs).
 *
 * On n'envoie que ce que le navigateur nous montre : jamais un `HttpOnly`. Le
 * bocal du worker reste autoritaire, un nom qu'il porte déjà n'est pas écrasé.
 * @param {unknown} id identifiant de la demande, à renvoyer tel quel
 */
function sendDocumentCookies(id) {
  commander({ type: "cookies-document", id, cookie: document.cookie });
}

/** @param {Record<string, any> | null} config */
function declareArtifacts(config) {
  if (!config) return;
  artifactConfig = config;
  commander({ type: "artifact-config", config });
}

function sendBridgePort(vm) {
  // Même précaution que pour le canal de commande, et l'enjeu y est plus grand :
  // ce port voit passer chaque descripteur de requête, `cookie:` EN CLAIR.
  // Le port n'existe qu'après la création du canal, et le gestionnaire en a
  // besoin : il le lit dans ce porte-référence plutôt que dans une liaison
  // déclarée après son propre usage.
  const relais = /** @type {{ port: MessagePort | null }} */ ({ port: null });
  const paire = creerCanalPrive((event) => {
    if (relais.port) relayToVm(vm, relais.port, donneesMessage(event));
  });
  relais.port = paire.port1;
  commander({ type: "bridge-port" }, [paire.port2]);
}

// `Reflect.apply` ici pour la même raison que sur le canal de commande, et
// l'enjeu y est plus grand encore : ce port voit passer chaque descripteur de
// requête, en-tête `cookie:` EN CLAIR. Un `MessagePort.prototype.postMessage`
// remplacé le recevrait en `this`.
async function relayToVm(vm, port, data) {
  if (data?.type !== "http-request") return;
  const { descriptor, body } = data;
  try {
    const response = await vm.handleHttpRequest(descriptor, body);
    const transfer = response.body ? [response.body] : [];
    APPLIQUER(POSTER_SUR_PORT, port, [
      { type: "http-response", id: descriptor.id, ...response },
      transfer,
    ]);
  } catch (error) {
    APPLIQUER(POSTER_SUR_PORT, port, [
      { type: "http-response", id: descriptor.id, error: error.message },
      [],
    ]);
  }
}

// Vérification préalable : sur un navigateur qui n'a pas de quoi faire tourner
// la sandbox, mieux vaut le dire tout de suite et le dire clairement qu'échouer
// plus loin sur un « navigator.serviceWorker is undefined ».
function checkBrowserSupport() {
  const { demarrable, bloquants, degradations } = diagnostiquer(releverCapacites(window));
  for (const manque of degradations) {
    logLine(`Fonctionnement dégradé — ${manque.titre} : ${manque.consequence}`);
  }
  if (demarrable) return true;
  const resume = resumerManques(bloquants);
  logLine(`Navigateur non pris en charge :\n${resume}`);
  showDiagnostic("Ce navigateur ne peut pas faire tourner la sandbox", resume);
  for (const id of BADGE_IDS) setBadge(id, false);
  return false;
}

/**
 * Affiche un diagnostic à la place de l'application. Le journal de boot est
 * long et gris : un visiteur dont le navigateur ne convient pas n'y lira rien.
 *
 * Le ton « info » sert aux situations qui ne sont pas des pannes — un onglet
 * secondaire n'a rien cassé —, et l'action facultative ajoute le bouton qui
 * lui permet d'en sortir.
 *
 * Le lien facultatif, lui, sert aux impasses : quand plus aucun geste dans
 * cette page ne peut aider, il reste à renvoyer le visiteur vers ce que la
 * sandbox exige de son navigateur.
 *
 * L'action SECONDAIRE, enfin, n'existe que pour les panneaux qui posent une
 * question plutôt que d'annoncer un fait : demander « redémarrer ? » sans
 * offrir de revenir en arrière serait un piège, puisque le panneau a déjà pris
 * la place de l'application.
 *
 * @param {string} titre
 * @param {string} detail
 * @param {{ ton?: "erreur" | "info", action?: { libelle: string, onClick: (bouton: HTMLButtonElement) => void } | null, secondaire?: { libelle: string, onClick: (bouton: HTMLButtonElement) => void } | null, lien?: { libelle: string, href: string } | null }} [options]
 */
function showDiagnostic(
  titre,
  detail,
  { ton = "erreur", action = null, secondaire = null, lien = null } = {},
) {
  if (!diagnosticElement) return;
  diagnosticElement.replaceChildren();
  diagnosticElement.classList.toggle("info", ton === "info");
  const titreElement = document.createElement("h2");
  titreElement.textContent = titre;
  const detailElement = document.createElement("p");
  // textContent, jamais innerHTML : ce texte peut citer un message d'erreur.
  detailElement.textContent = detail;
  diagnosticElement.append(titreElement, detailElement);
  if (action) {
    const bouton = document.createElement("button");
    bouton.type = "button";
    bouton.id = "diagnostic-action";
    bouton.textContent = action.libelle;
    bouton.addEventListener("click", () => action.onClick(bouton));
    diagnosticElement.append(bouton);
  }
  if (secondaire) {
    const bouton = document.createElement("button");
    bouton.type = "button";
    bouton.id = "diagnostic-secondaire";
    bouton.className = "secondaire";
    bouton.textContent = secondaire.libelle;
    // Habillage posé ici et pas dans la feuille de style : celle-ci ne connaît
    // qu'un bouton de diagnostic, plein et accentué. Deux boutons pleins côte à
    // côte donneraient le même poids à « redémarrer » et à « ne rien faire »,
    // et se toucheraient. Trois propriétés suffisent à rendre celui-ci
    // secondaire ; elles ont vocation à rejoindre `.secondaire` dans index.html.
    bouton.style.marginLeft = "0.8rem";
    bouton.style.background = "transparent";
    bouton.style.color = "var(--accent)";
    bouton.addEventListener("click", () => secondaire.onClick(bouton));
    diagnosticElement.append(bouton);
  }
  if (lien) {
    const ancre = document.createElement("a");
    ancre.id = "diagnostic-lien";
    ancre.href = lien.href;
    ancre.textContent = lien.libelle;
    // Nouvel onglet : la sandbox reste ouverte derrière, et rien n'est perdu si
    // le visiteur revient. `noopener` parce que la page ouverte n'a rien à
    // faire de la nôtre.
    ancre.target = "_blank";
    ancre.rel = "noopener noreferrer";
    diagnosticElement.append(ancre);
  }
  diagnosticElement.hidden = false;
  frameElement.hidden = true;
}

/**
 * Passe au rouge les badges restés en attente. Ceux qui sont déjà verts ont
 * bel et bien été franchis : les repeindre effacerait l'information la plus
 * utile, celle de l'étape où le démarrage s'est arrêté.
 */
function marquerBadgesEnEchec() {
  for (const id of BADGE_IDS) {
    const badge = document.getElementById(`badge-${id}`);
    if (badge.classList.contains("pending")) setBadge(id, false);
  }
}

/** Rend la place à l'application : le diagnostic n'a plus lieu d'être. */
function hideDiagnostic() {
  if (!diagnosticElement) return;
  diagnosticElement.replaceChildren();
  diagnosticElement.classList.remove("info");
  diagnosticElement.hidden = true;
  frameElement.hidden = false;
}

/**
 * Étape que la première visite ne peut satisfaire qu'après un rechargement.
 *
 * Le rechargement fait PARTIE du démarrage normal : il ne doit donc rien
 * signaler d'anormal. La promesse rendue ne se résout jamais — la page part,
 * la suite n'a plus lieu d'être — au lieu de lever, ce qui affichait
 * auparavant une « ERREUR FATALE » et passait tous les badges au rouge à
 * chaque première visite sur Firefox et WebKit.
 *
 * Ne sert plus qu'à l'isolation cross-origin. Le contrôle du worker, lui, a sa
 * propre reprise (`ensureControlled`) : son échec est récupérable d'un clic,
 * là où une page servie sans COOP/COEP ne s'isolera jamais par une navigation
 * de plus — cet abandon-là reste donc un échec, et le reste fatal.
 *
 * @param {{ satisfait: boolean, garde: string, attente: string, echec: string }} etape
 * @returns {Promise<void>}
 */
function resumeAfterReload({ satisfait, garde, attente, echec }) {
  const decision = decisionReprise({
    satisfait,
    dejaRecharge: sessionStorage.getItem(garde) !== null,
  });
  if (decision === "poursuivre") return Promise.resolve();
  if (decision === "abandonner") throw new Error(echec);
  sessionStorage.setItem(garde, "1");
  logLine(`${attente} — rechargement…`);
  location.reload();
  return new Promise(() => {}); // la page se recharge, on n'ira pas plus loin
}

// Marge laissée à `clients.claim()` pour parvenir jusqu'à la page.
//
// `navigator.serviceWorker.ready` se résout dès que la registration possède un
// worker actif ; la revendication des clients, elle, se propage juste après,
// par un aller-retour de messages entre le worker et le document. Lire
// `controller` dans la foulée de `ready`, c'est donc parfois lire quelques
// millisecondes trop tôt — et c'est ce qui déclenchait un rechargement à une
// page qui allait être contrôlée de toute façon. Deux secondes : trois ordres
// de grandeur au-dessus du round-trip attendu, marge confortable même sous le
// bridage processeur 8× mesuré par `npm run test:bridage`, et sans commune
// mesure avec le coût de l'alternative (une navigation complète).
const DELAI_CONTROLE_MS = 2_000;

/**
 * Laisse au worker le temps de revendiquer la page, sans jamais l'attendre
 * plus que de raison. Rend la main dès `controllerchange`, et de toute façon
 * au bout du délai — l'appelant relit `controller` et décide.
 * @returns {Promise<void>}
 */
function attendreControle() {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const conclure = () => {
      clearTimeout(minuterie);
      navigator.serviceWorker.removeEventListener("controllerchange", conclure);
      resolve();
    };
    const minuterie = setTimeout(conclure, DELAI_CONTROLE_MS);
    navigator.serviceWorker.addEventListener("controllerchange", conclure);
  });
}

/**
 * Le worker doit piloter la page : sans lui, aucune requête de l'application
 * n'est servie. Au tout premier passage la page n'est pas encore contrôlée, et
 * un rechargement règle ça — il fait partie du démarrage normal.
 *
 * Ce n'est PAS un échec fatal quand il ne suffit pas. Mesuré sur une sandbox
 * publiée le 18/08/2026 : le rechargement automatique était reparti pendant
 * que le worker s'activait encore, la page est revenue non contrôlée, la garde
 * était déjà posée — et la coquille annonçait « ERREUR FATALE » sous quatre
 * badges rouges alors qu'un rechargement de plus, fait à la main, la faisait
 * démarrer normalement. Un prospect ferme l'onglet devant ce mot ; il est en
 * plus faux. La décision (poursuivre, recharger, proposer, renoncer) vit dans
 * shared/prerequis-demarrage.js ; ici, rien que le câblage.
 *
 * @returns {Promise<void>}
 */
async function ensureControlled() {
  await attendreControle();
  const tentatives = compterTentatives(sessionStorage.getItem(GARDE_CONTROLE));
  const plan = repriseControle({
    controle: navigator.serviceWorker.controller !== null,
    tentatives,
  });
  if (plan.suite === "poursuivre") return;

  if (plan.suite === "recharger") {
    rechargerPourControle(tentatives, plan.journal);
    return new Promise(() => {}); // la page part, on n'ira pas plus loin
  }

  // Le diagnostic prend la place de l'application : l'indicateur d'attente
  // n'a plus rien à indiquer et masquerait le bas de l'explication.
  indicateur.fin();
  if (plan.suite === "proposer") {
    // Aucun badge rouge : rien n'est cassé, il manque une navigation.
    setBadges(null);
    showDiagnostic(plan.titre, plan.detail, {
      ton: "info",
      action: {
        libelle: plan.libelleAction,
        onClick(bouton) {
          bouton.disabled = true;
          rechargerPourControle(tentatives, "Rechargement demandé par le visiteur");
        },
      },
    });
  } else {
    logLine(`${plan.titre} — ${plan.detail}`);
    showDiagnostic(plan.titre, plan.detail, { lien: plan.lien });
    marquerBadgesEnEchec();
  }
  // Le démarrage attend désormais un clic, ou s'arrête là. Ne jamais se
  // résoudre est ce qui l'empêche de continuer, sans lever — donc sans
  // repasser par la bannière d'échec fatal.
  return new Promise(() => {});
}

/**
 * Consomme un rechargement du quota et recharge. Le compteur vit dans
 * `sessionStorage` : il est propre à cet onglet et disparaît avec lui, ce qui
 * fait qu'un visiteur revenu plus tard repart avec son quota entier.
 * @param {number} tentatives rechargements déjà consommés
 * @param {string} journal ce qu'on inscrit avant de partir
 */
function rechargerPourControle(tentatives, journal) {
  sessionStorage.setItem(GARDE_CONTROLE, String(tentatives + 1));
  logLine(`${journal} — rechargement…`);
  location.reload();
}

// Le SW ré-injecte COOP/COEP, mais seulement sur les navigations qu'il
// intercepte : celle qui l'a installé, elle, est déjà partie sans. Un
// rechargement de plus suffit sur un hébergeur statique. En local, serve.mjs
// pose les en-têtes et cette étape passe du premier coup.
function ensureCrossOriginIsolated() {
  return resumeAfterReload({
    satisfait: crossOriginIsolated,
    garde: GARDE_ISOLATION,
    attente: "Isolation cross-origin absente : en-têtes COOP/COEP réinjectés par le Service Worker",
    echec:
      "SharedArrayBuffer indisponible : servez la page avec les en-têtes COOP/COEP (voir serve.mjs)",
  });
}

// --- Nom de la sandbox -----------------------------------------------------
//
// Le titre de l'onglet et le titre de la page annonçaient « railsbox » : le
// nom de la MACHINERIE. Le visiteur, lui, arrive pour une application précise,
// qui n'était nommée nulle part — ni dans l'onglet, ni dans l'en-tête, ni dans
// un favori qu'il aurait posé. Avec deux démonstrations ouvertes, ses deux
// onglets portaient le même titre.

/**
 * Nomme la page d'après l'application. Ne lève JAMAIS : un titre manqué ne
 * vaut pas un démarrage manqué, et cette fonction est appelée en plein boot.
 * @param {Record<string, any> | null} config
 */
function appliquerNomSandbox(config) {
  try {
    const nom = nomSandbox(config);
    const titre = document.getElementById("titre-app");
    if (titre) titre.textContent = nom;
    document.title = `${nom} — ${SUFFIXE_TITRE}`;
  } catch (error) {
    logLine(`Nom de la sandbox indéterminé, titre laissé tel quel : ${error.message}`);
  }
}

// --- Bilan de démarrage ----------------------------------------------------

/**
 * Publie le bilan : au journal toujours, dans la page si elle offre un endroit
 * pour ça.
 *
 * Le journal reste la trace ; `#bilan-boot` est ce que le visiteur lit. Il n'a
 * pas à savoir que la sandbox a démarré, il le voit — ce qu'il ignore, et ce
 * qu'il attribue à railsbox par défaut, c'est la part de l'attente qui revient
 * à l'application elle-même.
 */
function publierBilan() {
  const mesures = mesuresDemarrage({ jalons, requetesSql });
  logLine(`Bilan du démarrage — ${mesures.map((m) => `${m.libelle} : ${m.valeur}`).join(" · ")}`);
  const section = document.getElementById("bilan-boot");
  if (!section) return;
  const liste = document.createElement("dl");
  liste.id = "bilan-mesures";
  for (const mesure of mesures) {
    const terme = document.createElement("dt");
    terme.textContent = mesure.libelle;
    const valeur = document.createElement("dd");
    valeur.textContent = mesure.valeur;
    liste.append(terme, valeur);
  }
  // On remplace NOTRE liste, pas le contenu de la section : le titre qu'elle
  // porte peut-être vient de la page, et l'écraser serait s'arroger un balisage
  // qui ne nous appartient pas.
  section.querySelector("#bilan-mesures")?.remove();
  if (!section.querySelector("h2, h3")) {
    const titre = document.createElement("h2");
    titre.textContent = "Bilan du démarrage";
    section.prepend(titre);
  }
  section.append(liste);
  section.hidden = false;
}

// --- Contrôles de la coquille ----------------------------------------------

// Choix du visiteur sur le journal, retenu PAR SANDBOX : deux démonstrations
// publiées sur la même origine partagent `localStorage`, et le pli de l'une
// n'a rien à dire du pli de l'autre. Même raisonnement que le nom du verrou
// d'élection, même clé de découpage.
const CLE_JOURNAL = `railsbox:journal:${SHELL_PATH}`;
const HOTES_MAINTENEUR = new Set(["localhost", "127.0.0.1", "[::1]"]);

const TITRE_REDEMARRAGE = "Redémarrer la sandbox ?";
const DETAIL_REDEMARRAGE =
  "La machine virtuelle n'a pas de bouton « reset » : la redémarrer, c'est recharger cette " +
  "page. Elle repartira de son instantané mémoire déjà téléchargé — quelques dizaines de " +
  "secondes, pas un premier boot. En revanche tout ce qui a été saisi ou créé dans " +
  "l'application depuis le démarrage disparaît : le disque de la VM ne vit qu'en mémoire, et " +
  "cette mémoire part avec la page.";
const LIBELLE_REDEMARRAGE = "Redémarrer maintenant";
const LIBELLE_ANNULER = "Revenir à l'application";

/**
 * Journal déplié par défaut ? Oui chez le mainteneur, non chez le visiteur.
 * C'est un outil de diagnostic : en local, c'est ce qu'on regarde ; sur une
 * sandbox publiée, c'est un tiers d'écran de gris qui défile devant quelqu'un
 * venu voir l'APPLICATION. Le choix explicite du visiteur, lui, prime dans les
 * deux cas.
 * @returns {boolean}
 */
function journalOuvertParDefaut() {
  return HOTES_MAINTENEUR.has(location.hostname);
}

/**
 * `localStorage` LÈVE dans un navigateur qui refuse le stockage (mode privé
 * strict, cookies de tiers bloqués) : une préférence d'affichage ne justifie
 * pas de faire échouer la page.
 * @param {string} cle
 * @returns {string | null}
 */
function lirePreference(cle) {
  try {
    return localStorage.getItem(cle);
  } catch {
    return null;
  }
}

/**
 * @param {string} cle
 * @param {string} valeur
 */
function ecrirePreference(cle, valeur) {
  try {
    localStorage.setItem(cle, valeur);
  } catch {
    // Préférence non retenue : le pli vaudra pour cette visite seulement.
  }
}

/**
 * Porte l'état du journal DEUX FOIS, et c'est voulu.
 *
 * `aria-expanded` est la source de vérité : c'est ce qu'annonce un lecteur
 * d'écran, ce que suit le chevron du bouton, et ce que lisent les règles en
 * `:has()`. La classe sur `<body>` est le jumeau de ces règles pour un moteur
 * sans `:has()` — qui invalide le sélecteur, donc la règle, donc le repli. Le
 * journal resterait déplié sur ce moteur-là sans elle. Ni l'un ni l'autre ne
 * pose `hidden` sur le volet : la feuille lui donne `display: grid`, un
 * attribut `hidden` y serait sans effet visible tout en prétendant le
 * contraire aux technologies d'assistance.
 * @param {HTMLElement} bouton
 * @param {boolean} ouvert
 */
function appliquerEtatJournal(bouton, ouvert) {
  bouton.setAttribute("aria-expanded", String(ouvert));
  document.body.classList.toggle("journal-replie", !ouvert);
}

/**
 * @param {HTMLElement} bouton
 */
function installerJournalRepliable(bouton) {
  const memoire = lirePreference(CLE_JOURNAL);
  let ouvert = memoire === null ? journalOuvertParDefaut() : memoire === "1";
  appliquerEtatJournal(bouton, ouvert);
  bouton.addEventListener("click", () => {
    ouvert = !ouvert;
    appliquerEtatJournal(bouton, ouvert);
    ecrirePreference(CLE_JOURNAL, ouvert ? "1" : "0");
  });
}

/**
 * Plein écran sur le cadre de l'application — jamais sur la page entière : ce
 * qu'on veut agrandir, c'est l'application, pas la coquille qui l'entoure.
 *
 * Le refus est un cas NORMAL, pas une panne : politique de permissions du
 * document, iframe sans autorisation de plein écran, geste non reconnu. Une
 * bannière par-dessus l'application serait une punition disproportionnée ; la
 * ligne de journal suffit, et elle nomme la cause exacte.
 * @param {HTMLElement} bouton
 */
function installerPleinEcran(bouton) {
  bouton.addEventListener("click", () => {
    const demande = frameElement?.requestFullscreen?.bind(frameElement);
    if (!demande) {
      logLine("Plein écran indisponible : ce navigateur n'expose pas l'API Fullscreen.");
      return;
    }
    Promise.resolve(demande()).catch((error) => {
      logLine(`Plein écran refusé par le navigateur : ${error.message}`);
    });
  });
}

/**
 * Ce qu'affichait le panneau de diagnostic, gardé le temps d'une question.
 * @typedef {{ enfants: ChildNode[], info: boolean, cadreMasque: boolean }} PanneauSauve
 */

/**
 * Photographie le panneau en place — les NŒUDS eux-mêmes, donc leurs
 * écouteurs avec : le bouton « reprendre la sandbox » d'un onglet secondaire
 * doit rester cliquable après avoir été rendu.
 * @returns {PanneauSauve | null} `null` si rien n'était affiché
 */
function sauverDiagnostic() {
  if (!diagnosticElement || diagnosticElement.hidden) return null;
  return {
    enfants: [...diagnosticElement.childNodes],
    info: diagnosticElement.classList.contains("info"),
    // `hidden` peut valoir « until-found » et pas seulement un booléen : on
    // ne retient que le fait, qui est tout ce que cette page pose.
    cadreMasque: Boolean(frameElement.hidden),
  };
}

/**
 * Rend la place à ce qui l'occupait — ou à l'application si rien ne l'occupait.
 * @param {PanneauSauve | null} sauvegarde
 */
function restaurerDiagnostic(sauvegarde) {
  if (!sauvegarde || !diagnosticElement) {
    hideDiagnostic();
    return;
  }
  diagnosticElement.replaceChildren(...sauvegarde.enfants);
  diagnosticElement.classList.toggle("info", sauvegarde.info);
  diagnosticElement.hidden = false;
  frameElement.hidden = sauvegarde.cadreMasque;
}

/**
 * Redémarrage. Il n'existe AUCUN chemin propre pour relancer la VM en place :
 * `bootVm` construit un émulateur et l'état de l'invité vit dans la mémoire de
 * cette page. Recharger EST le redémarrage — mais recharger jette aussi tout
 * ce que le visiteur a saisi, et un bouton qui fait ça sans prévenir est un
 * piège. D'où la confirmation, qui dit exactement ce qui va se passer.
 *
 * La confirmation prend la place de l'application, donc parfois la place d'un
 * autre panneau — celui d'un onglet secondaire, celui d'une session expirée où
 * une lecture de disque est justement RETENUE pour ne rien perdre. Renoncer
 * doit alors rendre ce panneau intact, sans quoi le bouton « redémarrer »
 * détruirait par ricochet ce que le panneau protégeait.
 */
function demanderRedemarrage() {
  const precedent = sauverDiagnostic();
  showDiagnostic(TITRE_REDEMARRAGE, DETAIL_REDEMARRAGE, {
    ton: "info",
    action: {
      libelle: LIBELLE_REDEMARRAGE,
      onClick(bouton) {
        bouton.disabled = true;
        logLine("Redémarrage confirmé par le visiteur — rechargement de la page.");
        location.reload();
      },
    },
    secondaire: { libelle: LIBELLE_ANNULER, onClick: () => restaurerDiagnostic(precedent) },
  });
}

/**
 * Câble les contrôles. Appelé AVANT `start()`, et volontairement : replier le
 * journal, passer en plein écran et redémarrer doivent marcher même quand le
 * démarrage, lui, ne marche pas — c'est précisément là qu'on en a besoin.
 *
 * Chaque contrôle est facultatif : la coquille peut être publiée sans, et une
 * page à laquelle il manque un bouton doit démarrer normalement.
 */
function installerControles() {
  const boutonJournal = document.getElementById("btn-journal");
  if (boutonJournal) installerJournalRepliable(boutonJournal);
  const boutonPleinEcran = document.getElementById("btn-plein-ecran");
  if (boutonPleinEcran) installerPleinEcran(boutonPleinEcran);
  const boutonRedemarrer = document.getElementById("btn-redemarrer");
  boutonRedemarrer?.addEventListener("click", () => demanderRedemarrage());
}

installerControles();

start().catch((error) => {
  // Le diagnostic remplace l'application : l'indicateur d'attente n'a plus
  // rien à indiquer et masquerait le bas de l'explication.
  indicateur.fin();
  logLine(`ERREUR FATALE: ${error.message}`);
  showDiagnostic("Le démarrage a échoué", error.message);
  marquerBadgesEnEchec();
});
