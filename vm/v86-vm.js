// Backend v86 : vrai noyau Linux i386 émulé (JIT open source, BSD-2-Clause).
// Le pont HTTP passe par le port série ttyS0 (voir shared/serial-codec.js et
// le démon /opt/rib/serial-bridge.py embarqué dans l'image disque).
import { parseCurlHeaders } from "../shared/request-codec.js";
import {
  buildEnvironmentFrame,
  buildRequestFrames,
  buildRestartFrame,
  buildTimeSyncFrame,
  createLineAssembler,
  createResponseAssembler,
  splitHttpResponse,
} from "../shared/serial-codec.js";
import { creerLimiteConcurrence } from "../shared/limite-concurrence.js";
import { loadSnapshot } from "../shared/snapshot-parts.js";
import { INSTANTANE, verifierInstantane } from "../shared/instantane-lien.js";
import {
  buildDiskImages,
  isBootableConfig,
  isSplitConfig,
  memoryBytes,
} from "../shared/v86-config.js";

// Relatifs à la page : voir main.js.
const V86_LIB_URL = new URL("vendor/v86/libv86.js", document.baseURI).href;
const V86_WASM_PATH = new URL("vendor/v86/v86.wasm", document.baseURI).href;
const BIOS_URL = new URL("vendor/v86/seabios.bin", document.baseURI).href;
const VGA_BIOS_URL = new URL("vendor/v86/vgabios.bin", document.baseURI).href;
const VGA_MEMORY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
// Requêtes simultanées admises vers la VM. Voir shared/limite-concurrence.js
// pour les mesures : au-dela de deux, sur un poste lent, tout tombe en 502 —
// alors que les memes requetes EN SEQUENCE passent toutes.
const VM_CONCURRENCE_MAX = 2;
const PROBE_TIMEOUT_MS = 10_000;
// Boot complet noyau + PostgreSQL + Puma sous émulation : jusqu'à ~15 min à
// froid (large marge) ; quelques secondes après restauration d'instantané.
//
// SONDER PLUS SOUVENT COÛTE PLUS QUE CE QUE ÇA RAPPORTE — mesuré, pas supposé.
// `npm run test:bridage` (tests/bridage/) date l'instant où l'application
// répond vraiment : la coquille l'annonce 5 à 8,5 s plus tard, et la tentation
// est grande de resserrer la cadence pour récupérer ces secondes. Le même
// instrument montre pourquoi ce serait un mauvais échange. Chaque sonde
// abandonnée fait quand même rendre une page à Rails DANS la VM, et sa réponse
// remonte le canal série à raison d'un appel JavaScript par octet — sur le
// thread précisément que le processeur du visiteur ralentit. Ajouter un
// deuxième sondeur au rythme d'une sonde toutes les 2 s a allongé le boot de
// 1 % sans bridage, 7 % à 4×, 12 % à 6×, et jusqu'à 133 s au lieu de 37 s à 8× :
// le mal grandit exactement avec la lenteur de l'appareil qu'on prétendait
// aider. Et l'instant du réveil se déplace lui aussi avec le bridage (7 s après
// la création de l'émulateur à 1×, ~16 s à 8×) : aucune cadence fixe plus
// serrée ne gagne sur toute la plage. D'où ces deux chiffres, inchangés.
const READY_MAX_ATTEMPTS = 240;
const READY_INTERVAL_MS = 5_000;
// L'horloge invitée ne dérive pas seulement au gel de l'instantané : sous
// émulation chargée elle prend jusqu'à 20 s de retard toutes les 5 s (mesuré
// au boot). Un recalage périodique est donc nécessaire en fonctionnement,
// sans quoi les cookies de session et jetons CSRF finissent par expirer.
const CLOCK_KEEPER_INTERVAL_MS = 15_000;
// Le canal série est de fait semi-duplex : une grosse réponse en cours (80 Ko de
// page d'accueil = ~11 trames DAT) monopolise l'écriture de l'invité, et
// l'acquittement d'une tranche montante attend derrière. Le délai doit donc
// être aussi large que celui d'une requête complète, sinon un POST lancé
// pendant un gros téléchargement échoue à tort (observé avec 30 s).
const ACK_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
const BRIDGE_ERROR_HINTS = new Map([
  [7, "connexion refusée — Puma n'écoute pas encore"],
  [28, "timeout HTTP à l'intérieur de la VM"],
  [56, "erreur du pont série"],
]);
const SNAPSHOT_DB_NAME = "rib-v86-snapshots";
const SNAPSHOT_STORE = "states";

