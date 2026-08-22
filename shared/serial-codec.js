// Codec des trames série pour le backend v86.
//
// v86 fait tourner un vrai noyau Linux : le pont passe par le port série
// émulé (ttyS0), un canal fiable et ordonné, sans les pièges de persistance
// Protocole ligne à ligne, multiplexé par id :
//   navigateur -> VM : "@RIB1 REQ <id> <b64(json)>"
//   VM -> navigateur : "@RIB1 RSB <id> <taille>" puis "DAT <id> <tranche>"*
//                      puis "END <id>" — ou "ERR <id> <code>" (codes curl :
//                      7 refusé, 28 timeout, 56 divers)
// Toute ligne sans le magic est du log (noyau, Puma…) affiché tel quel.
import {
  filterRequestHeaders,
  sanitizeAppPath,
  sanitizeCookieHeader,
  sanitizeForwardHost,
  sanitizeMethod,
} from "./request-codec.js";

export const FRAME_MAGIC = "@RIB1";
const BASE64_CONVERT_CHUNK = 0x8000;
const MAX_LINE_BYTES = 1024 * 1024;
const INITIAL_LINE_CAPACITY = 16 * 1024;
// Tranche montante volontairement petite : le canal hôte → invité perd des
// octets bien avant 128 Ko d'un seul tenant. 1536 octets bruts = 2048
// caractères base64, sous la limite canonique historique du TTY (4096).
const UPSTREAM_CHUNK_BYTES = 1536;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CONVERT_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CONVERT_CHUNK));
  }
  return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Décode une tranche base64 DIRECTEMENT dans le tampon de destination :
// évite d'accumuler la réponse entière en chaîne (2 Mo de corps = 2,6 Mo de
// chaîne monolithique + 2 Mo de binaire au même instant) avant de décoder.
// Retourne le nombre d'octets écrits.
/**
 * @param {string} base64
 * @param {Uint8Array} target
 * @param {number} offset
 * @returns {number} octets écrits
 */
export function decodeBase64Into(base64, target, offset) {
  const binary = atob(base64);
  if (offset + binary.length > target.length) {
    throw new Error("tranche hors du tampon annoncé");
  }
  for (let index = 0; index < binary.length; index += 1) {
    target[offset + index] = binary.charCodeAt(index);
  }
  return binary.length;
}

// Construit les trames d'une requête. Le corps N'EST PAS embarqué dans le
// descripteur : il part en trames BOD acquittées une par une.
//
// Deux raisons, l'une de correction, l'autre de coût :
//  - Correction : le canal montant (hôte → invité) perd des octets au-delà
//    d'environ 32 Ko d'un seul tenant (mesuré : 128 Ko n'arrive jamais et
//    bloque le canal). Le tampon d'entrée du TTY/UART déborde sans contrôle
//    de flux. Chaque tranche est donc acquittée avant l'envoi de la suivante.
//  - Coût : embarquer le corps en base64 DANS le JSON, lui-même ré-encodé en
//    base64, gonflait la charge utile de 77 %. Une seule couche désormais.
/**
 * @param {string} id
 * @param {{
 *   method: string,
 *   path: string,
 *   headers: Array<[string, string]>,
 *   forwardHost?: string,
 *   cookie?: string | null,
 *   bodyBytes?: Uint8Array | null,
 * }} request
 * @returns {{ head: string, bodyChunks: string[], tail: string }}
 */
