// V6.45 — Test de bout en bout du serveur réel (server.js + Admin.js) avec
// Meta et Gemini simulés (tests/helpers/meta-mock-preload.js) et un
// DATA_DIR temporaire. Vérifie qu'une conversation affichée « IA en pause »
// ne reçoit jamais de réponse IA, que l'état écrit par l'Admin n'est pas
// effacé par server.js, qu'aucun message client n'est perdu (échec d'envoi,
// arrêt brutal pendant la génération) et que la réponse groupée aux
// non-lus est idempotente.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// V6.45 — Comme en production (paquet sécurité) : webhooks signés avec
// l'App Secret, requêtes du centre de pilotage avec l'en-tête X-Mondeco-Client
// envoyé par apiFetch (protection CSRF).
const APP_SECRET = 'e2e-app-secret';
const SPA_HEADERS = { 'x-mondeco-client': 'admin' };

const ROOT = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-e2e-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const controlPath = path.join(dir, 'control.json');
  const sentPath = path.join(dir, 'sent.jsonl');
  const logPath = path.join(dir, 'server.log');
  fs.writeFileSync(controlPath, '{}');
  fs.writeFileSync(sentPath, '');
  const port = await freePort();
  const mockPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logStream = fs.openSync(logPath, 'a');
  let child = null;

  function startServer() {
    child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'meta-mock-preload.js'), 'server.js'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        PORT: String(port),
        DATA_DIR: dataDir,
        WHATSAPP_TOKEN: 'test-token',
        PHONE_NUMBER_ID: '999',
        VERIFY_TOKEN: 'verify',
        GEMINI_API_KEY: 'test-key',
        META_APP_SECRET: APP_SECRET,
        ADMIN_EMAIL: 'admin@test.local',
        ADMIN_PASSWORD: 'Passw0rd!Test123',
        NODE_ENV: 'development',
        SHUTDOWN_GRACE_MS: '2000',
        MONDECO_TEST_CONTROL: controlPath,
        MONDECO_TEST_SENT: sentPath,
        MONDECO_TEST_MOCK_PORT: String(mockPort)
      },
      stdio: ['ignore', logStream, logStream]
    });
  }

  const control = value => fs.writeFileSync(controlPath, JSON.stringify(value));
  const sentLines = () => fs.readFileSync(sentPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sentTo = to => sentLines().filter(item => item.to === to);
  const readReceipt = messageId => sentLines().find(item => item.kind === 'read_receipt' && item.message_id === messageId);
  let cookie = '';
  let sequence = 0;

  async function admin(method, route, body) {
    const response = await fetch(`${base}/admin${route}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', ...SPA_HEADERS },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json };
  }

  async function webhook(value, field = 'messages') {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '999' }, ...value } }] }] });
    const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`;
    const response = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: payload
    });
    assert.strictEqual(response.status, 200);
  }

  // Renvoie l'identifiant du message simulé.
  async function customerMessage(from, message) {
    const id = `wamid.TEST${Date.now()}${++sequence}`;
    await webhook({
      contacts: [{ wa_id: from, profile: { name: 'Client Test' } }],
      messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message }]
    });
    return id;
  }
  const text = (from, body) => customerMessage(from, { type: 'text', text: { body } });

  async function conversation(contact) {
    const list = (await admin('GET', '/api/conversations?limit=200')).json;
    const items = Array.isArray(list) ? list : (list?.conversations || list?.items || []);
    const item = items.find(entry => entry.contact === contact) || {};
    const detail = (await admin('GET', `/api/conversations/${contact}`)).json || {};
    return { item, entries: Array.isArray(detail.entries) ? detail.entries : [] };
  }

  async function waitFor(predicate, timeoutMs = 4000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await predicate()) return true;
      await wait(100);
    }
    return false;
  }

  async function waitReadyAndLogin() {
    const ready = await waitFor(async () => {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    }, 20000);
    assert.ok(ready, 'serveur démarré');
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SPA_HEADERS },
      body: JSON.stringify({ email: 'admin@test.local', password: 'Passw0rd!Test123' })
    });
    assert.strictEqual(login.status, 200);
    cookie = (login.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
  }

  try {
    startServer();
    await waitReadyAndLogin();

    await test('F8 : « Prendre en main » respecté et jamais effacé par un statut Meta ou un message client', async () => {
      const c = '21650000006';
      await text(c, 'Bonjour');
      assert.ok(await waitFor(() => sentTo(c).length === 1), 'réponse IA initiale');
      const takeover = await admin('POST', `/api/conversations/${c}/takeover`, {});
      assert.strictEqual(takeover.status, 200);
      await webhook({ statuses: [{ id: 'wamid.MOCK1', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: c }] });
      const id = await text(c, 'Vous êtes là ?');
      await waitFor(async () => sentTo(c).length > 1 || (await conversation(c)).entries.some(entry => entry.incoming === 'Vous êtes là ?'));
      await wait(300);
      assert.strictEqual(sentTo(c).length, 1, 'aucune réponse IA après la prise en main');
      const { item } = await conversation(c);
      assert.strictEqual(item.manualTakeover, true);
      assert.ok(item.assignedTo, 'affectation conservée');
      // F19 : accusé de lecture sans « en train d'écrire… » (l'IA ne répondra pas).
      assert.ok(await waitFor(() => Boolean(readReceipt(id))), 'accusé de lecture envoyé');
      assert.strictEqual(readReceipt(id).typing, false);
    });

    await test('F8 : « Réactiver IA » visible immédiatement par le bot', async () => {
      const c = '21650000009';
      await admin('POST', `/api/conversations/${c}/takeover`, {});
      assert.strictEqual((await admin('POST', `/api/conversations/${c}/reactivate-ai`, {})).status, 200);
      const id = await text(c, 'Bonjour, merci pour votre aide');
      assert.ok(await waitFor(() => sentTo(c).length === 1), 'réponse IA après réactivation');
      assert.strictEqual(readReceipt(id)?.typing, true);
    });

    await test('F10 : prise en main PENDANT la génération IA → réponse IA retenue', async () => {
      const c = '21650000002';
      control({ geminiDelayMs: 1500 });
      await text(c, 'Bonjour, vous êtes là ?');
      await wait(400);
      assert.strictEqual((await admin('POST', `/api/conversations/${c}/takeover`, {})).status, 200);
      assert.ok(await waitFor(async () => (await conversation(c)).entries.some(entry => entry.action === 'ai_reply_suppressed_human_active'), 5000));
      assert.strictEqual(sentTo(c).length, 0);
      control({});
    });

    await test('F10 : message commercial envoyé pendant la génération IA → une seule réponse (celle du commercial)', async () => {
      const c = '21650000012';
      control({ geminiDelayMs: 1500 });
      await text(c, 'Bonjour, merci');
      await wait(400);
      const reply = await admin('POST', '/api/commercial/send', { contact: c, channel: 'whatsapp', text: 'Bonjour, je suis Sami de MONDECO.' });
      assert.strictEqual(reply.status, 200);
      await wait(1800);
      assert.deepStrictEqual(sentTo(c).map(item => item.text), ['Bonjour, je suis Sami de MONDECO.']);
      control({});
    });

    await test('F10 : réponse depuis WhatsApp Business pendant la génération IA → réponse IA retenue', async () => {
      const c = '21650000013';
      control({ geminiDelayMs: 1500 });
      await text(c, 'Bonjour à vous');
      await wait(400);
      await webhook({
        messages: [{ to: c, id: `wamid.ECHO${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oui, nous livrons à Sousse.' } }]
      }, 'smb_message_echoes');
      assert.ok(await waitFor(async () => (await conversation(c)).entries.some(entry => entry.action === 'ai_reply_suppressed_human_active'), 5000));
      assert.strictEqual(sentTo(c).length, 0, 'aucune réponse IA après la réponse du commercial');
      // V6.45 — Le message client retenu garde son heure : il se range
      // avant la réponse du commercial, la conversation n'est pas « À
      // répondre ».
      const { item, entries } = await conversation(c);
      const suppressed = entries.find(entry => entry.action === 'ai_reply_suppressed_human_active');
      const human = entries.find(entry => /Oui, nous livrons à Sousse/.test(entry.reply || entry.outgoing || entry.text || ''));
      assert.ok(suppressed && human, JSON.stringify(entries.map(entry => entry.action)));
      assert.ok(Date.parse(suppressed.time) <= Date.parse(human.time), `${suppressed.time} > ${human.time}`);
      assert.notStrictEqual(item.pendingReply, true, 'conversation déjà répondue');
      control({});
    });

    await test('F9/F13 : handoff IA → pause sans échéance, SLA conservé, message suivant sans réponse IA', async () => {
      const c = '21650000001';
      control({ geminiReply: '[COMMERCIAL_REQUIRED]' });
      await text(c, 'Bonjour, une question');
      assert.ok(await waitFor(async () => (await conversation(c)).item.slaStatus === 'pending'));
      const { item } = await conversation(c);
      assert.strictEqual(item.humanPaused, true);
      assert.ok(!item.pausedUntil, 'aucune reprise automatique après 60 s');
      assert.strictEqual(item.commercialAttention, true);
      control({});
      // Le client relance : l'IA (qui répondrait maintenant) reste en pause.
      await text(c, 'Prix svp ?');
      assert.ok(await waitFor(async () => (await conversation(c)).entries.some(entry => entry.incoming === 'Prix svp ?' && entry.action === 'human_pause')));
      await wait(300);
      assert.strictEqual(sentTo(c).length, 0);
      assert.strictEqual((await conversation(c)).item.slaStatus, 'pending', 'SLA toujours actif');
    });

    await test('F11 : envoi Meta en échec → message client journalisé et escaladé', async () => {
      const c = '21650000007';
      control({ graphSendFail: 500 });
      await text(c, 'Je veux commander le canapé, appelez moi au 22 123 456');
      assert.ok(await waitFor(async () => (await conversation(c)).entries.some(entry => entry.action === 'ai_reply_send_failed' && /22 123 456/.test(entry.incoming || ''))));
      const { item } = await conversation(c);
      assert.strictEqual(item.commercialAttention, true);
      assert.strictEqual(item.slaStatus, 'pending');
      control({});
    });

    await test('F17 : « répondre à tous les non-lus » idempotent, prises en main respectées', async () => {
      const failed = '21650000007'; // non lu, réponse IA en échec juste avant
      const taken = '21650000005';
      await admin('POST', `/api/conversations/${taken}/takeover`, {});
      await text(taken, 'Bonjour ?');
      assert.ok(await waitFor(async () => (await conversation(taken)).entries.some(entry => entry.incoming === 'Bonjour ?')));
      const sentBefore = sentTo(failed).length;
      const first = await admin('POST', '/api/conversations/ai-respond-all-unread', {});
      assert.strictEqual(first.status, 200);
      assert.ok(first.json.respondedCount >= 1);
      assert.ok(first.json.ignored.some(entry => entry.contact === taken && entry.reason === 'manual_takeover'));
      assert.strictEqual(sentTo(failed).length, sentBefore + 1);
      const second = await admin('POST', '/api/conversations/ai-respond-all-unread', {});
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.json.respondedCount, 0, 'aucune nouvelle réponse au second clic');
      assert.strictEqual(sentTo(failed).length, sentBefore + 1);
      assert.strictEqual(sentTo(taken).length, 0);
      assert.strictEqual((await conversation(taken)).item.manualTakeover, true);
    });

    await test('F19 : réaction emoji → conservée, sans escalade ni pause', async () => {
      const c = '21650000011';
      await text(c, 'Bonjour');
      assert.ok(await waitFor(() => sentTo(c).length === 1));
      await customerMessage(c, { type: 'reaction', reaction: { message_id: 'wamid.MOCK1', emoji: '👍' } });
      assert.ok(await waitFor(async () => (await conversation(c)).entries.some(entry => entry.action === 'customer_reaction' && entry.reaction === '👍')));
      const { item, entries } = await conversation(c);
      assert.ok(!item.commercialAttention && !item.humanPaused && !item.manualTakeover);
      assert.ok(!entries.some(entry => entry.action === 'commercial_required'));
    });

    await test('sticker client → conservé, sans escalade ni pause : la question suivante reçoit la réponse IA', async () => {
      const c = '21650000014';
      await text(c, 'Bonjour, vous êtes ouverts aujourd’hui ?');
      assert.ok(await waitFor(() => sentTo(c).length === 1));
      await customerMessage(c, { type: 'sticker', sticker: { id: 'STICKER1', mime_type: 'image/webp', animated: false } });
      assert.ok(await waitFor(async () => (await conversation(c)).entries.some(entry => entry.action === 'customer_sticker')));
      const { item } = await conversation(c);
      assert.ok(!item.humanPaused && !item.manualTakeover, JSON.stringify({ humanPaused: item.humanPaused }));
      assert.notStrictEqual(item.slaStatus, 'pending');
      await text(c, 'Merci ! Et vous livrez à Sfax ?');
      assert.ok(await waitFor(() => sentTo(c).length === 2), 'réponse IA après le sticker');
      assert.ok(!(await conversation(c)).entries.some(entry => entry.action === 'commercial_required' || entry.action === 'human_pause'));
    });

    await test('F18 : statut Meta « failed » conservé et affiché dans la conversation', async () => {
      const c = '21650000011';
      await webhook({
        statuses: [{
          id: 'wamid.MOCKFAILED',
          status: 'failed',
          timestamp: String(Math.floor(Date.now() / 1000)),
          recipient_id: c,
          errors: [{ code: 131047, title: 'Re-engagement message' }]
        }]
      });
      assert.ok(await waitFor(async () => (await conversation(c)).entries.some(entry => entry.action === 'meta_delivery_failed' && /131047/.test(entry.system_body || ''))));
    });

    await test('Intégration sécurité : webhook non signé refusé, message sans numéro destinataire ni traité ni journalisé', async () => {
      const c = '21650000077';
      const id = `wamid.NOPHONE${Date.now()}`;
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        contacts: [{ wa_id: c, profile: { name: 'Sans numéro' } }],
        messages: [{ from: c, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Bonjour' } }]
      } }] }] });
      const unsigned = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      assert.strictEqual(unsigned.status, 401);
      const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`;
      const signed = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: payload });
      assert.strictEqual(signed.status, 200);
      await wait(600);
      // Jamais inscrit au journal : il ne sera pas rejoué au redémarrage (F15).
      const journalPath = path.join(dataDir, 'inbound-journal.jsonl');
      const journal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : '';
      assert.ok(!journal.includes(id), 'message sans numéro absent du journal');
      assert.strictEqual(sentTo(c).length, 0);
      assert.ok(!(await conversation(c)).entries.some(entry => entry.message_id === id));
    });

    await test('F15 : arrêt brutal pendant la génération IA → message rejoué au redémarrage', async () => {
      const c = '21650000008';
      control({ geminiDelayMs: 5000 });
      await text(c, 'Bonjour, je reviens vers vous');
      await wait(800);
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
      assert.strictEqual(sentTo(c).length, 0);
      // V6.45 — Message reçu il y a 2 h pendant une coupure (journal
      // seulement) : trop ancien pour l'IA, présenté au commercial ET pris
      // en compte dans l'état (fenêtre de 24 h, tri de l'Inbox).
      const old = '21650000015';
      const oldMs = Date.now() - 2 * 60 * 60 * 1000;
      fs.appendFileSync(path.join(dataDir, 'inbound-journal.jsonl'), `${JSON.stringify({
        t: 'in',
        id: 'wamid.OLDJOURNAL1',
        at: new Date(oldMs).toISOString(),
        payload: {
          channel: 'whatsapp',
          profileName: 'Client Ancien',
          message: { from: old, id: 'wamid.OLDJOURNAL1', timestamp: String(Math.floor(oldMs / 1000)), type: 'text', text: { body: 'Je veux commander le salon, rappelez-moi' } }
        }
      })}\n`);
      control({ geminiDelayMs: 800 });
      startServer();
      await waitReadyAndLogin();
      // Message suivant envoyé tout de suite : traité APRÈS le message rejoué.
      await text(c, 'Et pour la livraison ?');
      assert.ok(await waitFor(() => sentTo(c).length === 2, 20000), 'réponses IA envoyées après la reprise');
      const { entries } = await conversation(c);
      const first = entries.find(entry => entry.incoming === 'Bonjour, je reviens vers vous' && entry.reply_sent === true);
      const second = entries.find(entry => entry.incoming === 'Et pour la livraison ?' && entry.reply_sent === true);
      assert.ok(first && second, JSON.stringify(entries.map(entry => [entry.incoming, entry.action])));
      assert.ok(Date.parse(first.time) <= Date.parse(second.time), `${first.time} > ${second.time}`);
      await wait(500);
      assert.strictEqual(sentTo(c).length, 2, 'une seule réponse par message');
      control({});
      assert.ok(await waitFor(async () => (await conversation(old)).entries.some(entry => entry.action === 'ai_reply_send_failed')));
      const detail = (await admin('GET', `/api/conversations/${old}`)).json || {};
      const lastCustomerMs = Date.parse(detail?.state?.lastCustomerAt || '');
      assert.ok(Number.isFinite(lastCustomerMs) && Math.abs(lastCustomerMs - oldMs) < 5000, JSON.stringify(detail?.state || {}));
      assert.strictEqual(sentTo(old).length, 0, 'aucune réponse IA automatique à un message trop ancien');
    });

    console.log(`ALL ${passed} MESSAGING E2E TESTS PASSED`);
  } catch (error) {
    console.error('FAIL', error);
    try {
      console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-60).join('\n'));
    } catch {}
    process.exitCode = 1;
  } finally {
    if (child) child.kill('SIGKILL');
    await wait(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
