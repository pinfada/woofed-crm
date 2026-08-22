// Panneau « Inspecteur d'environnement » : transforme un échec de démarrage
// en étape d'installation guidée. Les variables manquantes sont détectées
// dans les logs de l'application (voir shared/env-detector.js), remplies en
// un clic pour les secrets internes, saisies pour les services tiers, puis
// injectées dans la VM qui relance l'application — sans reconstruire l'image.
//
// Convention : identifiants en anglais ; textes affichés, classes CSS et
// attributs data-* (appariés à env-drawer.css) en français.
//
// Le panneau se comporte comme un dialogue modal : il masque l'application
// derrière un voile, donc laisser le Tab s'échapper vers cette application
// invisible fait perdre le curseur au clavier — on tape dans un formulaire
// qu'on ne voit plus. D'où le contrat tenu ici : role/aria-modal, piège de
// focus tant qu'il est ouvert, `inert` dès qu'il est fermé, et retour du
// focus sur le déclencheur à la fermeture.
import { MANUAL_SOURCE } from "./shared/env-detector.js";

const STORAGE_KEY = "rib-env-overrides";

// Ce que Tab peut atteindre à l'intérieur du panneau. Le filtre porte sur
// `hidden` et jamais sur la géométrie (offsetParent, getBoundingClientRect) :
// hors navigateur — tests, rendu différé — tout paraît invisible et le piège
// se refermerait sur une liste vide, ce qui revient à ne rien piéger.
const FOCUSABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Plusieurs tiroirs dans une même page se voleraient leurs identifiants, et
// un aria-labelledby qui pointe vers le titre du voisin annonce le mauvais
// dialogue. Un compteur suffit à les garder distincts.
let instanceCount = 0;

/**
 * @param {{
 *   registry: ReturnType<typeof import("./shared/env-detector.js").createEnvironmentRegistry>,
 *   onApply: (variables: Record<string, string>) => Promise<void> | void,
 *   onLog?: (message: string) => void,
 * }} options
 */
