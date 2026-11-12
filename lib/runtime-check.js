// ============================================================
// MONDECO — vérifications de démarrage et identité de la version
// lib/runtime-check.js
//
// V6.46 — Chargé en PREMIER par server.js :
// - version de Node : better-sqlite3 13 (package-lock) n'accepte que
//   Node 22 ou plus. Sous Node 20, `new Database()` provoque une erreur de
//   segmentation (code 139) au premier message, APRÈS l'accusé 200 envoyé à
//   Meta : le message était perdu, sans log ni alerte. Le serveur refuse
//   désormais de démarrer, avec un message clair, sur une version non prise
//   en charge ;
// - fichier .env lu dans le dossier de l'application (et non plus dans le
//   dossier courant) : un lancement systemd/pm2 depuis un autre dossier
//   démarrait sans secrets ni DATA_DIR ;
// - version de l'application (package.json) et commit Git déployé, pour
//   /health et les logs.
//
// Ce fichier doit rester lisible par d'anciennes versions de Node (pas de
// ?. ni de ??) : il doit pouvoir afficher son message d'erreur.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const DEFAULT_MIN_NODE_MAJOR = 22;

function readPackageJson(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir || APP_DIR, 'package.json'), 'utf8')) || {};
  } catch (error) {
    return {};
  }
}

// Version majeure minimale lue dans "engines.node" (">=22", "^22 || >=24"…).
function minNodeMajor(appDir) {
  const pkg = readPackageJson(appDir);
  const range = String((pkg.engines && pkg.engines.node) || '');
  const match = /(\d+)/.exec(range);
  const major = match ? Number(match[1]) : NaN;
  return Number.isFinite(major) && major > 0 ? major : DEFAULT_MIN_NODE_MAJOR;
}

// '' si la version convient, sinon le message d'erreur à afficher.
function nodeVersionProblem(version, minMajor) {
  const raw = String(version || process.versions.node || '').replace(/^v/, '');
  const major = Number(raw.split('.')[0]);
  const minimum = Number(minMajor) || DEFAULT_MIN_NODE_MAJOR;
  if (Number.isFinite(major) && major >= minimum) return '';
  return (
    '❌ MONDECO ne peut pas démarrer : Node.js ' + (raw || 'inconnu') +
    ' n’est pas pris en charge (Node.js ' + minimum + ' ou plus requis, ' +
    'Node.js 22 LTS recommandé). Le module SQLite (better-sqlite3) plante ' +
    'sous cette version au premier message reçu. Installez Node.js ' + minimum +
    ' (ex. « nvm install 22 » ou paquet NodeSource), relancez « npm ci ' +
    '--omit=dev » puis redémarrez le service.'
  );
}

function assertSupportedNode(options) {
  const opts = options || {};
  const problem = nodeVersionProblem(
    opts.version || process.versions.node,
    opts.minMajor || minNodeMajor(opts.appDir)
  );
  if (!problem) return true;
  const write = opts.log || (message => console.error(message));
  write(problem);
  const exit = opts.exit || (code => process.exit(code));
  exit(1);
  return false;
}

// Charge <dossier de l'application>/.env (prioritaire), puis, pour la
// compatibilité avec les anciens lancements, le .env du dossier courant
// s'il est différent (dotenv ne remplace jamais une variable déjà définie :
// les valeurs du dossier de l'application et du système l'emportent).
function loadAppEnv(appDir, options) {
  const opts = options || {};
  const dir = appDir || APP_DIR;
  const cwd = opts.cwd || process.cwd();
  const dotenv = opts.dotenv || require('dotenv');
  const env = opts.env || process.env;
  const candidates = [path.join(dir, '.env')];
  const cwdEnv = path.join(cwd, '.env');
  if (path.resolve(cwdEnv) !== path.resolve(candidates[0])) candidates.push(cwdEnv);

  const loaded = [];
  const errors = [];
  for (const file of candidates) {
    let exists = false;
    try {
      exists = fs.statSync(file).isFile();
    } catch (error) {
      exists = false;
    }
    if (!exists) continue;
    const result = dotenv.config({ path: file, processEnv: env, quiet: true });
    if (result && result.error) errors.push({ file, error: result.error.message });
    else loaded.push(file);
  }
  return {
    appEnvPath: candidates[0],
    loaded,
    errors,
    fromCwdOnly: loaded.length > 0 && loaded.indexOf(candidates[0]) === -1
  };
}

function readAppVersion(appDir) {
  return String(readPackageJson(appDir).version || '0.0.0');
}

