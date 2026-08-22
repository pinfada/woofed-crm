// Normalisation de la configuration v86, partagée entre le navigateur
// (v86-vm.js) et le harnais Node (tools/vm-harness.mjs). Logique pure, donc
// testable sans émulateur.
//
// Deux formes de configuration coexistent :
//  - MONO-DISQUE (héritée : jiyufit, demo) — un seul `disk` (hda) contenant
//    à la fois la base et l'application.
//  - BASE + APPLICATION (ADR 0002) — un rootfs de base `disk` (hda, mutualisé
//    entre sandboxes) et un disque applicatif `appDisk` (hdb, ~100-300 Mo).
//    Le hdb est « padé » à une géométrie fixe (`appDiskSize`) : c'est la même
//    taille que le disque vide présent lors de la capture de l'instantané de
//    base, condition sine qua non de la restauration (v86 refuse un hdb de
//    géométrie différente — voir docs/decisions/0002).

const DEFAULT_MEMORY_MB = 1024;

/**
 * Vérifie qu'une configuration porte les champs indispensables au boot.
 * @param {Record<string, any> | null | undefined} config
 * @returns {config is Record<string, any> & { disk: string, kernel: string, initrd: string }}
 */
export function isBootableConfig(config) {
  return Boolean(config?.disk && config?.kernel && config?.initrd);
}

/**
 * Indique si la configuration décrit un montage base + application (deux
 * disques) plutôt qu'une image mono-disque.
 * @param {Record<string, any>} config
 * @returns {boolean}
 */
export function isSplitConfig(config) {
  return Boolean(config?.appDisk);
}

/**
 * Descripteur d'un disque pour v86.
 *
 * Un disque peut être servi d'un seul tenant (lecture par requêtes Range) ou
 * DÉCOUPÉ EN FICHIERS-PARTIES quand l'hébergeur plafonne la taille des fichiers
 * — le cas de GitHub Pages, 100 Mo maximum (ADR 0001). Dans ce second cas v86
 * dérive lui-même le nom du morceau contenant l'offset demandé
 * (`tools/build-v86-image/artifact-parts.mjs` produit la même convention) et ne
 * télécharge que celui-là : pas de réassemblage, et le visiteur ne paie que les
 * blocs réellement lus.
 * @param {string} url
 * @param {number|undefined} size
 * @param {number|undefined} chunkSize taille de morceau, absente si non découpé
 * @returns {{ url: string, async: true, size?: number, use_parts?: true, fixed_chunk_size?: number }}
 */
function diskImage(url, size, chunkSize) {
  const image = { url, async: /** @type {true} */ (true), size };
  if (!chunkSize) return image;
  return { ...image, use_parts: /** @type {true} */ (true), fixed_chunk_size: chunkSize };
}

/**
 * Construit les descripteurs de disques pour le constructeur v86 : hda
 * (rootfs) toujours, hdb (disque applicatif) si la configuration est en mode
 * base + application. Les deux sont chargés en `async` (lecture par blocs,
 * jamais téléchargés en entier).
 * @param {{
 *   disk: string, diskSize?: number, diskChunkSize?: number,
 *   appDisk?: string, appDiskSize?: number, appDiskChunkSize?: number,
 * }} config
 * @returns {{ hda: ReturnType<typeof diskImage>, hdb?: ReturnType<typeof diskImage> }}
 */
export function buildDiskImages(config) {
  const images = { hda: diskImage(config.disk, config.diskSize, config.diskChunkSize) };
  if (config.appDisk) {
    return {
      ...images,
      hdb: diskImage(config.appDisk, config.appDiskSize, config.appDiskChunkSize),
    };
  }
  return images;
}

/**
 * Mémoire allouée à la VM en octets, défaut compris.
 * @param {Record<string, any>} config
 * @returns {number}
 */
export function memoryBytes(config) {
  return (config.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024;
}

export { DEFAULT_MEMORY_MB };
