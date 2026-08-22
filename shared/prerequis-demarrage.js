// Conditions préalables au démarrage de la coquille, et reprise après
// rechargement. Logique PURE : elle ne touche ni au DOM, ni à
// `location.reload()`, ni à `sessionStorage` — main.js s'en charge, ce module
// décide. C'est ce qui la rend testable sans navigateur.
//
// Deux questions, un seul module, parce qu'elles répondent ensemble à « la
// coquille peut-elle démarrer ici, et sinon que dit-on au visiteur ? ».

/** Gardes de rechargement, une par RAISON de recharger. */
export const GARDE_CONTROLE = "rib-reprise-controle";
export const GARDE_ISOLATION = "rib-reprise-isolation";

/**
 * Rechargements consentis pour que le Service Worker prenne les commandes.
 *
 * DEUX, et le chiffre n'est pas rond par hasard. Obtenir le contrôle est une
 * COURSE : `navigator.serviceWorker.ready` se résout dès que la registration a
 * un worker actif, alors que `clients.claim()` — qui donne son `controller` à
 * la page — se propage un instant plus tard. Chaque navigation est donc un
 * ticket dans cette course. Le premier ticket est joué par la coquille
 * elle-même (rechargement automatique du premier passage) ; le second est
 * offert au visiteur, d'un clic, parce que c'est exactement ce qu'il ferait de
 * lui-même et que cela a suffi à chaque incident observé. Un troisième ne
 * corrigerait plus une course mais un blocage durable — navigation privée,
 * extension qui refuse les Service Workers, moteur non supporté —, et
 * recharger indéfiniment ne le règle pas : mieux vaut le dire.
 */
export const MAX_REPRISES_CONTROLE = 2;

/** Où le visiteur lit ce que la sandbox exige de son navigateur. */
export const URL_PREREQUIS = "https://github.com/pinfada/railsbox#ce-que-verront-vos-visiteurs";

/**
 * @typedef {{
 *   contexteSecurise: boolean,
 *   serviceWorker: boolean,
 *   webAssembly: boolean,
 *   cacheStorage: boolean,
 *   indexedDb: boolean,
 *   decompression: boolean,
 * }} Capacites
 */

/**
 * @typedef {{ cle: string, titre: string, consequence: string }} Manque
 */

// Sans l'une de ces trois-là, rien ne peut fonctionner : aucune dégradation
// n'est possible, seul un message honnête l'est.
//
// SharedArrayBuffer est délibérément ABSENT de cette liste : il n'apparaît
// qu'une fois la page cross-origin isolée, donc APRÈS que le Service Worker a
// réinjecté COOP/COEP. Le tester avant le démarrage accuserait à tort tous les
// navigateurs, y compris ceux qui fonctionnent. C'est l'étape d'isolation qui
// le constate, au bon moment.
const BLOQUANTS = [
  {
    cle: "contexteSecurise",
    titre: "Contexte non sécurisé",
    consequence:
      "Service Worker et mémoire partagée n'existent qu'en HTTPS (ou sur localhost). " +
      "Ouvrez la sandbox par son adresse https://.",
  },
  {
    cle: "serviceWorker",
    titre: "Service Worker indisponible",
    consequence:
      "Toute la sandbox repose dessus : proxy des requêtes de l'application et réinjection " +
      "des en-têtes d'isolation. Il est bloqué en navigation privée sur certains navigateurs, " +
      "et dans la plupart des webviews intégrées aux applications (réseaux sociaux, messageries). " +
      "Ouvrez la page dans un onglet de navigateur ordinaire.",
  },
  {
    cle: "webAssembly",
    titre: "WebAssembly indisponible",
    consequence: "L'émulateur x86 est un module WebAssembly : sans lui, aucune VM ne peut tourner.",
  },
];