// Commit déployé : variable d'environnement (Railway, CI) sinon lecture
// directe de .git (aucune commande lancée). '' si inconnu.
function readGitCommit(appDir, env) {
  const vars = env || process.env;
  const fromEnv = String(vars.GIT_COMMIT || vars.RAILWAY_GIT_COMMIT_SHA || vars.SOURCE_COMMIT || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 12).toLowerCase();
  try {
    const dir = appDir || APP_DIR;
    let gitDir = path.join(dir, '.git');
    const stat = fs.statSync(gitDir);
    if (stat.isFile()) {
      // Worktree : « gitdir: /chemin/vers/.git/worktrees/nom ».
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!pointer) return '';
      gitDir = path.resolve(dir, pointer[1].trim());
    }
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch (error) {
      commonDir = gitDir;
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 12) : '';
    const refName = ref[1].trim();
    for (const base of [gitDir, commonDir]) {
      try {
        const sha = fs.readFileSync(path.join(base, refName), 'utf8').trim();
        if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 12);
      } catch (error) {
        // Référence compactée (packed-refs) : voir ci-dessous.
      }
    }
    const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
    for (const line of packed.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2 && parts[1] === refName && /^[0-9a-f]{40}$/i.test(parts[0])) {
        return parts[0].slice(0, 12);
      }
    }
  } catch (error) {
    // Pas de dépôt Git (archive, image Docker) : commit inconnu.
  }
  return '';
}

// Interrupteur booléen d'environnement (true/1/oui/on, false/0/non/off).
function envFlag(value, defaultValue) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!raw) return Boolean(defaultValue);
  if (['true', '1', 'yes', 'oui', 'on', 'enabled'].indexOf(raw) !== -1) return true;
  if (['false', '0', 'no', 'non', 'off', 'disabled'].indexOf(raw) !== -1) return false;
  return Boolean(defaultValue);
}

// V6.46 — Canaux réellement traités. Depuis le 13/10, seuls les messages
// WhatsApp sont traités : les webhooks Instagram et Facebook (Messenger,
// commentaires de la Page) étaient acquittés puis jetés par un `if (false)`
// écrit en dur. Ils sont désormais pilotés par INSTAGRAM_WEBHOOK_ENABLED et
// FACEBOOK_WEBHOOK_ENABLED (défaut : false = comportement actuel inchangé).
function resolveChannelFlags(env) {
  const vars = env || process.env;
  return {
    whatsapp: true,
    instagram: envFlag(vars.INSTAGRAM_WEBHOOK_ENABLED, false),
    facebook: envFlag(vars.FACEBOOK_WEBHOOK_ENABLED, false)
  };
}

// Libellé lisible (« WhatsApp + Instagram ») des canaux actifs.
function channelsLabel(flags) {
  const f = flags || {};
  const names = ['WhatsApp'];
  if (f.instagram) names.push('Instagram');
  if (f.facebook) names.push('Facebook');
  return names.join(' + ');
}

// V6.46 — Exception non rattrapée : le processus est dans un état inconnu et
// doit s'arrêter (le gestionnaire de processus le relance). Avant, il
// quittait aussitôt après console.error : l'alerte ALERT_WEBHOOK_URL,
// regroupée et envoyée 2 s plus tard au plus tôt, n'était jamais envoyée.
// Désormais : log, plus de nouvelles connexions, écriture des fichiers en
// attente, envoi IMMÉDIAT de l'alerte (attente limitée à `alertTimeoutMs`),
// puis sortie avec le code 1. Une seconde exception pendant cette séquence
// est seulement journalisée.
function createFatalErrorHandler(options) {
  const opts = options || {};
  const log = opts.log || ((error) => console.error('❌ Exception non rattrapée (arrêt) :', error));
  const stopAccepting = opts.stopAccepting || (() => {});
  const flushWrites = opts.flushWrites || (() => {});
  const flushAlerts = opts.flushAlerts || (() => Promise.resolve());
  const exit = opts.exit || (code => process.exit(code));
  const alertTimeoutMs = Math.max(0, Number(opts.alertTimeoutMs) || 4000);
  let handling = false;

  return function onFatalError(error, origin) {
    if (handling) {
      try { console.error('❌ Nouvelle exception pendant l’arrêt :', error); } catch (ignored) { /* rien */ }
      return;
    }
    handling = true;
    try { log(error, origin); } catch (ignored) { /* rien */ }
    try { stopAccepting(); } catch (ignored) { /* rien */ }
    try { flushWrites(); } catch (ignored) { /* rien */ }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      exit(1);
    };
    // Volontairement sans unref() : le processus reste en vie le temps
    // d'envoyer l'alerte, au plus `alertTimeoutMs`.
    const timer = setTimeout(finish, alertTimeoutMs);
    Promise.resolve()
      .then(() => flushAlerts())
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        finish();
      });
  };
}

module.exports = {
  APP_DIR,
  DEFAULT_MIN_NODE_MAJOR,
  minNodeMajor,
  nodeVersionProblem,
  assertSupportedNode,
  loadAppEnv,
  readAppVersion,
  readGitCommit,
  envFlag,
  resolveChannelFlags,
  channelsLabel,
  createFatalErrorHandler
};
