// Veille de la VM quand l'onglet est masqué.
//
// L'émulation x86 consomme le processeur du visiteur même quand personne ne
// regarde : un onglet laissé en arrière-plan continue de payer le prix plein.
// Ce contrôleur suspend la VM après un délai de grâce (les allers-retours
// rapides entre onglets ne doivent pas déclencher un cycle pause/reprise) et
// la reprend dès que l'onglet redevient visible.
//
// Logique pure : les minuteries et les actions sont injectées, donc testables
// sans navigateur ni horloge réelle. Le branchement sur `visibilitychange`
// vit dans main.js.

/**
 * Délai de grâce avant suspension. Assez long pour absorber un changement
 * d'onglet furtif, assez court pour que la batterie du visiteur en profite.
 */
export const DELAI_VEILLE_MS = 15_000;

/**
 * @param {{
 *   pause: () => void,
 *   resume: () => void,
 *   delayMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void,
 * }} options
 * @returns {{ hidden: () => void, visible: () => void, isPaused: () => boolean }}
 */
export function createVeilleController({
  pause,
  resume,
  delayMs = DELAI_VEILLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let paused = false;

  return {
    /** L'onglet vient d'être masqué : armer la suspension différée. */
    hidden() {
      if (timer !== null || paused) return;
      timer = setTimer(() => {
        timer = null;
        paused = true;
        pause();
      }, delayMs);
    },
    /** L'onglet redevient visible : annuler ou reprendre, jamais les deux. */
    visible() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (paused) {
        paused = false;
        resume();
      }
    },
    isPaused: () => paused,
  };
}
