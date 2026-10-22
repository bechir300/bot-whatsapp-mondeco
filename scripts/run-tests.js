// Lance tous les fichiers test_*.js à la racine et dans tests/.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const candidates = [
  ...fs.readdirSync(root).filter(name => /^test_.*\.js$/.test(name)),
  ...(fs.existsSync(path.join(root, 'tests'))
    ? fs.readdirSync(path.join(root, 'tests'))
      .filter(name => /\.test\.js$/.test(name))
      .map(name => path.join('tests', name))
    : [])
];

let failed = 0;
for (const file of candidates) {
  const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`❌ ${file} a échoué`);
  }
}

console.log(`\n${candidates.length - failed}/${candidates.length} fichier(s) de test OK`);
if (failed) process.exit(1);