/**
 * @param {{
 *   onConsole?: (line: string) => void,
 *   config: {
 *     disk: string, kernel: string, initrd: string, cmdline?: string,
 *     diskSize?: number, memoryMb?: number, state?: string,
 *     appDisk?: string, appDiskSize?: number,
 *   },
 *   fresh?: boolean,
 * }} options
 */
export async function bootVm({ onConsole = () => {}, config, fresh = false }) {
  if (!isBootableConfig(config)) {
    throw new Error(
      "Configuration v86 incomplète — lancez tools/build-v86-image/build.sh pour produire public/disks/",
    );
  }
  await loadClassicScript(V86_LIB_URL);
  const V86Constructor = window.V86 ?? window.V86Starter;
  if (!V86Constructor) {
    throw new Error("libv86.js chargé mais le constructeur V86 est introuvable");
  }

  // Instantané mémoire : un état post-boot évite le boot à froid (~13 min).
  // Deux sources, dans l'ordre : le cache IndexedDB de ce navigateur, puis
  // l'instantané pré-calculé livré avec l'image (aucun utilisateur final ne
  // devrait jamais subir un boot à froid). ?fresh=1 purge et force le froid.
  const snapshotKey = JSON.stringify(config);
  const snapshot = fresh
    ? await purgeSnapshot(onConsole)
    : await resolveSnapshot(snapshotKey, config, onConsole);

  if (isSplitConfig(config)) {
    onConsole(`[v86] montage base + application : rootfs ${config.disk} + hdb ${config.appDisk}`);
  }
  const emulator = new V86Constructor({
    wasm_path: V86_WASM_PATH,
    memory_size: memoryBytes(config),
    vga_memory_size: VGA_MEMORY_BYTES,
    bios: { url: BIOS_URL },
    vga_bios: { url: VGA_BIOS_URL },
    bzimage: { url: config.kernel },
    initrd: { url: config.initrd },
    cmdline: config.cmdline,
    // hda (rootfs) toujours, hdb (disque applicatif) en mode base + app.
    ...buildDiskImages(config),
    // ArrayBuffer direct plutôt qu'un Blob URL : v86 accepte { buffer } et
    // cela évite de retenir 600+ Mo dans un Object URL que le navigateur ne
    // libère jamais tout seul (doublement de la mémoire de l'onglet).
    ...(snapshot.state ? { initial_state: { buffer: snapshot.state } } : {}),
    autostart: true,
    disable_speaker: true,
    disable_keyboard: true,
    disable_mouse: true,
  });

  const state = { nextId: 1, pending: new Map(), acks: new Map(), clockKeeper: null };
  const assembler = createResponseAssembler({
    onResponse: (id, bytes) => settle(state, id, { bytes }),
    onError: (id, code) => settle(state, id, { errorCode: code }),
    onLog: onConsole,
    onAck: (id) => state.acks.get(id)?.(),
  });
  const lineAssembler = createLineAssembler((line) => assembler.handleLine(line));
  emulator.add_listener("serial0-output-byte", (byte) => lineAssembler.feedByte(byte));

  return createFacade(emulator, state, onConsole, {
    snapshotKey,
    wasRestored: snapshot.state !== null,
    lastTransfer: assembler.lastTransfer,
    serialStats: lineAssembler.stats,
  });
}

