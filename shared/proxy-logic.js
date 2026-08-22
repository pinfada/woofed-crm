// Logique pure du Service Worker proxy (sw-proxy.js) : tout ce qui se teste
// sans environnement Service Worker vit ici — réécriture des redirections,
// en-têtes d'isolation, pages d'erreur. Le SW ne garde que le câblage
// événementiel (fetch/message/ports), intestable en dehors du navigateur.

// Frontière du proxy quand la coquille est servie À LA RACINE d'une origine.
// Ce n'est plus toujours le cas : depuis l'ADR 0004, chaque démonstration est
// publiée sur un Pages de projet, donc sous « /<depot>/ ». Les fonctions
// ci-dessous acceptent donc un chemin de base, dont « / » reste le défaut.
export const APP_PREFIX = "/app";

/**
 * Normalise un chemin de base en une forme sans barre oblique finale : « / »
 * devient «  » (chaîne vide), « /depot/ » devient « /depot ». Concaténer
 * ensuite « /app » donne la frontière du proxy dans les deux cas.
 * @param {string} basePath
 * @returns {string}
 */
export function normalizeBasePath(basePath) {
  const trimmed = String(basePath ?? "/").replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Frontière du proxy pour un chemin de base donné.
 * @param {string} [basePath]
 * @returns {string}
 */
export function appPrefix(basePath = "/") {
  return `${normalizeBasePath(basePath)}/app`;
}

// Racine des assets extraits de l'image disque (tools/extract-assets.sh).
// Servis en statique : ils ne traversent jamais le pont série.
export const STATIC_ASSETS_ROOT = "/disks/assets/";

/**
 * Traduit un chemin d'asset applicatif (/app/assets/…) vers son équivalent
 * statique extrait de l'image, ou null si le chemin n'est pas un asset
 * fingerprinté servable statiquement. C'est le levier de performance n°1 :
 * ~90 % du trafic série d'un chargement de page est constitué d'assets
 * immuables que la VM n'a aucune raison de servir elle-même.
 * @param {string} pathname
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {string | null}
 */
export function staticAssetPath(pathname, basePath = "/") {
  const base = normalizeBasePath(basePath);
  const prefix = `${base}/app/assets/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest === "" || rest.includes("..")) return null;
  return `${base}${STATIC_ASSETS_ROOT}${rest}`;
}

// Fichiers statiques que Rails référence EN DUR à la racine, sans préfixe
// (/favicon.ico, /site.webmanifest…) : ils échappaient au proxy et
// produisaient des 404 silencieux. Extraits de l'image vers /disks/appstatic/
// par tools/extract-assets.sh, ils sont servis statiquement — qu'ils soient
// demandés nus ou préfixés /app.
//
// Cette liste n'est PLUS la vérité, seulement le repli. La vérité est
// l'inventaire écrit à l'extraction avec ce que l'image contenait RÉELLEMENT à
// la racine de son `public/` : une allowlist en dur ne pouvait pas connaître
// les chemins racine d'une application tierce, et tout ce qui n'y figurait pas
// faisait 404 en silence. La liste ci-dessous sert encore aux sandboxes
// construites avant l'inventaire.
export const ROOT_STATIC_ROOT = "/disks/appstatic/";
// Nom volontairement improbable : l'application garde le droit d'avoir son
// propre `public/index.json`, qui ne doit pas entrer en collision avec le
// nôtre (tools/extract-assets.sh écarte ce nom de l'extraction).
export const ROOT_STATIC_INDEX = "railsbox-index.json";
export const DEFAULT_ROOT_STATIC_FILES = Object.freeze([
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "site.webmanifest",
  "manifest.json",
  "browserconfig.xml",
  "robots.txt",
]);

// Noms que LA COQUILLE sert à sa propre racine. Ils ne sont jamais résolus
// vers l'extraction, quoi que dise l'index : une application qui embarquerait
// un `public/main.js` prendrait sinon la place du chargeur de la coquille —
// c'est-à-dire du code qui pilote la VM et enregistre le Service Worker.
// C'est le seul point où élargir la résolution racine pouvait faire un dégât,
// et il est fermé ici, en dur, du côté qui nous appartient.
export const SHELL_OWNED_FILES = Object.freeze([
  "index.html",
  "main.js",
  "sw-proxy.js",
  "badge.svg",
  "env-drawer.js",
  "env-drawer.css",
  "types.d.ts",
]);

// Un nom de fichier racine plausible : un seul segment, un point (donc une
// extension), aucun caractère qui puisse construire un autre chemin. Le nom
// est concaténé à /disks/appstatic/ : la traversée est fermée par la forme,
// pas par un nettoyage.
const ROOT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/;

/**
 * Nom de fichier racine visé par une requête, ou null si la requête n'en vise
 * aucun. Accepte les deux écritures — nue (`/favicon.ico`) et préfixée
 * (`/app/favicon.ico`) — parce que Rails produit les deux.
 * @param {string} pathname
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {string | null}
 */
export function rootStaticCandidate(pathname, basePath = "/") {
  const base = normalizeBasePath(basePath);
  const prefix = `${base}/app`;
  let bare;
  if (pathname === `${prefix}` || pathname.startsWith(`${prefix}/`)) {
    bare = pathname.slice(prefix.length + 1);
  } else if (pathname === base || pathname.startsWith(`${base}/`)) {
    bare = pathname.slice(base.length + 1);
  } else {
    return null; // hors du site : ce chemin ne nous appartient pas
  }
  if (!ROOT_FILE_NAME.test(bare)) return null;
  if (bare === "." || bare === ".." || SHELL_OWNED_FILES.includes(bare)) return null;
  return bare;
}

/**
 * Traduit un chemin racine vers son équivalent extrait de l'image, ou null.
 * @param {string} pathname
 * @param {string} [basePath] racine de publication de la coquille
 * @param {readonly string[] | ReadonlySet<string>} [knownFiles] fichiers réellement
 *   extraits (index.json) ; à défaut, la liste de repli
 * @returns {string | null}
 */
export function rootStaticPath(pathname, basePath = "/", knownFiles = DEFAULT_ROOT_STATIC_FILES) {
  const bare = rootStaticCandidate(pathname, basePath);
  if (bare === null) return null;
  const known = knownFiles instanceof Set ? knownFiles.has(bare) : [...knownFiles].includes(bare);
  return known ? `${normalizeBasePath(basePath)}${ROOT_STATIC_ROOT}${bare}` : null;
}

/**
 * Lit l'inventaire des fichiers racine extraits de l'image.
 *
 * FRONTIÈRE : ce document est produit à partir d'une image applicative TIERCE.
 * Chaque nom est revalidé par la même forme que les chemins entrants, et tout
 * ce qui appartient à la coquille est écarté — un index hostile ne peut donc
 * rien viser d'autre que /disks/appstatic/<nom-plausible>.
 * @param {unknown} data document déjà décodé (JSON.parse)
 * @returns {string[]} noms retenus, sans doublon
 */
export function parseRootStaticIndex(data) {
  const listed = /** @type {*} */ (data)?.files;
  const files = Array.isArray(data) ? data : Array.isArray(listed) ? listed : [];
  /** @type {string[]} */
  const names = [];
  for (const entry of files) {
    if (typeof entry !== "string") continue;
    if (!ROOT_FILE_NAME.test(entry)) continue;
    if (SHELL_OWNED_FILES.includes(entry) || names.includes(entry)) continue;
    names.push(entry);
  }
  return names;
}

// --- Frontière de la sandbox ----------------------------------------------
//
// UN SERVICE WORKER N'INTERCEPTE PAS QUE SES PROPRES CLIENTS. On l'a cru, et
// c'est faux : l'algorithme *Handle Fetch* route une requête de NAVIGATION
// (non-subresource) par *Match Service Worker Registration* sur l'URL DE LA
// REQUÊTE, pas via le client qui l'a initiée. Un formulaire posté depuis
// evil.example vers `https://<hôte>/<depot>/app/posts` traverse donc ce
// worker — qui y attacherait le cookie de session du bocal, lequel n'applique
// pas `SameSite`. Le jeton d'authenticité resterait seul en défense, et il ne
// couvre pas les routes en `skip_forgery_protection` / `null_session`,
// fréquentes sur les contrôleurs API des applications non modifiées visées.
//
// LES EN-TÊTES NE SUFFISENT PAS — C'EST MESURÉ, pas supposé. Un relevé complet
// de la `Request` d'une navigation interceptée, sur les trois moteurs, donne :
//
//   signal                | Chromium              | Firefox | WebKit
//   ----------------------|-----------------------|---------|--------
//   en-tête Origin        | navigations non-GET   | jamais  | jamais
//   en-tête Sec-Fetch-*   | jamais                | jamais  | jamais
//   request.mode          | oui                   | oui     | oui
//   request.destination   | oui                   | oui     | oui
//   request.referrer      | oui                   | oui     | oui
//   event.clientId        | vide sur navigation   | vide    | vide
//
// `Sec-Fetch-Site` est ajouté APRÈS l'interception (couche réseau) : un worker
// ne le voit sur aucun moteur. Une défense qui ne repose que sur `Origin` et
// `Sec-Fetch-Site` est donc aveugle sur Firefox et WebKit — elle l'était.
//
// La règle s'appuie sur ce qui EXISTE partout, la forme de la requête :
//
//  1. tout signal d'origine qui contredit la nôtre (`Origin` étranger — y
//     compris l'opaque « null » —, `Sec-Fetch-Site` inter-site, référent
//     étranger) refuse la requête ;
//  2. `destination === "document"` refuse : l'application n'est JAMAIS une
//     navigation de premier niveau, elle ne vit que dans l'iframe que la
//     coquille crée. Un formulaire forgé par un tiers, lui, en est toujours
//     une. C'est le seul signal qui ferme l'attaque classique sur les trois
//     moteurs ;
//  3. une navigation d'iframe qui ÉCRIT (méthode autre que GET/HEAD) doit être
//     attribuable à nous : `Origin` ou référent same-origin. Sans cela, un
//     attaquant qui met notre `/app/` dans SON iframe (ce que `frame-ancestors`
//     empêche seulement de RENDRE — la requête, elle, a déjà écrit) et qui
//     supprime son référent ne laisserait aucun signal sur Firefox.
//
// Ce qui n'est PAS une navigation est hors de cette règle, et c'est un théorème,
// pas une tolérance : une sous-ressource n'est interceptée QUE si son client est
// contrôlé, donc same-origin. Mesuré : un `fetch()` inter-origine vers `/app/*`
// n'atteint le worker sur aucun des trois moteurs.
//
// Refuser jusqu'aux navigations GET inter-site est STRICTEMENT PLUS FORT que
// `SameSite=Lax` (qui les laisserait passer avec leurs cookies) : c'est
// pourquoi le bocal n'a pas besoin d'apparier `SameSite`. Rien de légitime n'y
// est perdu : un lien entrant vers `/app/…` tombe de toute façon sur une VM qui
// n'a pas booté.
const ORIGINES_REFUSEES = new Set(["cross-site", "same-site"]);
// Destinations d'une navigation. `mode === "navigate"` les couvre déjà sur les
// trois moteurs mesurés ; l'ensemble sert de garde pour un moteur qui ne
// renseignerait que l'un des deux.
const DESTINATIONS_NAVIGATION = new Set(["document", "iframe", "frame"]);
// Méthodes sans effet de bord attendu : elles restent admises sans attribution,
// pour ne pas casser une application qui supprimerait son référent.
const METHODES_SURES = new Set(["GET", "HEAD"]);

/**
 * Origine http(s) d'une référence, ou null si elle n'en porte pas. `referrer`
 * vaut « » quand la politique de référent l'a supprimé et « about:client »
 * avant résolution : ni l'un ni l'autre ne dit quoi que ce soit.
 * @param {string | null | undefined} reference
 * @returns {string | null}
 */
function httpOrigin(reference) {
  if (typeof reference !== "string" || reference === "") return null;
  try {
    const url = new URL(reference);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * @param {string | null | undefined} mode
 * @param {string | null | undefined} destination
 * @returns {boolean}
 */
function isNavigation(mode, destination) {
  return mode === "navigate" || DESTINATIONS_NAVIGATION.has(String(destination));
}

/**
 * Motif de refus d'une requête `/app/*`, ou null si elle peut être relayée.
 * @param {{
 *   method?: string | null,
 *   mode?: string | null,
 *   destination?: string | null,
 *   origin?: string | null,
 *   referrer?: string | null,
 *   secFetchSite?: string | null,
 * }} signals forme de la requête (`Request.mode`, `.destination`, `.referrer`)
 *   et en-têtes `Origin` / `Sec-Fetch-Site` (null quand ils sont absents)
 * @param {string} selfOrigin origine du Service Worker
 * @returns {string | null}
 */
export function appRequestRefusal(
  { method, mode, destination, origin, referrer, secFetchSite },
  selfOrigin,
) {
  if (typeof origin === "string" && origin !== "" && origin !== selfOrigin) {
    return `Requête d'origine ${origin} refusée : la sandbox ne relaie que sa propre origine`;
  }
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (ORIGINES_REFUSEES.has(site)) {
    return `Requête inter-site (Sec-Fetch-Site: ${site}) refusée : la sandbox ne relaie que sa propre origine`;
  }
  const referrerOrigin = httpOrigin(referrer);
  if (referrerOrigin !== null && referrerOrigin !== selfOrigin) {
    return `Requête référencée par ${referrerOrigin} refusée : la sandbox ne relaie que sa propre origine`;
  }
  if (!isNavigation(mode, destination)) return null;
  if (destination === "document") {
    return (
      "Navigation de premier niveau refusée : l'application ne s'ouvre que dans " +
      "le cadre de la coquille, jamais directement"
    );
  }
  const attribuee = origin === selfOrigin || referrerOrigin === selfOrigin;
  const sure = METHODES_SURES.has(String(method ?? "GET").toUpperCase());
  if (!sure && !attribuee) {
    return (
      "Écriture sans origine attribuable refusée : une navigation qui écrit doit " +
      "venir de la coquille ou de son iframe"
    );
  }
  return null;
}

/**
 * Le client qui envoie un message au Service Worker est-il le DOCUMENT
 * COQUILLE, seul habilité à fournir le pont vers la VM et l'identité des
 * artefacts ?
 *
 * Sans ce filtre, un XSS dans l'application (iframe same-origin, donc client
 * du worker) pouvait poster son propre `bridge-port` : le worker lui aurait
 * alors livré chaque descripteur de requête, `cookie:` EN CLAIR — les cookies
 * `HttpOnly` compris. Le même filtre ferme l'abus d'`artifact-config`, qui
 * détournerait le cache d'artefacts.
 *
 * LE CRITÈRE EST UNE LISTE D'ADMISSION, PAS UNE LISTE D'EXCLUSION. Il a
 * d'abord été écrit à l'envers : « tout ce qui n'est pas sous /app est la
 * coquille ». Cette formulation donnait le privilège à n'importe quel document
 * same-origin ouvert ailleurs sur l'origine — et RailsBox en sert : les
 * fichiers racine extraits de l'image applicative (tools/extract-assets.sh)
 * sont rendus depuis /disks/appstatic/ sous leur nom nu, `404.html` compris,
 * sans la CSP applicative. Une page HTML TIERCE devenait ainsi une coquille.
 * La coquille est un document que nous publions, à une adresse que nous
 * connaissons : on la nomme, et tout le reste est refusé par défaut.
 *
 * CE QUE ÇA NE FERME PAS. Tant que l'iframe applicative porte
 * `allow-same-origin` (public/index.html), le code qui s'y exécute atteint le
 * document parent et peut poster depuis SON contexte : ce filtre ne survit
 * alors pas à un XSS applicatif, quelle que soit sa précision. Il ferme la
 * porte des documents voisins, pas celle du même realm. Voir
 * docs/decisions/0008-separation-origine-de-l-application.md.
 * @param {string | null | undefined} clientUrl
 * @param {{ origin: string, basePath?: string }} self
 * @returns {boolean}
 */
export function isShellClient(clientUrl, { origin, basePath = "/" }) {
  let url;
  try {
    url = new URL(String(clientUrl));
  } catch {
    return false; // client sans URL exploitable : jamais la coquille
  }
  if (url.origin !== origin) return false;
  const base = normalizeBasePath(basePath);
  return url.pathname === `${base}/` || url.pathname === `${base}/index.html`;
}

// --- Canal de commande privé ----------------------------------------------
//
// LE FILTRE D'URL NE SUFFIT PAS, ET NE PEUT PAS SUFFIRE. `isShellClient` juge
// sur `event.source.url`. Or un XSS applicatif n'est pas contraint d'émettre
// depuis l'iframe : l'iframe porte `allow-same-origin`, donc son script atteint
// `parent.document` et peut y ajouter un `<script src="/app/…">` — même
// origine, donc autorisé par la CSP de la coquille (`script-src 'self'`). Ce
// script s'exécute dans le REALM DE LA COQUILLE, et le message qu'il poste
// porte l'URL de la coquille. Le filtre le laisse alors passer par
// construction.
//
// La parade ne peut donc pas être un critère sur l'émetteur : elle doit être
// une CAPACITÉ que l'attaquant n'a pas. C'est un `MessagePort` privé, créé par
// la coquille avant qu'aucun contenu applicatif n'existe, gardé dans la
// fermeture de son module, et jamais exposé à un objet joignable. Le worker
// n'accepte les commandes que sur ce port ; le canal public ne sert plus qu'à
// l'établir.
//
// Ce que cela ferme : un script injecté dans la coquille ne peut plus poser de
// pont, réécrire la configuration des artefacts, dicter des cookies ni libérer
// des lectures retenues — il ne détient pas le port, et ne peut pas le
// fabriquer.
//
// Ce que cela ne ferme pas : voir
// docs/decisions/0008-separation-origine-de-l-application.md.

/**
 * Établissement du canal. C'est une RÉPONSE, jamais une proposition : le
 * message ne vaut que s'il porte le `nonce` d'une demande que le worker vient
 * d'émettre vers ce client précis.
 *
 * Sans cette contrainte, un worker fraîchement redémarré — le navigateur le tue
 * dès qu'il est inactif — adoptait le premier canal proposé. Un script injecté
 * n'avait qu'à réveiller le worker et parler le premier.
 */
export const MESSAGE_ETABLIR_CANAL = "coquille-canal";

/** Demande du worker à la coquille : « rétablis le canal », avec son nonce. */
export const MESSAGE_CANAL_PERDU = "coquille-canal-request";

/**
 * Demande de la coquille au worker : « ouvre un tour de rétablissement ». Elle
 * ne donne aucun droit — elle déclenche l'émission de nonces vers LES CLIENTS
 * COQUILLE, chacun le sien. Un script injecté peut l'émettre ; il n'y gagne
 * rien, puisqu'il perd le tour qui suit (voir `MESSAGE_CANAL_PERDU`).
 */
export const MESSAGE_CANAL_DEMANDE = "coquille-canal-demande";

/**
 * ACCUSÉ DE RÉCEPTION, posté sur le canal qui vient d'être adopté. Sans lui,
 * une coquille ne savait pas si son canal avait pris : elle ne pouvait ni
 * réessayer, ni relâcher les commandes qu'elle avait mises de côté.
 */
export const MESSAGE_CANAL_OK = "coquille-canal-ok";

/** Refus explicite, pour que la coquille sache qu'il faut redemander. */
export const MESSAGE_CANAL_REFUSE = "coquille-canal-refuse";

/** Durée de vie d'un nonce de rétablissement. */
export const TTL_NONCE_CANAL_MS = 10_000;

/**
 * Une réponse d'établissement est-elle recevable ?
 *
 * Trois conditions, et le nonce est CONSOMMÉ par l'appelant en cas d'accord :
 *  - le nonce correspond à une demande réellement émise ;
 *  - il n'a pas expiré ;
 *  - il revient DU CLIENT à qui il a été adressé.
 *
 * La troisième ne protège pas d'un script injecté — il vit dans le même client
 * que la coquille, et voit donc le même nonce. Ce qui le distingue est
 * ailleurs : la coquille a posé son écouteur à l'évaluation de son module,
 * avant que le moindre code étranger n'existe, et les écouteurs sont appelés
 * dans leur ordre d'inscription. Elle répond donc la première, et le nonce est
 * déjà consommé quand l'intrus répond. Voir docs/decisions/0008.
 * @param {Map<string, { clientId: string | null, at: number }>} demandes
 * @param {{ nonce: unknown, clientId: string | null, maintenant: number }} reponse
 * @returns {{ accepte: boolean, raison: string }}
 */
export function verifierReponseCanal(demandes, { nonce, clientId, maintenant }) {
  if (typeof nonce !== "string" || nonce === "") {
    return { accepte: false, raison: "canal proposé sans nonce : le worker n'a rien demandé" };
  }
  const demande = demandes.get(nonce);
  if (!demande) {
    return { accepte: false, raison: "nonce inconnu ou déjà consommé" };
  }
  if (maintenant - demande.at > TTL_NONCE_CANAL_MS) {
    return { accepte: false, raison: "nonce expiré" };
  }
  if (demande.clientId !== clientId) {
    return { accepte: false, raison: "nonce revenu d'un autre client que son destinataire" };
  }
  return { accepte: true, raison: "" };
}

/**
 * Retire les nonces périmés. Une coquille qui ne répond jamais ferait sinon
 * enfler la table indéfiniment.
 * @param {Map<string, { clientId: string | null, at: number }>} demandes
 * @param {number} maintenant
 */
export function purgerDemandesCanal(demandes, maintenant) {
  for (const [nonce, demande] of demandes) {
    if (maintenant - demande.at > TTL_NONCE_CANAL_MS) demandes.delete(nonce);
  }
}

// Commandes qui ne sont recevables QUE sur le canal privé. La liste est
// ouverte par CONSTRUCTION : tout message ajouté ici devient inaccessible au
// canal public, sans qu'aucun appelant n'ait à y penser.
const COMMANDES_PRIVILEGIEES = new Set([
  "artifact-config",
  "bridge-port",
  "cookies-document",
  "session-restauree",
]);

/**
 * Ce type de message commande-t-il le proxy ?
 * @param {unknown} type
 * @returns {boolean}
 */
export function estCommandePrivilegiee(type) {
  return typeof type === "string" && COMMANDES_PRIVILEGIEES.has(type);
}

// Codes pour lesquels le constructeur Response interdit un corps.
export const BODYLESS_STATUS = new Set([101, 204, 205, 304]);

/**
 * Corps à passer au constructeur Response : null pour les statuts sans corps.
 * (Type volontairement lib-agnostique : ce module est aussi vérifié sous la
 * config Node, où BodyInit n'existe pas.)
 * @param {number} status
 * @param {ArrayBuffer | string | null | undefined} body
 */
export function responseBodyFor(status, body) {
  return BODYLESS_STATUS.has(status) ? null : (body ?? null);
}

/**
 * Sécurisation des redirections : la cible doit rester un chemin relatif
 * sous /app, donc réintercepté par le proxy. Deux cas à ramener :
 *  - chemin absolu sans préfixe (« /users/sign_in ») ;
 *  - URL absolue « https://localhost:8080/… » que Rails génère à cause du
 *    X-Forwarded-Proto ; la suivre telle quelle ferait tenter au navigateur
 *    une connexion TLS vers un port qui n'écoute qu'en clair.
 * Les redirections externes sont laissées intactes.
 * @param {string} location
 * @param {{ origin: string, host: string }} self - origine/hôte de la page
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {string}
 */
export function rewriteLocation(location, self, basePath = "/") {
  let target;
  try {
    target = new URL(location, self.origin);
  } catch {
    return location; // en-tête inexploitable : laissé intact
  }
  const isSelf =
    target.host === self.host || target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (!isSelf) return location; // redirection externe : ne pas y toucher
  const prefix = appPrefix(basePath);
  const path =
    target.pathname.startsWith(`${prefix}/`) || target.pathname === prefix
      ? target.pathname
      : `${prefix}${target.pathname}`;
  return `${path}${target.search}${target.hash}`;
}

// CSP des documents applicatifs proxifiés : l'iframe est same-origin (il le
// faut — cookies + interception SW), donc un XSS dans l'application aurait
// sinon accès au VRAI réseau du navigateur pour exfiltrer. connect-src 'self'
// coupe fetch/XHR/beacon vers des tiers ; form-action 'self' bloque l'envoi
// de formulaires vers l'extérieur ; script-src reste souple ('unsafe-inline' :
// importmap et les inline-scripts Rails en dépendent) ; img-src large (fonds
// de carte type OSM) — canal résiduel assumé, documenté dans SECURITY.md.
const APP_DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

/**
 * Prépare les en-têtes d'une réponse proxifiée : réécrit Location, pose les
 * en-têtes exigés par l'isolation cross-origin (sous COEP:require-corp, un
 * document imbriqué doit lui-même les porter, et ses sous-ressources un CORP
 * explicite) et applique la CSP applicative à TOUT document HTML.
 *
 * La CSP est ajoutée, jamais substituée : une politique déjà posée par
 * l'application est conservée, et les deux s'appliquent alors CONJOINTEMENT
 * (le CSP niveau 3 intersecte les politiques multiples, qu'elles arrivent en
 * plusieurs en-têtes ou en une liste séparée par des virgules). L'ancienne
 * pose conditionnelle laissait au contraire une application équipée d'une CSP
 * permissive désactiver la nôtre — alors que SECURITY.md la présentait comme
 * inconditionnelle.
 * @param {Array<[string, string]> | undefined} rawHeaders
 * @param {{ origin: string, host: string }} self
 * @param {string} [basePath] racine de publication de la coquille
 * @returns {Headers}
 */
export function prepareProxyHeaders(rawHeaders, self, basePath = "/") {
  const headers = new Headers(rawHeaders ?? []);
  const location = headers.get("location");
  if (location) {
    headers.set("location", rewriteLocation(location, self, basePath));
  }
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  relaxFramingHeaders(headers);
  const isHtml = (headers.get("content-type") ?? "").includes("text/html");
  if (isHtml) {
    headers.append("Content-Security-Policy", APP_DOCUMENT_CSP);
  }
  return headers;
}

/**
 * Lève l'interdiction d'affichage en cadre posée par l'application.
 *
 * railsbox IMPOSE l'iframe : c'est ainsi que la sandbox montre l'application.
 * Or `X-Frame-Options: DENY` et `frame-ancestors 'none'` sont des durcissements
 * recommandés, présents dans quantité d'applications Rails en production — la
 * nôtre de démonstration ne les a simplement jamais eus. Une application non
 * modifiée qui les porte s'affichait donc en « refus de connexion », sans que
 * rien dans le journal ne le dise : le boot réussit, la requête répond 200, et
 * le navigateur refuse en silence de peindre le cadre.
 *
 * La protection n'est pas supprimée, elle est RAMENÉE AU BON NIVEAU : notre
 * propre CSP applique `frame-ancestors 'self'` à tout document proxifié, si
 * bien qu'un site tiers ne peut toujours pas encadrer l'application. On retire
 * donc l'en-tête hérité (que le CSP niveau 3 rendrait de toute façon
 * prioritaire) et l'on détend la seule directive `frame-ancestors` des
 * politiques de l'application, sans toucher au reste de ces politiques.
 *
 * Le faire ICI plutôt que par un initialiseur déposé dans l'arbre applicatif
 * couvre aussi ce qu'aucune configuration Rails ne trahit : un en-tête posé
 * par un middleware Rack, une gem, ou un reverse-proxy embarqué.
 * @param {Headers} headers en-têtes de la réponse de la VM, modifiés en place
 */
function relaxFramingHeaders(headers) {
  headers.delete("x-frame-options");
  for (const nom of ["content-security-policy", "content-security-policy-report-only"]) {
    const politique = headers.get(nom);
    if (politique === null) continue;
    const detendue = relaxFrameAncestors(politique);
    if (detendue === null) headers.delete(nom);
    else headers.set(nom, detendue);
  }
}

/**
 * Remplace la valeur de `frame-ancestors` par `'self'` dans une politique,
 * en laissant les autres directives intactes.
 *
 * Les politiques multiples s'INTERSECTENT (CSP niveau 3) : laisser passer un
 * `frame-ancestors 'none'` de l'application annulerait le `'self'` que nous
 * ajoutons, quel que soit l'ordre. La directive est donc réécrite là où elle
 * est déclarée, plutôt que contredite ailleurs.
 * @param {string} politique valeur d'un en-tête Content-Security-Policy
 * @returns {string | null} politique réécrite, ou null si elle devient vide
 */
export function relaxFrameAncestors(politique) {
  const directives = String(politique)
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "")
    .map((directive) =>
      /^frame-ancestors(\s|$)/i.test(directive) ? "frame-ancestors 'self'" : directive,
    );
  return directives.length === 0 ? null : directives.join("; ");
}

/**
 * Le message peut contenir du contenu dérivé des réponses de la VM (donc de
 * l'application, donc potentiellement d'un tiers) : il doit être échappé
 * avant toute interpolation dans du HTML.
 * @param {unknown} text
 */
export function escapeHtml(text) {
  /** @type {Record<string, string>} */
  const remplacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  // `?? character` n'est pas une précaution décorative : sans lui, un caractère
  // hors table produirait « undefined » DANS le HTML.
  return String(text).replace(/[&<>"']/g, (character) => remplacements[character] ?? character);
}

/**
 * Page d'erreur autonome du proxy (statut coercé, message échappé).
 * @param {number} status
 * @param {string} message
 */
export function errorPage(status, message) {
  return `<!doctype html><meta charset="utf-8">
<body style="font-family:system-ui;background:#101418;color:#dce3ea;padding:2rem">
<h1 style="color:#ff6b6b">${Number(status)}</h1><p>${escapeHtml(message)}</p></body>`;
}
