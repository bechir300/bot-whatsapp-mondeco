// V6.45 — Source de vérité unique de l'état des conversations
// (lib/conversation-state-store.js) : écriture immédiate dans SQLite,
// copies anciennes sans effet sur les conversations modifiées depuis,
// reprise après arrêt brutal, JSON absent ou illisible, restauration.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createConversationStateStore } = require('../lib/conversation-state-store');

const quiet = { log() {}, warn() {}, error() {} };
let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}

function writeJsonAtomic(filePath, data) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  fs.renameSync(temp, filePath);
}

function openDbFactory(dbPath) {
  let db = null;
  return () => {
    if (db) return db;
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_states (
        contact TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    return db;
  };
}

function makeStore(dir, options = {}) {
  const openDb = options.openDb || openDbFactory(path.join(dir, 'mondeco.db'));
  const store = createConversationStateStore({
    jsonPath: path.join(dir, 'conversation-state.json'),
    openDb,
    writeJson: writeJsonAtomic,
    writeDebounceMs: 60 * 60 * 1000,
    jsonMinIntervalMs: 60 * 60 * 1000,
    logger: quiet,
    ...options
  });
  return { store, openDb };
}

function sqliteRow(openDb, contact) {
  const row = openDb().prepare('SELECT data FROM conversation_states WHERE contact = ?').get(contact);
  return row ? JSON.parse(row.data) : null;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-state-store-'));
let counter = 0;
const freshDir = () => {
  const dir = path.join(root, String(++counter));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

try {
  test('une écriture est visible immédiatement et écrite tout de suite dans SQLite', () => {
    const dir = freshDir();
    const { store, openDb } = makeStore(dir);
    store.update('21650000006', current => ({ ...current, manualTakeover: true, humanPaused: true, assignedTo: 'Sami' }));
    assert.strictEqual(store.get('21650000006').manualTakeover, true);
    assert.strictEqual(sqliteRow(openDb, '21650000006').assignedTo, 'Sami');
    // Le JSON complet reste groupé (pas encore écrit).
    assert.strictEqual(fs.existsSync(path.join(dir, 'conversation-state.json')), false);
    store.flush();
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'conversation-state.json'), 'utf8'));
    assert.strictEqual(json['21650000006'].manualTakeover, true);
  });

  test('régression F8 : prise en main puis écritures « server.js » entrelacées → jamais effacée', () => {
    const dir = freshDir();
    const { store } = makeStore(dir);
    const c = '21650000006';
    // server.js : message client
    store.update(c, current => ({ ...current, lastCustomerAt: '2026-11-11T20:07:20.000Z', unreadCount: 1 }));
    // Admin.js : « Prendre en main »
    store.update(c, current => ({ ...current, manualTakeover: true, humanPaused: true, assignedTo: 'Administrateur MONDECO' }));
    // server.js : statut « read » Meta puis nouveau message client
    store.update(c, current => ({ ...current, lastReadByCustomerAt: '2026-11-11T20:07:25.000Z' }));
    store.update(c, current => ({ ...current, lastCustomerAt: '2026-11-11T20:07:28.000Z', unreadCount: Number(current.unreadCount || 0) + 1 }));
    const state = store.get(c);
    assert.strictEqual(state.manualTakeover, true);
    assert.strictEqual(state.assignedTo, 'Administrateur MONDECO');
    assert.strictEqual(state.unreadCount, 2);
    // « Réactiver IA » (Admin) puis message client (server) : la réactivation tient.
    store.update(c, current => ({ ...current, manualTakeover: false, humanPaused: false }));
    store.update(c, current => ({ ...current, unreadCount: 3 }));
    assert.strictEqual(store.get(c).manualTakeover, false);
  });

  test('régression F13 : SLA + affectation puis pause IA → rien n’est perdu', () => {
    const dir = freshDir();
    const { store, openDb } = makeStore(dir);
    const c = '21650000001';
    // registerCommercialEscalation (Admin.js) puis pauseAiForCommercial (server.js)
    store.update(c, current => ({ ...current, commercialAttention: true, assignedTo: 'Commercial de garde', sla: { status: 'pending', dueAt: '2026-11-11T20:06:37.000Z' } }));
    store.update(c, current => ({ ...current, humanPaused: true, pausedUntil: null }));
    const state = store.get(c);
    assert.strictEqual(state.sla.status, 'pending');
    assert.strictEqual(state.assignedTo, 'Commercial de garde');
    assert.strictEqual(sqliteRow(openDb, c).sla.status, 'pending');
  });

  test('régression F18 : une copie complète ancienne n’efface pas une prise en main faite entre-temps', () => {
    const dir = freshDir();
    const { store } = makeStore(dir);
    store.update('21650000003', current => ({ ...current, awaitingResponse: true, followUpsSent: 0 }));
    store.update('21650000006', current => ({ ...current, manualTakeover: false }));
    const snapshot = store.loadAll(); // boucle de relance : copie prise au début
    // Pendant l'await de l'envoi Meta : prise en main de 21650000006.
    store.update('21650000006', current => ({ ...current, manualTakeover: true, assignedTo: 'Administrateur MONDECO' }));
    // La boucle enregistre SA modification puis la copie complète.
    snapshot['21650000003'] = { ...snapshot['21650000003'], followUpsSent: 1 };
    store.saveAll(snapshot);
    assert.strictEqual(store.get('21650000006').manualTakeover, true);
    assert.strictEqual(store.get('21650000006').assignedTo, 'Administrateur MONDECO');
    assert.strictEqual(store.get('21650000003').followUpsSent, 1);
    // Second enregistrement de la même copie avec une nouvelle modification de l'appelant.
    snapshot['21650000003'] = { ...snapshot['21650000003'], followUpsSent: 2 };
    store.saveAll(snapshot);
    assert.strictEqual(store.get('21650000003').followUpsSent, 2);
    assert.strictEqual(store.get('21650000006').manualTakeover, true);
  });

  test('suppression via une copie (purge) seulement si la conversation n’a pas changé depuis', () => {
    const dir = freshDir();
    const { store } = makeStore(dir);
    store.update('old-resolved', () => ({ resolved: true }));
    store.update('reopened', () => ({ resolved: true }));
    const snapshot = store.loadAll();
    delete snapshot['old-resolved'];
    delete snapshot.reopened;
    store.update('reopened', current => ({ ...current, resolved: false })); // nouveau message entre-temps
    store.saveAll(snapshot);
    assert.strictEqual('old-resolved' in store.live(), false);
    assert.strictEqual(store.get('reopened').resolved, false);
  });

  test('une carte construite hors loadAll() ne peut jamais supprimer de conversations', () => {
    const dir = freshDir();
    const { store, openDb } = makeStore(dir);
    store.update('keep-1', () => ({ resolved: false }));
    store.update('keep-2', () => ({ resolved: true }));
    store.saveAll({ 'keep-1': { resolved: true, note: 'partiel' } });
    assert.strictEqual(store.get('keep-1').note, 'partiel');
    assert.strictEqual(store.get('keep-2').resolved, true);
    assert.ok('keep-2' in store.live());
    assert.strictEqual(sqliteRow(openDb, 'keep-1').note, 'partiel');
  });

  test('get() renvoie une copie indépendante (pas de modification du cache par effet de bord)', () => {
    const dir = freshDir();
    const { store } = makeStore(dir);
    store.update('c1', () => ({ sla: { status: 'pending' } }));
    const copy = store.get('c1');
    copy.sla.status = 'tampered';
    assert.strictEqual(store.get('c1').sla.status, 'pending');
    // L'updater reçoit aussi une copie : muter l'objet imbriqué sans le
    // renvoyer ne touche pas l'état enregistré.
    store.update('c1', current => {
      current.sla.status = 'mutated';
      return null;
    });
    assert.strictEqual(store.get('c1').sla.status, 'pending');
  });

  test('arrêt brutal entre deux écritures JSON : l’état est repris depuis SQLite au démarrage', () => {
    const dir = freshDir();
    const first = makeStore(dir);
    first.store.update('a', () => ({ v: 1 }));
    first.store.flush();
    // Le JSON garde l'ancienne version ; SQLite reçoit les suivantes.
    const later = Date.now() + 5;
    while (Date.now() < later) {}
    first.store.update('a', current => ({ ...current, v: 2, manualTakeover: true }));
    first.store.update('b', () => ({ v: 1 }));
    // « Redémarrage » : nouvelle instance, même base.
    const second = makeStore(dir, { openDb: first.openDb });
    assert.deepStrictEqual(second.store.get('a'), { v: 2, manualTakeover: true });
    assert.deepStrictEqual(second.store.get('b'), { v: 1 });
    assert.ok('b' in second.store.loadAll());
  });

  test('installation neuve sans JSON : la carte complète est disponible tout de suite (pas de perte)', () => {
    const dir = freshDir();
    const { store } = makeStore(dir);
    store.update('x', () => ({ n: 1 }));
    store.update('y', () => ({ n: 2 }));
    const all = store.loadAll();
    assert.deepStrictEqual(Object.keys(all).sort(), ['x', 'y']);
    // Ancien bug : sans fichier JSON, la carte relue était vide et la
    // conversation suivante remplaçait toutes les autres.
    store.saveAll(all);
    assert.deepStrictEqual(Object.keys(store.live()).sort(), ['x', 'y']);
  });

  test('JSON illisible : état repris depuis SQLite et fichier jamais écrasé', () => {
    const dir = freshDir();
    const first = makeStore(dir);
    first.store.update('keep', () => ({ manualTakeover: true }));
    fs.writeFileSync(path.join(dir, 'conversation-state.json'), '{ corrompu');
    const second = makeStore(dir, { openDb: first.openDb });
    assert.strictEqual(second.store.get('keep').manualTakeover, true);
    second.store.update('new', () => ({ n: 1 }));
    second.store.flush();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'conversation-state.json'), 'utf8'), '{ corrompu');
    assert.strictEqual(second.store.isUnreadable(), true);
  });

  test('fichier JSON remplacé (restauration d’une sauvegarde) : rechargé, jamais écrasé par l’ancienne version', () => {
    const dir = freshDir();
    const { store } = makeStore(dir);
    store.update('a', () => ({ v: 'avant' }));
    store.flush();
    const jsonPath = path.join(dir, 'conversation-state.json');
    const later = Date.now() + 5;
    while (Date.now() < later) {}
    writeJsonAtomic(jsonPath, { a: { v: 'restauré' }, z: { v: 1 } });
    assert.strictEqual(store.get('a').v, 'restauré');
    store.update('z', current => ({ ...current, v: 2 }));
    store.flush();
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.strictEqual(json.a.v, 'restauré');
    assert.strictEqual(json.z.v, 2);
  });

  test('conversation absente de la carte : dernière version SQLite reprise (comportement antérieur)', () => {
    const dir = freshDir();
    const { store, openDb } = makeStore(dir);
    store.update('keep', () => ({ n: 1 }));
    store.flush();
    openDb().prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run('purged', JSON.stringify({ firstSeenAt: '2026-01-01' }), 1);
    assert.strictEqual(store.get('purged').firstSeenAt, '2026-01-01');
    const updated = store.update('purged', current => ({ ...current, unreadCount: 1 }));
    assert.strictEqual(updated.firstSeenAt, '2026-01-01');
  });
  console.log(`ALL ${passed} CONVERSATION STATE STORE TESTS PASSED`);
} catch (error) {
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
