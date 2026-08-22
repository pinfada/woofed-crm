// Bocal à cookies du proxy : le magasin que le navigateur refuse de tenir.
//
// LE DÉFAUT QU'IL CORRIGE. Un Service Worker ne peut pas faire poser un cookie
// par le navigateur : `Set-Cookie` est un en-tête de réponse INTERDIT, filtré
// silencieusement par le constructeur `Response`, et une réponse synthétisée
// n'alimente jamais le magasin de cookies. Le cookie de session de Rails — qui
// porte la graine du jeton CSRF — n'atteignait donc jamais le client, aucun
// en-tête `Cookie:` ne repartait vers la VM, et TOUT POST se soldait par un
// 422 « ActionController::InvalidAuthenticityToken ». Mesuré sur la
// démonstration publiée : `document.cookie` vide côté hôte comme côté iframe.
//
// LE REMÈDE. Le proxy tient le magasin lui-même : les `Set-Cookie` des
// réponses de la VM sont retirés de la réponse rendue au document et rangés
// ici ; chaque requête relayée repart avec l'en-tête `Cookie:` que ce magasin
// sérialise. Le trajet complet reste à l'intérieur du Service Worker.
//
// CE QUE ÇA CHANGE POUR L'ISOLATION, EXACTEMENT. `document.cookie` reste
// vide : un script de l'application ne peut pas lire la session par le chemin
// habituel, et un `HttpOnly` posé par Rails ne lui est pas rendu. Ce n'est PAS
// « hors de portée de tout script » pour autant, et l'affirmation contraire a
// figuré ici : l'iframe est same-origin, donc un XSS dans l'application peut
// ouvrir l'IndexedDB `railsbox-cookies` de l'origine, exactement comme il peut
// lire le localStorage de l'inspecteur (déjà documenté dans SECURITY.md). Le
// gain est réel mais borné, et il tient à deux gardes qui vivent ailleurs :
// le filtre du document coquille sur les messages du worker (proxy-logic.js,
// `isShellClient`) et le refus des requêtes inter-origine (`appRequestRefusal`).
//
// PÉRIMÈTRE VOLONTAIREMENT RÉDUIT (ADR 0004 : un visiteur = sa VM = ses
// cookies, aucun partage possible par construction) :
//  - `Domain` est conservé pour le diagnostic mais PAS apparié : il n'y a
//    qu'un seul hôte de part et d'autre du pont, et refuser un cookie sur un
//    domaine mal deviné par l'application casserait sa session sans rien
//    protéger ;
//  - `Secure` et `SameSite` sont conservés, pas appliqués : le « transport »
//    est un MessagePort interne à l'onglet, pas un réseau. `SameSite` n'a plus
//    d'objet depuis que le Service Worker REFUSE toute requête `/app/*` dont
//    l'initiateur est inter-site (`appRequestRefusal`) : ce refus est
//    strictement plus fort que `SameSite=Lax`, qui laisserait encore passer
//    une navigation GET inter-site avec ses cookies ;
//  - `Path`, `Expires`, `Max-Age` et `HttpOnly`, eux, sont pleinement
//    honorés : ce sont ceux dont dépend le comportement de l'application
//    (déconnexion = `Max-Age=0`, cookies de scope, expiration de session).
//
// Logique PURE : aucune E/S, aucune horloge implicite (`now` est injecté).
// Le câblage — IndexedDB, MessagePort — reste dans sw-proxy.js.