export function createEnvironmentDrawer({ registry, onApply, onLog = () => {} }) {
  const elements = buildStructure();
  document.body.append(elements.overlay, elements.panel);

  let busy = false;
  // Résolus quand une réparation aboutit (environnement appliqué ET
  // application redémarrée). C'est le canal explicite qu'attend main.js —
  // aucune observation du DOM n'est nécessaire.
  const repairWaiters = [];

  hydrateFromStorage(registry);
  // Avant toute ouverture : sans ça, les deux actions restent offertes alors
  // qu'un tiroir jamais ouvert n'a par définition rien à générer ni à appliquer.
  syncActions();

  // Option « session seulement » (voir SECURITY.md) : décochée, les valeurs
  // restent en mémoire pour la session et l'enregistrement local est purgé.
  function persistIfAllowed() {
    if (elements.persistCheckbox.checked) {
      persist(registry);
    }
  }
  elements.persistCheckbox.addEventListener("change", () => {
    if (elements.persistCheckbox.checked) {
      persist(registry);
      announce("Les valeurs seront conservées sur ce navigateur.", "neutre");
    } else {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // stockage indisponible : rien à purger
      }
      announce("Valeurs en session seulement : rien ne sera conservé.", "neutre");
    }
  });

  elements.trigger.addEventListener("click", () => toggle(true));
  elements.closeButton.addEventListener("click", () => toggle(false));
  elements.overlay.addEventListener("click", () => toggle(false));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || elements.panel.dataset.ouvert !== "oui") return;
    // Sans preventDefault, la même touche peut en plus vider le champ en cours
    // de saisie chez certains navigateurs : on ferme, on ne fait que ça.
    event.preventDefault();
    toggle(false);
  });

  // Piège de focus plutôt que `inert` sur l'arrière-plan : le déclencheur vit
  // dans la coquille, donc rendre l'arrière-plan inerte rendrait aussi inerte
  // le bouton auquel il faut redonner le focus à la fermeture. Le piège reste
  // par ailleurs confiné à nos propres nœuds, alors que poser `inert` sur des
  // éléments que ce module ne possède pas casserait au moindre remaniement de
  // la coquille. aria-modal="true" couvre le lecteur d'écran, que Tab ne régit
  // pas. `inert` sert ici à l'inverse : neutraliser le panneau une fois fermé.
  elements.panel.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const stops = focusStops();
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  elements.mocksButton.addEventListener("click", () => {
    const wasFocused = document.activeElement === elements.mocksButton;
    const filledCount = registry.fillMocks();
    persistIfAllowed();
    render();
    // Générer supprime la raison d'être du bouton : il se désactive sous le
    // doigt, et un élément désactivé rend son focus à <body> — donc hors du
    // dialogue, là où le piège de focus ne rattrape plus rien. On reporte
    // explicitement sur l'action qui prend la suite.
    if (wasFocused && elements.mocksButton.disabled) {
      (elements.applyButton.disabled ? elements.closeButton : elements.applyButton).focus();
    }
    announce(
      filledCount === 0
        ? "Rien à générer : les secrets internes ont déjà une valeur."
        : `${filledCount} valeur${filledCount > 1 ? "s" : ""} générée${filledCount > 1 ? "s" : ""} au format attendu.`,
      filledCount === 0 ? "neutre" : "succes",
    );
  });

  elements.applyButton.addEventListener("click", async () => {
    const payload = registry.toPayload();
    if (Object.keys(payload).length === 0) {
      announce("Aucune valeur à appliquer : renseignez au moins une variable.", "erreur");
      return;
    }
    setBusy(true);
    announce("Écriture de l'environnement puis redémarrage de l'application…", "neutre");
    try {
      await onApply(payload);
      persistIfAllowed();
      announce("Application redémarrée avec les nouvelles variables.", "succes");
      render();
      for (const waiter of repairWaiters.splice(0)) waiter();
    } catch (error) {
      announce(`Échec : ${error.message}`, "erreur");
    } finally {
      setBusy(false);
    }
  });

  /**
   * Redonne le focus au bouton « Générer » d'une ligne reconstruite.
   * @param {string} name nom de la variable dont la ligne vient d'être refaite
   */
  function focusRowButton(name) {
    const row = Array.from(elements.body.querySelectorAll(".env-variable")).find(
      (candidate) => /** @type {HTMLElement} */ (candidate).dataset.variable === name,
    );
    const button = /** @type {HTMLElement | null} */ (
      row?.querySelector(".env-bouton-ligne") ?? null
    );
    button?.focus();
  }

  /** @returns {HTMLElement[]} arrêts de tabulation du panneau, dans l'ordre du DOM */
  function focusStops() {
    return /** @type {HTMLElement[]} */ (
      Array.from(elements.panel.querySelectorAll(FOCUSABLES))
    ).filter((element) => !element.closest("[hidden]"));
  }

  function toggle(open) {
    if (open) render();
    elements.panel.dataset.ouvert = open ? "oui" : "non";
    elements.overlay.dataset.ouvert = open ? "oui" : "non";
    elements.panel.setAttribute("aria-hidden", open ? "false" : "true");
    // Fermé, le panneau reste dans le DOM et hors écran : sans `inert`, ses
    // champs restent atteignables au Tab depuis la page, et on saisit des
    // valeurs dans un panneau invisible. Retiré avant le focus ci-dessous,
    // sinon la cible refuserait de le prendre.
    elements.panel.toggleAttribute("inert", !open);
    elements.trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) elements.closeButton.focus();
    else elements.trigger.focus();
  }

  function setBusy(value) {
    busy = value;
    elements.applyButton.textContent = value ? "Redémarrage en cours…" : "Appliquer et redémarrer";
    syncActions();
  }

  // Un bouton actif qui ne peut rien produire ment sur l'état du système :
  // le clic ne fait rien de visible et l'utilisateur va chercher la panne
  // ailleurs. Chaque action est donc coupée dès qu'elle n'a plus de matière,
  // en disant laquelle manque. La raison passe par aria-describedby et non
  // par `title` : une infobulle ne s'ouvre qu'à la souris et reste muette
  // pour un lecteur d'écran, exactement le public qui subit le blocage.
  function syncActions() {
    const variables = registry.list();
    const generatableCount = variables.filter((v) => v.value === "" && v.mockable).length;
    const appliableCount = Object.keys(registry.toPayload()).length;

    setAction(
      elements.mocksButton,
      elements.mocksHint,
      generatableCount > 0
        ? ""
        : variables.length === 0
          ? "Rien à générer tant qu'aucune variable n'est détectée."
          : "Rien à générer : les secrets internes ont déjà une valeur.",
    );
    setAction(
      elements.applyButton,
      elements.applyHint,
      appliableCount > 0
        ? ""
        : variables.length === 0
          ? "Rien à appliquer tant qu'aucune variable n'est détectée."
          : "Rien à appliquer : renseignez au moins une variable.",
    );
  }

  /**
   * @param {HTMLButtonElement} button action concernée
   * @param {HTMLElement} hint paragraphe portant la raison du blocage
   * @param {string} reason raison, ou chaîne vide si l'action est possible
   */
  function setAction(button, hint, reason) {
    const blocked = reason !== "";
    button.disabled = busy || blocked;
    hint.textContent = reason;
    hint.hidden = !blocked;
    // Un aria-describedby qui vise un élément masqué n'est jamais restitué :
    // on ne pose le lien que tant que la raison est réellement affichée.
    if (blocked) button.setAttribute("aria-describedby", hint.id);
    else button.removeAttribute("aria-describedby");
  }

  function announce(message, tone = "neutre") {
    elements.status.textContent = message;
    elements.status.dataset.ton = tone;
    if (tone !== "neutre") onLog(`[env] ${message}`);
  }

  function render() {
    const variables = registry.list();
    // « Bloquante » se juge sur la gravité du message, pas sur la famille :
    // une variable citée dans un simple avertissement laisse l'application
    // démarrer, seule la fonctionnalité associée reste inactive.
    const blockingCount = variables.filter(
      (v) => v.value === "" && v.severity === "critical",
    ).length;
    const optionalCount = variables.filter(
      (v) => v.value === "" && v.severity !== "critical",
    ).length;
    const readyCount = variables.filter((v) => v.value !== "").length;

    elements.blockingCounter.textContent = String(blockingCount);
    elements.optionalCounter.textContent = String(optionalCount);
    elements.readyCounter.textContent = String(readyCount);
    elements.trigger.dataset.alerte = blockingCount > 0 ? "oui" : "non";
    elements.badge.textContent = String(variables.length);
    elements.badge.hidden = variables.length === 0;
    syncActions();

    elements.body.replaceChildren();
    if (variables.length === 0) {
      const emptyMessage = document.createElement("p");
      emptyMessage.className = "env-vide";
      emptyMessage.textContent =
        "Aucune variable manquante détectée. Ce panneau se remplit tout seul si l'application signale une configuration incomplète.";
      elements.body.append(emptyMessage);
      return;
    }

    const explanation = document.createElement("p");
    explanation.className = "env-explication";
    explanation.textContent =
      "Détecté dans les journaux de démarrage. Les secrets internes acceptent une valeur générée ; les services tiers exigent vos identifiants, sans quoi la fonctionnalité correspondante reste inactive.";
    elements.body.append(explanation);

    for (const variable of variables) {
      elements.body.append(buildRow(variable));
    }
  }

  function buildRow(variable) {
    const rowState =
      variable.value !== "" ? "prete" : variable.severity === "critical" ? "critique" : "externe";
    const row = document.createElement("article");
    row.className = "env-variable";
    row.dataset.etat = rowState;
    row.dataset.variable = variable.name;

    const header = document.createElement("header");
    const name = document.createElement("span");
    name.className = "env-nom";
    name.textContent = variable.name;
    const pill = document.createElement("span");
    pill.className = "env-pastille";
    pill.textContent =
      rowState === "prete"
        ? "prête"
        : rowState === "critique"
          ? "bloque le démarrage"
          : "fonctionnalité inactive";
    const familyLabel = document.createElement("span");
    familyLabel.className = "env-famille";
    familyLabel.textContent = variable.label;
    header.append(name, pill, familyLabel);

    const inputWrap = document.createElement("div");
    inputWrap.className = "env-saisie";
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = variable.value;
    input.setAttribute("aria-label", `Valeur de ${variable.name}`);
    input.placeholder = variable.mockable
      ? "valeur générée ou saisie"
      : "identifiant fourni par le service";
    input.addEventListener("input", () => {
      registry.setValue(variable.name, input.value.trim());
      persistIfAllowed();
    });
    input.addEventListener("change", render);
    inputWrap.append(input);

    if (variable.mockable) {
      const generateButton = document.createElement("button");
      generateButton.type = "button";
      generateButton.className = "env-bouton-ligne";
      generateButton.textContent = "Générer";
      generateButton.addEventListener("click", () => {
        registry.setValue(variable.name, variable.generate());
        persistIfAllowed();
        // render() reconstruit toutes les lignes : le bouton qu'on vient de
        // presser n'existe plus, et son focus part sur <body>. On le rend à
        // son remplaçant, repéré par le nom de la variable.
        render();
        focusRowButton(variable.name);
      });
      inputWrap.append(generateButton);
    }

    row.append(header, inputWrap);

    if (variable.source && variable.source !== MANUAL_SOURCE) {
      const source = document.createElement("p");
      source.className = "env-source";
      source.textContent = variable.source;
      row.append(source);
    }
    return row;
  }

  return {
    element: elements.trigger,
    // Appelé pour chaque ligne de journal : ouvre le panneau à la première
    // variable réellement bloquante, pour que l'utilisateur voie le problème
    // sans avoir à lire les logs. Un simple avertissement ne l'interrompt pas.
    ingest(line) {
      const added = registry.ingestLogLine(line);
      if (added.length === 0) return [];
      render();
      const hasBlocking = registry
        .list()
        .some((v) => added.includes(v.name) && v.severity === "critical" && v.value === "");
      if (hasBlocking && !busy && elements.panel.dataset.ouvert !== "oui") {
        toggle(true);
      }
      return added;
    },
    open: () => toggle(true),
    refresh: render,
    announce,
    // Nombre de variables détectées encore sans valeur (pour décider d'une
    // nouvelle tentative de démarrage sans inspecter le DOM du panneau).
    missingCount: () => registry.list().filter((v) => v.value === "").length,
    // Nombre total de variables détectées, remplies ou non : c'est ce compte
    // qui décide d'offrir une nouvelle chance de réparation — une variable
    // déjà remplie peut porter une valeur erronée que l'utilisateur corrigera.
    detectedCount: () => registry.size,
    // Promesse résolue à la prochaine réparation réussie (env appliqué +
    // application relancée). Remplace l'ancienne observation par MutationObserver.
    nextRepair: () => new Promise((resolve) => repairWaiters.push(resolve)),
  };
}