// Manques qui coûtent des téléchargements ou un boot à froid, jamais le
// fonctionnement : on les signale, on ne s'arrête pas.
const DEGRADANTS = [
  {
    cle: "cacheStorage",
    titre: "Cache Storage indisponible",
    consequence: "Les morceaux de disque seront retéléchargés à chaque visite.",
  },
  {
    cle: "indexedDb",
    titre: "IndexedDB indisponible",
    consequence:
      "L'instantané mémoire ne peut pas être conservé localement : chaque visite le retélécharge.",
  },
  {
    cle: "decompression",
    titre: "DecompressionStream indisponible",
    consequence:
      "Un instantané livré gzippé ne peut pas être décompressé : la VM devra booter à froid.",
  },
];

/**
 * Relève les capacités d'une portée globale (window). Passée en paramètre
 * plutôt que lue directement : c'est ce qui permet de la simuler en test.
 * @param {any} portee
 * @returns {Capacites}
 */
export function releverCapacites(portee) {
  return {
    contexteSecurise: portee.isSecureContext === true,
    serviceWorker: Boolean(portee.navigator?.serviceWorker),
    webAssembly: typeof portee.WebAssembly === "object",
    cacheStorage: Boolean(portee.caches),
    indexedDb: Boolean(portee.indexedDB),
    decompression: typeof portee.DecompressionStream === "function",
  };
}

/**
 * @param {Manque[]} references
 * @param {Capacites} capacites
 * @returns {Manque[]}
 */
function manquants(references, capacites) {
  return references.filter((manque) => capacites[manque.cle] !== true);
}

/**
 * Diagnostic complet : ce qui interdit de démarrer, et ce qui ne fera que
 * coûter cher.
 * @param {Capacites} capacites
 * @returns {{ demarrable: boolean, bloquants: Manque[], degradations: Manque[] }}
 */
export function diagnostiquer(capacites) {
  const bloquants = manquants(BLOQUANTS, capacites);
  return {
    demarrable: bloquants.length === 0,
    bloquants,
    degradations: manquants(DEGRADANTS, capacites),
  };
}

/**
 * Message destiné au visiteur. Il nomme ce qui manque et ce que cela empêche :
 * « ça ne marche pas » n'aide personne à savoir s'il doit changer d'onglet, de
 * navigateur, ou renoncer.
 * @param {Manque[]} manques
 * @returns {string}
 */
export function resumerManques(manques) {
  return manques.map((manque) => `${manque.titre} — ${manque.consequence}`).join("\n");
}

/**
 * Étape de démarrage qui exige une condition du navigateur, et peut être
 * satisfaite par UN rechargement (le Service Worker vient de s'installer, la
 * navigation suivante passera par lui).
 *
 * Chaque étape a sa PROPRE garde : la première visite a besoin des deux
 * rechargements — l'un pour que le Service Worker prenne le contrôle, l'autre
 * pour que la navigation qu'il intercepte porte enfin COOP/COEP. Une garde
 * unique, consommée par le premier, interdisait le second ; c'est ce qui
 * faisait échouer Firefox et WebKit, où le contrôle est pris dès la première
 * page (`clients.claim()`) alors que l'isolation, elle, exige une navigation
 * de plus.
 *
 * @param {{ satisfait: boolean, dejaRecharge: boolean }} contexte
 * @returns {"poursuivre" | "recharger" | "abandonner"}
 */
export function decisionReprise({ satisfait, dejaRecharge }) {
  if (satisfait) return "poursuivre";
  return dejaRecharge ? "abandonner" : "recharger";
}

// --- Contrôle du Service Worker --------------------------------------------
//
// Cette étape-ci a droit à un traitement à part, et à elle seule. Toutes les
// autres conditions de démarrage sont des constats définitifs : un navigateur
// sans WebAssembly n'en aura pas au rechargement suivant, une page servie sans
// COOP/COEP ne s'isolera pas d'un clic. Le contrôle du worker, lui, est une
// course que la navigation suivante regagne — mesuré en production le
// 18/08/2026, où « ERREUR FATALE » s'affichait sur une sandbox parfaitement
// fonctionnelle qu'un seul rechargement remettait en marche.