// Cherche un instantané utilisable : cache local d'abord (instantané), puis
// l'instantané pré-calculé livré avec l'image (téléchargé une fois, puis mis
// en cache local pour les visites suivantes).
async function resolveSnapshot(snapshotKey, config, onConsole) {
  const cached = await snapshotGet(snapshotKey).catch(() => null);
  if (cached) {
    onConsole(`[v86] instantané local trouvé (${formatMegabytes(cached)}) — restauration…`);
    return { state: cached, fromCache: true };
  }
  // L'instantané est-il celui de CE disque ? Les deux fichiers portent les
  // mêmes noms d'une construction à l'autre, et rien dans les noms ne dit
  // qu'ils ont cessé d'aller ensemble. Restaurer un état posé sur un système
  // de fichiers qu'il ne connaît pas donne une VM dont Puma ne répond jamais —
  // 337 s de sondes muettes, sans un message (ADR 0007). Un boot à froid coûte
  // des minutes ; celui-là ne finit pas.
  //
  // L'ABSENCE DE MARQUE EST TOLÉRÉE, et c'est le point : toutes les sandboxes
  // publiées avant que `stateFor` n'existe ont un instantané valide et pas de
  // marque. Les refuser les ferait booter à froid pour rien. Seul le DÉSACCORD
  // est refusé.
  const lien = verifierInstantane(config);
  if (lien.verdict === INSTANTANE.DESACCORDE) {
    onConsole(`[v86] instantané écarté — ${lien.raison}`);
    onConsole("[v86] boot à froid (plusieurs minutes) plutôt qu'un état incohérent");
    return { state: null, fromCache: false };
  }
  if (!config.state) {
    onConsole("[v86] aucun instantané — boot à froid (plusieurs minutes)");
    return { state: null, fromCache: false };
  }
  try {
    // Deux formats coexistent, et c'est la PRÉSENCE DE L'INVENTAIRE qui
    // tranche : un instantané découpé en publie un, une sandbox publiée avant
    // le découpage n'en a pas. Rien à déclarer dans la configuration, donc rien
    // à mettre à jour sur les sandboxes déjà en ligne. Tout est dans
    // shared/snapshot-parts.js — téléchargement compris, pour que les deux
    // chemins soient exécutés par les tests sans navigateur ni VM.
    const state = await loadSnapshot({
      url: new URL(config.state, document.baseURI).href,
      onLog: onConsole,
    });
    onConsole(`[v86] instantané téléchargé (${formatMegabytes(state)}) — mise en cache…`);
    // Mise en cache AVANT de démarrer l'émulateur : v86 peut prendre
    // possession du buffer, et un put concurrent stockerait un tampon détaché.
    await snapshotPut(snapshotKey, state).catch((error) =>
      onConsole(
        `[v86] cache local impossible (${error.message}) — re-téléchargement au prochain lancement`,
      ),
    );
    onConsole("[v86] restauration depuis l'instantané pré-calculé…");
    return { state, fromCache: false };
  } catch (error) {
    onConsole(`[v86] instantané pré-calculé indisponible (${error.message}) — boot à froid`);
    return { state: null, fromCache: false };
  }
}

async function purgeSnapshot(onConsole) {
  await snapshotDelete().catch(() => {});
  onConsole("[v86] boot à froid demandé (?fresh=1) — instantané purgé");
  return { state: null, fromCache: false };
}

function formatMegabytes(buffer) {
  return `${Math.round(buffer.byteLength / 1024 / 1024)} Mo`;
}

function settle(state, id, outcome) {
  const entry = state.pending.get(id);
  if (!entry) return; // réponse arrivée après expiration
  state.pending.delete(id);
  clearTimeout(entry.timer);
  if (outcome.errorCode !== undefined) {
    const hint = BRIDGE_ERROR_HINTS.get(outcome.errorCode) ?? `code ${outcome.errorCode}`;
    entry.reject(new Error(`Aucune réponse HTTP: ${hint}`));
  } else {
    entry.resolve(outcome.bytes);
  }
}

