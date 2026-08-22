// Détection des variables d'environnement manquantes à partir des logs de
// boot de l'application, et fabrication de valeurs factices au bon format.
//
// Aucune heuristique ne peut deviner *a priori* qu'une application refuse de
// démarrer sans telle clé : ces exigences sont des `raise` propres à chaque
// base de code. En revanche, l'application le dit très clairement quand elle
// échoue — il suffit de l'écouter. Ce module transforme ces messages en
// actions proposables à l'utilisateur.

// Mots-clés signalant qu'une configuration fait défaut. Le nom de la
// variable se trouve AVANT (« FOO must be set ») ou APRÈS (« Missing FOO »).
const KEYWORDS_AFTER_VARIABLE =
  /(?:must be (?:set|at least|provided|configured|present|defined)|is missing|is required|not configured|missing or empty|manquantes?|manquants?|absentes?|absents?|requises?|requis|obligatoires?)/gi;
const KEYWORDS_BEFORE_VARIABLE =
  /(?:key not found:|missing required environment variable:?|missing|manquante?)/gi;

// Fenêtre de recherche autour du mot-clé. Assez large pour « Missing required
// environment variable: FOO », assez étroite pour ne pas ramasser la moitié
// d'une ligne de journal.
const SEARCH_WINDOW = 70;

// Forme d'un nom de variable d'environnement : au moins un souligné. C'est
// la règle qui écarte FATAL, WARN, DEVISE ou PRODUCTION — des mots en
// majuscules qui traînent dans les journaux sans être des variables. Les
// rares variables d'un seul mot (PORT, TZ) ont presque toujours une valeur
// par défaut, donc ne bloquent pas un démarrage.
const VARIABLE_SHAPE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

// Provenance d'une variable ajoutée à la main (affichée telle quelle, mais
// aussi testée par l'UI : exportée pour éviter la comparaison de littéraux).
export const MANUAL_SOURCE = "ajout manuel";

// Familles reconnues : classe la variable et fournit un générateur adapté.
// « internal » = secret propre au déploiement, factice acceptable.
// « external » = identifiant d'un service tiers : aucune valeur inventée ne
// peut fonctionner, l'utilisateur doit la fournir (ou laisser la
// fonctionnalité désactivée).
const FAMILIES = [
  {
    test: /SECRET_KEY_BASE$/,
    kind: "internal",
    label: "Clé de session Rails",
    generate: () => randomHex(64),
  },
  {
    test: /(SIGNING|PSEUDONYMIZATION|ENCRYPTION|DERIVATION|HMAC|EVIDENCE)/,
    kind: "internal",
    label: "Clé de chiffrement / signature",
    generate: () => randomHex(32),
  },
  {
    test: /_SALT$/,
    kind: "internal",
    label: "Sel de dérivation",
    generate: () => randomHex(32),
  },
  {
    test: /^STRIPE_SECRET_KEY$/,
    kind: "external",
    label: "Stripe — clé secrète",
    // Format imposé par les validations Rails habituelles (sk_live_…) ; la
    // valeur reste inerte, aucun appel réel ne peut aboutir.
    generate: () => `sk_live_${randomAlphanumeric(24)}`,
    mockable: true,
  },
  {
    test: /^STRIPE_PUBLIC_KEY$|^STRIPE_PUBLISHABLE_KEY$/,
    kind: "external",
    label: "Stripe — clé publique",
    generate: () => `pk_live_${randomAlphanumeric(24)}`,
    mockable: true,
  },
  {
    test: /_PASSWORD$/,
    kind: "internal",
    label: "Mot de passe interne",
    generate: () => randomHex(16),
  },
  {
    test: /_USERNAME$|_USER$/,
    kind: "internal",
    label: "Identifiant interne",
    generate: () => "demo",
  },
  {
    test: /_EMAIL$/,
    kind: "internal",
    label: "Adresse de contact",
    generate: () => "demo@exemple.local",
  },
  {
    test: /_URL$|_HOST$|_ENDPOINT$/,
    kind: "external",
    label: "Adresse de service",
    generate: () => "",
  },
  {
    test: /(API_KEY|ACCESS_KEY|CLIENT_ID|CLIENT_SECRET|TOKEN|WEBHOOK)/,
    kind: "external",
    label: "Identifiant de service tiers",
    generate: () => "",
  },
];

const FALLBACK_FAMILY = {
  kind: "internal",
  label: "Valeur de configuration",
  generate: () => "demo",
};

// Variables que l'application réclamerait à tort : elles appartiennent à
// l'infrastructure du bac à sable, pas à l'application.
const IGNORED = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "PWD",
  "RAILS_ENV",
  "RACK_ENV",
]);

export function classifyVariable(name) {
  const family = FAMILIES.find((candidate) => candidate.test.test(name)) ?? FALLBACK_FAMILY;
  return {
    name,
    kind: family.kind,
    label: family.label,
    // Une variable externe n'est « simulable » que si un format factice
    // satisfait les validations locales (cas de Stripe).
    mockable: family.kind === "internal" || family.mockable === true,
    generate: family.generate,
  };
}

// Les journaux Rails préfixent leurs messages d'une étiquette entre crochets
// ([DEVISE], [STRIPE], [Metrics]…). Ce sont des noms de sous-systèmes, pas
// des variables : les retirer évite de proposer « DEVISE » à l'utilisateur.
function stripLogTags(line) {
  return line.replace(/\[[A-Za-z][A-Za-z0-9_:.-]*\]/g, " ");
}

