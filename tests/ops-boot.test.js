// V6.46 — Démarrage RÉEL du serveur (server.js + Admin.js + vrai module
// better-sqlite3) avec un DATA_DIR temporaire, lancé depuis un AUTRE dossier
// que celui de l'application (comme systemd/pm2), API Meta et Gemini
// simulées (tests/helpers/meta-mock-preload.js). Vérifie :
// - /health : version, commit, aucune version de Node, SQLite, dossier des
//   données, configuration, âge du dernier webhook ; HOST respecté ;
// - un webhook WhatsApp est traité et le processus reste en vie ;
// - webhooks Instagram/Facebook ignorés, journalisés et comptés (défaut) ;
// - flux catalogue, /sw.js unique, stickers autorisés aux commerciaux ;
// - promesse rejetée et exception non rattrapée → ALERT_WEBHOOK_URL
//   (avant l'arrêt pour l'exception) ;
// - base mondeco.db corrompue : /health « degraded » (503), UNE seule
//   erreur (au lieu d'une quinzaine par message), état des conversations
//   (prise en main, affectation) conservé.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_SECRET = 'ops-boot-secret';
const SPA = { 'X-Mondeco-Client': 'admin' };
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function tunisToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Récepteur local des alertes (ALERT_WEBHOOK_URL).
async function startAlertReceiver() {
  const alerts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { alerts.push(JSON.parse(body).text || ''); } catch { alerts.push(body); }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { alerts, url: `http://127.0.0.1:${server.address().port}/alert`, close: () => server.close() };
}

async function startServer({ dir, dataDir, env = {}, preloads = [] }) {
  const port = await freePort();
  const mockPort = await freePort();
  fs.mkdirSync(dir, { recursive: true });
  const controlPath = path.join(dir, 'control.json');
  const sentPath = path.join(dir, 'sent.jsonl');
  fs.writeFileSync(controlPath, '{}');
  fs.writeFileSync(sentPath, '');
  // Lancé depuis un autre dossier que l'application, qui contient son propre
  // .env (secours) : le .env est cherché d'abord dans le dossier de server.js.
  const cwd = path.join(dir, 'ailleurs');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.env'), 'MONDECO_OPS_TEST_CWD_ENV=1\n');
  let log = '';
  const child = spawn(process.execPath, [
    '-r', path.join(__dirname, 'helpers', 'meta-mock-preload.js'),
    ...preloads.flatMap(file => ['-r', file]),
    path.join(ROOT, 'server.js')
  ], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
      VERIFY_TOKEN: 'verify',
      WHATSAPP_TOKEN: 'test-token',
      PHONE_NUMBER_ID: '999',
      GEMINI_API_KEY: 'test-key',
      META_APP_SECRET: APP_SECRET,
      ADMIN_EMAIL: 'admin@ops.test',
      ADMIN_PASSWORD: 'Ops-Test-Password-1',
      WOOCOMMERCE_SYNC_ENABLED: 'false',
      SHUTDOWN_GRACE_MS: '2000',
      LOG_FORMAT: 'text',
      MONDECO_TEST_CONTROL: controlPath,
      MONDECO_TEST_SENT: sentPath,
      MONDECO_TEST_MOCK_PORT: String(mockPort),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      const res = await fetch(`${base}/health`);
      up = res.status === 200 || res.status === 503;
    } catch {
      await wait(250);
    }
  }
  if (!up) {
    child.kill('SIGKILL');
    throw new Error(`Le serveur n'a pas démarré :\n${log.slice(-3000)}`);
  }
  return {
    base,
    child,
    exited,
    log: () => log,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return exited;
    }
  };
}

