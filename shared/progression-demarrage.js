// Ce que la coquille dit au visiteur pendant qu'elle démarre.
//
// Motivation, mesurée et non supposée. La recette `npm run test:bridage`
// (tests/bridage/) bride réellement le processeur du navigateur via Chrome
// DevTools Protocol et rejoue le démarrage de la sandbox publiée. Deux boots
// par taux, contexte neuf à chaque fois :
//
//   bridage    application annoncée    application VISIBLE    dont silence
//     1×            23,7 / 24,4 s          24,7 / 25,5 s        1,0 s
//     4×            26,8 / 26,8 s          30,4 / 31,2 s        3,7 / 4,4 s
//     6×            31,7 / 31,8 s          39,0 / 39,4 s        7,3 / 7,6 s
//     8×            37,1 / 39,6 s          49,7 / 54,0 s       12,6 / 14,5 s
//
// Deux enseignements en sortent, et ce module ne fait qu'y répondre :
//
//  1. le démarrage ne CASSE pas sur un processeur lent, il s'allonge — donc le
//     visiteur n'a pas besoin d'un message d'erreur, il a besoin de savoir où
//     il en est et que ce n'est pas bloqué ;
//  2. l'étape la moins visible est la dernière : entre « badge HTTP au vert » et
//     « première page affichée », la coquille ne disait plus rien. Cette
//     colonne « silence » vaut 1 s sur un poste de bureau, mais 12 à 15 s sur
//     un appareil d'entrée de gamme — un cadre vide sous une rangée de badges
//     tout verts, où plus rien ne distingue « ça arrive » de « c'est bloqué ».
//
// Logique pure : ni DOM, ni horloge réelle. Le branchement vit dans main.js.

/**
 * Étapes du démarrage, dans l'ordre. La dernière — le rendu de la première
 * page par la VM — n'était signalée nulle part avant la mesure sous bridage.
 */
export const ETAPES_DEMARRAGE = [
  { cle: "serviceWorker", titre: "Installation du proxy Service Worker" },
  { cle: "isolation", titre: "Réinjection des en-têtes d'isolation" },
  { cle: "vm", titre: "Téléchargement des artefacts et démarrage de la VM" },
  { cle: "application", titre: "Réveil du serveur applicatif dans la VM" },
  { cle: "premierePage", titre: "Rendu de la première page par la VM" },
];

/**
 * Bornes du démarrage COMPLET mesuré sur la sandbox de référence, jusqu'à la
 * première page visible : du poste de bureau non bridé (25 s) au processeur
 * bridé 8× (54 s), soit un téléphone d'entrée de gamme. Elles servent à dire
 * au visiteur ce qui est « normal », en chiffres qu'on peut produire.
 */
export const REFERENCE_MS = { rapide: 25_000, lent: 54_000 };

/**
 * Au-delà, l'attente sort de tout ce qui a été mesuré : on cesse de laisser le
 * visiteur deviner. Placé une petite marge au-dessus du pire cas mesuré (54 s),
 * pour ne pas s'excuser d'un démarrage qui, lui, est normal.
 */
export const SEUIL_LENTEUR_MS = 75_000;

/** Deuxième palier : environ trois fois le pire cas mesuré. Là, on le dit franchement. */
export const SEUIL_TRES_LENT_MS = 150_000;

/**
 * @typedef {{
 *   position: number, total: number, titre: string,
 *   secondes: number, lenteur: "normale" | "lente" | "tres-lente",
 *   texte: string,
 * }} EtatProgression
 */

/**
 * État affichable du démarrage.
 * @param {{ cle: string, ecouleMs: number }} entree
 * @returns {EtatProgression}
 */
export function etatProgression({ cle, ecouleMs }) {
  const position = ETAPES_DEMARRAGE.findIndex((etape) => etape.cle === cle);
  if (position < 0) throw new Error(`Étape de démarrage inconnue : ${cle}`);
  const titre = ETAPES_DEMARRAGE[position].titre;
  const secondes = Math.max(0, Math.floor(ecouleMs / 1000));
  const lenteur = niveauLenteur(ecouleMs);
  return {
    position: position + 1,
    total: ETAPES_DEMARRAGE.length,
    titre,
    secondes,
    lenteur,
    texte:
      `Étape ${position + 1}/${ETAPES_DEMARRAGE.length} · ${titre} · ${secondes} s` +
      complement(lenteur),
  };
}

/**
 * @param {number} ecouleMs
 * @returns {"normale" | "lente" | "tres-lente"}
 */
function niveauLenteur(ecouleMs) {
  if (ecouleMs >= SEUIL_TRES_LENT_MS) return "tres-lente";
  if (ecouleMs >= SEUIL_LENTEUR_MS) return "lente";
  return "normale";
}

/**
 * Phrase ajoutée quand l'attente dépasse ce qui a été mesuré. Elle dit deux
 * choses et rien d'autre : ce qui est normal, et que ce n'est pas bloqué.
 * @param {"normale" | "lente" | "tres-lente"} lenteur
 * @returns {string}
 */
function complement(lenteur) {
  if (lenteur === "normale") return "";
  const reference = `${Math.round(REFERENCE_MS.rapide / 1000)}–${Math.round(REFERENCE_MS.lent / 1000)} s mesurées`;
  if (lenteur === "lente") {
    return ` — plus lent que la référence (${reference}) : ce processeur émule la VM au ralenti, mais rien n'est bloqué.`;
  }
  return (
    ` — bien au-delà de la référence (${reference}). Sur un appareil très lent, l'application finit` +
    " par s'afficher ; la sandbox n'abandonne pas d'elle-même."
  );
}

/**
 * Indicateur de démarrage : garde l'étape courante et rafraîchit l'affichage à
 * intervalle régulier, pour que le compteur de secondes avance même quand rien
 * d'autre ne se passe — c'est précisément le cas pendant le rendu de la
 * première page, la plus longue attente muette mesurée.
 *
 * Minuteries injectées : testable sans navigateur.
 * @param {{
 *   afficher: (etat: EtatProgression) => void,
 *   terminer?: () => void,
 *   maintenant?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void,
 *   rafraichissementMs?: number,
 * }} options
 */
export function creerIndicateurDemarrage({
  afficher,
  terminer = () => {},
  maintenant = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  rafraichissementMs = 1_000,
}) {
  const debut = maintenant();
  let cle = null;
  let minuterie = null;

  function rendre() {
    if (cle === null) return;
    afficher(etatProgression({ cle, ecouleMs: maintenant() - debut }));
  }

  return {
    /**
     * Déclare l'étape en cours. Rendu immédiat, puis rafraîchi à la seconde.
     * @param {string} nouvelleCle
     */
    etape(nouvelleCle) {
      cle = nouvelleCle;
      rendre();
      if (minuterie === null) minuterie = setTimer(rendre, rafraichissementMs);
    },
    /** Démarrage abouti (ou abandonné) : le compteur n'a plus lieu d'être. */
    fin() {
      if (minuterie !== null) {
        clearTimer(minuterie);
        minuterie = null;
      }
      cle = null;
      terminer();
    },
    /** Durée écoulée depuis la création, en millisecondes. */
    ecouleMs: () => maintenant() - debut,
  };
}
