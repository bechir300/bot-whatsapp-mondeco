// V6.46 — Sûreté des données côté server.js (paquet w2-data) : un message
// client reçu pendant un disque plein n'est jamais perdu, une ligne
// tronquée n'abîme pas l'événement suivant, une rafale après redémarrage
// reste entière dans conversation-log.json, les notifications ne sont plus
// réécrites à chaque message. server.js réel, DATA_DIR temporaire, ENOSPC
// injecté au niveau de fs.writeSync.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-w2data-server-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = '0';
process.env.WOOCOMMERCE_SYNC_ENABLED = 'false';
process.env.ADMIN_PASSWORD = 'test-password-not-used-123';
process.env.MONDECO_STORAGE_BALLAST_MB = '0';
for (const name of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'WHATSAPP_TOKEN', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_VOLUME_MOUNT_PATH']) delete process.env[name];
globalThis.fetch = async url => { throw new Error(`réseau bloqué pendant les tests : ${url}`); };

// conversation-log.json existant (redémarrage) avec une entrée.
fs.writeFileSync(path.join(dataDir, 'conversation-log.json'), JSON.stringify([{ contact: '21698000000', message_id: 'wamid.OLD', incoming: 'ancien', time: new Date(Date.now() - 3600 * 1000).toISOString() }]));
const past = new Date(Date.now() - 3600 * 1000);
fs.utimesSync(path.join(dataDir, 'conversation-log.json'), past, past);

const serverPath = path.join(root, 'server.js');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compileWithTestExports(content, filename) {
  if (filename === serverPath) {
    content += `
;globalThis.__srv = { logConversation, flushHistoryLogWrite, flushPendingPersistentWrites, pendingPersistentEvents,
  HISTORY_PATH, CONVERSATION_EVENTS_DIR, MESSAGE_ID_INDEX_PATH, httpServer, loadNotificationsStore, isoDateKey,
  persistentMessageIds };`;
  }
  return originalCompile.call(this, content, filename);
};

const logs = [];
const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
const capture = level => (...args) => logs.push(`${level} ${args.map(String).join(' ')}`);
console.log = capture('log');
console.info = capture('info');
console.warn = capture('warn');
console.error = capture('error');
require(serverPath);
Module.prototype._compile = originalCompile;
const S = globalThis.__srv;
const say = line => saved.log(line);

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  say(`PASS ${label}`);
}

// ---------- Disque plein simulé ----------
// Les descripteurs ouverts sur conversation-events/ reçoivent une écriture
// PARTIELLE puis ENOSPC (comme un vrai disque plein au milieu d'un ajout).
const fdPaths = new Map();
const originalOpenSync = fs.openSync;
const originalWriteSync = fs.writeSync;
const originalCloseSync = fs.closeSync;
let diskFull = false;
fs.openSync = function patchedOpen(file, ...rest) {
  const fd = originalOpenSync.call(this, file, ...rest);
  fdPaths.set(fd, String(file));
  return fd;
};
fs.closeSync = function patchedClose(fd) {
  fdPaths.delete(fd);
  return originalCloseSync.call(this, fd);
};
fs.writeSync = function patchedWrite(fd, buffer, offset, length, ...rest) {
  const target = fdPaths.get(fd) || '';
  if (diskFull && (target.includes('conversation-events') || target.endsWith('conversation-message-ids.jsonl'))) {
    if (Buffer.isBuffer(buffer) && (length || buffer.length) > 10) {
      originalWriteSync.call(this, fd, buffer, offset || 0, Math.floor((length || buffer.length) / 2));
    }
    const error = new Error('ENOSPC: no space left on device, write');
    error.code = 'ENOSPC';
    throw error;
  }
  return originalWriteSync.call(this, fd, buffer, offset, length, ...rest);
};

function inbound(contact, id, text) {
  S.logConversation({
    contact,
    channel: 'whatsapp',
    message_id: id,
    incoming: text,
    direction: 'incoming',
    time: new Date().toISOString()
  });
}

