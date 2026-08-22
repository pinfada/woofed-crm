// Instantané mémoire servi en FICHIERS-PARTIES (ADR 0003, extension de 2026-08-17).
//
// POURQUOI L'INSTANTANÉ A REJOINT LES DISQUES. Les disques sont découpés depuis
// l'ADR 0003 parce que v86 sait lire des morceaux tout seul (`use_parts`).
// L'instantané, lui, n'est lu par personne d'autre que NOUS : la coquille le
// télécharge d'un bloc et le passe à v86 en ArrayBuffer. Il était donc resté
// d'un seul tenant — et la limite de 95 Mo par fichier de GitHub Pages
// (ADR 0001) était devenue, sans que rien ne le dise, un plafond de mémoire
// utilisable. Une application un peu lourde (PostgreSQL + Rails + back-office)
// produit 118 Mo d'instantané gzippé et la construction échouait à la dernière
// minute. Le découpage lève ce plafond.
//
// CE MODULE PORTE LE TÉLÉCHARGEMENT ET LE RÉASSEMBLAGE DE L'INSTANTANÉ, et
// rien de l'émulateur. `loadSnapshot` reçoit son `fetch` en paramètre : les
// deux chemins — morceaux et fichier d'un seul tenant — sont donc exécutés pour
// de vrai par `npm test`, corps gzippés compris, sans navigateur ni VM. Le
// reste est de la logique pure : dérivation des noms, validation de
// l'inventaire, choix du chemin, réassemblage en mémoire.
//
// TROIS CONTRAINTES GOUVERNENT CE QUI SUIT.
//
//  1. AUCUN EN-TÊTE, AUCUN RANGE. Les morceaux sont lus par des GET nus : le
//     dépôt d'artefacts est un Pages cross-origin qui répond 405 aux préflights
//     (ADR 0001). Chaque appel est un `fetch(url)` sans second argument, et
//     tests/artefacts-requetes-simples.test.mjs le verrouille.
//  2. UNE SEULE COPIE EN MÉMOIRE. L'instantané décompressé pèse plusieurs
//     centaines de mégaoctets, et la page en garde déjà un exemplaire pour v86.
//     L'assembleur alloue donc le tampon final UNE fois, à la taille annoncée
//     par l'inventaire, et y écrit chaque morceau à sa place. Rien n'est
//     concaténé, rien n'est recopié à la fin.
//  3. COMPATIBILITÉ ASCENDANTE. Les sandboxes déjà publiées portent un
//     instantané d'un seul tenant et AUCUN inventaire. L'absence d'inventaire
//     est donc le signal de repli, pas une erreur.

import { splitArtifactName } from "./artifact-cache.js";

/** Suffixes de compression qu'un nom d'artefact peut porter. */
const COMPRESSION_SUFFIX = /\.(gz|zst)$/;

/**
 * Compressions que la COQUILLE sait défaire. `DecompressionStream` couvre gzip
 * sur les trois moteurs depuis 2023 ; le zstd n'existe que sur un seul, et
 * c'est pourquoi les morceaux d'instantané sont gzippés là où ceux des disques
 * — décompressés par v86 lui-même — restent en zstd.
 */
const COMPRESSIONS_SUPPORTEES = new Set([null, "gzip"]);

/**
 * URL de l'inventaire d'un artefact découpé.
 *
 * L'inventaire est nommé d'après le fichier NON compressé, exactement comme le
 * fait `tools/build-v86-image/split-artifact.mjs` à l'écriture :
 *
 *   disks/demo-split-state.bin.gz → disks/demo-split-state.bin-parts.json
 *
 * @param {string} artifactUrl
 * @returns {string}
 */
export function manifestUrlFor(artifactUrl) {
  return `${String(artifactUrl).replace(COMPRESSION_SUFFIX, "")}-parts.json`;
}

/**
 * Nom du fichier-partie contenant un offset donné.
 *
 * Reproduit à l'identique la convention de v86 (`AsyncXHRPartfileBuffer`), celle
 * qu'écrit `partName()` côté construction : la naming n'est PAS relue de
 * l'inventaire, elle est redérivée ici. L'inventaire ne sert qu'aux trois
 * nombres qu'on ne peut pas deviner — taille totale, taille de morceau,
 * compression. Un inventaire qui mentirait sur les noms ne pourrait donc pas
 * faire télécharger autre chose que les morceaux de CET artefact.
 *
 * L'égalité des deux implémentations est vérifiée par les tests.
 * @param {string} artifactUrl URL de l'artefact complet (suffixe de compression compris)
 * @param {number} start offset de début, multiple de `chunkBytes`
 * @param {number} chunkBytes taille de morceau
 * @returns {string}
 */