// « GOOGLE_CLIENT_ID/SECRET » désigne deux variables : le préfixe commun est
// recollé sur le second membre.
function expandSlashPairs(line) {
  return line.replace(
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_([A-Z0-9]+)\/([A-Z0-9]+)\b/g,
    (_all, prefix, first, second) => `${prefix}_${first} ${prefix}_${second}`,
  );
}

function collectVariables(fragment, found) {
  VARIABLE_SHAPE.lastIndex = 0;
  let token = VARIABLE_SHAPE.exec(fragment);
  while (token !== null) {
    if (!IGNORED.has(token[0])) found.add(token[0]);
    token = VARIABLE_SHAPE.exec(fragment);
  }
}

// Extrait les noms de variables citées dans une ligne de log d'échec.
//
// Approche par fenêtre plutôt que par capture directe : une expression du
// type « (VARIABLE).{0,40}(mot-clé) » capture le PREMIER jeton en majuscules
// de la ligne, qui est souvent le mauvais — sur
// `{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}` elle
// retenait « FATAL ». On repère donc le mot-clé, puis on collecte les jetons
// de forme « variable » dans son voisinage immédiat, ce qui capture aussi
// les paires (GOOGLE_CLIENT_ID/SECRET → les deux).
export function detectVariablesInLine(rawLine) {
  const line = expandSlashPairs(stripLogTags(rawLine));
  const found = new Set();

  KEYWORDS_AFTER_VARIABLE.lastIndex = 0;
  let keyword = KEYWORDS_AFTER_VARIABLE.exec(line);
  while (keyword !== null) {
    collectVariables(line.slice(Math.max(0, keyword.index - SEARCH_WINDOW), keyword.index), found);
    keyword = KEYWORDS_AFTER_VARIABLE.exec(line);
  }

  KEYWORDS_BEFORE_VARIABLE.lastIndex = 0;
  keyword = KEYWORDS_BEFORE_VARIABLE.exec(line);
  while (keyword !== null) {
    const start = keyword.index + keyword[0].length;
    collectVariables(line.slice(start, start + SEARCH_WINDOW), found);
    keyword = KEYWORDS_BEFORE_VARIABLE.exec(line);
  }

  return [...found];
}

// Une variable citée dans un avertissement ne bloque pas le démarrage : la
// fonctionnalité concernée est simplement désactivée. Les journaux Rails en
// JSON portent leur niveau, autant s'en servir plutôt que de tout traiter
// comme critique — c'est la différence entre « à corriger » et « à savoir ».
export function severityOfLine(line) {
  if (/"severity"\s*:\s*"(WARN|WARNING|INFO|DEBUG)"/i.test(line)) return "warning";
  if (/"severity"\s*:\s*"(ERROR|FATAL)"/i.test(line)) return "critical";
  if (/\b(FATAL|cannot boot|aborted!|Exiting)\b/i.test(line)) return "critical";
  if (/\bwarning\b|\bWARN\b/i.test(line)) return "warning";
  return "critical";
}

// Cas particulier fréquent : Rails signale les trois clés de chiffrement
// d'un bloc, sans les nommer une par une.
const ENCRYPTION_TRIPLET = [
  "ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY",
  "ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY",
  "ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT",
];

export function expandKnownGroups(names, line) {
  if (/encryption keys?/i.test(line) || /clés? de chiffrement/i.test(line)) {
    return [...new Set([...names, ...ENCRYPTION_TRIPLET])];
  }
  return names;
}

// Registre des variables détectées, alimenté en continu par les logs.
export function createEnvironmentRegistry() {
  const variables = new Map(); // nom -> { …classification, severity, value, source }

  return {
    get size() {
      return variables.size;
    },
    list() {
      return [...variables.values()].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "internal" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    },
    // Retourne les noms nouvellement découverts (pour signaler à l'UI).
    ingestLogLine(line) {
      const names = expandKnownGroups(detectVariablesInLine(line), line);
      const severity = severityOfLine(line);
      const added = [];
      for (const name of names) {
        if (variables.has(name)) {
          // Une même variable peut d'abord apparaître en avertissement puis
          // en erreur fatale : on retient toujours le pire des deux.
          if (severity === "critical") variables.get(name).severity = "critical";
          continue;
        }
        variables.set(name, {
          ...classifyVariable(name),
          severity,
          value: "",
          source: line.slice(0, 200),
        });
        added.push(name);
      }
      return added;
    },
    add(name) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || variables.has(name)) return false;
      variables.set(name, {
        ...classifyVariable(name),
        severity: "critical",
        value: "",
        source: MANUAL_SOURCE,
      });
      return true;
    },
    remove(name) {
      variables.delete(name);
    },
    setValue(name, value) {
      const entry = variables.get(name);
      if (entry) entry.value = value;
    },
    // Remplit toutes les variables simulables encore vides.
    fillMocks() {
      let filledCount = 0;
      for (const entry of variables.values()) {
        if (entry.value === "" && entry.mockable) {
          entry.value = entry.generate();
          filledCount += 1;
        }
      }
      return filledCount;
    },
    // Ce qui sera réellement envoyé à la VM (les vides sont ignorés).
    toPayload() {
      const payload = {};
      for (const entry of variables.values()) {
        if (entry.value !== "") payload[entry.name] = entry.value;
      }
      return payload;
    },
    hydrate(saved) {
      for (const [name, value] of Object.entries(saved ?? {})) {
        if (!variables.has(name)) {
          variables.set(name, {
            ...classifyVariable(name),
            severity: "critical",
            value: "",
            source: "session précédente",
          });
        }
        variables.get(name).value = value;
      }
    },
  };
}

function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function randomAlphanumeric(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}
