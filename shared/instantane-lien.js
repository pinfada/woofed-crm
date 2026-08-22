// Le lien entre un instantané mémoire et le disque qu'il a figé.
//
// Module partagé parce que les DEUX côtés en ont besoin : la chaîne de
// construction, qui pose la marque à la capture, et la coquille, qui décide au
// démarrage s'il faut restaurer ou booter à froid.

/** Verdicts possibles sur le lien entre un instantané et son disque. */
export const INSTANTANE = Object.freeze({
  ACCORDE: "accorde",
  AUCUN: "aucun",
  SANS_MARQUE: "sans-marque",
  DESACCORDE: "desaccorde",
});

/**
 * Forme d'une empreinte utilisable.
 *
 * De 12 à 64 caractères hexadécimaux : la chaîne écrit un SHA-256 complet, mais
 * l'ADR 0007 nomme déjà les artefacts avec les 12 premiers, et se lier ici à
 * une longueur unique interdirait de rapprocher un jour les deux.
 */
const EMPREINTE = /^[0-9a-f]{12,64}$/;

/**
 * L'instantané est-il celui de CETTE version du disque ?
 *
 * LE VRAI DANGER N'EST PAS L'ÉCRASEMENT, C'EST LE PANACHAGE. Un
 * `zealot.ext2` reconstruit et un `zealot-state.bin` d'avant portent les mêmes
 * noms : rien, dans les noms, ne dit qu'ils ne vont plus ensemble. Restaurer un
 * état mémoire sur un système de fichiers qu'il ne connaît pas donne une VM
 * dont Puma ne répond jamais — le défaut exact que l'ADR 0007 décrit, et qui
 * avait coûté 337 s de sondes muettes sans un seul message.
 *
 * DEUX LIENS, PAS UN, ET LE PREMIER PRIME (ADR 0009).
 *
 * 1. PAR EMPREINTE DE CONTENU — `appDiskSha256` contre `stateForAppDiskSha256`.
 *    C'est une identité réelle : les deux valeurs sont lues sur les OCTETS du
 *    disque applicatif, par deux acteurs distincts et à deux moments distincts
 *    — la capture, qui hache le disque qu'elle attache, et le découpage, qui
 *    hache celui qu'il publie. Un disque échangé entre les deux les fait
 *    diverger. C'est le seul des deux liens qu'une manipulation hors séquence
 *    ne peut pas rendre vrai par construction.
 *
 * 2. PAR DATE DÉCLARÉE — `stateFor` contre `builtAt`, le lien historique,
 *    conservé pour tout ce qui a été publié avant l'empreinte. Les deux valeurs
 *    y sont produites par la CONFIGURATION ; aucune n'est lue sur le disque. Il
 *    garantit une cohérence de construction DÉCLARÉE, et rien de plus : il
 *    attrape une configuration réécrite, ou servie périmée par un cache
 *    d'hébergeur, face à un instantané qui n'est plus le sien — le cas décrit
 *    dans main.js — ainsi qu'une reconstruction MONOLITHIQUE, `build.sh`
 *    réécrivant la configuration à chaque passage donc `builtAt`, alors que
 *    `stateFor` garde l'ancienne valeur. Il N'ATTRAPE PAS un disque applicatif
 *    reconstruit sans que la configuration soit régénérée : sur le chemin
 *    découplé, `builtAt` naît à la CAPTURE, de sorte que les deux valeurs sont
 *    égales par construction. C'est le trou que l'empreinte vient fermer.
 *
 * CE QUE MÊME L'EMPREINTE NE FAIT PAS, et il faut le dire net : personne ne
 * vérifie AU BOOT que les octets servis valent l'empreinte déclarée — la
 * coquille ne hache pas 512 Mo, elle les lit paresseusement par morceaux. Le
 * lien reste une cohérence de chaîne de construction ; il devient seulement une
 * cohérence que le CONTENU PEUT DÉMENTIR, au lieu d'une que la date ne pouvait
 * que confirmer. Sur le chemin publié, les noms d'artefacts portent eux-mêmes
 * l'empreinte (ADR 0007) : un contenu changé change l'URL, et une URL qui
 * n'existe pas échoue bruyamment.
 *
 * LES DEUX EMPREINTES SONT EXIGÉES ENSEMBLE. Une seule des deux — ou une valeur
 * mal formée — n'est pas un désaccord : c'est une configuration à cheval sur
 * deux versions de la chaîne, qu'on juge alors sur la date. Refuser sur cette
 * seule asymétrie ferait booter à froid, plusieurs minutes durant, une sandbox
 * parfaitement saine. Mais dès que les deux sont là, la comparaison est
 * STRICTE : une valeur tronquée face à une valeur complète n'est pas une
 * correspondance partielle, c'est une chaîne incohérente.
 *
 * TROIS VERDICTS PLUTÔT QU'UN BOOLÉEN, et c'est délibéré. Un instantané SANS
 * marque n'est pas un instantané fautif : c'est celui de toutes les sandboxes
 * publiées avant que cette marque n'existe. Le refuser ferait booter à froid des
 * démonstrations qui fonctionnent parfaitement. L'appelant décide donc : la
 * coquille tolère l'absence de marque et ne refuse que le DÉSACCORD, une chaîne
 * de construction peut être plus stricte.
 * @param {{ state?: unknown, stateFor?: unknown, builtAt?: unknown,
 *           appDiskSha256?: unknown, stateForAppDiskSha256?: unknown }} config
 * @returns {{ verdict: string, raison: string }}
 */