function signedWebhook(base, payloadObject) {
  const payload = JSON.stringify(payloadObject);
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`
    },
    body: payload
  });
}

function whatsAppText(from, id, body) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '999' },
          contacts: [{ wa_id: from, profile: { name: 'Client Test' } }],
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }]
        }
      }]
    }]
  };
}

async function health(base) {
  const res = await fetch(`${base}/health`);
  return { status: res.status, body: await res.json() };
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error(`Délai dépassé : ${label}`);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-ops-boot-'));
  const receiver = await startAlertReceiver();
  const servers = [];
  try {
    // ======================================================
    // Serveur A : configuration complète, base saine.
    // ======================================================
    const dataA = path.join(dir, 'dataA');
    fs.mkdirSync(dataA);
    fs.writeFileSync(path.join(dataA, 'products.json'), JSON.stringify([
      { id: 'p-ops-1', name: 'Salon Diana', price: '1200', image: 'https://mondeco.tn/salon-diana.jpg', active: true }
    ]));
    const rejectFile = path.join(dir, 'reject.trigger');
    const crashFile = path.join(dir, 'crash.trigger');
    const a = await startServer({
      dir: path.join(dir, 'A'),
      dataDir: dataA,
      env: {
        ALERT_WEBHOOK_URL: receiver.url,
        MONDECO_TEST_REJECT_FILE: rejectFile,
        MONDECO_TEST_CRASH_FILE: crashFile
      },
      preloads: [path.join(__dirname, 'helpers', 'crash-preload.js')]
    });
    servers.push(a);

    await test('démarrage : bannière versionnée, .env cherché dans le dossier de l’application, HOST respecté', async () => {
      const log = a.log();
      assert.ok(log.includes(`🚀 MONDECO WHATSAPP V${PKG.version}`), log.slice(0, 3000));
      assert.ok(log.includes(`SERVEUR MONDECO V${PKG.version} DÉMARRÉ`));
      assert.ok(log.includes('(adresse 127.0.0.1)'), 'HOST=127.0.0.1');
      const envLine = log.split('\n').find(line => line.startsWith('Fichier .env :')) || '';
      assert.ok(envLine.includes(path.join(dir, 'A', 'ailleurs', '.env')), envLine);
      assert.ok(log.includes('Canaux traités : WhatsApp — webhooks Instagram ignorés'));
      assert.ok(!/❌ Initialisation SQLite|Base SQLite .* indisponible/.test(log));
    });

    await test('/health : ok, version et commit, aucune version de Node, SQLite et dossier des données vérifiés', async () => {
      const { status, body } = await health(a.base);
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(body.version, PKG.version);
      assert.ok(body.commit === null || /^[0-9a-f]{7,12}$/.test(body.commit), body.commit);
      assert.ok(!('node' in body) && !JSON.stringify(body).includes(process.version), 'version de Node exposée');
      assert.deepStrictEqual(body.checks.data_dir, { ok: true });
      assert.strictEqual(body.checks.sqlite.ok, true);
      assert.strictEqual(body.checks.config.ok, true);
      assert.deepStrictEqual(body.channels, { whatsapp: true, instagram: false, facebook: false });
      assert.strictEqual(body.checks.last_webhook.at, null);
      const rootPage = await (await fetch(`${a.base}/`)).text();
      assert.strictEqual(rootPage, '✅ MONDECO WhatsApp actif.');
    });

    await test('webhook WhatsApp traité, processus vivant, âge du dernier webhook dans /health', async () => {
      const res = await signedWebhook(a.base, whatsAppText('21650001111', 'wamid.OPS1', 'Bonjour, prix du salon Diana ?'));
      assert.strictEqual(res.status, 200);
      await waitFor(() => a.log().includes('MESSAGE ENTRANT'), 5000, 'message traité');
      await wait(1500);
      assert.strictEqual(a.child.exitCode, null, `processus arrêté :\n${a.log().slice(-2000)}`);
      const { status, body } = await health(a.base);
      assert.strictEqual(status, 200);
      assert.ok(Number.isInteger(body.checks.last_webhook.whatsapp_age_s) && body.checks.last_webhook.whatsapp_age_s >= 0, JSON.stringify(body.checks.last_webhook));
      assert.ok(body.checks.last_webhook.at);
    });

    await test('webhooks Instagram et Facebook : acquittés, ignorés, journalisés et comptés', async () => {
      const ig = await signedWebhook(a.base, { object: 'instagram', entry: [{ id: '1', messaging: [{ sender: { id: '42' }, message: { mid: 'm1', text: 'prix ?' } }] }] });
      const fb = await signedWebhook(a.base, { object: 'page', entry: [{ id: '2', messaging: [{ sender: { id: '43' }, message: { mid: 'm2', text: 'dispo ?' } }] }] });
      assert.strictEqual(ig.status, 200);
      assert.strictEqual(fb.status, 200);
      const { body } = await health(a.base);
      assert.deepStrictEqual(body.checks.ignored_webhooks, { instagram: 1, page: 1 });
      assert.ok(a.log().includes('Webhook Instagram ignoré : canal désactivé (INSTAGRAM_WEBHOOK_ENABLED=false)'));
      assert.ok(a.log().includes('Webhook Facebook ignoré : canal désactivé (FACEBOOK_WEBHOOK_ENABLED=false)'));
    });

    await test('flux catalogue (DATA_DIR) et service worker unique', async () => {
      const feed = await fetch(`${a.base}/catalog-feed.csv`);
      assert.strictEqual(feed.status, 200);
      assert.ok((await feed.text()).includes('Salon Diana'));
      const sw = await fetch(`${a.base}/admin/sw.js`);
      assert.strictEqual(sw.status, 200);
      assert.strictEqual(await sw.text(), fs.readFileSync(path.join(ROOT, 'pwa-assets', 'sw.js'), 'utf8'));
    });

    await test('stickers : un commercial y a accès (plus de 403), avec les contrôles d’un envoi texte', async () => {
      const call = async (method, route, cookie, body) => {
        const res = await fetch(`${a.base}/admin${route}`, {
          method,
          headers: { cookie, 'content-type': 'application/json', ...SPA },
          body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: res.status, json, text, headers: res.headers };
      };
      const login = async (email, password) => {
        const res = await call('POST', '/login', '', { email, password });
        assert.strictEqual(res.status, 200, res.text);
        return String(res.headers.get('set-cookie') || '').split(';')[0];
      };
      const adminCookie = await login('admin@ops.test', 'Ops-Test-Password-1');
      const created = await call('POST', '/api/users', adminCookie, { name: 'Commercial Ops', email: 'com@ops.test', role: 'commercial', password: 'Commercial-Pass-1' });
      assert.ok([200, 201].includes(created.status), created.text);
      const userId = (created.json?.user || created.json)?.id;
      const schedule = await call('POST', '/api/schedules', adminCookie, {
        userId, date: tunisToday(), startTime: '00:00', endTime: '23:59', channels: ['whatsapp_messages']
      });
      assert.strictEqual(schedule.status, 201, schedule.text);
      const commercial = await login('com@ops.test', 'Commercial-Pass-1');

      const list = await call('GET', '/api/stickers', commercial);
      assert.strictEqual(list.status, 200, list.text);
      assert.ok(list.json.stickers.length >= 1);
      const preview = await fetch(`${a.base}/admin/sticker-preview/heart`, { headers: { cookie: commercial } });
      assert.strictEqual(preview.status, 200);
      // Destinataire différent de la conversation : refusé par le contrôle
      // d'un envoi texte (400), et non plus par le contrôle des rôles (403).
      const mismatch = await call('POST', '/api/commercial/send-sticker', commercial, { contact: '21650001111', externalContact: '21650009999', stickerId: 'heart' });
      assert.strictEqual(mismatch.status, 400, mismatch.text);
      // Bon destinataire : la demande atteint l'envoi WhatsApp (l'API Meta
      // simulée ne gère pas l'envoi de média : 500 attendu ici, jamais 403).
      const sent = await call('POST', '/api/commercial/send-sticker', commercial, { contact: '21650001111', stickerId: 'heart' });
      assert.notStrictEqual(sent.status, 403, sent.text);
      assert.ok([200, 500].includes(sent.status), `${sent.status} ${sent.text}`);
      await waitFor(() => /Envoi sticker commercial|sticker/i.test(a.log()), 3000, 'envoi du sticker tenté');
    });

    await test('promesse rejetée sans gestionnaire : alerte ALERT_WEBHOOK_URL, serveur toujours en service', async () => {
      fs.writeFileSync(rejectFile, '');
      await waitFor(() => receiver.alerts.some(text => text.includes('MONDECO_TEST_REJECTION')), 15000, 'alerte de la promesse rejetée');
      assert.ok(receiver.alerts.find(text => text.includes('MONDECO_TEST_REJECTION')).includes('Unhandled Promise Rejection'));
      assert.strictEqual((await health(a.base)).status, 200);
    });

    await test('exception non rattrapée : alerte envoyée AVANT l’arrêt (code 1)', async () => {
      fs.writeFileSync(crashFile, '');
      const { code } = await Promise.race([a.exited, wait(10000).then(() => ({ code: 'timeout' }))]);
      assert.strictEqual(code, 1, a.log().slice(-2000));
      const alert = receiver.alerts.find(text => text.includes('MONDECO_TEST_CRASH'));
      assert.ok(alert, `alerte absente : ${JSON.stringify(receiver.alerts)}`);
      assert.ok(alert.includes(`Exception non rattrapée (arrêt) — MONDECO V${PKG.version}`), alert);
    });

    // ======================================================
    // Serveur B : mondeco.db corrompu, conversation prise en main.
    // ======================================================
    const dataB = path.join(dir, 'dataB');
    fs.mkdirSync(dataB);
    fs.writeFileSync(path.join(dataB, 'mondeco.db'), crypto.randomBytes(8192));
    const contact = '21600000001';
    fs.writeFileSync(path.join(dataB, 'conversation-state.json'), JSON.stringify({
      [contact]: {
        channel: 'whatsapp',
        assignedUserId: 'u1',
        assignedUserName: 'Commercial 1',
        manualTakeover: true,
        humanPaused: true,
        pausedUntil: '2099-01-01T00:00:00.000Z',
        aiModePreference: 'commercial',
        customerName: 'Client Test'
      }
    }));
    const alertsBefore = receiver.alerts.length;
    const b = await startServer({ dir: path.join(dir, 'B'), dataDir: dataB, env: { ALERT_WEBHOOK_URL: receiver.url } });
    servers.push(b);

    await test('mondeco.db corrompu : /health « degraded » (503) avec la raison', async () => {
      const { status, body } = await health(b.base);
      assert.strictEqual(status, 503, JSON.stringify(body));
      assert.strictEqual(body.status, 'degraded');
      assert.deepStrictEqual(body.reasons, ['sqlite: file is not a database']);
      assert.strictEqual(body.checks.sqlite.ok, false);
      assert.ok(body.checks.sqlite.retry_in_s > 0);
    });

    await test('mondeco.db corrompu : une seule erreur (et une alerte) même après des messages, état conservé', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await signedWebhook(b.base, whatsAppText(contact, `wamid.OPSB${i}`, `Bonjour ${i}`));
        assert.strictEqual(res.status, 200);
      }
      await waitFor(() => (b.log().match(/MESSAGE ENTRANT/g) || []).length >= 3, 8000, 'messages traités');
      await wait(1000);
      const errors = b.log().match(/Base SQLite mondeco\.db indisponible/g) || [];
      assert.strictEqual(errors.length, 1, b.log().slice(-3000));
      assert.ok(!b.log().includes('Initialisation SQLite échouée'));
      await waitFor(() => receiver.alerts.slice(alertsBefore).some(text => text.includes('Base SQLite mondeco.db indisponible')), 15000, 'alerte SQLite');
      const sqliteAlerts = receiver.alerts.slice(alertsBefore).join('\n').match(/Base SQLite mondeco\.db indisponible/g) || [];
      assert.strictEqual(sqliteAlerts.length, 1);

      const { code } = await b.stop();
      assert.strictEqual(code, 0, b.log().slice(-2000));
      const state = JSON.parse(fs.readFileSync(path.join(dataB, 'conversation-state.json'), 'utf8'))[contact];
      assert.strictEqual(state.assignedUserId, 'u1');
      assert.strictEqual(state.manualTakeover, true);
      assert.strictEqual(state.pausedUntil, '2099-01-01T00:00:00.000Z');
      assert.strictEqual(state.aiModePreference, 'commercial');
      assert.strictEqual(state.customerName, 'Client Test');
      assert.strictEqual(state.lastCustomerText, 'Bonjour 2');
    });

    console.log(`\n${passed} test(s) de démarrage réel OK`);
  } catch (error) {
    console.error('FAIL', error);
    for (const server of servers) console.error(`--- log serveur ---\n${server.log().slice(-4000)}`);
    process.exitCode = 1;
  } finally {
    for (const server of servers) {
      try { server.child.kill('SIGKILL'); } catch {}
    }
    receiver.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})();