export function partNameFor(artifactUrl, start, chunkBytes) {
  const { base, extension } = splitArtifactName(artifactUrl);
  // v86 insère le séparateur lui-même, sauf si la base est déjà un répertoire.
  const separateur = base.endsWith("/") ? "" : "-";
  return `${base}${separateur}${start}-${start + chunkBytes}${extension}`;
}

/**
 * @typedef {{
 *   url: string,
 *   totalBytes: number,
 *   chunkBytes: number,
 *   compression: "gzip" | null,
 *   parts: string[],
 * }} PlanInstantane
 */

/**
 * Analyse et VALIDE l'inventaire d'un instantané découpé.
 *
 * Rend `null` — donc « retombe sur le fichier unique » — dès que quoi que ce
 * soit cloche : JSON illisible, tailles absurdes, compression qu'on ne sait pas
 * défaire, inventaire qui décrit un autre artefact. Le repli est toujours sûr
 * (le fichier d'un seul tenant est peut-être publié), tandis qu'un plan bancal
 * produirait un instantané corrompu, donc une VM qui échoue à la restauration
 * très loin de la cause.
 * @param {string} text corps de `<artefact>-parts.json`
 * @param {string} artifactUrl URL de l'instantané complet
 * @returns {PlanInstantane | null}
 */
export function parseSnapshotManifest(text, artifactUrl) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (manifest === null || typeof manifest !== "object") return null;

  const { totalBytes, chunkBytes } = manifest;
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) return null;
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) return null;

  const compression = manifest.compression ?? null;
  if (!COMPRESSIONS_SUPPORTEES.has(compression)) return null;

  // L'inventaire doit parler du fichier qu'on s'apprête à lire : un `-parts.json`
  // laissé par une construction précédente, ou copié d'un autre artefact, ferait
  // sinon assembler des morceaux qui n'existent pas.
  if (typeof manifest.artifact === "string" && manifest.artifact !== "") {
    if (basename(manifest.artifact) !== basename(artifactUrl)) return null;
  }

  const parts = [];
  for (let start = 0; start < totalBytes; start += chunkBytes) {
    parts.push(partNameFor(artifactUrl, start, chunkBytes));
  }
  // Recoupement avec le compte publié : deux façons de dériver le même nombre,
  // et un désaccord signale un inventaire incohérent.
  if (Number.isInteger(manifest.partCount) && manifest.partCount !== parts.length) return null;

  return { url: String(artifactUrl), totalBytes, chunkBytes, compression, parts };
}

/**
 * @param {string} url
 * @returns {string}
 */
function basename(url) {
  const text = String(url);
  return text.slice(text.lastIndexOf("/") + 1);
}

/**
 * Chemin de téléchargement à emprunter pour un instantané.
 *
 * `manifestText` vaut `null` quand l'inventaire est absent — le cas de TOUTES
 * les sandboxes publiées avant le découpage, dont la démonstration de référence.
 * C'est le seul discriminant : rien dans la configuration n'a besoin de changer,
 * et une sandbox ancienne continue de se charger sans le savoir.
 * @param {string} artifactUrl URL de l'instantané déclarée par la configuration
 * @param {string | null} manifestText corps de l'inventaire, ou null s'il est absent
 * @returns {{ mode: "parts", plan: PlanInstantane } | { mode: "whole", url: string }}
 */
export function chooseSnapshotSource(artifactUrl, manifestText) {
  const plan = manifestText === null ? null : parseSnapshotManifest(manifestText, artifactUrl);
  return plan === null ? { mode: "whole", url: String(artifactUrl) } : { mode: "parts", plan };
}