function createFacade(emulator, state, onConsole, snapshot) {
  // Attend l'acquittement d'une tranche montante : sans ce contrôle de flux,
  // le tampon d'entrée de l'invité déborde et la requête est perdue.
  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  function waitForAck(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.acks.delete(id);
        reject(new Error("tranche du corps non acquittée par la VM"));
      }, ACK_TIMEOUT_MS);
      state.acks.set(id, () => {
        clearTimeout(timer);
        state.acks.delete(id);
        resolve();
      });
    });
  }

  async function sendRequest(descriptor, body, timeoutMs) {
    const id = String(state.nextId++);
    const bodyBytes = descriptor.hasBody && body ? new Uint8Array(body) : null;
    const { head, bodyChunks, tail } = buildRequestFrames(id, { ...descriptor, bodyBytes });

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error("Délai dépassé en attendant la VM v86"));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
    });

    emulator.serial0_send(head);
    for (const chunk of bodyChunks) {
      const acked = waitForAck(id);
      emulator.serial0_send(chunk);
      await acked;
    }
    emulator.serial0_send(tail);
    return response;
  }

  // La file est creee UNE FOIS par instance de VM : elle porte l'etat des
  // jetons, la partager entre deux VM n'aurait aucun sens.
  const filePont = creerLimiteConcurrence(VM_CONCURRENCE_MAX);

  async function handleHttpRequest(descriptor, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    // Le jeton est pris AVANT d'entrer dans sendRequest, donc le delai ne court
    // pas pendant l'attente en file : une requete mise en attente ne doit pas
    // consommer son propre budget de temps a ne rien faire.
    return filePont(() => servirRequete(descriptor, body, timeoutMs));
  }

  async function servirRequete(descriptor, body, timeoutMs) {
    const rawBytes = await sendRequest(descriptor, body, timeoutMs);
    const { headText, bodyBytes } = splitHttpResponse(rawBytes);
    const parsed = parseCurlHeaders(headText);
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      // Copie : subarray partage le buffer, qui doit rester transférable.
      body: bodyBytes.length > 0 ? bodyBytes.slice().buffer : null,
    };
  }

  async function startServer() {
    // Tout est piloté par l'init du guest (guest-init.sh) : rien à lancer ici.
    onConsole("[v86] init du guest en charge de PostgreSQL/Redis/Puma");
  }

  // Recale l'horloge de l'invité sur celle de l'hôte. Indispensable après
  // restauration (le noyau reprend à la date de la capture) : sans cela les
  // cookies de session et jetons CSRF sont vus comme expirés. Émis à chaque
  // sonde car le démon du pont peut ne pas être encore vivant au premier tour.
  function syncGuestClock() {
    emulator.serial0_send(buildTimeSyncFrame(Date.now() / 1000));
  }

  function startClockKeeper() {
    if (state.clockKeeper) return;
    state.clockKeeper = setInterval(syncGuestClock, CLOCK_KEEPER_INTERVAL_MS);
  }

  function stopClockKeeper() {
    clearInterval(state.clockKeeper);
    state.clockKeeper = null;
  }

  /** @param {(attempt: number, error: string | null) => void} [onAttempt] */
  async function waitUntilReady(onAttempt = () => {}) {
    for (let attempt = 1; attempt <= READY_MAX_ATTEMPTS; attempt += 1) {
      syncGuestClock();
      const result = await probe();
      onAttempt(attempt, result.error);
      if (result.ok) {
        // Dernier recalage juste avant que l'application serve de vraies
        // requêtes, puis entretien périodique contre la dérive continue.
        syncGuestClock();
        startClockKeeper();
        return;
      }
      await sleep(READY_INTERVAL_MS);
    }
    throw new Error("Puma n'a jamais répondu dans la VM v86");
  }

  async function probe() {
    try {
      // L'application est montée sous /app dans la VM : sonder la racine
      // ne testerait que Rack::URLMap, pas l'application elle-même.
      const response = await handleHttpRequest(
        { method: "GET", path: "/app/", headers: [], hasBody: false, forwardHost: "localhost" },
        null,
        PROBE_TIMEOUT_MS,
      );
      return { ok: response.status > 0, error: null };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // Sauvegarde l'état mémoire post-boot dans IndexedDB (inutile si la VM
  // vient elle-même d'être restaurée depuis un instantané).
  async function persistSnapshot() {
    if (snapshot.wasRestored) {
      return "[v86] VM restaurée depuis l'instantané — pas de nouvelle sauvegarde";
    }
    const startedAt = performance.now();
    const stateBuffer = await emulator.save_state();
    await snapshotPut(snapshot.snapshotKey, stateBuffer);
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const megabytes = Math.round(stateBuffer.byteLength / 1024 / 1024);
    return `[v86] instantané sauvegardé (${megabytes} Mo en ${seconds}s) — prochains boots en quelques secondes`;
  }

  // Écrit les variables dans la VM puis relance le serveur applicatif. Les
  // deux trames sont acquittées, donc on sait quand l'invité a réellement
  // pris en compte la demande — pas seulement quand on l'a envoyée.
  async function applyEnvironment(variables) {
    const envId = String(state.nextId++);
    const envAck = waitForAck(envId);
    emulator.serial0_send(buildEnvironmentFrame(envId, variables));
    await envAck;

    const restartId = String(state.nextId++);
    const restartAck = waitForAck(restartId);
    emulator.serial0_send(buildRestartFrame(restartId));
    await restartAck;
  }

  // Veille d'arrière-plan : l'émulation consomme le processeur du visiteur
  // même sans spectateur. La pause arrête le CPU virtuel ET l'entretien
  // d'horloge (recaler une VM arrêtée ne sert à rien) ; la reprise recale
  // immédiatement l'horloge invitée, qui a pris exactement la durée de la
  // pause de retard — sans quoi cookies de session et jetons CSRF expirent.
  async function pause() {
    stopClockKeeper();
    await emulator.stop();
  }

  function resume() {
    emulator.run();
    syncGuestClock();
    startClockKeeper();
  }

  return {
    startServer,
    handleHttpRequest,
    waitUntilReady,
    applyEnvironment,
    persistSnapshot,
    syncGuestClock,
    stopClockKeeper,
    pause,
    resume,
    // Débit du dernier transfert et compteurs du canal série (diagnostic).
    metrics: () => ({
      lastTransfer: { ...snapshot.lastTransfer },
      serial: { ...snapshot.serialStats },
    }),
    saveState: () => emulator.save_state(),
    _emulator: emulator,
  };
}

// --- Persistance des instantanés (IndexedDB, un seul enregistrement) -------

function snapshotOpenDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SNAPSHOT_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function snapshotGet(key) {
  const db = await snapshotOpenDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(SNAPSHOT_STORE).objectStore(SNAPSHOT_STORE).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {string} key
 * @param {ArrayBuffer} buffer
 * @returns {Promise<void>}
 */
async function snapshotPut(key, buffer) {
  const db = await snapshotOpenDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
    // Un seul instantané conservé : on purge avant d'écrire (clés = configs).
    transaction.objectStore(SNAPSHOT_STORE).clear();
    transaction.objectStore(SNAPSHOT_STORE).put(buffer, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** @returns {Promise<void>} */
async function snapshotDelete() {
  const db = await snapshotOpenDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
    transaction.objectStore(SNAPSHOT_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function loadClassicScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () =>
      reject(new Error(`Chargement impossible: ${url} (npm install effectué ?)`));
    document.head.append(script);
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
