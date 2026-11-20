// V6.46 — Sûreté des données (paquet w2-data) : état des conversations et
// magasins JSON quand SQLite est indisponible ou qu'un fichier est vide /
// illisible. Dossiers temporaires uniquement.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createConversationStateStore } = require('../lib/conversation-state-store');
const { createJsonObjectStore } = require('../lib/json-object-store');

const quiet = { log() {}, warn() {}, error() {} };
let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

function writeJsonAtomic(filePath, data) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  fs.renameSync(temp, filePath);
}

function createDb(dbPath) {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS conversation_states (contact TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);');
  return db;
}

// Base « cassée » : openDb renvoie null (comme getSqliteDb après une erreur
// d'ouverture) jusqu'à ce que `available` passe à true.
function switchableDb(dbPath) {
  const control = { available: false, opens: 0, db: null };
  control.openDb = () => {
    control.opens++;
    if (!control.available) return null;
    if (!control.db) control.db = createDb(dbPath);
    return control.db;
  };
  return control;
}

function sqliteRow(db, contact) {
  const row = db.prepare('SELECT data FROM conversation_states WHERE contact = ?').get(contact);
  return row ? JSON.parse(row.data) : null;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-w2data-stores-'));
let counter = 0;
const freshDir = () => {
  const dir = path.join(root, String(++counter));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

(async () => {
  try {
    await test('G27 : base SQLite illisible → un message client n’efface jamais prise en main, affectation ni fiche client', () => {
      const dir = freshDir();
      const jsonPath = path.join(dir, 'conversation-state.json');
      const before = {
        channel: 'whatsapp',
        assignedTo: 'Sami',
        assignedUserId: 'u-sami',
        manualTakeover: true,
        humanPaused: true,
        favorite: true,
        customerProfile: { city: 'Sfax', budget: '3000 DT' }
      };
      fs.writeFileSync(jsonPath, JSON.stringify({ 21698000001: before }));
      fs.writeFileSync(path.join(dir, 'mondeco.db'), 'ceci n’est pas une base SQLite');
      let opens = 0;
      const store = createConversationStateStore({
        jsonPath,
        openDb: () => {
          opens++;
          try { return createDb(path.join(dir, 'mondeco.db')); } catch { return null; }
        },
        writeJson: writeJsonAtomic,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 60 * 60 * 1000,
        sqliteRetryMs: 60 * 60 * 1000,
        logger: quiet
      });
      // markCustomerMessage (server.js) : lecture-modification-écriture.
      for (let i = 0; i < 5; i++) {
        store.update('21698000001', current => ({ ...current, lastCustomerAt: new Date().toISOString(), awaitingResponse: true }));
      }
      store.flush();
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))['21698000001'];
      assert.strictEqual(json.manualTakeover, true);
      assert.strictEqual(json.humanPaused, true);
      assert.strictEqual(json.assignedTo, 'Sami');
      assert.deepStrictEqual(json.customerProfile, before.customerProfile);
      assert.strictEqual(json.awaitingResponse, true);
      // Ouverture non retentée à chaque appel (avant : 5 erreurs pour 1 message).
      assert.ok(opens <= 2, `ouvertures tentées : ${opens}`);
      assert.strictEqual(store.stats().sqliteAvailable, false);
    });

    await test('G27/G28 : SQLite indisponible au démarrage puis rétablie → lignes plus récentes reprises, jamais écrasées par la copie JSON', async () => {
      const dir = freshDir();
      const jsonPath = path.join(dir, 'conversation-state.json');
      const dbPath = path.join(dir, 'mondeco.db');
      // JSON écrit il y a un moment ; SQLite a reçu ensuite une prise en main.
      fs.writeFileSync(jsonPath, JSON.stringify({
        A: { channel: 'whatsapp', humanPaused: false, assignedTo: '' },
        B: { channel: 'whatsapp', note: 'json' }
      }));
      const past = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(jsonPath, past, past);
      const seed = createDb(dbPath);
      seed.prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run('A', JSON.stringify({ channel: 'whatsapp', humanPaused: true, assignedTo: 'Sami' }), Date.now());
      seed.prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run('B', JSON.stringify({ channel: 'whatsapp', note: 'sqlite' }), Date.now());
      seed.close();

      const control = switchableDb(dbPath);
      const store = createConversationStateStore({
        jsonPath,
        openDb: control.openDb,
        writeJson: writeJsonAtomic,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 60 * 60 * 1000,
        sqliteRetryMs: 0,
        logger: quiet
      });
      assert.strictEqual(store.get('A').humanPaused, false, 'base indisponible : copie JSON');
      assert.strictEqual(store.stats().sqliteOverlayPending, true);
      // Pendant la panne, B est modifiée en mémoire (message client).
      store.update('B', current => ({ ...current, note: 'mémoire' }));
      control.available = true;
      // Resynchronisation complète (3 min après le démarrage en production).
      await store.backgroundFullSync();
      assert.strictEqual(store.get('A').humanPaused, true, 'prise en main SQLite reprise');
      assert.strictEqual(store.get('A').assignedTo, 'Sami');
      assert.strictEqual(sqliteRow(control.db, 'A').humanPaused, true, 'ligne SQLite plus récente jamais écrasée');
      assert.strictEqual(store.get('B').note, 'mémoire', 'modification faite depuis le démarrage gardée');
      assert.strictEqual(sqliteRow(control.db, 'B').note, 'mémoire');
      control.db.close();
    });

    await test('update() : aucune entrée vide créée pour une conversation inconnue', () => {
      const dir = freshDir();
      const dbPath = path.join(dir, 'mondeco.db');
      const db = createDb(dbPath);
      const store = createConversationStateStore({
        jsonPath: path.join(dir, 'conversation-state.json'),
        openDb: () => db,
        writeJson: writeJsonAtomic,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 60 * 60 * 1000,
        logger: quiet
      });
      store.update('inconnu-1', () => undefined);
      store.update('inconnu-2', current => current);
      store.update('inconnu-3', () => ({}));
      assert.strictEqual('inconnu-1' in store.live(), false);
      assert.strictEqual('inconnu-2' in store.live(), false);
      assert.strictEqual('inconnu-3' in store.live(), false);
      assert.strictEqual(sqliteRow(db, 'inconnu-1'), null);
      // Conversation retirée de la carte mais présente dans SQLite : un
      // updater sans changement ne la réinscrit pas.
      db.prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run('archivee', JSON.stringify({ resolved: true }), Date.now());
      store.update('archivee', current => current);
      assert.strictEqual('archivee' in store.live(), false);
      // Une vraie modification reste enregistrée.
      store.update('nouveau', current => ({ ...current, channel: 'whatsapp' }));
      assert.strictEqual(store.get('nouveau').channel, 'whatsapp');
      db.close();
    });

    await test('G29 : conversation-state.json vide (0 octet) → reconstruit depuis SQLite, jamais réécrit avec un seul client', () => {
      const dir = freshDir();
      const jsonPath = path.join(dir, 'conversation-state.json');
      const db = createDb(path.join(dir, 'mondeco.db'));
      for (let i = 1; i <= 3; i++) {
        db.prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run(`2169800000${i}`, JSON.stringify({ favorite: true, assignedTo: 'Sami' }), Date.now() - 3600 * 1000);
      }
      fs.writeFileSync(jsonPath, '');
      const store = createConversationStateStore({
        jsonPath,
        openDb: () => db,
        writeJson: writeJsonAtomic,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 60 * 60 * 1000,
        logger: quiet
      });
      store.update('21698000009', current => ({ ...current, channel: 'whatsapp' }));
      store.flush();
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.deepStrictEqual(Object.keys(json).sort(), ['21698000001', '21698000002', '21698000003', '21698000009']);
      assert.strictEqual(json['21698000001'].assignedTo, 'Sami');
      db.close();
    });

    await test('V6.46 — JSON vide (0 octet) + SQLite indisponible → mémoire reprise du .bak, IA en pause gardée, .bak jamais écrasé par {} ni par une version plus pauvre', () => {
      const dir = freshDir();
      const jsonPath = path.join(dir, 'conversation-state.json');
      const bak = { 21698000001: { channel: 'whatsapp', humanPaused: true, manualTakeover: true, assignedUserId: 'u-1' } };
      fs.writeFileSync(jsonPath, '');
      fs.writeFileSync(`${jsonPath}.bak`, JSON.stringify(bak));
      const control = switchableDb(path.join(dir, 'mondeco.db'));
      // Écriture comme Admin.js : copie du fichier actuel vers .bak avant rename.
      const write = (target, data) => {
        if (fs.existsSync(target) && fs.statSync(target).size) fs.copyFileSync(target, `${target}.bak`);
        writeJsonAtomic(target, data);
      };
      const store = createConversationStateStore({
        jsonPath,
        openDb: control.openDb,
        writeJson: write,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 0,
        sqliteRetryMs: 0,
        logger: quiet
      });
      assert.strictEqual(store.get('21698000001').humanPaused, true, 'prise en main reprise du .bak');
      assert.strictEqual(store.get('21698000001').assignedUserId, 'u-1');
      store.update('21698000001', current => ({ ...current, lastCustomerAt: '2026-11-12T10:00:00.000Z', awaitingResponse: true }));
      store.flush();
      // Mémoire = .bak + changements : JSON écrit, le .bak (fichier vide
      // avant la 1re écriture) reste intact.
      assert.strictEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))['21698000001'].humanPaused, true, 'JSON écrit avec le .bak et le changement');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${jsonPath}.bak`, 'utf8')), bak, '.bak intact');
      assert.strictEqual(store.stats().jsonHeldForOverlay, false);
      assert.ok(fs.existsSync(`${jsonPath}.sqlite-overlay-pending`), 'reprise SQLite due enregistrée');
      // La base revient : reprise faite, JSON de nouveau écrit (avec le .bak).
      control.available = true;
      store.update('21698000002', current => ({ ...current, channel: 'whatsapp' }));
      store.flush();
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.strictEqual(json['21698000001'].humanPaused, true);
      assert.strictEqual(json['21698000001'].awaitingResponse, true);
      assert.ok(json['21698000002']);
      assert.strictEqual(store.stats().jsonHeldForOverlay, false);
      assert.ok(!fs.existsSync(`${jsonPath}.sqlite-overlay-pending`), 'reprise faite : plus rien en attente');
      control.db.close();
    });

    await test('V6.46 — JSON vide + .bak + SQLite toujours indisponible : prise en main faite pendant la panne gardée après redémarrage (arrêt compris), puis fusionnée avec SQLite à son retour', () => {
      const dir = freshDir();
      const jsonPath = path.join(dir, 'conversation-state.json');
      const dbPath = path.join(dir, 'mondeco.db');
      // Base avant la panne : A plus récent que le .bak (affectation), B
      // client connu sans prise en main.
      const seed = createDb(dbPath);
      seed.prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run('A', JSON.stringify({ channel: 'whatsapp', humanPaused: true, manualTakeover: true, assignedUserId: 'u-9' }), Date.now() - 1000);
      seed.prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run('B', JSON.stringify({ channel: 'whatsapp', adReferral: { adId: '77' }, humanPaused: false }), Date.now() - 1000);
      seed.close();
      fs.writeFileSync(jsonPath, '');
      fs.writeFileSync(`${jsonPath}.bak`, JSON.stringify({ A: { channel: 'whatsapp', humanPaused: true, manualTakeover: true, assignedUserId: 'u-1' } }));
      const write = (target, data) => {
        if (fs.existsSync(target) && fs.statSync(target).size) fs.copyFileSync(target, `${target}.bak`);
        writeJsonAtomic(target, data);
      };
      const options = control => ({
        jsonPath,
        openDb: control.openDb,
        writeJson: write,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 60 * 60 * 1000,
        sqliteRetryMs: 0,
        logger: quiet
      });
      // 1er démarrage : base illisible tout du long.
      const down1 = switchableDb(dbPath);
      const first = createConversationStateStore(options(down1));
      first.update('B', current => ({ ...current, channel: 'whatsapp', lastCustomerAt: '2026-11-12T10:00:00.000Z' }));
      first.update('B', current => ({ ...current, humanPaused: true, manualTakeover: true, assignedUserId: 'u-2' }));
      first.flush(true); // arrêt (SIGTERM)
      assert.notStrictEqual(fs.readFileSync(jsonPath, 'utf8'), '', 'JSON écrit à l’arrêt (avant : rien)');
      assert.strictEqual(JSON.parse(fs.readFileSync(`${jsonPath}.bak`, 'utf8')).A.assignedUserId, 'u-1', '.bak intact');
      // 2e démarrage, base toujours indisponible : la prise en main de B est là.
      const down2 = switchableDb(dbPath);
      const second = createConversationStateStore(options(down2));
      assert.strictEqual(second.get('B').humanPaused, true, 'prise en main de B gardée (avant : perdue, l’IA répondait)');
      assert.strictEqual(second.get('A').humanPaused, true);
      // La base revient : lignes SQLite reprises, champs de B modifiés
      // pendant la panne fusionnés avec sa ligne.
      down2.available = true;
      second.update('C', current => ({ ...current, channel: 'whatsapp' }));
      assert.strictEqual(second.get('A').assignedUserId, 'u-9', 'ligne SQLite plus récente que le .bak reprise');
      const b = second.get('B');
      assert.strictEqual(b.humanPaused, true);
      assert.strictEqual(b.assignedUserId, 'u-2');
      assert.deepStrictEqual(b.adReferral, { adId: '77' }, 'champ de la ligne SQLite gardé');
      second.flush(true);
      assert.ok(!fs.existsSync(`${jsonPath}.sqlite-overlay-pending`));
      assert.strictEqual(sqliteRow(down2.db, 'B').humanPaused, true);
      down2.db.close();
    });

    await test('V6.46 — écriture SQLite refusée par un verrou passager, sans autre message ensuite : nouvel essai automatique, ligne écrite et /health de nouveau « ok »', async () => {
      const dir = freshDir();
      const dbPath = path.join(dir, 'mondeco.db');
      createDb(dbPath).close();
      const db = new Database(dbPath, { timeout: 0 });
      const locker = new Database(dbPath);
      const results = [];
      const store = createConversationStateStore({
        jsonPath: path.join(dir, 'conversation-state.json'),
        openDb: () => db,
        writeJson: writeJsonAtomic,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 60 * 60 * 1000,
        writeRetryMs: 30,
        onWriteResult: ok => results.push(ok),
        logger: quiet
      });
      locker.exec('BEGIN EXCLUSIVE');
      store.update('21698000011', current => ({ ...current, channel: 'whatsapp', humanPaused: true }));
      assert.deepStrictEqual(results, [false], 'écriture refusée pendant le verrou');
      locker.exec('COMMIT');
      locker.close();
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.strictEqual(results[results.length - 1], true, 'écriture réussie au nouvel essai (avant : jamais retentée)');
      assert.strictEqual(sqliteRow(db, '21698000011').humanPaused, true);
      db.close();
    });

    await test('V6.46 — conversation absente du JSON, touchée pendant la panne SQLite → prise en main / affectation / pub de la ligne SQLite gardées', async () => {
      const dir = freshDir();
      const jsonPath = path.join(dir, 'conversation-state.json');
      const dbPath = path.join(dir, 'mondeco.db');
      fs.writeFileSync(jsonPath, JSON.stringify({ autre: { channel: 'whatsapp' } }));
      const past = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(jsonPath, past, past);
      const seed = createDb(dbPath);
      seed.prepare('INSERT INTO conversation_states (contact, data, updated_at) VALUES (?, ?, ?)').run('21698000007', JSON.stringify({
        channel: 'whatsapp', humanPaused: true, manualTakeover: true, assignedUserId: 'u-7', adReferral: { adId: '120' }, unreadCount: 0
      }), Date.now());
      seed.close();
      const control = switchableDb(dbPath);
      const store = createConversationStateStore({
        jsonPath,
        openDb: control.openDb,
        writeJson: writeJsonAtomic,
        writeDebounceMs: 60 * 60 * 1000,
        jsonMinIntervalMs: 60 * 60 * 1000,
        sqliteRetryMs: 0,
        logger: quiet
      });
      // Pendant la panne : le client écrit (état construit à partir de {}).
      store.update('21698000007', current => ({ ...current, channel: 'whatsapp', lastCustomerAt: '2026-11-12T10:00:00.000Z', awaitingResponse: true, unreadCount: (current.unreadCount || 0) + 1 }));
      control.available = true;
      store.update('autre', current => ({ ...current, note: 'x' }));
      const merged = store.get('21698000007');
      assert.strictEqual(merged.humanPaused, true);
      assert.strictEqual(merged.manualTakeover, true);
      assert.strictEqual(merged.assignedUserId, 'u-7');
      assert.deepStrictEqual(merged.adReferral, { adId: '120' });
      assert.strictEqual(merged.awaitingResponse, true, 'champ écrit pendant la panne gardé');
      assert.strictEqual(merged.unreadCount, 1);
      store.flush();
      const row = sqliteRow(control.db, '21698000007');
      assert.strictEqual(row.humanPaused, true);
      assert.strictEqual(row.assignedUserId, 'u-7');
      assert.strictEqual(row.lastCustomerAt, '2026-11-12T10:00:00.000Z');
      await store.backgroundFullSync();
      assert.strictEqual(sqliteRow(control.db, '21698000007').manualTakeover, true);
      control.db.close();
    });

    await test('G29 : magasin JSON vide (0 octet) → repris depuis le .bak (avant : {} puis réécrit)', () => {
      const dir = freshDir();
      const filePath = path.join(dir, 'ai-history.json');
      fs.writeFileSync(filePath, '');
      fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ client: { messages: [1, 2] } }));
      const store = createJsonObjectStore({ filePath, write: writeJsonAtomic, logger: quiet });
      assert.deepStrictEqual(store.get('client'), { messages: [1, 2] });
      store.update('autre', () => ({ ok: true }));
      store.flush();
      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.deepStrictEqual(Object.keys(disk).sort(), ['autre', 'client']);
    });

    await test('G29 : fichier illisible + .bak valide → fichier abîmé mis de côté, le .bak n’est jamais remplacé par la version illisible', () => {
      const dir = freshDir();
      const filePath = path.join(dir, 'kpi-daily.json');
      fs.writeFileSync(filePath, '{"2026-11-01": {"messages": 4');
      fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ '2026-11-01': { messages: 4 } }));
      // Écriture comme Admin.js : copie du fichier actuel vers .bak avant rename.
      const write = (target, data) => {
        if (fs.existsSync(target) && fs.statSync(target).size) fs.copyFileSync(target, `${target}.bak`);
        writeJsonAtomic(target, data);
      };
      const store = createJsonObjectStore({ filePath, write, logger: quiet });
      assert.deepStrictEqual(store.get('2026-11-01'), { messages: 4 });
      const quarantined = fs.readdirSync(dir).filter(name => name.startsWith('kpi-daily.json.corrupt-'));
      assert.strictEqual(quarantined.length, 1);
      store.update('2026-11-02', () => ({ messages: 1 }));
      store.flush();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8')), { '2026-11-01': { messages: 4 } });
      assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8'))['2026-11-02'].messages, 1);
    });

    await test('G29 : notifications illisibles sans .bak → mises de côté (.corrupt-*) au lieu d’être écrasées par 1 notification', () => {
      const dir = freshDir();
      const filePath = path.join(dir, 'notifications.json');
      const truncated = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, preview: 'x'.repeat(40) })) }).slice(0, 900);
      fs.writeFileSync(filePath, truncated);
      const store = createJsonObjectStore({ filePath, write: writeJsonAtomic, onUnreadable: 'quarantine', logger: quiet });
      store.replaceAll({ items: [{ id: 'nouveau' }] });
      store.flush();
      const quarantined = fs.readdirSync(dir).filter(name => name.startsWith('notifications.json.corrupt-'));
      assert.strictEqual(quarantined.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), truncated, 'contenu d’origine intact');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).items.map(item => item.id), ['nouveau']);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`ALL ${passed} DATA SAFETY STORE TESTS PASSED`);
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