/**
 * Assembleur d'instantané : UN tampon, alloué une fois à la taille finale, que
 * chaque morceau vient remplir à sa place.
 *
 * C'est le point qui décide de la mémoire de l'onglet. L'alternative évidente —
 * empiler les morceaux puis les concaténer — ferait exister deux fois
 * l'instantané complet au moment de la concaténation, soit plusieurs centaines
 * de mégaoctets de plus, sur un chemin où la page en garde déjà une copie pour
 * v86. Le seul dépassement ici est le morceau en cours.
 *
 * Le DERNIER morceau est complété de zéros à la publication (v86 lit toujours
 * un morceau entier, voir artifact-parts.mjs) : on n'en recopie que les octets
 * utiles, sans quoi l'instantané serait plus gros que ce que v86 attend.
 * @param {PlanInstantane} plan
 */
export function createSnapshotAssembler(plan) {
  const target = new Uint8Array(plan.totalBytes);
  let offset = 0;
  let index = 0;

  return {
    /** Nombre de morceaux déjà intégrés. */
    get received() {
      return index;
    },
    /**
     * Intègre un morceau DÉCOMPRESSÉ, dans l'ordre du plan.
     * @param {Uint8Array} bytes
     */
    push(bytes) {
      if (index >= plan.parts.length) {
        throw new Error(`morceau surnuméraire (${plan.parts.length} attendus)`);
      }
      const useful = Math.min(plan.chunkBytes, plan.totalBytes - offset);
      if (bytes.length < useful) {
        throw new Error(
          `morceau ${index} tronqué : ${bytes.length} octets pour ${useful} attendus`,
        );
      }
      target.set(bytes.subarray(0, useful), offset);
      offset += useful;
      index += 1;
    },
    /**
     * Rend l'instantané complet. Refuse de rendre un tampon partiel : un
     * instantané amputé se restaurerait en apparence, puis planterait la VM.
     * @returns {ArrayBuffer}
     */
    finish() {
      if (index !== plan.parts.length || offset !== plan.totalBytes) {
        throw new Error(
          `instantané incomplet : ${index}/${plan.parts.length} morceaux, ` +
            `${offset}/${plan.totalBytes} octets`,
        );
      }
      return target.buffer;
    },
  };
}

// --- Transport --------------------------------------------------------------

/**
 * Un instantané découpé se lit en dizaines de requêtes consécutives, et GitHub
 * Pages finit par répondre 503 sur une rafale (mesuré au douzième morceau sur
 * 363 depuis un runner, voir tools/build-v86-image/assemble-artifact.mjs). Ce
 * n'est pas une erreur de fond mais du bridage : on réessaie en espaçant,
 * plutôt que de retomber en boot à froid — treize minutes — pour un morceau
 * manqué.
 */
const PART_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;
/** Une ligne de journal tous les N morceaux : de la progression, pas du bruit. */
const LOG_EVERY = 10;

/**
 * Télécharge l'instantané pré-calculé, quel que soit son format.
 *
 * L'appelant n'a rien à savoir du découpage : c'est la présence de l'inventaire
 * qui tranche, et son absence ramène au fichier d'un seul tenant — le format de
 * toutes les sandboxes publiées avant 2026-08-17.
 * @param {{
 *   url: string,
 *   onLog?: (line: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   fetch?: typeof globalThis.fetch,
 * }} options `fetch` et `sleep` sont injectables pour les tests ; le défaut est
 *   celui du navigateur.
 * @returns {Promise<ArrayBuffer>}
 */
