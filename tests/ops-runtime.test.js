// V6.46 — Tests unitaires du paquet « exploitation » : version de Node
// (lib/runtime-check.js), .env lu dans le dossier de l'application, commit
// déployé, interrupteurs Instagram/Facebook, arrêt sur exception avec
// alerte, rapport /health (lib/health.js) et connexion SQLite mémorisée
// (lib/sqlite-health.js). Aucun fichier réel touché (dossiers temporaires).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeCheck = require('../lib/runtime-check');
const { createDataDirProbe, buildHealthReport } = require('../lib/health');
const { createSqliteConnection } = require('../lib/sqlite-health');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-ops-runtime-'));
let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

function captureLogger() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (...args) => lines.log.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' '))
  };
}

(async () => {
  try {
    // ---------------- Version de Node ----------------
    await test('package.json : engines.node >=22, sans undici, engine-strict', async () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
      assert.strictEqual(pkg.engines.node, '>=22');
      assert.ok(!pkg.dependencies.undici, 'undici ne doit plus être une dépendance');
      const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
      assert.strictEqual(lock.packages[''].engines.node, '>=22');
      assert.ok(!lock.packages['node_modules/undici'], 'undici absent du package-lock');
      assert.strictEqual(lock.packages[''].version, pkg.version);
      assert.ok(/^engine-strict\s*=\s*true$/m.test(fs.readFileSync(path.join(__dirname, '..', '.npmrc'), 'utf8')));
      // Le minimum de better-sqlite3 (package-lock) est bien couvert.
      const sqliteMin = Number(/(\d+)/.exec(lock.packages['node_modules/better-sqlite3'].engines.node)[1]);
      assert.ok(runtimeCheck.minNodeMajor() >= sqliteMin, `minimum ${runtimeCheck.minNodeMajor()} < better-sqlite3 ${sqliteMin}`);
    });

    await test('Node 20 refusé avec un message clair, Node 22/24 acceptés', async () => {
      assert.strictEqual(runtimeCheck.minNodeMajor(), 22);
      assert.strictEqual(runtimeCheck.nodeVersionProblem('22.0.0', 22), '');
      assert.strictEqual(runtimeCheck.nodeVersionProblem('v24.1.0', 22), '');
      const problem = runtimeCheck.nodeVersionProblem('v20.20.2', 22);
      assert.ok(problem.includes('20.20.2') && problem.includes('22') && problem.includes('better-sqlite3'), problem);

      const logged = [];
      const exits = [];
      const ok = runtimeCheck.assertSupportedNode({ version: '20.20.2', log: line => logged.push(line), exit: code => exits.push(code) });
      assert.strictEqual(ok, false);
      assert.deepStrictEqual(exits, [1]);
      assert.ok(logged[0].startsWith('❌ MONDECO ne peut pas démarrer'), logged[0]);
      assert.strictEqual(runtimeCheck.assertSupportedNode({ version: process.versions.node, exit: () => { throw new Error('ne doit pas sortir'); } }), true);
    });

    // ---------------- .env ----------------
    await test('.env lu dans le dossier de l’application, quel que soit le dossier courant', async () => {
      const appDir = path.join(tmpRoot, 'app');
      const otherCwd = path.join(tmpRoot, 'ailleurs');
      fs.mkdirSync(appDir, { recursive: true });
      fs.mkdirSync(otherCwd, { recursive: true });
      fs.writeFileSync(path.join(appDir, '.env'), 'VERIFY_TOKEN=depuis-app\nDATA_DIR=/srv/data\nPORT=3978\n');
      fs.writeFileSync(path.join(otherCwd, '.env'), 'VERIFY_TOKEN=depuis-cwd\nEXTRA_CWD=1\n');
      const env = { PORT: '4000' };
      const result = runtimeCheck.loadAppEnv(appDir, { cwd: otherCwd, env });
      assert.strictEqual(env.VERIFY_TOKEN, 'depuis-app', 'le .env de l’application est prioritaire');
      assert.strictEqual(env.DATA_DIR, '/srv/data');
      assert.strictEqual(env.PORT, '4000', 'une variable du système n’est jamais remplacée');
      assert.strictEqual(env.EXTRA_CWD, '1', 'le .env du dossier courant reste un secours');
      assert.deepStrictEqual(result.loaded, [path.join(appDir, '.env'), path.join(otherCwd, '.env')]);
      assert.strictEqual(result.fromCwdOnly, false);

      // Sans .env dans l'application : secours signalé.
      const env2 = {};
      const result2 = runtimeCheck.loadAppEnv(path.join(tmpRoot, 'sans-env'), { cwd: otherCwd, env: env2 });
      assert.strictEqual(env2.VERIFY_TOKEN, 'depuis-cwd');
      assert.strictEqual(result2.fromCwdOnly, true);

      // Aucun .env : rien de chargé, aucune erreur.
      const result3 = runtimeCheck.loadAppEnv(path.join(tmpRoot, 'vide'), { cwd: path.join(tmpRoot, 'vide2'), env: {} });
      assert.deepStrictEqual(result3.loaded, []);
      assert.deepStrictEqual(result3.errors, []);
    });

    await test('server.js charge .env via loadAppEnv(__dirname), plus jamais dotenv.config() du dossier courant', async () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert.ok(!/require\(['"]dotenv['"]\)\.config\(\s*\)/.test(source), 'dotenv.config() sans chemin');
      const check = source.indexOf('runtimeCheck.assertSupportedNode()');
      const load = source.indexOf('runtimeCheck.loadAppEnv(__dirname)');
      const logger = source.indexOf("require('./lib/logger')");
      assert.ok(check > 0 && check < load && load < logger, 'ordre : version de Node, .env, puis le reste');
    });

    // ---------------- Version déployée ----------------
    await test('commit déployé : variable d’environnement, sinon .git (dépôt, worktree, packed-refs)', async () => {
      assert.strictEqual(runtimeCheck.readGitCommit(tmpRoot, { GIT_COMMIT: 'ABCDEF1234567890' }), 'abcdef123456');
      assert.strictEqual(runtimeCheck.readGitCommit(tmpRoot, { RAILWAY_GIT_COMMIT_SHA: 'nimporte quoi' }), '');
      const repo = path.join(tmpRoot, 'repo');
      fs.mkdirSync(path.join(repo, '.git', 'refs', 'heads'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/prod\n');
      fs.writeFileSync(path.join(repo, '.git', 'packed-refs'), `# pack-refs\n${'a'.repeat(40)} refs/heads/prod\n`);
      assert.strictEqual(runtimeCheck.readGitCommit(repo, {}), 'a'.repeat(12));
      fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'prod'), `${'b'.repeat(40)}\n`);
      assert.strictEqual(runtimeCheck.readGitCommit(repo, {}), 'b'.repeat(12));
      assert.strictEqual(runtimeCheck.readGitCommit(path.join(tmpRoot, 'pas-de-git'), {}), '');
      assert.ok(/^\d+\.\d+\.\d+/.test(runtimeCheck.readAppVersion()));
    });

    // ---------------- Canaux ----------------
    await test('Instagram/Facebook : désactivés par défaut, activables par variable', async () => {
      assert.deepStrictEqual(runtimeCheck.resolveChannelFlags({}), { whatsapp: true, instagram: false, facebook: false });
      assert.deepStrictEqual(
        runtimeCheck.resolveChannelFlags({ INSTAGRAM_WEBHOOK_ENABLED: 'true', FACEBOOK_WEBHOOK_ENABLED: 'oui' }),
        { whatsapp: true, instagram: true, facebook: true }
      );
      assert.strictEqual(runtimeCheck.resolveChannelFlags({ INSTAGRAM_WEBHOOK_ENABLED: 'n’importe quoi' }).instagram, false);
      assert.strictEqual(runtimeCheck.channelsLabel({ instagram: false, facebook: true }), 'WhatsApp + Facebook');
      const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      const admin = fs.readFileSync(path.join(__dirname, '..', 'Admin.js'), 'utf8');
      assert.ok(!/^\s*if \(false\b/m.test(server), 'plus de if (false) dans server.js');
      assert.ok(!/^\s*if \(false\b/m.test(admin), 'plus de if (false) dans Admin.js');
    });

    // ---------------- Exception non rattrapée ----------------
    await test('exception non rattrapée : connexions fermées, écritures faites, alerte envoyée AVANT la sortie', async () => {
      const steps = [];
      let releaseAlert;
      const handler = runtimeCheck.createFatalErrorHandler({
        log: () => steps.push('log'),
        stopAccepting: () => steps.push('close'),
        flushWrites: () => steps.push('flush'),
        flushAlerts: () => new Promise(resolve => { releaseAlert = () => { steps.push('alert'); resolve(); }; }),
        exit: code => steps.push(`exit:${code}`),
        alertTimeoutMs: 2000
      });
      handler(new Error('boom'));
      const savedError = console.error;
      const secondLogged = [];
      console.error = (...args) => secondLogged.push(args.join(' '));
      try { handler(new Error('seconde')); } finally { console.error = savedError; }
      assert.ok(secondLogged[0].includes('Nouvelle exception pendant l’arrêt'), 'seconde exception seulement journalisée');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepStrictEqual(steps, ['log', 'close', 'flush'], 'attente de l’alerte avant de quitter');
      releaseAlert();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepStrictEqual(steps, ['log', 'close', 'flush', 'alert', 'exit:1']);
    });

    await test('exception non rattrapée : sortie même si l’alerte ne répond pas (délai maximal)', async () => {
      const exits = [];
      const handler = runtimeCheck.createFatalErrorHandler({
        log: () => {},
        stopAccepting: () => { throw new ReferenceError('httpServer pas encore créé'); },
        flushWrites: () => { throw new Error('disque plein'); },
        flushAlerts: () => new Promise(() => {}),
        exit: code => exits.push(code),
        alertTimeoutMs: 50
      });
      handler(new Error('boom'));
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.deepStrictEqual(exits, [1]);
    });

    // ---------------- /health ----------------
    await test('/health : ok sans version de Node ; degraded (503) avec les raisons', async () => {
      const ok = buildHealthReport({ version: '6.46.0', commit: 'abc', nowMs: 1_000_000, startedAtMs: 940_000, lastWebhook: { any: 990_000, whatsapp: 980_000 } });
      assert.strictEqual(ok.httpStatus, 200);
      assert.strictEqual(ok.body.status, 'ok');
      assert.strictEqual(ok.body.version, '6.46.0');
      assert.strictEqual(ok.body.uptime_s, 60);
      assert.strictEqual(ok.body.checks.last_webhook.age_s, 10);
      assert.strictEqual(ok.body.checks.last_webhook.whatsapp_age_s, 20);
      const text = JSON.stringify(ok.body);
      assert.ok(!text.includes(process.version) && !('node' in ok.body), 'aucune version de Node');

      const bad = buildHealthReport({
        dataDir: { ok: false, error: 'EACCES : permission denied' },
        sqlite: { ok: false, error: 'file is not a database' },
        config: { required: { VERIFY_TOKEN: true, WHATSAPP_TOKEN: false }, enforce: true }
      });
      assert.strictEqual(bad.httpStatus, 503);
      assert.strictEqual(bad.body.status, 'degraded');
      assert.deepStrictEqual(bad.body.reasons, [
        'data_dir: EACCES : permission denied',
        'sqlite: file is not a database',
        'config: WHATSAPP_TOKEN manquant(s)'
      ]);
      // Hors production : configuration incomplète signalée sans 503.
      const dev = buildHealthReport({ config: { required: { WHATSAPP_TOKEN: false }, enforce: false } });
      assert.strictEqual(dev.httpStatus, 200);
      assert.deepStrictEqual(dev.body.checks.config.missing, ['WHATSAPP_TOKEN']);
      // Aucun webhook encore reçu : âge inconnu, jamais une raison de 503.
      assert.strictEqual(dev.body.checks.last_webhook.age_s, null);
    });

    await test('/health : sonde d’écriture du dossier des données (réussite, échec, cache)', async () => {
      const dir = path.join(tmpRoot, 'data-ok');
      fs.mkdirSync(dir);
      let now = 0;
      const probe = createDataDirProbe(dir, { ttlMs: 1000, now: () => now });
      assert.deepStrictEqual(probe(), { ok: true });
      assert.deepStrictEqual(fs.readdirSync(dir), [], 'aucun fichier laissé');
      const missing = createDataDirProbe(path.join(tmpRoot, 'absent', 'sous-dossier'));
      const result = missing();
      assert.strictEqual(result.ok, false);
      assert.ok(result.error.startsWith('ENOENT'), result.error);
      now = 500;
      fs.rmSync(dir, { recursive: true });
      assert.deepStrictEqual(probe(), { ok: true }, 'résultat gardé pendant ttlMs');
      now = 2000;
      assert.strictEqual(probe().ok, false, 'revérifié après ttlMs');
    });

    // ---------------- SQLite ----------------
    await test('SQLite illisible : une seule erreur, plus de réouverture à chaque accès, puis reprise', async () => {
      const logger = captureLogger();
      let opens = 0;
      let broken = true;
      let now = 0;
      const closed = [];
      const connection = createSqliteConnection({
        dbPath: '/tmp/mondeco.db',
        openDatabase: () => {
          opens++;
          const handle = {
            close: () => closed.push(opens),
            prepare: () => ({ get: () => ({ n: 1 }) })
          };
          if (broken) {
            // Ouverture réussie mais initialisation impossible : refermée.
            handle.pragma = () => { throw new Error('file is not a database'); };
          } else {
            handle.pragma = () => {};
          }
          return handle;
        },
        initialize: db => db.pragma('journal_mode = WAL'),
        logger,
        retryMs: 30_000,
        now: () => now
      });

      for (let i = 0; i < 15; i++) assert.strictEqual(connection.get(), null);
      assert.strictEqual(opens, 1, 'une seule tentative pendant l’attente');
      assert.deepStrictEqual(closed, [1], 'base à moitié ouverte refermée');
      assert.strictEqual(logger.lines.error.length, 1, 'une seule ligne d’erreur (une alerte)');
      assert.ok(logger.lines.error[0].includes('file is not a database'));
      const probe = connection.probe();
      assert.strictEqual(probe.ok, false);
      assert.strictEqual(probe.error, 'file is not a database');
      assert.strictEqual(probe.retry_in_s, 30);

      now = 31_000;
      assert.strictEqual(connection.get(), null);
      assert.strictEqual(opens, 2, 'nouvel essai après l’attente');
      assert.strictEqual(logger.lines.error.length, 1, 'même erreur : pas de nouvelle alerte');
      now = 31_000 + 59_000;
      assert.strictEqual(connection.get(), null);
      assert.strictEqual(opens, 2, 'attente doublée (60 s)');

      broken = false;
      now = 31_000 + 61_000;
      assert.ok(connection.get(), 'base de nouveau disponible');
      assert.ok(logger.lines.warn.some(line => line.includes('de nouveau disponible')));
      assert.strictEqual(connection.probe().ok, true);
      assert.strictEqual(connection.get(), connection.get(), 'même connexion réutilisée');
      assert.strictEqual(opens, 3);
    });

    await test('SQLite : vraie base (better-sqlite3) ouverte, puis fichier corrompu détecté', async () => {
      const dbPath = path.join(tmpRoot, 'vraie.db');
      const logger = captureLogger();
      const good = createSqliteConnection({
        dbPath,
        initialize: db => { db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE IF NOT EXISTS t (x)'); },
        logger
      });
      assert.ok(good.get(), 'module natif chargé et base ouverte');
      assert.strictEqual(good.probe().ok, true);
      good.get().close();

      const badPath = path.join(tmpRoot, 'corrompue.db');
      fs.writeFileSync(badPath, Buffer.alloc(8192, 0x5a));
      const bad = createSqliteConnection({ dbPath: badPath, initialize: db => db.pragma('journal_mode = WAL'), logger });
      assert.strictEqual(bad.get(), null);
      assert.strictEqual(bad.probe().ok, false);
      assert.ok(/not a database/.test(bad.probe().error), bad.probe().error);
    });

    console.log(`\n${passed} test(s) exploitation (unitaires) OK`);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
})();