export function verifierInstantane(config) {
  if (typeof config?.state !== "string" || config.state === "") {
    return { verdict: INSTANTANE.AUCUN, raison: "aucun instantané référencé" };
  }

  const disque = empreinte(config.appDiskSha256);
  const capture = empreinte(config.stateForAppDiskSha256);
  if (disque && capture) {
    if (disque !== capture) {
      return {
        verdict: INSTANTANE.DESACCORDE,
        raison:
          `instantané capturé sur le disque applicatif ${abrege(capture)}, alors que la ` +
          `configuration nomme le disque ${abrege(disque)} : ce ne sont pas les mêmes ` +
          "octets, et restaurer l'un sur l'autre poserait un état mémoire sur un " +
          "système de fichiers qu'il ne connaît pas.",
      };
    }
    return { verdict: INSTANTANE.ACCORDE, raison: "" };
  }

  if (typeof config.stateFor !== "string" || config.stateFor === "") {
    return {
      verdict: INSTANTANE.SANS_MARQUE,
      raison:
        "instantané sans marque d'origine (`stateFor`) : capturé avant que la " +
        "marque n'existe. Restauré tel quel ; une recapture le lierait à sa " +
        "construction.",
    };
  }
  if (config.stateFor !== config.builtAt) {
    return {
      verdict: INSTANTANE.DESACCORDE,
      raison:
        `instantané capturé sur la construction du ${config.stateFor}, alors que le ` +
        `disque est celui du ${config.builtAt} : le restaurer poserait un état ` +
        "mémoire sur un système de fichiers qu'il ne connaît pas.",
    };
  }
  return { verdict: INSTANTANE.ACCORDE, raison: "" };
}

/**
 * Une empreinte utilisable, ou rien.
 *
 * Le filtre porte sur la FORME parce qu'une valeur mal formée doit renvoyer au
 * lien par date, jamais produire un désaccord : deux valeurs invalides et
 * différentes — un `null` et un `""` rescapés d'un JSON.stringify malheureux —
 * feraient refuser un instantané sain.
 * @param {unknown} valeur
 * @returns {string|null} empreinte hexadécimale, ou null si ce n'en est pas une
 */
function empreinte(valeur) {
  return typeof valeur === "string" && EMPREINTE.test(valeur) ? valeur : null;
}

/**
 * Les premiers caractères d'une empreinte, pour un message qu'on peut lire.
 *
 * Douze : ce que l'ADR 0007 met déjà dans les noms d'artefacts publiés, donc ce
 * que le lecteur du message retrouvera tel quel dans l'URL du disque.
 * @param {string} valeur empreinte complète
 * @returns {string}
 */
function abrege(valeur) {
  return valeur.slice(0, 12);
}
