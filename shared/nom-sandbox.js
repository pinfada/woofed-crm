// Le nom de la sandbox : ce que l'onglet annonce, et ce que le titre affiche.
//
// Ce que ce module répare. La coquille se nommait elle-même — « railsbox 2.1 ·
// VM Linux x86 dans le navigateur » — alors que le visiteur venait pour
// l'APPLICATION, qui n'apparaissait nulle part. Dans un historique de
// navigation, cet onglet ne voulait rien dire.
//
// Pourquoi c'est plus délicat qu'il n'y paraît. Le nom vient de
// `v86-config.json`, un fichier TÉLÉCHARGÉ : sur une sandbox publiée, c'est une
// donnée tierce qui finit dans le `<title>` et dans un `<h1>`. On la traite
// donc comme une entrée non fiable — caractères de contrôle et marques
// invisibles retirés, longueur bornée. C'est le vecteur habituel des titres
// trompeurs, et il ne coûte rien de le fermer.

/** Nom rendu quand rien ne se déduit. Neutre, jamais vide. */
export const NOM_PAR_DEFAUT = "Application Rails";

/** Au-delà, un titre ne tient plus dans un onglet et sert surtout à tromper. */
export const LONGUEUR_MAX_NOM = 60;

/**
 * Nettoie une valeur venue de la configuration.
 *
 * Tout ce qui n'est ni lettre, ni chiffre, ni ponctuation, ni symbole, ni
 * espace tombe : les caractères de contrôle et les marques invisibles n'ont
 * rien à faire dans un titre.
 * @param {unknown} valeur valeur brute
 * @returns {string} nom propre, vide si rien d'exploitable
 */
export function nettoyerNom(valeur) {
  if (typeof valeur !== "string") return "";
  const propre = valeur
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\p{Zs}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return propre.slice(0, LONGUEUR_MAX_NOM);
}

/**
 * « disks/jiyufit-app.ext2.zst » → « jiyufit ».
 *
 * Le suffixe « -app » nomme le montage, pas la sandbox, et la compression est
 * un détail de publication.
 * @param {unknown} chemin chemin d'artefact
 * @returns {string} nom déduit, vide si le chemin n'en porte pas
 */
export function nomDepuisChemin(chemin) {
  if (typeof chemin !== "string") return "";
  const fichier = chemin.split("/").pop() ?? "";
  return fichier.replace(/\.(?:ext2|img|bin)(?:\.(?:zst|gz))?$/i, "").replace(/-app$/i, "");
}

/**
 * Déduit le nom de la sandbox d'une configuration.
 *
 * Dans l'ordre : le champ explicite s'il existe, puis le disque applicatif,
 * puis en dernier le disque unique des configurations mono-disque héritées.
 * @param {Record<string, any> | null | undefined} config configuration chargée
 * @returns {string} nom de la sandbox, jamais vide
 */
export function nomSandbox(config) {
  const candidats = [config?.name, nomDepuisChemin(config?.appDisk), nomDepuisChemin(config?.disk)];
  for (const candidat of candidats) {
    const propre = nettoyerNom(candidat);
    if (propre) return propre;
  }
  return NOM_PAR_DEFAUT;
}