const JOURNAL_PREMIER_PASSAGE = "Premier passage : activation du Service Worker";

const TITRE_ATTENTE_CONTROLE = "Un rechargement est nécessaire pour démarrer";
const DETAIL_ATTENTE_CONTROLE =
  "Le Service Worker qui relie cette page à la machine virtuelle vient de s'installer, mais " +
  "il ne pilote pas encore cet onglet : il lui manque une navigation. Rien n'est cassé et " +
  "rien n'est perdu — rechargez la page, le démarrage repartira tout seul.";
const LIBELLE_RECHARGER = "Recharger la page";

const TITRE_ECHEC_CONTROLE = "Le Service Worker ne parvient pas à piloter cette page";
const DETAIL_ECHEC_CONTROLE =
  "La page a déjà été rechargée deux fois sans que le Service Worker en prenne les commandes, " +
  "et sans lui aucune requête de l'application ne peut être servie. Trois causes couvrent " +
  "presque tous les cas, et vous pouvez les vérifier vous-même : une fenêtre de navigation " +
  "privée, où plusieurs navigateurs désactivent les Service Workers ; une extension de blocage " +
  "(antipub, protection de la vie privée) qui les refuse sur ce site ; un navigateur trop " +
  "ancien, ou une webview intégrée à une application. Rouvrez la sandbox dans un onglet " +
  "ordinaire d'un navigateur à jour, extensions désactivées pour ce site.";
const LIBELLE_PREREQUIS = "Navigateurs pris en charge";

/**
 * @typedef {{ suite: "poursuivre" }
 *   | { suite: "recharger", journal: string }
 *   | { suite: "proposer", titre: string, detail: string, libelleAction: string }
 *   | { suite: "renoncer", titre: string, detail: string,
 *       lien: { libelle: string, href: string } }} PlanControle
 */

/**
 * Que faire quand la page n'est pas (encore) contrôlée par le Service Worker.
 *
 * Trois issues, et une seule est un échec. Le premier passage recharge sans
 * rien dire d'anormal ; la fois d'après, on rend la main au visiteur avec un
 * bouton plutôt que de lui annoncer une panne qui n'en est pas une ; au-delà
 * du plafond seulement, on admet que recharger n'y fera rien.
 *
 * @param {{ controle: boolean, tentatives: number }} contexte
 * @returns {PlanControle}
 */
export function repriseControle({ controle, tentatives }) {
  if (controle) return { suite: "poursuivre" };
  if (tentatives < 1) return { suite: "recharger", journal: JOURNAL_PREMIER_PASSAGE };
  if (tentatives < MAX_REPRISES_CONTROLE) {
    return {
      suite: "proposer",
      titre: TITRE_ATTENTE_CONTROLE,
      detail: DETAIL_ATTENTE_CONTROLE,
      libelleAction: LIBELLE_RECHARGER,
    };
  }
  return {
    suite: "renoncer",
    titre: TITRE_ECHEC_CONTROLE,
    detail: DETAIL_ECHEC_CONTROLE,
    lien: { libelle: LIBELLE_PREREQUIS, href: URL_PREREQUIS },
  };
}

/**
 * Nombre de rechargements déjà tentés, tel que `sessionStorage` le rend :
 * `null` quand rien n'a été écrit, et « 1 » pour la garde booléenne d'avant —
 * un onglet ouvert au moment de la mise à jour ne doit pas repartir à zéro.
 * @param {string | null | undefined} valeur
 * @returns {number}
 */
export function compterTentatives(valeur) {
  const tentatives = Number.parseInt(valeur ?? "", 10);
  return Number.isFinite(tentatives) && tentatives > 0 ? tentatives : 0;
}
