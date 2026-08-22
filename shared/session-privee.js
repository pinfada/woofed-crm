// Expiration d'une session d'authentification EN PLEIN BOOT de la VM.
//
// LE PROBLÈME. Sur une sandbox distribuée en privé, les morceaux du disque
// applicatif sont derrière une session. Si celle-ci expire pendant que v86
// lit son disque, le chargeur de fichiers-parties de v86 (`libv86.js:36`,
// fonction `Aa`) n'a AUCUNE issue : il ne résout la lecture que lorsque tous
// les morceaux sont arrivés, et son chargeur générique (`libv86.js:9-11`) ne
// rappelle `done()` que sur 200/206, ne réessaie que sur 5xx, et ne fait
// strictement RIEN sur un 4xx — ni réessai, ni erreur. Rendre un 401 à v86,
// c'est donc geler la lecture pour toujours, en silence.
//
// LA SORTIE. `event.respondWith(promesse)` accepte une promesse de durée
// arbitraire : UNE RÉPONSE JAMAIS RENDUE N'EST PAS UNE ERREUR, C'EST UNE
// LECTURE LENTE. On ne rend donc pas le refus à v86 — on RETIENT la requête,
// on prévient la coquille (qui suspend la VM et propose de se reconnecter), et
// on rejoue la requête une fois la session rétablie. La VM ne perd rien : son
// CPU virtuel est arrêté, sa mémoire reste intacte, son horloge est recalée à
// la reprise — exactement la machinerie de la veille d'onglet.
//
// POURQUOI LA PAUSE N'EST PAS OPTIONNELLE. Sans elle, l'invité continue de
// tourner pendant que sa lecture ne revient pas. Le délai ATA de libata (30 s
// par défaut) réinitialiserait le lien puis remonterait « / » en lecture
// seule : destruction irréversible de la sandbox. Arrêter le CPU arrête ses
// compteurs.
//
// Ce module ne porte QUE la décision, sans navigateur ni minuterie réelle :
// reconnaître un refus de session, et tenir l'épisode de rétention (qui
// notifie, qui attend, quand on abandonne). Le câblage — `fetch`, `clients`,
// `postMessage`, `pause()`/`resume()` — vit dans sw-proxy.js et main.js.

/**
 * En-tête qui fait foi (contrat du bord, C3). Le Service Worker doit trancher
 * SANS lire le corps de la réponse : lire le corps le consommerait, et un
 * bord mal configuré peut très bien répondre 401 sur autre chose qu'une
 * session expirée (une clé d'API absente, par exemple) — cas où réveiller un
 * écran de reconnexion serait un mensonge.
 */
export const EN_TETE_AUTH = "x-railsbox-auth";

/** Seule valeur qui déclenche la rétention. Voir {@link EN_TETE_AUTH}. */
export const AUTH_EXPIREE = "expired";

/**
 * Plafond de rétention. Au-delà, la promesse retenue est résolue et l'écran
 * devient terminal.
 *
 * POURQUOI UN PLAFOND. v86 demande ses morceaux par rafales : une rétention
 * illimitée ferait enfler indéfiniment la table des requêtes en vol du worker
 * pendant qu'un visiteur parti déjeuner ne revient pas. Dix minutes est le
 * budget d'attente d'un humain qui doit rouvrir sa boîte mail, pas davantage.
 */
export const PLAFOND_RETENTION_MS = 600_000;

/**
 * Lit un en-tête, que la source soit un `Headers` du navigateur, une `Map`,
 * ou un objet nu — le module est testé sans navigateur, et les tests ne
 * doivent pas être obligés de fabriquer un `Headers`.
 * @param {unknown} headers
 * @param {string} nom en minuscules
 * @returns {string | null}
 */
function lireEnTete(headers, nom) {
  if (!headers) return null;
  const source = /** @type {any} */ (headers);
  if (typeof source.get === "function") {
    const valeur = source.get(nom);
    return typeof valeur === "string" ? valeur : null;
  }
  for (const [cle, valeur] of Object.entries(source)) {
    if (cle.toLowerCase() === nom) return typeof valeur === "string" ? valeur : null;
  }
  return null;
}

