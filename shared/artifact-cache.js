// Décision de mise en cache des ARTEFACTS IMMUABLES (chantier C, critère C3).
//
// Le problème : GitHub Pages plafonne ses réponses à `Cache-Control:
// max-age=600`, sans moyen de le configurer. Or nos artefacts sont immuables
// par construction — une base publiée n'est jamais réécrite, une correction
// produit une nouvelle version (ADR 0004), et les fichiers-parties sont des
// tranches figées d'un disque figé (ADR 0003). Un visiteur qui revient le
// lendemain retélécharge donc les ~48 Mo de morceaux qu'il avait déjà lus,
// alors que rien n'a changé.
//
// La réponse : un cache applicatif (Cache Storage) tenu par le Service
// Worker, en stratégie « cache d'abord ». Ce module en porte la LOGIQUE PURE
// — quelles URL sont cacheables, sous quel nom de cache, quels caches sont
// périmés — pour qu'elle soit testable sans navigateur. Le câblage (Cache
// Storage, quota, événements fetch) vit dans sw-proxy.js.
//
// Deux invariants gouvernent tout ce qui suit :
//
//  1. ON NE CACHE QUE CE QUI EST NOMMÉ DANS LA CONFIGURATION V86. Pas
//     d'heuristique sur l'URL seule : le disque, le disque applicatif,
//     l'instantané, le noyau et l'initrd de la configuration courante, et rien
//     d'autre.
//  2. LE NOM DU CACHE PORTE L'IDENTITÉ DE LA CONSTRUCTION. Il dérive de la
//     configuration entière (dont `builtAt`), et tout changement bascule sur
//     un cache neuf en abandonnant l'ancien.
//
//     Cette règle est née d'une URL de disque applicatif STABLE d'une
//     construction à l'autre, qu'un cache indexé par la seule URL aurait
//     panachée. Ce n'est plus le cas : depuis l'ADR 0007, le disque applicatif
//     et l'instantané portent l'empreinte de leur contenu, et une URL ne
//     désigne plus jamais deux contenus. La règle est conservée quand même —
//     elle est la seule à protéger les sandboxes publiées AVANT le
//     versionnement, dont les artefacts gardent des noms stables. Son coût
//     assumé : `builtAt` changeant à chaque construction, une reconstruction
//     à contenu identique repart d'un cache applicatif vierge — alors que les
//     URL, elles, n'ont pas bougé et restent servies par les caches HTTP. La
//     retirer de l'identité est désormais envisageable ; c'est une décision
//     distincte, à prendre quand plus aucune sandbox d'avant l'ADR 0007 ne
//     sera en ligne.

/** Préfixe commun à tous les caches d'artefacts gérés par ce module. */
export const CACHE_PREFIX = "railsbox-artefacts";

/**
 * Version du FORMAT de cache, indépendante de la version des artefacts. Elle
 * ne change que si la façon d'y écrire change ; les caches d'un autre format
 * sont supprimés à l'activation du Service Worker.
 */
export const CACHE_FORMAT = "v1";

/**
 * Sépare une URL d'artefact en base et extension, selon la convention de v86
 * (`AsyncXHRPartfileBuffer`), reproduite à l'identique par
 * `tools/build-v86-image/artifact-parts.mjs` : la dernière extension, suivie
 * du `.zst` optionnel qui marque la compression.
 *
 * Seule divergence avec v86, volontaire : l'extension ne peut pas enjamber une
 * barre oblique. Sur une URL absolue sans extension — un initrd servi par un
 * domaine en « .io », par exemple — la règle de v86 attraperait tout ce qui
 * suit le point du nom de domaine ; ici elle ne trouve rien, ce qui est le
 * résultat souhaité.
 * @param {string} url
 * @returns {{ base: string, extension: string }}
 */
export function splitArtifactName(url) {
  const text = String(url);
  const match = text.match(/\.[^./]+(\.zst)?$/);
  const extension = match ? match[0] : "";
  return { base: text.slice(0, text.length - extension.length), extension };
}

// Suffixe de fichier-partie : « -<début>-<fin> » avant l'extension.
const PART_SUFFIX = /-(\d+)-(\d+)$/;

/**
 * URL de l'artefact complet dont une URL est un fichier-partie, ou null si
 * l'URL n'a pas la forme d'un fichier-partie.
 *
 *   /disks/demo-app-4194304-8388608.ext2.zst → /disks/demo-app.ext2.zst
 *
 * C'est l'inverse exact de `partName()` côté construction : les deux
 * conventions sont vérifiées l'une contre l'autre par les tests.
 * @param {string} url
 * @returns {string | null}
 */
