// Déclarations d'ambiance pour le typecheck (tsc --checkJs).
// Les globales injectées par des scripts classiques (libv86.js, CheerpX) et
// les hooks de diagnostic n'existent pas dans lib.dom : on les déclare ici.

// Le backend CheerpX est chargé depuis le CDN de Leaning Technologies : le
// module distant n'a pas de déclarations de types locales.
declare module "https://*";

interface Window {
  /** Hook de diagnostic exposé pour DevTools (façade VM courante). */
  __vm?: unknown;
  /** Constructeur v86 injecté par vendor/v86/libv86.js (nom moderne). */
  V86?: new (options: Record<string, unknown>) => any;
  /** Constructeur v86 injecté par libv86.js (nom historique). */
  V86Starter?: new (options: Record<string, unknown>) => any;
}
