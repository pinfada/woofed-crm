// Élection de l'onglet qui fait tourner la sandbox.
//
// Deux onglets ouverts sur la même sandbox, c'était deux émulations x86 pour
// un seul service rendu : le processeur du visiteur payait double, et le
// Service Worker — qui ne retient qu'UN pont vers une VM — envoyait les
// requêtes de tout le monde dans la VM du dernier onglet annoncé. Un billet
// créé dans un onglet apparaissait dans l'autre, dont la VM ne le connaissait
// pas.
//
// Arbitrage retenu : Web Locks. Un verrou exclusif nommé d'après le chemin de
// la coquille ; l'onglet qui le tient est l'onglet actif. Le navigateur le rend
// LUI-MÊME à la fermeture ou au rechargement de l'onglet, ce qui rend tout état
// zombie impossible — c'est ce qu'un dispositif à battements de cœur
// (BroadcastChannel + minuterie) ne sait pas garantir sans code de rattrapage.
//
// Deux options du même appel couvrent les deux gestes :
//   - `ifAvailable` : ne prend le verrou que s'il est libre, sans jamais
//     attendre. C'est la candidature au chargement d'un onglet.
//   - `steal` : arrache le verrou à son tenant. C'est la reprise explicite par
//     le visiteur, et le tenant précédent l'apprend par le rejet `AbortError`
//     de sa propre requête (vérifié sur les trois moteurs).
//
// Logique pure : le gestionnaire de verrous est injecté, donc simulable en
// test sans navigateur. Le branchement sur `navigator.locks`, le panneau
// affiché au visiteur et la libération de la VM vivent dans main.js.

/** Préfixe du nom de verrou, pour ne pas collisionner avec un autre usage. */
export const PREFIXE_VERROU = "railsbox-sandbox";

export const ROLE_PRINCIPAL = "principal";
export const ROLE_SECONDAIRE = "secondaire";

/**
 * Nom du verrou d'une sandbox. Les verrous sont partagés par origine : sur un
 * Pages d'utilisateur, deux démonstrations cohabitent sur la même origine sous
 * des chemins différents. Le chemin de la coquille entre donc dans le nom,
 * sans quoi ouvrir une démonstration mettrait l'autre en attente.
 * @param {string} cheminBase chemin de la coquille (« / », « /railsbox-demo/ »)
 * @returns {string}
 */
export function nomVerrou(cheminBase) {
  const brut = typeof cheminBase === "string" ? cheminBase.trim() : "";
  const avecTete = brut.startsWith("/") ? brut : `/${brut}`;
  const chemin = avecTete.endsWith("/") ? avecTete : `${avecTete}/`;
  return `${PREFIXE_VERROU}:${chemin}`;
}

/**
 * Web Locks est-il utilisable ici ? Disponible sur les trois moteurs, mais
 * réservé aux contextes sécurisés : sans lui on ne sait pas arbitrer, et la
 * coquille démarre comme avant plutôt que de refuser de démarrer.
 * @param {any} portee portée globale (window)
 * @returns {boolean}
 */
export function verrousDisponibles(portee) {
  return typeof portee?.navigator?.locks?.request === "function";
}

/**
 * Contrat du gestionnaire de verrous, décrit ici plutôt qu'emprunté à lib.dom :
 * c'est aussi la forme que doit respecter le double utilisé en test.
 *
 * @typedef {{ name: string, mode: string }} Verrou
 * @typedef {{ mode?: string, ifAvailable?: boolean, steal?: boolean }} OptionsVerrou
 * @typedef {{
 *   request: (
 *     nom: string,
 *     options: OptionsVerrou,
 *     callback: (verrou: Verrou | null) => any,
 *   ) => Promise<any>,
 * }} GestionnaireVerrous
 */

/**
 * @param {{
 *   verrous: GestionnaireVerrous,
 *   nom: string,
 *   onEviction?: () => void,
 * }} options
 */
export function creerElection({ verrous, nom, onEviction = () => {} }) {
  /** @type {string | null} */
  let role = null;
  /** @type {(() => void) | null} */
  let rendreVerrou = null;

  /**
   * Une requête de verrou, ramenée à la seule question qui nous intéresse :
   * l'a-t-on obtenu ? La promesse rendue par `request`, elle, ne se règle qu'à
   * la libération — c'est par son REJET qu'on apprend s'être fait évincer.
   * @param {OptionsVerrou} options
   * @returns {Promise<boolean>}
   */
  function demander(options) {
    /** @type {(obtenu: boolean) => void} */
    let annoncer;
    const verdict = new Promise((resolve) => {
      annoncer = resolve;
    });
    const tenue = verrous.request(nom, options, (verrou) => {
      if (!verrou) {
        annoncer(false);
        return undefined;
      }
      annoncer(true);
      // Tenu tant que cette promesse ne se règle pas : c'est ce qui garde le
      // verrou pour toute la vie de l'onglet.
      /** @type {Promise<void>} */
      const tenu = new Promise((resolve) => {
        rendreVerrou = resolve;
      });
      return tenu;
    });
    tenue.then(
      () => {},
      () => {
        // Rejet : un autre onglet a arraché le verrou (`steal`). Seul signal
        // d'éviction, et les trois moteurs l'émettent.
        if (role !== ROLE_PRINCIPAL) return;
        role = ROLE_SECONDAIRE;
        rendreVerrou = null;
        onEviction();
      },
    );
    return verdict;
  }

  /**
   * @param {OptionsVerrou} options
   * @returns {Promise<string>}
   */
  async function prendre(options) {
    if (role === ROLE_PRINCIPAL) return role;
    role = (await demander(options)) ? ROLE_PRINCIPAL : ROLE_SECONDAIRE;
    return role;
  }

  return {
    /** @returns {string | null} rôle courant, `null` avant toute candidature */
    role: () => role,

    /**
     * Candidature au chargement : on prend le verrou s'il est libre, on ne se
     * met JAMAIS en file d'attente. Un onglet secondaire reste secondaire tant
     * que le visiteur ne demande rien — sans quoi la fermeture de l'onglet
     * actif ferait démarrer une VM dans un onglet d'arrière-plan que personne
     * ne regarde, exactement la dépense qu'on cherche à supprimer.
     * @returns {Promise<string>}
     */
    candidater: () => prendre({ mode: "exclusive", ifAvailable: true }),

    /**
     * Reprise explicite par le visiteur : arrache le verrou à l'onglet qui le
     * tient, lequel est notifié et libère sa VM.
     * @returns {Promise<string>}
     */
    reprendre: () => prendre({ mode: "exclusive", steal: true }),

    /** Rend le verrou volontairement (sans évincer personne). */
    relacher() {
      if (!rendreVerrou) return;
      const rendre = rendreVerrou;
      rendreVerrou = null;
      role = ROLE_SECONDAIRE;
      rendre();
    },
  };
}