export function artifactUrlOfPart(url) {
  const { base, extension } = splitArtifactName(url);
  if (extension === "") return null;
  const suffix = base.match(PART_SUFFIX);
  if (!suffix) return null;
  return `${base.slice(0, base.length - suffix[0].length)}${extension}`;
}

/**
 * Pré-filtre SYNCHRONE, appliqué avant même de savoir si une configuration
 * est connue : l'URL a-t-elle la forme d'un artefact immuable ?
 *
 * Il existe parce que `fetch` d'un Service Worker exige de décider tout de
 * suite si l'on répond ou non — sans attendre quoi que ce soit d'asynchrone.
 * Il est délibérément permissif : la vérification qui fait foi est
 * {@link isCacheableArtifactUrl}, et tout ce qu'il laisse passer à tort
 * repart en `fetch` réseau inchangé.
 * @param {string} url
 * @returns {boolean}
 */
export function looksLikeImmutableArtifact(url) {
  return artifactUrlOfPart(url) !== null || /-(vmlinuz|initrd)$/.test(String(url));
}

/**
 * Une requête est éligible au cache si elle est un GET SANS en-tête Range.
 *
 * v86 lit les fichiers-parties par requêtes complètes (un GET nu par morceau,
 * aucun en-tête ajouté — d'où l'absence de préflight CORS, point de vigilance
 * de l'ADR 0001). Il ne recourt aux requêtes Range que pour un disque servi
 * d'un seul tenant, et la réponse est alors un 206 partiel que Cache Storage
 * REFUSE de stocker. Ces requêtes-là sont donc laissées au navigateur.
 * @param {{ method?: string, rangeHeader?: string | null }} shape
 * @returns {boolean}
 */
export function isCacheableRequestShape({ method, rangeHeader }) {
  return method === "GET" && (rangeHeader === null || rangeHeader === undefined);
}

/**
 * Une réponse mérite-t-elle d'être ÉCRITE dans le cache d'artefacts ?
 *
 * Trois refus, pour trois raisons distinctes :
 *
 *  - `status !== 200` : un 206 partiel est de toute façon refusé par Cache
 *    Storage, et une erreur n'a rien à faire dans un cache d'immuables.
 *  - `type === "opaque"` : le corps en est illisible, donc invérifiable.
 *  - `redirected` : LA réponse empoisonnée. `fetch` suit les redirections par
 *    défaut ; un portail captif, une page d'erreur d'hébergeur servie en 200
 *    ou une bascule de domaine rend alors un 200 lisible dont le corps est du
 *    HTML. L'écrire sous l'URL du morceau de disque, dans un cache « d'abord »
 *    sans revalidation, casse la sandbox jusqu'à ce que la CONFIGURATION
 *    change — le nom du cache dérivant d'elle, aucun rechargement de page ni
 *    `?fresh=1` ne la sauve. Un artefact immuable se sert à son URL exacte :
 *    tout détour est le signe qu'on ne parle plus au bon interlocuteur.
 *
 * Le champ `redirected` peut manquer (contextes de test, moteurs anciens) :
 * son absence ne vaut pas redirection, sans quoi plus rien ne serait caché.
 * @param {{ status?: number, type?: string, redirected?: boolean }} response
 * @returns {boolean}
 */
export function estArtefactCacheable({ status, type, redirected }) {
  return status === 200 && type !== "opaque" && redirected !== true;
}

/**
 * Inventaire des artefacts immuables décrits par une configuration v86,
 * en URL absolues résolues contre la racine de publication.
 *
 * Les disques ne sont retenus QUE s'ils sont découpés en fichiers-parties
 * (`diskChunkSize` / `appDiskChunkSize`, ADR 0003) : un disque d'un seul
 * tenant est lu par requêtes Range, hors du périmètre de ce cache.
 *
 * L'INSTANTANÉ, lui, est retenu SANS CONDITION, et c'est volontaire. Il est
 * découpé depuis 2026-08-17 (même ADR), mais la configuration ne le dit pas :
 * c'est la présence de son inventaire `-parts.json` qui tranche, côté coquille,
 * pour que les sandboxes déjà publiées continuent de fonctionner sans être
 * reconstruites. Le retenir ici est sans risque — un instantané d'un seul
 * tenant n'engendre aucune URL de la forme « fichier-partie », donc aucune
 * requête ne peut correspondre — et cela évite d'ajouter à la configuration un
 * champ qui pourrait diverger de la réalité des fichiers publiés.
 * @param {Record<string, any> | null | undefined} config
 * @param {string} baseHref racine de publication (portée du Service Worker)
 * @returns {{ kernel: string | null, initrd: string | null, disks: string[], state: string | null }}
 */