export function buildRequestFrames(id, { method, path, headers, forwardHost, cookie, bodyBytes }) {
  const finalHeaders = [];
  const safeHost = sanitizeForwardHost(forwardHost);
  if (safeHost !== null) {
    finalHeaders.push(["host", safeHost]);
  }
  // Canal DÉDIÉ pour le cookie, comme pour l'hôte : il ne vient pas du
  // navigateur (qui n'en a aucun) mais du bocal du Service Worker, et
  // filterRequestHeaders retire justement tout `Cookie:` venu d'ailleurs.
  const safeCookie = sanitizeCookieHeader(cookie);
  if (safeCookie !== null) {
    finalHeaders.push(["cookie", safeCookie]);
  }
  finalHeaders.push(...filterRequestHeaders(headers));
  const body = bodyBytes ?? new Uint8Array(0);
  const descriptor = {
    method: sanitizeMethod(method),
    path: sanitizeAppPath(path),
    headers: finalHeaders,
    bodyLength: body.length,
  };
  const encoded = bytesToBase64(new TextEncoder().encode(JSON.stringify(descriptor)));
  const head = `${FRAME_MAGIC} REQ ${id} ${encoded}\n`;

  const bodyChunks = [];
  for (let offset = 0; offset < body.length; offset += UPSTREAM_CHUNK_BYTES) {
    const slice = body.subarray(offset, offset + UPSTREAM_CHUNK_BYTES);
    bodyChunks.push(`${FRAME_MAGIC} BOD ${id} ${bytesToBase64(slice)}\n`);
  }
  return { head, bodyChunks, tail: `${FRAME_MAGIC} FIN ${id}\n` };
}

// Synchronisation d'horloge : après restauration d'un instantané, le noyau
// invité reprend à la seconde où l'état a été capturé. Sans recalage, Rails
// rejette les cookies de session et les jetons CSRF (vus comme expirés), et
// toute vérification TLS échoue.
/**
 * @param {number | string} epochSeconds
 * @returns {string}
 */
export function buildTimeSyncFrame(epochSeconds) {
  const seconds = Math.floor(Number(epochSeconds));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Horodatage de synchronisation invalide");
  }
  return `${FRAME_MAGIC} TIME ${seconds}\n`;
}

// Injection de variables d'environnement puis relance du serveur applicatif,
// à chaud : c'est ce qui permet de réparer une configuration manquante depuis
// le navigateur, sans reconstruire l'image disque.
/**
 * @param {string} id
 * @param {Record<string, unknown>} variables
 * @returns {string}
 */
export function buildEnvironmentFrame(id, variables) {
  /** @type {Record<string, string>} */
  const cleaned = {};
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) continue;
    if (typeof value !== "string" || value === "") continue;
    cleaned[name] = value;
  }
  if (Object.keys(cleaned).length === 0) {
    throw new Error("Aucune variable exploitable à transmettre");
  }
  const encoded = bytesToBase64(new TextEncoder().encode(JSON.stringify(cleaned)));
  return `${FRAME_MAGIC} ENV ${id} ${encoded}\n`;
}

/**
 * @param {string} id
 * @returns {string}
 */
export function buildRestartFrame(id) {
  return `${FRAME_MAGIC} RST ${id}\n`;
}

/** @param {string} line */
export function parseFrameLine(line) {
  if (!line.startsWith(`${FRAME_MAGIC} `)) return null;
  const parts = line.split(" ");
  const kind = parts[1];
  switch (kind) {
    case "RSB":
    case "DAT":
    case "ERR":
      if (!parts[2]) return null;
      return { kind, id: parts[2], value: parts[3] ?? "" };
    case "ACK":
    case "END":
      if (!parts[2]) return null;
      return { kind, id: parts[2], value: "" };
    case "LOG":
      return { kind, id: null, value: parts.slice(2).join(" ") };
    default:
      return null;
  }
}

