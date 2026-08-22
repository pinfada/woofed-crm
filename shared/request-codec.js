// Validation des requêtes HTTP traversant la frontière navigateur → VM.
// Partagé par le Service Worker (qui intercepte les requêtes de l'iframe) et
// par le codec série (qui les transmet au guest). Tout ce qui vient de
// l'application passe par ici : méthodes en liste blanche, chemins filtrés,
// en-têtes hop-by-hop retirés.

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_PATH_LENGTH = 2048;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8192;
const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;
const HOST_PATTERN = /^[a-zA-Z0-9.\-:[\]]+$/;

// En-têtes hop-by-hop, ou recalculés par curl / le constructeur Response.
//
// Deux ajouts qui ne sont pas hop-by-hop et méritent leur justification :
//
//  - « cookie » : le magasin de référence de l'application est celui du proxy
//    (shared/cookie-jar.js), injecté par le canal dédié de buildRequestFrames —
//    lequel y a d'abord fusionné les vrais cookies du navigateur que le bocal
//    ne connaît pas (posés en JavaScript par l'application). Filtrer ici
//    garantit qu'un `Cookie:` fabriqué ailleurs ne puisse pas doubler ni
//    supplanter ce canal : une seule voie d'entrée, contrôlée.
//
//  - « origin » : Rails compare `request.origin` à `request.base_url`
//    (forgery_protection_origin_check). Le guest ne peut PAS connaître
//    l'origine publique de façon fiable — schéma forcé à https pour les
//    applications en force_ssl, port de développement, sous-répertoire de
//    publication — et le moindre écart produit un 422 opaque sur une
//    application NON MODIFIÉE. On retire donc l'en-tête : Rails traite
//    `origin` nul comme valide (RFC : un client peut légitimement ne pas
//    l'envoyer), et la protection CSRF reste entièrement assurée par le jeton
//    de session, que le bocal à cookies fait de nouveau circuler.
//
//    ATTENTION — CE RETRAIT NE SE SUFFIT PAS À LUI-MÊME. On a cru ici qu'un
//    Service Worker « n'intercepte que les requêtes de ses propres clients
//    same-origin ». C'EST FAUX : dans l'algorithme *Handle Fetch*, une requête
//    de NAVIGATION est routée par *Match Service Worker Registration* sur
//    l'URL de la requête, sans considération du client initiateur. Un
//    formulaire posté depuis un site tiers vers `<origine>/…/app/…` traverse
//    donc bel et bien le worker. La vérification manquante a été portée là où
//    l'origine publique est connue — le Service Worker lui-même, qui REFUSE
//    en 403 toute requête `/app/*` dont l'initiateur n'est pas notre origine
//    (`appRequestRefusal`, shared/proxy-logic.js). Retirer l'en-tête reste
//    correct côté guest ; contrôler, c'est le rôle du worker.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "expect",
  "cookie",
  "origin",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "content-length",
]);

/** @param {unknown} value */
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** @param {unknown} method */
export function sanitizeMethod(method) {
  const upper = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(upper)) {
    throw new Error(`Méthode HTTP refusée: ${upper.slice(0, 20)}`);
  }
  return upper;
}

/** @param {unknown} rawPath */
export function sanitizeAppPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/")) {
    throw new Error("Chemin invalide (doit commencer par /)");
  }
  if (rawPath.length > MAX_PATH_LENGTH) {
    throw new Error("Chemin trop long");
  }
  // Un pathname+search issu de `new URL()` est déjà percent-encodé : espaces,
  // quotes, backslashes et caractères de contrôle n'ont rien à y faire.
  // eslint-disable-next-line no-control-regex -- filtrer les caractères de contrôle est le but
  if (/[\s'"\\`$\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new Error("Caractères interdits dans le chemin");
  }
  return rawPath;
}

/** @param {unknown} host */
export function sanitizeForwardHost(host) {
  if (typeof host !== "string" || host.length === 0) return null;
  return HOST_PATTERN.test(host) ? host : null;
}

/**
 * Valide l'en-tête `Cookie:` que le bocal du proxy veut injecter. Il ne vient
 * pas du navigateur mais d'un magasin alimenté par les réponses de la VM,
 * c'est-à-dire par du contenu applicatif : il traverse donc la frontière au
 * même titre que le reste. Contrôle par code de caractère — tout caractère de
 * contrôle (CR, LF, NUL) ou DEL disqualifie l'en-tête entier.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function sanitizeCookieHeader(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_HEADER_VALUE_LENGTH) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // Au-delà de U+00FF, le pont côté guest (`http.client`, encodage latin-1)
    // lève `UnicodeEncodeError` : le contrôle appartient donc bien à cette
    // frontière, pas au guest, qui n'a que le 502 pour l'exprimer.
    if (code < 0x20 || code === 0x7f || code > 0xff) return null;
  }
  return value;
}

/**
 * @param {Iterable<[unknown, unknown]> | null | undefined} entries
 * @returns {Array<[string, string]>}
 */
export function filterRequestHeaders(entries) {
  /** @type {Array<[string, string]>} */
  const kept = [];
  for (const [name, value] of entries ?? []) {
    const lowerName = String(name).toLowerCase();
    const stringValue = String(value);
    if (STRIPPED_REQUEST_HEADERS.has(lowerName)) continue;
    if (!HEADER_NAME_PATTERN.test(lowerName)) continue;
    if (stringValue.length > MAX_HEADER_VALUE_LENGTH) continue;
    // eslint-disable-next-line no-control-regex -- CRLF/NUL dans un en-tête = injection
    if (/[\r\n\u0000]/.test(stringValue)) continue;
    kept.push([lowerName, stringValue]);
    if (kept.length >= MAX_HEADER_COUNT) break;
  }
  return kept;
}

// Chemins (vus depuis la VM) des fichiers d'échange d'une requête donnée.
/** @param {unknown} headText */
export function parseCurlHeaders(headText) {
  const blocks = String(headText)
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length === 0) {
    throw new Error("Réponse HTTP vide (le serveur a-t-il répondu ?)");
  }
  // Plusieurs blocs possibles (ex: 100 Continue) : seul le dernier compte.
  const lines = blocks[blocks.length - 1].split(/\r?\n/);
  const statusMatch = lines[0].match(/^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/);
  if (!statusMatch) {
    throw new Error(`Ligne de statut illisible: ${lines[0].slice(0, 80)}`);
  }
  const headers = [];
  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    headers.push([name, line.slice(separatorIndex + 1).trim()]);
  }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers,
  };
}