export function immutableArtifacts(config, baseHref) {
  /** @param {unknown} value */
  const absolute = (value) => {
    if (!value) return null;
    try {
      return new URL(String(value), baseHref).href;
    } catch {
      return null;
    }
  };
  const disks = [
    config?.diskChunkSize ? absolute(config.disk) : null,
    config?.appDiskChunkSize ? absolute(config.appDisk) : null,
  ];
  return {
    kernel: absolute(config?.kernel),
    initrd: absolute(config?.initrd),
    disks: /** @type {string[]} */ (disks.filter((url) => url !== null)),
    state: absolute(config?.state),
  };
}

/**
 * Une URL désigne-t-elle un artefact immuable de la configuration courante ?
 * C'est la vérification qui fait foi : elle n'accepte que le noyau, l'initrd,
 * et les morceaux des disques et de l'instantané effectivement déclarés.
 * @param {string} url URL absolue
 * @param {ReturnType<typeof immutableArtifacts> | null | undefined} artifacts
 * @returns {boolean}
 */
export function isCacheableArtifactUrl(url, artifacts) {
  if (!artifacts) return false;
  const href = String(url);
  if (href === artifacts.kernel || href === artifacts.initrd) return true;
  const parent = artifactUrlOfPart(href);
  if (parent === null) return false;
  return parent === artifacts.state || artifacts.disks.includes(parent);
}

// Champs de la configuration qui identifient une construction. Tout ce qui
// change la moindre de ces valeurs doit repartir d'un cache vierge.
const IDENTITY_FIELDS = [
  "name",
  "baseName",
  "builtAt",
  "disk",
  "diskSize",
  "diskChunkSize",
  "appDisk",
  "appDiskSize",
  "appDiskChunkSize",
  "kernel",
  "initrd",
  // L'instantané est mis en cache morceau par morceau au même titre que les
  // disques : son identité doit donc entrer dans celle du cache.
  "state",
];

/**
 * Empreinte textuelle d'une configuration : ce qui identifie la construction
 * dont les artefacts sont mis en cache. Null si la configuration ne décrit
 * aucun disque, donc rien à mettre en cache.
 * @param {Record<string, any> | null | undefined} config
 * @returns {string | null}
 */
export function artifactSignature(config) {
  if (!config || !config.disk) return null;
  return IDENTITY_FIELDS.map((field) => {
    const value = config[field];
    return value === undefined || value === null ? "" : String(value);
  }).join("|");
}

/**
 * Hachage FNV-1a 32 bits, en hexadécimal sur huit caractères.
 *
 * Aucune propriété cryptographique n'est requise ici : il ne s'agit que de
 * dériver un nom de cache stable et court d'une empreinte, sans passer par
 * `crypto.subtle` (asynchrone) ni allonger le nom de toutes les URL.
 * @param {string} text
 * @returns {string}
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // Multiplication par 16777619 en arithmétique 32 bits non signée.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Rend un fragment de nom lisible en DevTools : minuscules, sans séparateur
 * exotique, borné en longueur.
 * @param {unknown} value
 * @returns {string}
 */
function slug(value) {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text === "" ? "sandbox" : text.slice(0, 32);
}

/**
 * Nom du cache d'artefacts pour une configuration donnée, ou null s'il n'y a
 * rien à mettre en cache. Deux constructions différentes produisent deux noms
 * différents : c'est ce qui garantit qu'une reconstruction n'hérite jamais des
 * morceaux de la précédente.
 * @param {Record<string, any> | null | undefined} config
 * @returns {string | null}
 */
export function cacheNameFor(config) {
  const signature = artifactSignature(config);
  if (signature === null) return null;
  return `${CACHE_PREFIX}-${CACHE_FORMAT}-${slug(config?.name)}-${fnv1a(signature)}`;
}

/**
 * Caches d'artefacts à supprimer une fois `currentName` en service : tous
 * ceux du même préfixe qui ne sont pas celui-là. Les caches étrangers au
 * module (instantanés, caches d'une autre application) ne sont jamais touchés.
 * @param {readonly string[]} names
 * @param {string} currentName
 * @returns {string[]}
 */
export function obsoleteCacheNames(names, currentName) {
  return names.filter((name) => name.startsWith(`${CACHE_PREFIX}-`) && name !== currentName);
}

/**
 * Caches écrits par une version antérieure du FORMAT : supprimables à
 * l'activation, avant même de connaître la configuration courante.
 * @param {readonly string[]} names
 * @returns {string[]}
 */
export function staleFormatCacheNames(names) {
  return names.filter(
    (name) =>
      name.startsWith(`${CACHE_PREFIX}-`) && !name.startsWith(`${CACHE_PREFIX}-${CACHE_FORMAT}-`),
  );
}