// Assemble les octets série en lignes. v86 n'émet aucun événement par bloc :
// c'est UN appel JS par octet (≈360 000 pour un CSS de 270 Ko une fois en
// base64). Le chemin chaud doit donc être strictement O(1) et sans
// allocation : tampon Uint8Array pré-alloué à croissance géométrique, pas de
// tableau d'entiers boxés ni de concaténation de chaînes.
/** @param {(line: string) => void} onLine */
export function createLineAssembler(onLine) {
  const decoder = new TextDecoder();
  const stats = { bytes: 0, lines: 0, truncated: 0 };
  let buffer = new Uint8Array(INITIAL_LINE_CAPACITY);
  let length = 0;
  let overflowed = false;

  return {
    stats,
    /** @param {number} byte */
    feedByte(byte) {
      stats.bytes += 1;
      if (byte === NEWLINE) {
        const end = length > 0 && buffer[length - 1] === CARRIAGE_RETURN ? length - 1 : length;
        if (end > 0) {
          stats.lines += 1;
          onLine(decoder.decode(buffer.subarray(0, end)));
        }
        length = 0;
        overflowed = false;
        return;
      }
      if (overflowed) return;
      if (length === buffer.length) {
        if (buffer.length >= MAX_LINE_BYTES) {
          overflowed = true;
          stats.truncated += 1;
          return;
        }
        const grown = new Uint8Array(Math.min(buffer.length * 2, MAX_LINE_BYTES));
        grown.set(buffer);
        buffer = grown;
      }
      buffer[length] = byte;
      length += 1;
    },
  };
}

// Réassemble les réponses multi-trames par id de requête, et mesure le débit
// réel du canal série (utile pour arbitrer la taille des tranches).
/**
 * @param {{
 *   onResponse: (id: string, bytes: Uint8Array) => void,
 *   onError: (id: string, code: number) => void,
 *   onLog: (line: string) => void,
 *   onAck?: (id: string) => void,
 *   now?: () => number,
 * }} handlers
 */
export function createResponseAssembler({
  onResponse,
  onError,
  onLog,
  onAck = () => {},
  now = () => Date.now(),
}) {
  const pending = new Map(); // id -> { target, offset, startedAt }
  const lastTransfer = { bytes: 0, milliseconds: 0, kilobytesPerSecond: 0 };
  return {
    lastTransfer,
    /** @param {string} line */
    handleLine(line) {
      const frame = parseFrameLine(line);
      if (frame === null) {
        onLog(line);
        return;
      }
      switch (frame.kind) {
        case "LOG":
          onLog(`[pont] ${frame.value}`);
          break;
        case "ACK":
          onAck(frame.id);
          break;
        case "RSB": {
          // Le démon annonce la taille BRUTE : on alloue une fois, à la
          // taille exacte, et chaque tranche s'y décode au vol.
          const expected = Number(frame.value);
          if (!Number.isInteger(expected) || expected < 0) {
            onError(frame.id, 56);
            break;
          }
          pending.set(frame.id, {
            target: new Uint8Array(expected),
            offset: 0,
            startedAt: now(),
          });
          break;
        }
        case "DAT": {
          const entry = pending.get(frame.id);
          if (!entry) break;
          try {
            entry.offset += decodeBase64Into(frame.value, entry.target, entry.offset);
          } catch {
            pending.delete(frame.id);
            onError(frame.id, 56);
          }
          break;
        }
        case "END": {
          const entry = pending.get(frame.id);
          pending.delete(frame.id);
          if (!entry) break;
          if (entry.offset !== entry.target.length) {
            // Réponse tronquée : mieux vaut une erreur franche qu'un corps
            // silencieusement incomplet.
            onError(frame.id, 56);
            break;
          }
          const milliseconds = Math.max(1, now() - entry.startedAt);
          lastTransfer.bytes = entry.target.length;
          lastTransfer.milliseconds = milliseconds;
          lastTransfer.kilobytesPerSecond = Math.round(entry.target.length / milliseconds);
          onResponse(frame.id, entry.target);
          break;
        }
        case "ERR":
          pending.delete(frame.id);
          onError(frame.id, Number(frame.value));
          break;
      }
    },
  };
}

// Sépare une réponse HTTP brute en tête texte + corps binaire.
/** @param {Uint8Array} bytes */
export function splitHttpResponse(bytes) {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return {
        headText: new TextDecoder().decode(bytes.subarray(0, index)),
        bodyBytes: bytes.subarray(index + 4),
      };
    }
  }
  throw new Error("Réponse HTTP sans séparateur tête/corps");
}