// Garde-fous : une application qui déraille ne doit pas faire enfler le
// magasin indéfiniment ni produire un en-tête que le guest refusera.
const MAX_COOKIES = 200;
const MAX_COOKIE_VALUE_LENGTH = 4096;
// Borne de l'en-tête `Cookie:` SÉRIALISÉ, alignée sur celle que la frontière
// d'entrée du guest applique (sanitizeCookieHeader, request-codec.js). La
// dépasser ne coûtait pas un cookie mais TOUS : l'en-tête entier était
// abandonné, et le visiteur perdait sa session — le 422 que ce module existe
// pour supprimer. On évince donc AVANT d'en arriver là.
export const MAX_COOKIE_HEADER_LENGTH = 8192;
// Caractères interdits dans un nom ou une valeur de cookie : CR, LF et NUL
// (injection en-tête), plus « ; » qui forgerait un second cookie. Comparaison
// par code de caractère : aucune séquence échappée dans une expression
// régulière, donc aucune ambiguïté de lecture.
const CODES_INTERDITS = new Set([0, 10, 13, 59]);

/**
 * Un nom ou une valeur peut-il franchir la frontière du guest ?
 *
 * Au-delà des caractères d'injection, tout codepoint > U+00FF est refusé : le
 * pont côté guest passe les en-têtes à `http.client`, qui les encode en
 * latin-1 et lève `UnicodeEncodeError` au-delà. L'exception y est convertie en
 * erreur de pont, donc en 502 — et comme le cookie fautif reste dans le bocal
 * (et dans IndexedDB), le 502 revient à CHAQUE requête, y compris après un
 * redémarrage du worker.
 * @param {string} texte
 * @returns {boolean}
 */
function contientInterdit(texte) {
  for (let index = 0; index < texte.length; index += 1) {
    const code = texte.charCodeAt(index);
    if (CODES_INTERDITS.has(code) || code > 0xff) return true;
  }
  return false;
}

/**
 * Contrôles d'un cookie déjà analysé, rejoués tels quels sur ce qui remonte de
 * la persistance : un enregistrement empoisonné dans IndexedDB (que rien
 * n'empêche un XSS de l'application d'y écrire) doit être refusé au même titre
 * qu'un `Set-Cookie` malformé.
 * @param {any} cookie
 * @returns {boolean}
 */
export function isTransmissibleCookie(cookie) {
  if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") return false;
  if (typeof cookie.path !== "string" || !cookie.path.startsWith("/")) return false;
  if (cookie.name === "" || contientInterdit(cookie.name) || contientInterdit(cookie.value)) {
    return false;
  }
  if (cookie.name.length + cookie.value.length > MAX_COOKIE_VALUE_LENGTH) return false;
  return cookie.expiresAt === null || Number.isFinite(cookie.expiresAt);
}

/**
 * Chemin par défaut d'un cookie sans attribut `Path` (RFC 6265 §5.1.4) :
 * le répertoire de la requête, jamais le fichier lui-même.
 * @param {string} requestPath chemin de la requête, sans chaîne de recherche
 * @returns {string}
 */
export function defaultPath(requestPath) {
  const path = typeof requestPath === "string" ? requestPath : "";
  if (!path.startsWith("/")) return "/";
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === 0 ? "/" : path.slice(0, lastSlash);
}

/**
 * Appariement de chemin (RFC 6265 §5.1.4) : un cookie de `/app` part avec
 * `/app` et `/app/posts`, jamais avec `/application`.
 * @param {string} cookiePath
 * @param {string} requestPath
 * @returns {boolean}
 */
export function pathMatches(cookiePath, requestPath) {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath[cookiePath.length] === "/";
}

/**
 * Date d'expiration absolue d'un cookie, en millisecondes epoch.
 * `Max-Age` prime sur `Expires` (RFC 6265 §5.2.2). `null` = cookie de session,
 * qui vit tant que le magasin vit.
 * @param {{ maxAge?: string, expires?: string }} attributs
 * @param {number} now
 * @returns {number | null}
 */
