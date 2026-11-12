// V6.46 — Hygiène du dépôt (paquet « exploitation ») :
// - toute variable d'environnement lue par le code est documentée dans
//   .env.example (35 ne l'étaient pas, dont des réglages qui suppriment des
//   données) ;
// - aucun chemin '/data/…' écrit en dur hors des anciens emplacements lus
//   pour compatibilité (DATA_DIR doit être respecté partout) ;
// - les interrupteurs read-receipt.off / showroom-pin.off sont cherchés
//   dans DATA_DIR ;
// - un seul service worker /sw.js ;
// - la CI teste la version minimale de Node prise en charge.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}

// Fichiers de code de production (hors tests) suivis ou nouveaux.
function productionJsFiles() {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.js'], { cwd: root, encoding: 'utf8' });
  const list = git.status === 0
    ? git.stdout.split(/\r?\n/).filter(Boolean)
    : ['server.js', 'Admin.js', ...fs.readdirSync(path.join(root, 'lib')).map(name => `lib/${name}`)];
  return list
    .filter(file => !file.startsWith('tests/') && !file.startsWith('node_modules/') && !/^test_.*\.js$/.test(file))
    .filter(file => fs.existsSync(path.join(root, file)));
}

const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  // Modules qui reçoivent l'environnement en paramètre (env.X, vars.X).
  /\b(?:env|vars)\??\.([A-Z][A-Z0-9_]{2,})/g
];

try {
  test('chaque variable d’environnement lue par le code est documentée dans .env.example', () => {
    const used = new Map();
    for (const file of productionJsFiles()) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const pattern of ENV_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source))) {
          if (!used.has(match[1])) used.set(match[1], file);
        }
      }
    }
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const documented = new Set([...example.matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)].map(match => match[1]));
    const missing = [...used.entries()].filter(([name]) => !documented.has(name)).map(([name, file]) => `${name} (${file})`);
    assert.deepStrictEqual(missing, [], `Variables à documenter dans .env.example : ${missing.join(', ')}`);
    assert.ok(used.size > 80, `détection des variables suspecte (${used.size})`);
    for (const name of ['HOST', 'INSTAGRAM_WEBHOOK_ENABLED', 'FACEBOOK_WEBHOOK_ENABLED', 'HISTORY_IMPORT_DAYS', 'REVIEW_REQUEST_SECRET', 'PUBLIC_BASE_URL']) {
      assert.ok(documented.has(name), name);
    }
  });

  test('aucun chemin /data écrit en dur hors des anciens emplacements de compatibilité', () => {
    const allowed = [
      // Anciens fichiers relus s'ils existent (DATA_DIR est utilisé en premier).
      "'/data/followup-last.json'",
      "'/data/read-receipt.off'",
      "'/data/showroom-pin.off'"
    ];
    const offenders = [];
    for (const file of productionJsFiles()) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const literals = line.match(/(['"`])\/data\/[^'"`]*\1/g) || [];
        for (const literal of literals) {
          if (!allowed.includes(literal)) offenders.push(`${file}:${index + 1} ${literal}`);
        }
      });
    }
    assert.deepStrictEqual(offenders, []);
  });

  test('read-receipt.off et showroom-pin.off cherchés dans DATA_DIR', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-ops-flags-'));
    try {
      const script = `
        const fs = require('fs');
        const path = require('path');
        const { markRead } = require('./read-receipt');
        const { maybeSendPin } = require('./showroom-pin');
        (async () => {
          const before = await markRead({});
          fs.writeFileSync(path.join(process.env.DATA_DIR, 'read-receipt.off'), '');
          fs.writeFileSync(path.join(process.env.DATA_DIR, 'showroom-pin.off'), '');
          const after = await markRead({ messageId: 'x', token: 't', phoneNumberId: '1', apiVersion: 'v1' });
          const pin = await maybeSendPin({ text: 'adresse showroom Nabeul', to: '216', token: 't', phoneNumberId: '1', apiVersion: 'v1' });
          console.log(JSON.stringify({ before, after, pin }));
        })();
      `;
      const run = spawnSync(process.execPath, ['-e', script], {
        cwd: root,
        env: { ...process.env, DATA_DIR: dataDir },
        encoding: 'utf8'
      });
      assert.strictEqual(run.status, 0, run.stderr);
      // Sans interrupteur : « skip » (paramètres manquants) ; avec : « off »,
      // et aucun envoi de position (aucun appel réseau tenté).
      // (« off » dès le départ si l'ancien /data/read-receipt.off existe
      // sur cette machine : il reste lu pour compatibilité.)
      const legacyOff = fs.existsSync('/data/read-receipt.off');
      assert.deepStrictEqual(JSON.parse(run.stdout.trim().split('\n').pop()), { before: legacyOff ? 'off' : 'skip', after: 'off', pin: false });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('/sw.js défini une seule fois (pwa-assets/sw.js)', () => {
    const admin = fs.readFileSync(path.join(root, 'Admin.js'), 'utf8');
    const routes = admin.match(/router\.get\(\s*'\/sw\.js'/g) || [];
    assert.strictEqual(routes.length, 1);
    assert.ok(/router\.get\('\/sw\.js'[\s\S]{0,400}PWA_ASSETS_DIR, 'sw\.js'/.test(admin));
  });

  test('CI : Node 22 (minimum pris en charge) et 24', () => {
    const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.ok(/node-version:\s*\[\s*22\s*,\s*24\s*\]/.test(ci), ci);
    assert.ok(/node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}/.test(ci));
    assert.ok(/run:\s*npm test/.test(ci));
  });

  console.log(`\n${passed} test(s) hygiène du dépôt OK`);
} catch (error) {
  console.error('FAIL', error.message);
  process.exitCode = 1;
}
