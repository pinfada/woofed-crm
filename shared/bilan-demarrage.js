// Le bilan de démarrage : ce qu'on affiche à la fin du boot, et pourquoi.
//
// Ce que ce module existe pour dire. Une sandbox railsbox met environ une
// minute à devenir utilisable, et le mainteneur attribue naturellement cette
// minute à railsbox. Mesuré sur une application réelle, le partage était
// pourtant de 42 % pour railsbox et 58 % pour l'application — dont 152 requêtes
// SQL sans aucun cache sur la première page. Ce chiffre-là est le seul que le
// mainteneur peut corriger, et il était noyé dans du JSON au milieu du journal.
//
// Pourquoi un module à part. Ces fonctions sont PURES : elles ne touchent ni au
// DOM, ni à l'horloge, ni à l'état du boot — tout leur arrive en paramètre.
// C'est ce qui les rend vérifiables sans navigateur, là où `main.js` exige un
// vrai Chromium. Les chiffres que l'on met en avant sont précisément ceux qu'il
// faut couvrir : une part fausse est plus nuisible qu'une part absente, parce
// qu'elle envoie chercher au mauvais endroit.

/**
 * Fragment de la ligne « Completed 200 OK in 24292ms (Views: 7335.6ms |
 * ActiveRecord: 8026.6ms (152 queries, 0 cached)) ».
 *
 * On ne lit QUE le compte de requêtes : le reste du format a bougé plusieurs
 * fois d'une version de Rails à l'autre, ce fragment-là non. Et s'il bouge
 * quand même, la ligne du bilan disparaît — elle ne ment pas.
 *
 * Le singulier est accepté explicitement : `queries?` ne reconnaît que
 * « querie » et « queries », jamais « query ». Une page à une seule requête
 * perdait donc sa ligne de bilan, en silence — le genre de trou qu'on ne voit
 * que sur la page la plus simple de l'application.
 */
export const MOTIF_REQUETES_SQL = /\((\d+) quer(?:y|ies)(?:, (\d+) cached)?\)/;

/**
 * @typedef {object} Jalons
 * @property {number} debut instant d'entrée dans la coquille
 * @property {number|null} vmRepond instant où la VM a répondu, null si jamais
 * @property {number|null} premierRendu instant du premier rendu applicatif
 */

/**
 * @typedef {object} RequetesSql
 * @property {number} requetes nombre de requêtes de la page
 * @property {number|null} cachees nombre servi par le cache, null si non dit
 */

/**
 * Lit le compte de requêtes SQL dans une ligne de journal applicatif.
 *
 * Défensive par construction : une ligne qui ne correspond pas rend `null`, et
 * le bilan omet simplement cette information. Jamais d'exception — cette
 * fonction est sur le chemin de CHAQUE ligne de console de la VM, une levée y
 * arrêterait le journal entier.
 * @param {string} texte ligne de journal
 * @returns {RequetesSql|null} compte lu, ou null si la ligne ne le porte pas
 */
export function lireRequetesSql(texte) {
  if (typeof texte !== "string") return null;
  const trouve = MOTIF_REQUETES_SQL.exec(texte);
  if (!trouve) return null;
  const requetes = Number(trouve[1]);
  if (!Number.isFinite(requetes)) return null;
  const cachees = Number(trouve[2]);
  return { requetes, cachees: Number.isFinite(cachees) ? cachees : null };
}

/**
 * Durée en secondes, une décimale.
 *
 * Pas plus : une milliseconde affichée sur un démarrage de 55 s donnerait une
 * fausse idée de la précision de la mesure, qui dépend de l'ordonnancement du
 * navigateur.
 * @param {number} ms durée en millisecondes
 * @returns {string} durée lisible, en français
 */
export function formatSecondes(ms) {
  const secondes = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000;
  const chiffres = secondes.toLocaleString("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${chiffres} s`;
}

/**
 * Part d'un total, en pourcentage entier.
 *
 * C'est le chiffre qui fait le travail : « 24,3 s » ne dit rien, « 24,3 s
 * (58 %) » dit où chercher.
 * @param {number} part durée de la part
 * @param {number} total durée totale
 * @returns {string} suffixe entre parenthèses, vide si le total est nul
 */
export function partPourcent(part, total) {
  if (!(total > 0)) return "";
  return ` (${Math.round((part / total) * 100)} %)`;
}

/**
 * Les mesures du bilan, dans l'ordre où on veut les lire.
 *
 * Sans jalon de réponse VM, le partage n'a pas de sens : on ne le fabrique pas,
 * on rend le total seul. Une part inventée enverrait le mainteneur optimiser
 * la mauvaise moitié.
 * @param {{jalons: Jalons, requetesSql?: RequetesSql|null, maintenant?: number}} entree état mesuré
 * @returns {{libelle: string, valeur: string}[]} lignes du bilan
 */
export function mesuresDemarrage({ jalons, requetesSql = null, maintenant = Date.now() }) {
  const fin = jalons.premierRendu ?? maintenant;
  const total = fin - jalons.debut;
  const mesures = [{ libelle: "Démarrage total", valeur: formatSecondes(total) }];

  if (jalons.vmRepond !== null && jalons.vmRepond !== undefined) {
    const railsbox = jalons.vmRepond - jalons.debut;
    const application = fin - jalons.vmRepond;
    mesures.push(
      {
        libelle: "Part railsbox (proxy, VM, serveur)",
        valeur: formatSecondes(railsbox) + partPourcent(railsbox, total),
      },
      {
        libelle: "Part application (premier rendu)",
        valeur: formatSecondes(application) + partPourcent(application, total),
      },
    );
  }

  // BONUS, et strictement défensif : présent seulement si l'application l'a
  // écrit dans un format qu'on a su lire.
  if (requetesSql) {
    const cachees = requetesSql.cachees === null ? "" : ` (${requetesSql.cachees} en cache)`;
    mesures.push({
      libelle: "Requêtes SQL de la page",
      valeur: `${requetesSql.requetes}${cachees}`,
    });
  }
  return mesures;
}
