// Vérifie la syntaxe de tous les fichiers JavaScript du projet, y compris
// les blocs <script> inline d'Admin.html.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  'server.js',
  'Admin.js',
  ...['lib', 'scripts', 'tests'].flatMap(dir =>
    fs.existsSync(path.join(root, dir))
      ? fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith('.js')).map(name => path.join(dir, name))
      : []
  )
];

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    console.error(`❌ ${file}\n${result.stderr}`);
  }
}

const html = spawnSync(process.execPath, [path.join(__dirname, 'check-admin-html.js')], { stdio: 'inherit' });
if (html.status !== 0) failed++;

if (failed) process.exit(1);
console.log(`✅ ${files.length} fichier(s) JavaScript valides.`);