export async function loadSnapshot({
  url,
  onLog = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetch = globalThis.fetch,
}) {
  const source = chooseSnapshotSource(url, await fetchManifestText(url, fetch));
  if (source.mode === "whole") {
    onLog(`[v86] téléchargement de l'instantané pré-calculé (${source.url})…`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readSnapshotBody(response, source.url);
  }
  return downloadParts(source.plan, { onLog, sleep, fetch });
}

/**
 * Corps de l'inventaire d'un instantané découpé, ou `null` s'il n'y en a pas.
 *
 * Son absence n'est PAS une anomalie : c'est le cas de toute sandbox publiée
 * avant le découpage de l'instantané, dont la démonstration de référence. Toute
 * défaillance — 404, réseau coupé, corps illisible — revient donc au même
 * verdict, et l'appelant repart sur le fichier d'un seul tenant.
 * @param {string} stateUrl
 * @param {typeof globalThis.fetch} fetch
 * @returns {Promise<string | null>}
 */
async function fetchManifestText(stateUrl, fetch) {
  try {
    const response = await fetch(manifestUrlFor(stateUrl));
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/**
 * Télécharge les morceaux et les réassemble.
 *
 * Séquentiel à dessein : chaque morceau est intégré au tampon final dès qu'il
 * arrive, puis oublié. Télécharger en parallèle ferait coexister autant de
 * morceaux décompressés que de requêtes en vol, sur un chemin où la mémoire est
 * la ressource rare — et n'accélérerait rien face à un hébergeur qui bride
 * précisément les rafales.
 * @param {PlanInstantane} plan
 * @param {{ onLog: (line: string) => void, sleep: (ms: number) => Promise<void>,
 *   fetch: typeof globalThis.fetch }} deps
 * @returns {Promise<ArrayBuffer>}
 */
async function downloadParts(plan, { onLog, sleep, fetch }) {
  if (plan.compression === "gzip" && typeof DecompressionStream === "undefined") {
    throw new Error("ce navigateur ne sait pas décompresser du gzip (DecompressionStream absent)");
  }
  onLog(
    `[v86] téléchargement de l'instantané pré-calculé en ${plan.parts.length} morceaux ` +
      `(${Math.round(plan.totalBytes / 1024 / 1024)} Mo une fois réassemblé)…`,
  );
  const assembler = createSnapshotAssembler(plan);
  for (const url of plan.parts) {
    const response = await fetchPart(url, { sleep, fetch });
    assembler.push(new Uint8Array(await readSnapshotBody(response, url)));
    if (assembler.received % LOG_EVERY === 0) {
      onLog(`[v86] morceau ${assembler.received}/${plan.parts.length}`);
    }
  }
  return assembler.finish();
}

/**
 * Récupère un morceau, en réessayant sur les réponses qui trahissent du bridage
 * (5xx, 429) mais jamais sur un 4xx, qui ne changera pas d'avis.
 * @param {string} url
 * @param {{ sleep: (ms: number) => Promise<void>, fetch: typeof globalThis.fetch }} deps
 * @returns {Promise<Response>}
 */
async function fetchPart(url, { sleep, fetch }) {
  /** @type {Error | null} */
  let derniere = null;
  for (let essai = 0; essai < PART_ATTEMPTS; essai += 1) {
    if (essai > 0) await sleep(RETRY_BASE_MS * 2 ** (essai - 1));
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      const echec = new Error(`HTTP ${response.status} sur ${url}`);
      if (response.status < 500 && response.status !== 429) throw echec;
      derniere = echec;
    } catch (error) {
      // `catch` reçoit n'importe quoi : une erreur réseau, mais aussi tout ce
      // qu'un `fetch` injecté pourrait lancer. On la ramène à une Error avant
      // de la lire, sinon `.message` est une hypothèse.
      const echec = error instanceof Error ? error : new Error(String(error));
      if (/^HTTP \d{3} sur /.test(echec.message)) throw echec;
      derniere = echec;
    }
  }
  throw new Error(`${derniere?.message ?? "échec"} — après ${PART_ATTEMPTS} tentatives`);
}

/**
 * Lit le corps d'un instantané, entier ou d'un de ses morceaux, en le
 * décompressant si l'URL le désigne comme gzippé.
 *
 * L'instantané est le plus gros téléchargement du visiteur : compressé il pèse
 * environ le tiers. Le serveur de développement sert le jumeau `.gz` avec un
 * Content-Encoding, et le navigateur décompresse tout seul ; un hébergement
 * statique comme GitHub Pages, lui, livre le fichier tel quel. On décompresse
 * donc explicitement quand l'URL l'annonce et que personne ne l'a fait avant.
 * @param {Response} response
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
async function readSnapshotBody(response, url) {
  const annonceGzip = /\.gz(\?.*)?$/.test(url);
  // Content-Encoding présent : le navigateur a déjà décompressé pour nous.
  const dejaDecompresse = (response.headers.get("content-encoding") ?? "") !== "";
  if (!annonceGzip || dejaDecompresse || typeof DecompressionStream === "undefined") {
    return response.arrayBuffer();
  }
  // Le typage de DecompressionStream diverge selon les lib DOM ; l'assertion
  // couvre cet écart, le contrat runtime est stable depuis longtemps.
  const decompresseur = /** @type {any} */ (new DecompressionStream("gzip"));
  const flux = /** @type {ReadableStream} */ (response.body).pipeThrough(decompresseur);
  return new Response(flux).arrayBuffer();
}
