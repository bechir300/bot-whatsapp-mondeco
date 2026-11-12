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

module.exports = {
  APP_DIR,
  DEFAULT_MIN_NODE_MAJOR,
  minNodeMajor,
  nodeVersionProblem,
  assertSupportedNode,
  loadAppEnv,
  readAppVersion,
  readGitCommit,
  envFlag
};
