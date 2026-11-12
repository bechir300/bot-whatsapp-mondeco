// Vérifie la syntaxe de tous les fichiers JavaScript du projet, y compris
// les blocs <script> inline d'Admin.html.
//
// V6.46 — La liste n'est plus limitée à server.js, Admin.js, lib/, scripts/
// et tests/ : tous les fichiers .js du dépôt sont vérifiés (suivis par Git,
// ou nouveaux et non ignorés), dont les modules chargés au démarrage
// (catalog-feed.js, product-named.js, read-receipt.js, showroom-pin.js,
// location-showrooms.js) et pwa-assets/sw.js. Une erreur de syntaxe dans
// catalog-feed.js empêchait le démarrage alors que la CI restait verte.
// Chaque require('./…') relatif du code de production (hors tests/, dont
// les fichiers contiennent des scripts en texte) doit aussi désigner un
// fichier existant (module oublié dans un commit = plantage au démarrage).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const IGNORED_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const rel = dir ? path.join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function listJsFiles() {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.js'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (git.status === 0 && git.stdout) {
    return git.stdout
      .split('\0')
      .filter(Boolean)
      .filter(file => !file.split('/').some(part => IGNORED_DIRS.has(part)))
      // Fichier supprimé mais encore dans l'index : ignoré.
      .filter(file => fs.existsSync(path.join(root, file)))
      .sort();
  }
  // Pas de dépôt Git (archive, image Docker) : parcours du dossier.
  return walk('').sort();
}

// require('./x') / require('../x') relatifs, hors commentaires de ligne.
function relativeRequires(source) {
  const found = [];
  const pattern = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    let match;
    while ((match = pattern.exec(line))) found.push(match[2]);
  }
  return found;
}

function resolvesToFile(fromFile, request) {
  const base = path.resolve(root, path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  return candidates.some(candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const files = listJsFiles();
for (const required of ['server.js', 'Admin.js']) {
  if (!files.includes(required)) {
    console.error(`❌ ${required} introuvable dans la liste des fichiers vérifiés.`);
    process.exit(1);
  }
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    console.error(`❌ ${file}\n${result.stderr}`);
  }
  if (file.startsWith('tests/')) continue;
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const request of relativeRequires(source)) {
    if (!resolvesToFile(file, request)) {
      failed++;
      console.error(`❌ ${file} : require('${request}') ne désigne aucun fichier.`);
    }
  }
}

const html = spawnSync(process.execPath, [path.join(__dirname, 'check-admin-html.js')], { stdio: 'inherit' });
if (html.status !== 0) failed++;

if (failed) process.exit(1);
console.log(`✅ ${files.length} fichier(s) JavaScript valides.`);