function expiryFrom({ maxAge, expires }, now) {
  if (maxAge !== undefined) {
    const seconds = Number.parseInt(maxAge, 10);
    if (!Number.isFinite(seconds)) return null;
    // Max-Age négatif ou nul : suppression immédiate — c'est ainsi que Rails
    // efface un cookie de session à la déconnexion.
    return now + seconds * 1000;
  }
  if (expires !== undefined) {
    const parsed = Date.parse(expires);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Analyse UNE valeur d'en-tête `Set-Cookie`.
 * @param {string} raw
 * @param {{ requestPath?: string, now?: number }} [contexte]
 * @returns {{
 *   name: string, value: string, path: string, domain: string | null,
 *   secure: boolean, httpOnly: boolean, sameSite: string | null,
 *   expiresAt: number | null,
 * } | null} null si la valeur est inexploitable
 */
export function parseSetCookie(raw, { requestPath = "/", now = Date.now() } = {}) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parts = raw.split(";");
  const pair = parts[0];
  const separator = pair.indexOf("=");
  if (separator <= 0) return null; // « ; HttpOnly » seul, ou nom vide
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name === "" || contientInterdit(name) || contientInterdit(value)) {
    return null;
  }
  if (name.length + value.length > MAX_COOKIE_VALUE_LENGTH) return null;

  const attributs = {};
  let path = null;
  let domain = null;
  let secure = false;
  let httpOnly = false;
  let sameSite = null;
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    const attribute = (equals < 0 ? part : part.slice(0, equals)).trim().toLowerCase();
    const attributeValue = equals < 0 ? "" : part.slice(equals + 1).trim();
    switch (attribute) {
      case "path":
        path = attributeValue.startsWith("/") ? attributeValue : null;
        break;
      case "domain":
        domain = attributeValue === "" ? null : attributeValue.replace(/^\./, "").toLowerCase();
        break;
      case "expires":
        attributs.expires = attributeValue;
        break;
      case "max-age":
        attributs.maxAge = attributeValue;
        break;
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "samesite":
        sameSite = attributeValue.toLowerCase() || null;
        break;
      default:
        break; // attribut inconnu : ignoré, comme le fait un navigateur
    }
  }

  return {
    name,
    value,
    path: path ?? defaultPath(requestPath),
    domain,
    secure,
    httpOnly,
    sameSite,
    expiresAt: expiryFrom(attributs, now),
  };
}

/**
 * Sépare les `Set-Cookie` du reste des en-têtes d'une réponse. Le proxy range
 * les premiers dans le magasin et ne rend QUE les seconds au document : un
 * `Set-Cookie` rendu serait de toute façon filtré par le constructeur
 * `Response`, et le retirer explicitement rend le contrat lisible.
 * @param {Array<[string, string]> | undefined | null} headers
 * @returns {{ setCookies: string[], headers: Array<[string, string]> }}
 */
export function extractSetCookie(headers) {
  /** @type {string[]} */
  const setCookies = [];
  /** @type {Array<[string, string]>} */
  const reste = [];
  for (const [name, value] of headers ?? []) {
    if (String(name).toLowerCase() === "set-cookie") {
      setCookies.push(String(value));
    } else {
      reste.push([String(name), String(value)]);
    }
  }
  return { setCookies, headers: reste };
}

/**
 * Sérialise une liste de cookies en valeur d'en-tête `Cookie:`.
 * @param {Array<{ name: string, value: string }>} cookies
 * @returns {string}
 */