/**
 * Cette réponse est-elle un refus de session RÉCUPÉRABLE ?
 *
 * Les deux conditions sont indissociables (contrat du bord, C2 + C3) :
 *
 *  - `401` et rien d'autre. Pas `403` : une révocation est irrécupérable et
 *    mérite un écran différent — proposer « reconnectez-vous » à un client
 *    révoqué serait un message mensonger. Pas `5xx` : v86 les réessaie déjà
 *    tout seul, indéfiniment, et le retenir en plus n'ajouterait rien.
 *  - `X-Railsbox-Auth: expired`. Un `401` nu vient d'ailleurs (une ressource
 *    tierce protégée, un bord mal configuré) et ne doit PAS réveiller l'écran
 *    de reconnexion de la sandbox.
 *
 * Le prédicat est faux pour tout ce qui existe aujourd'hui : sur le chemin
 * public gratuit, aucun bord n'émet jamais cet en-tête.
 * @param {number} status
 * @param {unknown} headers `Headers`, `Map` ou objet nu
 * @returns {boolean}
 */
export function estRefusDeSession(status, headers) {
  return status === 401 && lireEnTete(headers, EN_TETE_AUTH) === AUTH_EXPIREE;
}

/** Issues possibles d'une requête retenue. */
export const RESTAUREE = "restauree";
export const ABANDON = "abandon";

/**
 * Épisode de rétention : une session expirée, une ou plusieurs requêtes
 * d'artefacts retenues, une seule notification, une seule reprise.
 *
 * TROIS GARDE-FOUS, tous ici :
 *
 *  1. **Une seule notification par épisode.** v86 demande ses morceaux par
 *     rafales : sans étranglement, une session expirée produirait un message
 *     `session-expiree` par morceau en vol, donc autant de `pause()` et
 *     d'affichages de panneau. Seule la PREMIÈRE rétention d'un épisode
 *     demande à notifier ; les suivantes se contentent d'attendre.
 *  2. **Plafond de rétention.** Armé à l'ouverture de l'épisode, jamais
 *     réarmé : l'attente se compte depuis le premier refus, pas depuis le
 *     dernier morceau retenu — sinon une rafale continue repousserait le
 *     plafond sans fin.
 *  3. **La mort du worker se rattrape d'elle-même.** Le navigateur peut tuer
 *     le Service Worker pendant la rétention : la promesse meurt avec lui,
 *     v86 voit un échec réseau et déclenche son propre réessai. Propriété
 *     heureuse, et c'est pourquoi rien ici n'est persisté.
 *
 * @param {{
 *   plafondMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void,
 * }} [options]
 */
export function creerRetentionSession({
  plafondMs = PLAFOND_RETENTION_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** @type {Array<(issue: string) => void>} */
  let attentes = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let minuterie = null;
  let ouvert = false;

  /** @param {string} issue */
  function clore(issue) {
    if (!ouvert) return 0;
    ouvert = false;
    if (minuterie !== null) {
      clearTimer(minuterie);
      minuterie = null;
    }
    const liberees = attentes;
    attentes = [];
    for (const resoudre of liberees) resoudre(issue);
    return liberees.length;
  }

  return {
    /**
     * Retient une requête. `notifier` n'est vrai que pour la première
     * rétention de l'épisode : c'est l'étranglement du garde-fou 1.
     * @returns {{ notifier: boolean, attendre: Promise<string> }}
     */
    retenir() {
      const notifier = !ouvert;
      if (notifier) {
        ouvert = true;
        minuterie = setTimer(() => {
          minuterie = null;
          clore(ABANDON);
        }, plafondMs);
      }
      const attendre = new Promise((resoudre) => attentes.push(resoudre));
      return { notifier, attendre };
    },

    /**
     * La session est rétablie : toutes les requêtes retenues repartent, et
     * l'épisode se referme — un refus ultérieur notifiera donc à nouveau.
     * @returns {number} nombre de requêtes libérées
     */
    restaurer() {
      return clore(RESTAUREE);
    },

    /**
     * Abandon manuel (le visiteur renonce). Même effet que le plafond.
     * @returns {number}
     */
    abandonner() {
      return clore(ABANDON);
    },

    /** Un épisode est-il en cours ? */
    enCours: () => ouvert,
    /** Nombre de requêtes actuellement retenues. */
    retenues: () => attentes.length,
  };
}