function buildStructure() {
  const uid = `env-${(instanceCount += 1)}`;
  const panelId = `${uid}-panneau`;
  const titleId = `${uid}-titre`;
  const mocksHintId = `${uid}-aide-generer`;
  const applyHintId = `${uid}-aide-appliquer`;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "env-declencheur";
  trigger.dataset.alerte = "non";
  // Un déclencheur de panneau sans aria-expanded ne dit pas si le panneau est
  // déjà ouvert : au clavier on rappuie et on le referme sans le savoir.
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", panelId);
  const badge = document.createElement("span");
  badge.className = "compte";
  badge.hidden = true;
  trigger.append(document.createTextNode("Environnement"), badge);

  const overlay = document.createElement("div");
  overlay.className = "env-voile";
  overlay.dataset.ouvert = "non";

  const panel = document.createElement("aside");
  panel.id = panelId;
  panel.className = "env-panneau";
  panel.dataset.ouvert = "non";
  // role="dialog" + aria-modal : sans eux, un lecteur d'écran continue de
  // parcourir l'application derrière le voile comme si elle était utilisable.
  // Le titre visible fait office d'étiquette — dupliquer le texte dans un
  // aria-label le condamnerait à diverger du <h2> à la première retouche.
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", titleId);
  panel.setAttribute("aria-hidden", "true");
  panel.setAttribute("inert", "");
  panel.innerHTML = `
    <div class="env-entete">
      <h2 id="${titleId}">Inspecteur d'environnement</h2>
      <button type="button" class="env-fermer" aria-label="Fermer le panneau">✕</button>
    </div>
    <div class="env-resume">
      <div class="bloquantes"><span class="valeur">0</span><span class="libelle">bloquent le boot</span></div>
      <div class="facultatives"><span class="valeur">0</span><span class="libelle">non bloquantes</span></div>
      <div class="pretes"><span class="valeur">0</span><span class="libelle">prêtes</span></div>
    </div>
    <div class="env-corps"></div>
    <div class="env-pied">
      <div class="env-actions">
        <button type="button" class="env-action env-action--mocks">Générer les valeurs internes</button>
        <button type="button" class="env-action env-action--primaire">Appliquer et redémarrer</button>
      </div>
      <p class="env-aide" id="${mocksHintId}" hidden></p>
      <p class="env-aide" id="${applyHintId}" hidden></p>
      <label class="env-persistance">
        <input type="checkbox" checked class="env-conserver" />
        Conserver les valeurs sur ce navigateur
      </label>
      <p class="env-etat" data-ton="neutre" role="status"></p>
    </div>`;

  return {
    trigger,
    badge,
    overlay,
    panel,
    closeButton: /** @type {HTMLButtonElement} */ (panel.querySelector(".env-fermer")),
    body: /** @type {HTMLElement} */ (panel.querySelector(".env-corps")),
    status: /** @type {HTMLElement} */ (panel.querySelector(".env-etat")),
    mocksButton: /** @type {HTMLButtonElement} */ (panel.querySelector(".env-action--mocks")),
    applyButton: /** @type {HTMLButtonElement} */ (panel.querySelector(".env-action--primaire")),
    mocksHint: /** @type {HTMLElement} */ (panel.querySelector(`#${mocksHintId}`)),
    applyHint: /** @type {HTMLElement} */ (panel.querySelector(`#${applyHintId}`)),
    persistCheckbox: /** @type {HTMLInputElement} */ (panel.querySelector(".env-conserver")),
    blockingCounter: /** @type {HTMLElement} */ (panel.querySelector(".bloquantes .valeur")),
    optionalCounter: /** @type {HTMLElement} */ (panel.querySelector(".facultatives .valeur")),
    readyCounter: /** @type {HTMLElement} */ (panel.querySelector(".pretes .valeur")),
  };
}

// Les valeurs saisies survivent au rechargement : sans cela, chaque reprise
// d'instantané obligerait à tout ressaisir. Stockage local uniquement.
function persist(registry) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registry.toPayload()));
  } catch {
    // quota ou mode restreint : la perte de confort ne doit rien casser
  }
}

function hydrateFromStorage(registry) {
  try {
    registry.hydrate(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    // contenu illisible : on repart d'un registre vide
  }
}