export function serializeCookies(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * Analyse une valeur de `document.cookie` rapportée par un client.
 *
 * POURQUOI CE DÉTOUR. Un Service Worker n'a pas de DOM : `document.cookie` lui
 * est inaccessible, et le navigateur ne lui montre pas davantage l'en-tête
 * `Cookie` des requêtes qu'il intercepte. Seul un CLIENT peut lire ces
 * cookies-là et les lui rapporter — d'où ce format d'entrée, qui est exactement
 * la chaîne que le navigateur expose au document, valeurs comprises telles
 * qu'elles repartiraient dans un en-tête `Cookie:`.
 *
 * AUCUN CHEMIN N'Y FIGURE, et il n'en manque pas : le navigateur ne montre à un
 * document que les cookies dont le chemin apparie DÉJÀ celui du document. Le
 * seul rapporteur autorisé étant la coquille (servie à la racine de
 * publication), tout ce qu'elle voit apparie par construction « <base>/app/… » ;
 * leur prêter « / » ne les élargit donc pas. Le revers est réel et assumé : un
 * cookie posé par l'application SANS `path` explicite prend « <base>/app » pour
 * chemin, reste invisible de la coquille, et n'est donc pas récupéré — la même
 * limite exactement que celle du Cookie Store API, dont la portée est celle de
 * l'enregistrement du worker.
 * @param {unknown} raw valeur brute de `document.cookie`, telle qu'un client la
 *   rapporte — donc de type non garanti, comme tout ce qui vient d'un message
 * @returns {Array<{ name: string, value: string, path: string }>}
 */
export function parseDocumentCookie(raw) {
  if (typeof raw !== "string" || raw === "") return [];
  const cookies = [];
  for (const paire of raw.split(";")) {
    const separateur = paire.indexOf("=");
    // « = » en position 0 ou absent : cookie à nom vide, que le navigateur
    // rend comme sa seule valeur. Sans nom, rien à réémettre.
    if (separateur <= 0) continue;
    const name = paire.slice(0, separateur).trim();
    const value = paire.slice(separateur + 1).trim();
    if (name === "") continue;
    cookies.push({ name, value, path: "/" });
  }
  return cookies;
}

/**
 * Complète l'en-tête du bocal avec les VRAIS cookies du navigateur qu'il ne
 * connaît pas.
 *
 * LE DÉFAUT CORRIGÉ. Le bocal n'apprend que par `Set-Cookie`. Or l'iframe est
 * same-origin : `document.cookie = "timezone=…"` — fuseau horaire, locale,
 * bandeau de consentement, js-cookie — crée un cookie du navigateur dont
 * aucune réponse de la VM n'a parlé. Comme le proxy retire par ailleurs tout
 * `Cookie:` venu du navigateur, ces cookies-là avaient cessé d'atteindre le
 * serveur : régression silencieuse sur un motif courant des applications Rails
 * non modifiées.
 *
 * LE BOCAL RESTE AUTORITAIRE : un nom qu'il porte déjà n'est jamais doublé ni
 * remplacé (c'est lui qui tient la session et les `HttpOnly`). On n'ajoute que
 * ce qui manque, et seulement dans la limite de l'en-tête acceptable.
 * @param {string | null} header en-tête produit par le bocal
 * @param {Array<{ name?: string, value?: string, path?: string }> | null | undefined} browserCookies
 * @param {string} requestPath chemin de la requête (sans chaîne de recherche)
 * @returns {string | null}
 */
export function mergeBrowserCookies(header, browserCookies, requestPath) {
  const connus = new Set(
    (header ?? "")
      .split("; ")
      .map((paire) => paire.slice(0, paire.indexOf("=")))
      .filter((nom) => nom !== ""),
  );
  let fusion = header ?? "";
  for (const brut of browserCookies ?? []) {
    const cookie = {
      name: String(brut?.name ?? ""),
      value: String(brut?.value ?? ""),
      path: typeof brut?.path === "string" && brut.path.startsWith("/") ? brut.path : "/",
      expiresAt: null,
    };
    if (connus.has(cookie.name) || !isTransmissibleCookie(cookie)) continue;
    if (!pathMatches(cookie.path, requestPath)) continue;
    const candidat =
      fusion === ""
        ? `${cookie.name}=${cookie.value}`
        : `${fusion}; ${cookie.name}=${cookie.value}`;
    if (candidat.length > MAX_COOKIE_HEADER_LENGTH) break;
    connus.add(cookie.name);
    fusion = candidat;
  }
  return fusion === "" ? null : fusion;
}

/**
 * Magasin de cookies d'un visiteur. Clé d'unicité : nom + chemin (le domaine
 * n'entre pas en compte, cf. en-tête de fichier).
 *
 * @param {{ now?: () => number }} [options] `now` injectable pour les tests
 */
export function createCookieJar({ now = () => Date.now() } = {}) {
  /** @type {Map<string, any>} */
  const cookies = new Map();
  // Rang de création : départage deux cookies de même longueur de chemin dans
  // l'en-tête `Cookie:` (RFC 6265 §5.4.2), y compris posés dans la même
  // milliseconde — ce qui arrive à chaque réponse de Rails.
  let sequence = 0;
  // Rang de DERNIER USAGE, compteur distinct : c'est lui qui désigne la
  // victime d'une éviction. L'ancienneté de création était un critère
  // désastreux ici — le cookie de session de Rails est le premier créé et
  // conserve son rang à chaque réémission (RFC 6265 §5.3 étape 11), donc une
  // application qui pose beaucoup de cookies évinçait AVANT TOUT la session,
  // c'est-à-dire exactement ce qu'il fallait garder.
  let usage = 0;

  /** @param {{ name: string, path: string }} cookie */
  const keyOf = (cookie) => `${cookie.name} ${cookie.path}`;

  /** Retire les cookies expirés ; renvoie true si le magasin a changé. */
  function prune() {
    const instant = now();
    let changed = false;
    for (const [key, cookie] of cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= instant) {
        cookies.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Range un cookie déjà analysé. Un cookie expiré SUPPRIME son homonyme :
   * c'est le mécanisme d'effacement du web (`Max-Age=0`).
   * @param {any} cookie
   * @returns {boolean} true si le magasin a changé
   */
  function store(cookie) {
    const key = keyOf(cookie);
    if (cookie.expiresAt !== null && cookie.expiresAt <= now()) {
      return cookies.delete(key);
    }
    const previous = cookies.get(key);
    if (
      previous &&
      previous.value === cookie.value &&
      previous.expiresAt === cookie.expiresAt &&
      previous.httpOnly === cookie.httpOnly
    ) {
      return false; // réémission à l'identique : rien à persister
    }
    // Un cookie réécrit conserve son rang de création (RFC 6265 §5.3 étape 11)
    // — mais son rang d'usage, lui, repart à neuf : il vient de servir.
    cookies.set(key, {
      ...cookie,
      sequence: previous ? previous.sequence : sequence++,
      usage: usage++,
    });
    evict(key);
    return true;
  }

  /**
   * Ramène le magasin sous ses deux bornes — nombre d'entrées ET longueur de
   * l'en-tête sérialisé — en sacrifiant les cookies les moins récemment
   * utilisés. La borne de longueur est celle de la frontière du guest : la
   * franchir faisait abandonner l'en-tête ENTIER, donc perdre la session.
   *
   * À usage ÉGAL — le cas courant, puisqu'une même requête emporte d'un coup
   * tous les cookies de chemin `/` — la victime est le plus RÉCEMMENT créé.
   * Départager par ancienneté de création ferait retomber dans le défaut
   * qu'on corrige : le cookie de session de Rails est le premier créé et
   * conserve son rang à chaque réémission, il serait de nouveau sacrifié le
   * premier. Une inondation est faite de nouveaux venus ; c'est elle qui paie.
   * @param {string} protege clé à ne jamais évincer (celle qu'on vient de ranger)
   */
  function evict(protege) {
    const trop = () =>
      cookies.size > MAX_COOKIES ||
      serializeCookies([...cookies.values()]).length > MAX_COOKIE_HEADER_LENGTH;
    while (trop()) {
      const victime = [...cookies.entries()]
        .filter(([key]) => key !== protege)
        .sort((a, b) => a[1].usage - b[1].usage || b[1].sequence - a[1].sequence)[0];
      if (!victime) return; // seul le cookie protégé subsiste : rien à faire
      cookies.delete(victime[0]);
    }
  }

  return {
    /**
     * Range les `Set-Cookie` d'une réponse de la VM.
     * @param {string[]} setCookies valeurs brutes
     * @param {string} requestPath chemin de la requête (sans recherche)
     * @returns {boolean} true si le magasin a changé (donc s'il faut persister)
     */
    ingest(setCookies, requestPath) {
      let changed = false;
      for (const raw of setCookies ?? []) {
        const cookie = parseSetCookie(raw, { requestPath, now: now() });
        if (cookie === null || !isTransmissibleCookie(cookie)) continue;
        changed = store(cookie) || changed;
      }
      return changed;
    },

    /**
     * En-tête `Cookie:` à injecter dans une requête, ou null s'il n'y a rien à
     * envoyer. Ordre RFC 6265 §5.4.2 : chemin le plus spécifique d'abord, puis
     * ordre de création.
     * @param {string} requestPath chemin de la requête (sans recherche)
     * @returns {string | null}
     */
    headerFor(requestPath) {
      prune();
      const applicables = [...cookies.values()]
        .filter((cookie) => pathMatches(cookie.path, requestPath))
        .sort((a, b) => b.path.length - a.path.length || a.sequence - b.sequence);
      // Marquage d'usage : un cookie qui repart avec une requête vient de
      // servir, et ne doit donc pas être la prochaine victime d'une éviction.
      // UN SEUL rang pour toute la fournée — les distinguer reviendrait à les
      // classer par l'ordre de la RFC, donc à redésigner la session (premier
      // cookie de l'en-tête) comme la moins récemment utilisée. L'ORDRE de
      // l'en-tête, lui, reste celui de la RFC 6265 §5.4.2 : les deux critères
      // sont indépendants, c'est tout l'intérêt de compteurs distincts.
      const rangUsage = usage++;
      for (const cookie of applicables) cookie.usage = rangUsage;
      return applicables.length === 0 ? null : serializeCookies(applicables);
    },

    /**
     * État sérialisable (structured clone) pour la persistance, expirés purgés.
     * @returns {any[]}
     */
    snapshot() {
      prune();
      return [...cookies.values()].map((cookie) => ({ ...cookie }));
    },

    /**
     * Recharge un état persisté. Remplace le contenu courant : appelé une
     * seule fois, au réveil du Service Worker.
     * @param {any[]} saved
     */
    load(saved) {
      cookies.clear();
      sequence = 0;
      usage = 0;
      for (const cookie of saved ?? []) {
        // LES MÊMES CONTRÔLES QU'À L'INGESTION, rejoués : IndexedDB n'est pas
        // un canal de confiance. Il vit dans l'origine, qu'un XSS de
        // l'application partage — une entrée forgée y réinjecterait un « ; »
        // (donc un cookie supplémentaire à la sérialisation) ou un codepoint
        // hors latin-1, qui fait échouer le pont côté guest en 502 PERSISTANT,
        // rejoué à chaque réveil du worker.
        if (!isTransmissibleCookie(cookie)) continue;
        // Le rang de création est conservé s'il a été persisté : c'est lui qui
        // fixe l'ordre de l'en-tête `Cookie:`, et un magasin rechargé doit
        // produire exactement le même que le magasin d'origine.
        const rang = Number.isFinite(cookie.sequence) ? cookie.sequence : sequence;
        sequence = Math.max(sequence, rang + 1);
        const dernierUsage = Number.isFinite(cookie.usage) ? cookie.usage : rang;
        usage = Math.max(usage, dernierUsage + 1);
        cookies.set(keyOf(cookie), { ...cookie, sequence: rang, usage: dernierUsage });
      }
      prune();
      evict(""); // une persistance gonflée ne doit pas ressusciter hors bornes
    },

    clear() {
      cookies.clear();
    },

    get size() {
      return cookies.size;
    },
  };
}
