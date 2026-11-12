// Tests V6.45 de bout en bout du paquet sécurité : le vrai serveur
// (server.js + Admin.js) est démarré sur un port libre avec un DATA_DIR
// temporaire, puis interrogé en HTTP. Couvre : signature des webhooks,
// numéro WhatsApp obligatoire, CSP, protection CSRF, réponses rapides
// (droits + traçabilité), masquage réversible des messages, destinataire
// des envois, portée de /api/ai-replies, limite de connexion par (e-mail, IP).
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
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

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-security-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const ownOrigin = base;
  const secret = 'test-app-secret';
  const adminEmail = 'admin@mondeco.tn';
  const adminPassword = 'Test-Password-1234';
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60 * 1000).toISOString();

  // Données de départ : 3 conversations WhatsApp et 1 Instagram.
  fs.writeFileSync(path.join(dataDir, 'conversation-log.json'), JSON.stringify([
    { contact: '21650000001', channel: 'whatsapp', time: minutesAgo(10), reply_time: minutesAgo(10), message_id: 'wamid.A1', incoming: 'Bonjour, prix du salon Diana ?', reply: 'Le salon Diana est à 1200 DT.', action: 'ai_reply' },
    { contact: '21650000002', channel: 'whatsapp', time: minutesAgo(9), reply_time: minutesAgo(9), message_id: 'wamid.B1', incoming: 'Livraison à Sfax ?', reply: 'Oui, partout en Tunisie.', action: 'ai_reply' },
    { contact: '21650000003', channel: 'whatsapp', time: minutesAgo(8), message_id: 'wamid.C1', incoming: 'Message à effacer définitivement', reply: '', action: 'ok' },
    { contact: 'instagram:17841400000000001', channel: 'instagram', external_contact: '17841400000000001', time: minutesAgo(7), reply_time: minutesAgo(7), message_id: 'mid.I1', incoming: 'Prix chaise Lina ?', reply: 'La chaise Lina est à 150 DT.', action: 'ai_reply' }
  ]));
  fs.writeFileSync(path.join(dataDir, 'conversation-state.json'), JSON.stringify({
    '21650000001': { channel: 'whatsapp' },
    '21650000002': { channel: 'whatsapp' },
    '21650000003': { channel: 'whatsapp' },
    'instagram:17841400000000001': { channel: 'instagram', externalContact: '17841400000000001' }
  }));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      NODE_ENV: 'development',
      ADMIN_EMAIL: adminEmail,
      ADMIN_PASSWORD: adminPassword,
      VERIFY_TOKEN: 'verify-test',
      META_APP_SECRET: secret,
      WEBHOOK_SIGNATURE_REQUIRED: '',
      PHONE_NUMBER_ID: '111222333',
      WHATSAPP_TOKEN: '',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      // req.ip = dernière adresse de X-Forwarded-For (simule un proxy).
      TRUST_PROXY_HOPS: '1',
      ADMIN_ORIGIN_CHECK: '',
      ADMIN_ALLOWED_ORIGINS: '',
      PUBLIC_BASE_URL: '',
      RAILWAY_ENVIRONMENT_NAME: '',
      RAILWAY_ENVIRONMENT: '',
      RAILWAY_PROJECT_ID: '',
      WOOCOMMERCE_SYNC_ENABLED: 'false',
      LOG_FORMAT: 'text'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', chunk => { serverLog += chunk; });
  child.stderr.on('data', chunk => { serverLog += chunk; });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };

  function request(method, urlPath, { body, headers = {}, cookie = '', raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : (raw ? body : JSON.stringify(body));
      const finalHeaders = { ...headers };
      if (payload !== null && !finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json';
      if (payload !== null) finalHeaders['content-length'] = Buffer.byteLength(payload);
      if (cookie) finalHeaders.cookie = cookie;
      const req = http.request(`${base}${urlPath}`, { method, headers: finalHeaders }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error(`Délai dépassé : ${method} ${urlPath}`)));
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  // Requêtes de l'application (même origine).
  const app = (method, urlPath, cookie, body, headers = {}) =>
    request(method, urlPath, { cookie, body, headers: { origin: ownOrigin, ...headers } });

  async function login(email, password, headers = {}) {
    const res = await request('POST', '/admin/login', { body: { email, password }, headers: { origin: ownOrigin, ...headers } });
    const setCookie = [].concat(res.headers['set-cookie'] || [])[0] || '';
    return { ...res, cookie: setCookie.split(';')[0] };
  }

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await request('GET', '/health')).status === 200; } catch { await wait(250); }
    }
    assert.ok(up, `Le serveur n'a pas démarré :\n${serverLog.slice(-3000)}`);

    // ---------------- En-têtes ----------------
    await test('CSP stricte et interdiction d’affichage dans un cadre', async () => {
      const res = await request('GET', '/admin/login');
      const csp = String(res.headers['content-security-policy'] || '');
      for (const directive of ["script-src 'self' 'unsafe-inline'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"]) {
        assert.ok(csp.includes(directive), `CSP sans ${directive} : ${csp}`);
      }
      assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    });

    // ---------------- Webhooks Meta ----------------
    const sign = buffer => `sha256=${crypto.createHmac('sha256', secret).update(buffer).digest('hex')}`;
    const webhook = (payload, signature) => request('POST', '/webhook', {
      body: payload,
      raw: true,
      headers: signature === undefined ? {} : { 'x-hub-signature-256': signature }
    });

    await test('webhook : refusé sans signature ou mal signé, accepté signé (signature obligatoire par défaut)', async () => {
      const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
      assert.strictEqual((await webhook(payload)).status, 401);
      assert.strictEqual((await webhook(payload, 'sha256=00')).status, 401);
      assert.strictEqual((await webhook(payload, `sha256=${crypto.createHmac('sha256', 'autre').update(payload).digest('hex')}`)).status, 401);
      assert.strictEqual((await webhook(payload, sign(Buffer.from(payload)))).status, 200);
      assert.ok(/Signature des webhooks Meta obligatoire/.test(serverLog), 'message de démarrage attendu');
    });

    // ---------------- Comptes ----------------
    const admin = await login(adminEmail, adminPassword);
    assert.strictEqual(admin.status, 200, admin.text);
    const createUser = async (name, email, role) => {
      const res = await app('POST', '/admin/api/users', admin.cookie, { name, email, role, password: 'Commercial-Pass-1' });
      assert.ok([200, 201].includes(res.status), res.text);
      return res.json?.user || res.json;
    };
    const userA = await createUser('Commercial A', 'coma@mondeco.tn', 'commercial');
    const userB = await createUser('Commercial B', 'comb@mondeco.tn', 'commercial');
    await createUser('Commercial C', 'comc@mondeco.tn', 'commercial');
    assert.ok(userA?.id && userB?.id, 'identifiants des commerciaux');
    const loginA = await login('coma@mondeco.tn', 'Commercial-Pass-1');
    const loginB = await login('comb@mondeco.tn', 'Commercial-Pass-1');
    assert.strictEqual(loginA.status, 200, loginA.text);
    assert.strictEqual(loginB.status, 200, loginB.text);

    // A : planning du jour sur WhatsApp uniquement. B : aucun planning (tous les canaux).
    const schedule = await app('POST', '/admin/api/schedules', admin.cookie, {
      userId: userA.id, date: tunisToday(), startTime: '00:00', endTime: '23:59', channels: ['whatsapp_messages']
    });
    assert.strictEqual(schedule.status, 201, schedule.text);

    await test('webhook signé sans metadata.phone_number_id : message ignoré (PHONE_NUMBER_ID configuré)', async () => {
      const payload = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp',
          contacts: [{ wa_id: '21659999999', profile: { name: 'Faux' } }],
          messages: [{ from: '21659999999', id: 'wamid.FORGED1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'faux message' } }]
        } }] }]
      });
      assert.strictEqual((await webhook(payload, sign(Buffer.from(payload)))).status, 200);
      await wait(800);
      assert.ok(/sans numéro destinataire/.test(serverLog), 'journal du rejet attendu');
      const list = await app('GET', '/admin/api/conversations', admin.cookie);
      assert.strictEqual(list.status, 200, list.text);
      assert.ok(!list.text.includes('21659999999'), 'aucune conversation créée pour le faux numéro');
    });

    // ---------------- CSRF ----------------
    await test('CSRF : écriture refusée depuis une autre origine ou sans origine, acceptée depuis l’application', async () => {
      const foreign = await request('POST', '/admin/api/notifications/read-all', { cookie: admin.cookie, body: {}, headers: { origin: 'https://evil.mondeco.tn', 'sec-fetch-site': 'same-site' } });
      assert.strictEqual(foreign.status, 403);
      assert.strictEqual(foreign.json?.errorCode, 'CSRF_ORIGIN_REJECTED');
      const formPost = await request('POST', '/admin/api/speed-cleanup', { cookie: admin.cookie, body: 'x=1', raw: true, headers: { 'content-type': 'text/plain', origin: 'https://evil.mondeco.tn' } });
      assert.strictEqual(formPost.status, 403);
      const noOrigin = await request('POST', '/admin/api/notifications/read-all', { cookie: admin.cookie, body: {} });
      assert.strictEqual(noOrigin.status, 403);
      const sameOrigin = await app('POST', '/admin/api/notifications/read-all', admin.cookie, {});
      assert.notStrictEqual(sameOrigin.status, 403, sameOrigin.text);
      const appHeader = await request('POST', '/admin/api/notifications/read-all', { cookie: admin.cookie, body: {}, headers: { 'x-mondeco-client': 'admin' } });
      assert.notStrictEqual(appHeader.status, 403, appHeader.text);
      const reset = await request('POST', '/reset-test-history', { cookie: admin.cookie, body: {}, headers: { origin: 'https://evil.mondeco.tn' } });
      assert.strictEqual(reset.status, 403);
      const testIa = await request('GET', '/test-ia?message=Bonjour', { cookie: admin.cookie, headers: { 'sec-fetch-site': 'same-site' } });
      assert.strictEqual(testIa.status, 403);
      // Lecture (GET) jamais concernée.
      assert.strictEqual((await request('GET', '/admin/api/quick-replies', { cookie: admin.cookie })).status, 200);
    });

    // ---------------- Réponses rapides ----------------
    let quickReplyId = '';
    await test('réponses rapides : commercial en lecture seule', async () => {
      const create = await app('POST', '/admin/api/quick-replies', loginA.cookie, { title: 'Paiement', shortcut: 'e', content: 'Virement sur mon compte perso' });
      assert.strictEqual(create.status, 403, create.text);
      assert.strictEqual(create.json?.errorCode, 'QUICK_REPLY_READ_ONLY');
      const importRes = await app('POST', '/admin/api/quick-replies/import', loginA.cookie, { items: [{ title: 'x', shortcut: 'x', content: 'x' }] });
      assert.strictEqual(importRes.status, 403);
      assert.strictEqual((await app('GET', '/admin/api/quick-replies', loginA.cookie)).status, 200);
    });

    await test('réponses rapides : auteur enregistré et historique des modifications', async () => {
      const create = await app('POST', '/admin/api/quick-replies', admin.cookie, { title: 'Adresse showroom', shortcut: 'adresse', content: 'Showroom de Nabeul, route de Tunis.' });
      assert.strictEqual(create.status, 201, create.text);
      quickReplyId = create.json.id;
      assert.ok(create.json.createdBy && create.json.createdByName, 'auteur de la création');
      const update = await app('PUT', `/admin/api/quick-replies/${quickReplyId}`, admin.cookie, { content: 'Showroom de Nabeul, ouvert 9h-19h.' });
      assert.strictEqual(update.status, 200, update.text);
      assert.ok(update.json.updatedByName);
      assert.strictEqual((await app('PUT', `/admin/api/quick-replies/${quickReplyId}`, loginA.cookie, { content: 'piraté' })).status, 403);
      assert.strictEqual((await app('DELETE', `/admin/api/quick-replies/${quickReplyId}`, loginA.cookie)).status, 403);

      const history = await app('GET', '/admin/api/quick-replies/history', admin.cookie);
      assert.strictEqual(history.status, 200, history.text);
      const types = history.json.items.map(item => item.type);
      assert.ok(types.includes('quick_reply_create') && types.includes('quick_reply_update'), JSON.stringify(types));
      const updateEvent = history.json.items.find(item => item.type === 'quick_reply_update');
      assert.strictEqual(updateEvent.before.content, 'Showroom de Nabeul, route de Tunis.');
      assert.strictEqual(updateEvent.after.content, 'Showroom de Nabeul, ouvert 9h-19h.');
      assert.strictEqual((await app('GET', '/admin/api/quick-replies/history', loginA.cookie)).status, 403);

      const removed = await app('DELETE', `/admin/api/quick-replies/${quickReplyId}`, admin.cookie);
      assert.strictEqual(removed.status, 200, removed.text);
      const afterDelete = await app('GET', '/admin/api/quick-replies/history', admin.cookie);
      const deleteEvent = afterDelete.json.items.find(item => item.type === 'quick_reply_delete');
      assert.ok(deleteEvent && deleteEvent.before.content.includes('9h-19h'), 'texte supprimé conservé dans le journal');
    });

    // ---------------- Destinataire des envois ----------------
    await test('envois : destinataire différent de la conversation contrôlée refusé', async () => {
      const decoy = await app('POST', '/admin/api/commercial/send', loginA.cookie, { contact: 'decoy-999', externalContact: '21650000002', text: 'Contactez-moi en privé' });
      assert.strictEqual(decoy.status, 400, decoy.text);
      assert.strictEqual(decoy.json?.errorCode, 'RECIPIENT_MISMATCH');
      const sticker = await app('POST', '/admin/api/commercial/send-sticker', admin.cookie, { contact: '21650000001', externalContact: '21650000002', stickerId: 'x' });
      assert.strictEqual(sticker.status, 400, sticker.text);
      const call = await app('POST', '/admin/api/whatsapp/calls/start', admin.cookie, { contact: '21650000001', externalContact: '21650000002', sdp: 'v=0\r\n' });
      assert.strictEqual(call.status, 400, call.text);
      assert.strictEqual(call.json?.errorCode, 'RECIPIENT_MISMATCH');
    });

    // ---------------- Masquage réversible des messages ----------------
    const assign = async (contact, userId) => {
      const res = await app('POST', `/admin/api/conversations/${encodeURIComponent(contact)}/assign`, admin.cookie, { assignedUserId: userId });
      assert.strictEqual(res.status, 200, res.text);
    };
    const detail = async (contact, cookie = admin.cookie) => {
      const res = await app('GET', `/admin/api/conversations/${encodeURIComponent(contact)}`, cookie);
      assert.strictEqual(res.status, 200, res.text);
      return res.json;
    };
    const hide = (contact, key, part, cookie, permanent = false) =>
      app('DELETE', `/admin/api/conversations/${encodeURIComponent(contact)}/messages/${encodeURIComponent(key)}?part=${part}${permanent ? '&permanent=1' : ''}`, cookie);

    await test('suppression : un commercial ne masque que dans une conversation qui lui est affectée, jamais définitivement', async () => {
      await assign('21650000001', userA.id);
      const data = await detail('21650000001');
      const entry = data.entries.find(item => item.message_id === 'wamid.A1');
      const key = entry.purgeKeys.incoming;
      assert.ok(key, 'clé de suppression');
      assert.strictEqual((await hide('21650000001', key, 'incoming', loginB.cookie)).status, 403, 'B : conversation de A');
      assert.strictEqual((await hide('21650000002', (await detail('21650000002')).entries[0].purgeKeys.incoming, 'incoming', loginA.cookie)).status, 403, 'A : conversation non affectée');
      assert.strictEqual((await hide('21650000001', key, 'incoming', loginA.cookie, true)).status, 403, 'définitif : administrateur seulement');
      const hidden = await hide('21650000001', key, 'incoming', loginA.cookie);
      assert.strictEqual(hidden.status, 200, hidden.text);
      assert.strictEqual(hidden.json.hidden, true);
      assert.strictEqual(hidden.json.permanentlyDeleted, false);
      assert.strictEqual((await hide('21650000001', key, 'incoming', loginA.cookie)).status, 409, 'déjà masqué');
    });

    await test('message masqué : mention visible, conversation conservée, restauration par un administrateur', async () => {
      let data = await detail('21650000001');
      let entry = data.entries.find(item => item.message_id === 'wamid.A1');
      assert.ok(/^🗑 Message masqué par Commercial A/.test(entry.incoming), entry.incoming);
      assert.strictEqual(entry.reply, 'Le salon Diana est à 1200 DT.', 'l’autre partie reste visible');
      assert.ok(entry.softDeleted?.incoming?.id, 'identifiant de restauration');
      assert.strictEqual(entry.purgeKeys.incoming, '');
      assert.ok(entry.purgeKeys.reply, 'la réponse reste masquable');
      assert.strictEqual(data.state.assignedUserId, userA.id);

      const list = await app('GET', '/admin/api/conversations', admin.cookie);
      assert.ok(list.text.includes('21650000001'), 'la conversation reste dans la boîte de réception');

      const deletions = await app('GET', '/admin/api/message-deletions?contact=21650000001', admin.cookie);
      assert.strictEqual(deletions.status, 200, deletions.text);
      assert.strictEqual(deletions.json.items[0].preview, 'Bonjour, prix du salon Diana ?');
      assert.strictEqual(deletions.json.items[0].deletedByUserId, userA.id);
      assert.strictEqual((await app('GET', '/admin/api/message-deletions', loginA.cookie)).status, 403);
      assert.strictEqual((await app('POST', `/admin/api/message-deletions/${entry.softDeleted.incoming.id}/restore`, loginA.cookie, {})).status, 403);

      const restored = await app('POST', `/admin/api/message-deletions/${entry.softDeleted.incoming.id}/restore`, admin.cookie, {});
      assert.strictEqual(restored.status, 200, restored.text);
      data = await detail('21650000001');
      entry = data.entries.find(item => item.message_id === 'wamid.A1');
      assert.strictEqual(entry.incoming, 'Bonjour, prix du salon Diana ?');
      assert.ok(!entry.softDeleted);

      const activityDir = path.join(dataDir, 'team-activity-days');
      const activity = fs.readdirSync(activityDir).map(name => fs.readFileSync(path.join(activityDir, name), 'utf8')).join('');
      assert.ok(activity.includes('"type":"message_hide"') && activity.includes('"type":"message_restore"'), 'traces dans le journal d’activité');
    });

    await test('purge définitive (administrateur) : la conversation et son affectation sont conservées', async () => {
      await assign('21650000003', userB.id);
      const data = await detail('21650000003');
      const key = data.entries.find(item => item.message_id === 'wamid.C1').purgeKeys.incoming;
      assert.strictEqual((await hide('21650000003', key, 'incoming', admin.cookie)).status, 200);
      const hiddenEntry = (await detail('21650000003')).entries.find(item => item.message_id === 'wamid.C1');
      const purge = await hide('21650000003', hiddenEntry.softDeleted.keys.incoming, 'incoming', admin.cookie, true);
      assert.strictEqual(purge.status, 200, purge.text);
      assert.strictEqual(purge.json.permanentlyDeleted, true);
      const after = await detail('21650000003');
      assert.ok(!after.entries.some(item => item.message_id === 'wamid.C1'), 'message effacé');
      assert.strictEqual(after.state.assignedUserId, userB.id, 'affectation conservée');
      const log = fs.readFileSync(path.join(dataDir, 'conversation-log.json'), 'utf8');
      assert.ok(!log.includes('Message à effacer définitivement'), 'texte retiré du journal');
    });

    // ---------------- /api/ai-replies ----------------
    await test('/api/ai-replies : un commercial ne voit que les canaux de son planning', async () => {
      const contactsOf = res => res.json.replies.map(item => item.contact);
      const asAdmin = await app('GET', '/admin/api/ai-replies?limit=50', admin.cookie);
      assert.ok(contactsOf(asAdmin).includes('instagram:17841400000000001'), JSON.stringify(contactsOf(asAdmin)));
      const asA = await app('GET', '/admin/api/ai-replies?limit=50', loginA.cookie);
      assert.strictEqual(asA.status, 200, asA.text);
      assert.ok(contactsOf(asA).includes('21650000002'));
      assert.ok(!contactsOf(asA).some(contact => contact.startsWith('instagram:')), 'Instagram hors planning');
      assert.ok(!JSON.stringify(asA.json.stats.byChannel).includes('instagram'));
      const asB = await app('GET', '/admin/api/ai-replies?limit=50', loginB.cookie);
      assert.ok(contactsOf(asB).includes('instagram:17841400000000001'), 'sans planning : tous les canaux');
    });

    // ---------------- Limite de connexion ----------------
    await test('connexion : 8 échecs depuis 8 IP n’empêchent pas le vrai titulaire de se connecter', async () => {
      for (let i = 1; i <= 8; i++) {
        const res = await login(adminEmail, 'mauvais-mot-de-passe', { 'x-forwarded-for': `203.0.113.${i}` });
        assert.strictEqual(res.status, 401);
      }
      const startedAt = Date.now();
      const legit = await login(adminEmail, adminPassword, { 'x-forwarded-for': '198.51.100.77' });
      assert.strictEqual(legit.status, 200, legit.text);
      assert.ok(Date.now() - startedAt >= 900, 'délai progressif appliqué');
    });

    await test('connexion : 8 échecs depuis la même IP bloquent ce couple (e-mail, IP) seulement', async () => {
      for (let i = 0; i < 8; i++) {
        assert.strictEqual((await login('comc@mondeco.tn', 'mauvais', { 'x-forwarded-for': '203.0.113.50' })).status, 401);
      }
      const blocked = await login('comc@mondeco.tn', 'Commercial-Pass-1', { 'x-forwarded-for': '203.0.113.50' });
      assert.strictEqual(blocked.status, 429);
      assert.ok(Number(blocked.headers['retry-after']) > 0);
      const otherIp = await login('comc@mondeco.tn', 'Commercial-Pass-1', { 'x-forwarded-for': '198.51.100.20' });
      assert.strictEqual(otherIp.status, 200, otherIp.text);
    });

    console.log(`ALL ${passed} SECURITY ROUTE TESTS PASSED`);
  } catch (error) {
    console.error('FAIL', error);
    console.error('--- Fin du journal serveur ---\n' + serverLog.slice(-4000));
    cleanup();
    process.exit(1);
  }
  cleanup();
  process.exit(0);
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