function eventsFile() {
  return path.join(S.CONVERSATION_EVENTS_DIR, `conversation-events-${S.isoDateKey(new Date())}.jsonl`);
}

function eventLines() {
  const file = eventsFile();
  if (!fs.existsSync(file)) return { valid: [], invalid: [] };
  const valid = [];
  const invalid = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { valid.push(JSON.parse(line)); } catch { invalid.push(line); }
  }
  return { valid, invalid };
}

(async () => {
  await test('G32 : rafale juste après un redémarrage → toutes les entrées gardées dans conversation-log.json', () => {
    for (let i = 1; i <= 5; i++) inbound('21698111001', `wamid.R${i}`, `rafale ${i}`);
    S.flushHistoryLogWrite();
    const ids = JSON.parse(fs.readFileSync(S.HISTORY_PATH, 'utf8')).map(entry => entry.message_id);
    assert.deepStrictEqual(ids, ['wamid.OLD', 'wamid.R1', 'wamid.R2', 'wamid.R3', 'wamid.R4', 'wamid.R5']);
  });

  await test('G32 : fichier réécrit par Admin.js pendant une écriture en attente → entrées en attente reprises', () => {
    inbound('21698111001', 'wamid.R6', 'en attente');
    // Réécriture externe (rétention, purge…) avant l'écriture différée.
    fs.writeFileSync(S.HISTORY_PATH, JSON.stringify([{ contact: '21698111001', message_id: 'wamid.R5' }]));
    inbound('21698111001', 'wamid.R7', 'suivant');
    S.flushHistoryLogWrite();
    const ids = JSON.parse(fs.readFileSync(S.HISTORY_PATH, 'utf8')).map(entry => entry.message_id);
    assert.deepStrictEqual(ids, ['wamid.R5', 'wamid.R6', 'wamid.R7']);
  });

  await test('G30 : un message client ne réécrit plus notifications.json de façon synchrone', () => {
    const notificationsPath = path.join(dataDir, 'notifications.json');
    const before = fs.existsSync(notificationsPath) ? fs.readFileSync(notificationsPath, 'utf8') : null;
    inbound('21698111002', 'wamid.N1', 'notification');
    const after = fs.existsSync(notificationsPath) ? fs.readFileSync(notificationsPath, 'utf8') : null;
    assert.strictEqual(after, before, 'pas d’écriture immédiate');
    assert.ok(S.loadNotificationsStore().items.some(item => item.id === 'wamid.N1'), 'notification visible en mémoire');
  });

  await test('G26 : disque plein → les messages clients restent en mémoire (journal récent + notifications), rien n’est perdu', () => {
    inbound('21698222000', 'wamid.A0', 'avant la panne');
    const sizeBefore = fs.statSync(eventsFile()).size;
    diskFull = true;
    for (let i = 1; i <= 4; i++) inbound(`2169822200${i}`, `wamid.B${i}`, `pendant la panne ${i}`);
    assert.strictEqual(S.pendingPersistentEvents.length, 4, 'événements gardés pour un nouvel essai');
    assert.strictEqual(fs.statSync(eventsFile()).size, sizeBefore, 'écriture partielle annulée (aucune ligne tronquée)');
    const notifications = S.loadNotificationsStore().items.map(item => item.id);
    for (let i = 1; i <= 4; i++) assert.ok(notifications.includes(`wamid.B${i}`), `notification B${i}`);
    assert.ok(logs.some(line => line.startsWith('error') && /Journal permanent des conversations non écrit/.test(line)), 'alerte console.error');
  });

  await test('G26 : espace revenu → événements en attente écrits dans l’ordre, aucune ligne illisible, message suivant intact', () => {
    diskFull = false;
    inbound('21698333001', 'wamid.C1', 'après la panne');
    S.flushHistoryLogWrite();
    assert.strictEqual(S.pendingPersistentEvents.length, 0);
    const { valid, invalid } = eventLines();
    assert.deepStrictEqual(invalid, [], 'aucune ligne tronquée');
    const ids = valid.map(entry => entry.message_id);
    const order = ['wamid.A0', 'wamid.B1', 'wamid.B2', 'wamid.B3', 'wamid.B4', 'wamid.C1'].map(id => ids.indexOf(id));
    assert.ok(order.every(index => index >= 0), `tous présents : ${ids.join(',')}`);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'ordre conservé');
    const history = JSON.parse(fs.readFileSync(S.HISTORY_PATH, 'utf8')).map(entry => entry.message_id);
    for (const id of ['wamid.B1', 'wamid.B4', 'wamid.C1']) assert.ok(history.includes(id), `${id} dans conversation-log.json`);
    const index = fs.readFileSync(S.MESSAGE_ID_INDEX_PATH, 'utf8').split('\n');
    assert.ok(index.includes('wamid.B2'), 'identifiant écrit après coup dans l’index');
  });

  await test('G26 : ligne tronquée laissée par un arrêt brutal → l’événement suivant commence sur une nouvelle ligne', () => {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const file = path.join(S.CONVERSATION_EVENTS_DIR, `conversation-events-${S.isoDateKey(tomorrow)}.jsonl`);
    fs.writeFileSync(file, '{"contact":"21698444001","message_id":"wamid.TORN","incoming":"coup');
    S.logConversation({ contact: '21698444002', channel: 'whatsapp', message_id: 'wamid.NEXT', incoming: 'suivant', direction: 'incoming', time: tomorrow.toISOString() });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[1]).message_id, 'wamid.NEXT', 'événement suivant lisible');
  });

  await test('V6.46 — échec d’écriture de conversation-log.json : nouvel essai après 15 s, pas une réécriture complète à chaque message', async () => {
    S.flushHistoryLogWrite();
    const originalRenameSync = fs.renameSync;
    let attempts = 0;
    fs.renameSync = function patchedRename(from, to, ...rest) {
      if (String(to) === S.HISTORY_PATH) {
        attempts++;
        const error = new Error('ENOSPC: no space left on device, rename');
        error.code = 'ENOSPC';
        throw error;
      }
      return originalRenameSync.call(this, from, to, ...rest);
    };
    try {
      inbound('21698666001', 'wamid.F0', 'premier');
      S.flushHistoryLogWrite();
      const afterFirst = attempts;
      assert.ok(afterFirst >= 1, 'écriture tentée');
      for (let i = 1; i <= 5; i++) inbound('21698666001', `wamid.F${i}`, `pendant l’échec ${i}`);
      await new Promise(resolve => setTimeout(resolve, 2200));
      assert.strictEqual(attempts, afterFirst, `aucune réécriture avant le délai (tentatives : ${attempts})`);
    } finally {
      fs.renameSync = originalRenameSync;
    }
    S.flushHistoryLogWrite();
    const ids = JSON.parse(fs.readFileSync(S.HISTORY_PATH, 'utf8')).map(entry => entry.message_id);
    for (let i = 0; i <= 5; i++) assert.ok(ids.includes(`wamid.F${i}`), `wamid.F${i} écrit ensuite`);
  });

  await test('G29 : conversation-log.json illisible → mis de côté (.corrupt-*), jamais écrasé par une seule entrée', () => {
    S.flushHistoryLogWrite();
    const truncated = fs.readFileSync(S.HISTORY_PATH, 'utf8').slice(0, 80);
    fs.writeFileSync(S.HISTORY_PATH, truncated);
    inbound('21698555001', 'wamid.AFTER', 'après corruption');
    S.flushHistoryLogWrite();
    const quarantined = fs.readdirSync(dataDir).filter(name => name.startsWith('conversation-log.json.corrupt-'));
    assert.strictEqual(quarantined.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, quarantined[0]), 'utf8'), truncated);
    assert.ok(logs.some(line => line.startsWith('error') && /conversation-log\.json illisible/.test(line)));
  });

  say(`ALL ${passed} DATA SAFETY SERVER TESTS PASSED`);
  Object.assign(console, saved);
  try { S.httpServer.close(); } catch {}
  setTimeout(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }, 100);
})().catch(error => {
  Object.assign(console, saved);
  console.error('FAIL', error);
  console.error(logs.slice(-30).join('\n'));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
