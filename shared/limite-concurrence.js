// Combien de requêtes peuvent traverser le pont EN MÊME TEMPS.
//
// POURQUOI LIMITER PLUTÔT QU'ÉLARGIR. v86 émule UN SEUL processeur, et le pont
// série n'a qu'un écrivain. Cinq rendus Rails simultanés n'apportent donc
// presque aucun parallélisme utile — mais beaucoup de contention, sur un fil
// d'exécution déjà saturé par l'émulation elle-même.
//
// Les mesures faites sur la démonstration de woofed-crm, sur un poste 1,5× plus
// lent que la référence, disent exactement cela :
//
//   2 requêtes concurrentes  → 200 / 200
//   4 requêtes concurrentes  → 502 partout
//   5 requêtes concurrentes  → 502 partout, et l'onglet fige
//   5 requêtes EN SÉQUENCE   → 200 partout
//
// La séquence réussit là où le parallélisme échoue : la file d'attente est donc
// le bon outil, et non un délai plus généreux. Les frames paresseuses d'une
// application partent par cinq ; elles passeront désormais deux par deux.
//
// Ce module ne connaît ni v86 ni le pont : il ordonnance des promesses, et
// c'est tout ce qu'il y a à éprouver.

/**
 * Ordonnanceur à jetons. Rend une fonction qui exécute une tâche dès qu'un
 * jeton se libère, et les rend dans l'ordre d'arrivée.
 *
 * Le jeton est rendu même si la tâche ÉCHOUE : sans cela une seule erreur
 * réduirait la capacité définitivement, jusqu'à bloquer toute la sandbox.
 * @param {number} maximum nombre de tâches simultanées (au moins 1)
 * @returns {<T>(tache: () => Promise<T>) => Promise<T>}
 */
export function creerLimiteConcurrence(maximum) {
  const plafond = Number.isFinite(maximum) && maximum >= 1 ? Math.floor(maximum) : 1;
  let enVol = 0;
  /** @type {Array<() => void>} */
  const file = [];

  const liberer = () => {
    enVol -= 1;
    const suivant = file.shift();
    if (suivant) suivant();
  };

  return async function executer(tache) {
    if (enVol >= plafond) {
      await new Promise((resolve) => file.push(() => resolve(undefined)));
    }
    enVol += 1;
    try {
      return await tache();
    } finally {
      liberer();
    }
  };
}
