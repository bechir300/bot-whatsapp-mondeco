// V6.46 — Sûreté des données côté Admin.js (paquet w2-data) : restauration
// d'un snapshot, Storage Rescue sur espace libre ABSOLU, fichiers vides ou
// illisibles, notifications plafonnées, suppression définitive d'un
// message (journaux réécrits atomiquement, état reconstruit sans copie
// ancienne). Admin.js réel chargé avec un DATA_DIR temporaire ; l'espace
// disque est simulé (fs.statfsSync) et les erreurs disque injectées.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-w2data-admin-'));
const DATA_DIR = path.join(tmpRoot, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_EMAIL = 'test-admin@mondeco.test';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-123';
process.env.MONDECO_STORAGE_BALLAST_MB = '1';
process.env.MONDECO_PURGE_REWRITE_RETRY_MS = '50';
delete process.env.MONDECO_STORAGE_MODE;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
delete process.env.RAILWAY_ENVIRONMENT_NAME;

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
// Disque simulé : 100 Go, 15 Go libres (15 % : « bas » pour l'ancien ratio).
const disk = { total: 100 * GB, free: 15 * GB };
fs.statfsSync = () => ({ bsize: 4096, frsize: 4096, blocks: Math.floor(disk.total / 4096), bavail: Math.floor(disk.free / 4096), bfree: Math.floor(disk.free / 4096) });

const DAY = 24 * 60 * 60 * 1000;
const write = (rel, content) => {
  const full = path.join(DATA_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  return full;
};
const age = (full, days) => {
  const when = new Date(Date.now() - days * DAY);
  fs.utimesSync(full, when, when);
};
const exists = rel => fs.existsSync(path.join(DATA_DIR, rel));

// ---------- Données de départ ----------
const instructions = n => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, title: `Instruction ${i}`, content: 'x', active: true }));
write('instructions.json', instructions(7));
write('.v630-instructions-migrated', 'ok');
write('products.json', [{ id: 'p1', name: 'Lit Bianca' }, { id: 'p2', name: 'Pouf' }]);
write('products.json.bak', [{ id: 'p1', name: 'Lit Bianca' }, { id: 'p2', name: 'Pouf' }]);
write('conversation-log.json.bak', []);
write('backups/json/products/products-20261101-120000-000.json', '[]');
write('backups/json/products/products-20261102-120000-000.json', '[]');
age(write('backups/json/settings/settings-20261001-120000-000.json', '{}'), 40);
age(write('backups/json/settings/settings-20261002-120000-000.json', '{}'), 39);
const STATE_CONTACT = '21698444001';
write('conversation-state.json', {
  [STATE_CONTACT]: { channel: 'whatsapp', profileName: 'Client', profilePicture: '/admin/conversation-profile/avatar-utilise.jpg', assignedTo: 'Ancien', favorite: true },
  21698444002: { channel: 'whatsapp', profileName: 'Autre' }
});
age(write('conversation-profile/avatar-utilise.jpg', 'jpg'), 30);
age(write('conversation-profile/avatar-orphelin.jpg', 'jpg'), 30);
age(write('conversation-media/2026-10/customer-photo-sofa.jpg', 'photo'), 10);
age(write('conversation-media/2026-10/client-non-favori.jpg', 'photo'), 10);
age(write('backups/recycle/files/20261001-old.jpg', 'x'), 20);
// Snapshot d'aujourd'hui (pas de snapshot quotidien supplémentaire au démarrage).
const SNAP = 'snapshot-20261112-080000-000';
write(`backups/snapshots/${SNAP}/instructions.json`, instructions(7));
write(`backups/snapshots/${SNAP}/conversation-state.json`, {
  [STATE_CONTACT]: { channel: 'whatsapp', profileName: 'Client', profilePicture: '/admin/conversation-profile/avatar-utilise.jpg', assignedTo: 'Ancien', favorite: true }
});
write(`backups/snapshots/${SNAP}/snapshot-meta.json`, { id: SNAP, createdAt: new Date().toISOString(), reason: 'manual', instructionCount: 7 });
const day = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
write(`conversation-events/conversation-events-${day}.jsonl`, `${JSON.stringify({ contact: STATE_CONTACT, time: new Date(Date.now() - 10 * DAY).toISOString(), incoming: 'photo', attachments: [{ type: 'image', url: '/admin/conversation-media/2026-10/customer-photo-sofa.jpg' }] })}\n`);

// ---------- Chargement d'Admin.js avec accès aux fonctions internes ----------
const adminPath = path.join(root, 'Admin.js');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compileWithTestExports(content, filename) {
  if (filename === adminPath) {
    content += `
;globalThis.__adm = { createFullSnapshot, restoreFullSnapshot, listFullSnapshots, runSafeStorageMaintenance,
  emergencyFreeDisposableStorage, storageLevel, readJsonArray, loadProducts, loadInstructions, ensureDailySnapshot,
  loadNotificationsStore, saveNotificationsStore, flushNotificationsStore, notificationsStore,
  purgeConversationMessagePart, rebuildConversationStateAfterPurge, purgeMessageIdsFromIndex,
  getConversationStateSingle, updateConversationStateAdmin, readConversationStatesAdminCached,
  flushConversationStatesWrite, conversationEntryPartPurgeHash, writeJsonAtomic, runStorageGuardTick,
  ensureStorageBallast, STORAGE_BALLAST_PATH, MAX_NOTIFICATION_ITEMS, MESSAGE_ID_INDEX_PATH, SNAPSHOTS_DIR,
  loadPurgedRecordHashes, PURGED_RECORD_HASHES_PATH, pruneFullSnapshotsForStorageRescue, loadUsers, getBotSettings,
  USERS_PATH, SETTINGS_PATH, purgeConversationMessagePart };`;
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
try {
  require(adminPath);
} finally {
  Module.prototype._compile = originalCompile;
}
const A = globalThis.__adm;
const say = line => saved.log(line);

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  say(`PASS ${label}`);
}

(async () => {
  await test('G25/G34 : démarrage avec 15 Go libres (15 %) → aucun snapshot, .bak, version JSON, photo de profil ni média supprimé ; snapshot quotidien non ignoré', () => {
    assert.ok(exists(`backups/snapshots/${SNAP}`), 'snapshot conservé');
    assert.ok(exists('products.json.bak'));
    assert.ok(exists('conversation-log.json.bak'));
    assert.ok(exists('backups/json/products/products-20261102-120000-000.json'));
    assert.ok(exists('conversation-profile/avatar-utilise.jpg'));
    assert.ok(exists('conversation-profile/avatar-orphelin.jpg'));
    assert.ok(exists('conversation-media/2026-10/customer-photo-sofa.jpg'));
    assert.ok(exists('conversation-media/2026-10/client-non-favori.jpg'));
    assert.ok(exists('backups/recycle/files/20261001-old.jpg'));
    assert.ok(!logs.some(line => /Stockage critique|délai de grâce 15 jours annulé|Snapshot quotidien ignoré|supprimé/.test(line)), logs.filter(line => /supprim|ignoré|critique/.test(line)).join('\n'));
    assert.strictEqual(A.storageLevel(), 'ok');
    // Snapshot quotidien : pris tant que l'espace absolu le permet (le
    // snapshot du jour existe déjà : aucun nouveau, aucun supprimé).
    A.ensureDailySnapshot();
    assert.ok(!logs.some(line => /Snapshot quotidien ignoré/.test(line)));
  });

  await test('G23 : restaurer le seul snapshot le restaure vraiment, le garde et crée une copie de protection', () => {
    A.updateConversationStateAdmin(STATE_CONTACT, current => ({ ...current, assignedTo: 'Nouveau' }));
    A.writeJsonAtomic(path.join(DATA_DIR, 'instructions.json'), instructions(5));
    assert.strictEqual(A.loadInstructions().length, 5);
    const restored = A.restoreFullSnapshot(SNAP);
    assert.strictEqual(A.loadInstructions().length, 7, 'instructions restaurées');
    assert.ok(restored.restoredFiles.includes('instructions.json'));
    assert.ok(restored.safetySnapshotId.startsWith('snapshot-'));
    const ids = A.listFullSnapshots().map(item => item.id);
    assert.ok(ids.includes(SNAP), 'snapshot restauré jamais supprimé');
    assert.ok(ids.includes(restored.safetySnapshotId), 'copie de protection présente');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(A.SNAPSHOTS_DIR, restored.safetySnapshotId, 'instructions.json'), 'utf8')).length,
      5,
      'la copie de protection contient l’état d’avant'
    );
    // État des conversations rechargé en mémoire (et donc pour le bot).
    assert.strictEqual(A.getConversationStateSingle(STATE_CONTACT).assignedTo, 'Ancien');
  });

  await test('V6.46 — sauvegarde restaurée gardée par la rotation (redémarrage en mode compact) tant qu’aucun snapshot plus récent de l’état restauré n’existe', () => {
    const restoredMeta = A.listFullSnapshots().find(item => item.id === SNAP);
    assert.ok(restoredMeta.restoredAt, 'date de restauration enregistrée dans snapshot-meta.json');
    // Rotation « 1 snapshot » (mode compact, démarrage suivant).
    A.pruneFullSnapshotsForStorageRescue(1);
    const ids = A.listFullSnapshots().map(item => item.id);
    assert.ok(ids.includes(SNAP), 'sauvegarde restaurée conservée (avant : supprimée au redémarrage)');
    assert.strictEqual(ids.length, 2, 'copie de protection (la plus récente) gardée aussi');
  });

  await test('G23 : snapshot vide ou endommagé → erreur, rien n’est modifié', () => {
    write('backups/snapshots/snapshot-20261112-090000-000/snapshot-meta.json', { createdAt: new Date(Date.now() - 1000).toISOString() });
    assert.throws(() => A.restoreFullSnapshot('snapshot-20261112-090000-000'), /Sauvegarde vide/);
    write('backups/snapshots/snapshot-20261112-091000-000/instructions.json', '[{"id":');
    const before = A.listFullSnapshots().length;
    assert.throws(() => A.restoreFullSnapshot('snapshot-20261112-091000-000'), /endommagée/);
    assert.strictEqual(A.loadInstructions().length, 7);
    assert.strictEqual(A.listFullSnapshots().length, before, 'aucune copie de protection inutile');
    fs.rmSync(path.join(A.SNAPSHOTS_DIR, 'snapshot-20261112-090000-000'), { recursive: true, force: true });
    fs.rmSync(path.join(A.SNAPSHOTS_DIR, 'snapshot-20261112-091000-000'), { recursive: true, force: true });
  });

  await test('G29 : products.json vide (0 octet) → catalogue repris depuis products.json.bak (avant : 0 produit)', () => {
    write('products.json', '');
    assert.strictEqual(A.loadProducts().length, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'products.json'), 'utf8')).length, 2, 'fichier actif réparé');
    write('products.json', '[{"id":"p1"');
    assert.strictEqual(A.loadProducts().length, 2);
    assert.ok(fs.readdirSync(DATA_DIR).some(name => name.startsWith('products.json.corrupt-')), 'version illisible conservée');
  });

  await test('G25 : espace bas (60 Mo) → seulement le jetable ; dernier snapshot, .bak des données, photos utilisées et médias gardés', () => {
    disk.free = 60 * MB;
    fs.writeFileSync(A.STORAGE_BALLAST_PATH, Buffer.alloc(1024));
    A.runSafeStorageMaintenance({ reason: 'test bas' });
    assert.ok(!fs.existsSync(A.STORAGE_BALLAST_PATH), 'réserve libérée en premier');
    assert.ok(!exists('backups/recycle/files/20261001-old.jpg'), 'corbeille vidée');
    assert.ok(!exists('conversation-log.json.bak'), '.bak de cache supprimé');
    assert.ok(exists('products.json.bak'), '.bak des produits gardé');
    assert.ok(!exists('conversation-profile/avatar-orphelin.jpg'), 'photo orpheline supprimée');
    assert.ok(exists('conversation-profile/avatar-utilise.jpg'), 'photo affichée gardée');
    assert.ok(exists('conversation-media/2026-10/customer-photo-sofa.jpg'));
    assert.ok(exists('conversation-media/2026-10/client-non-favori.jpg'), 'aucun média supprimé automatiquement');
    const snapshots = A.listFullSnapshots();
    assert.strictEqual(snapshots.length, 2, 'le snapshot le plus récent et la sauvegarde restaurée gardés');
    assert.ok(snapshots.some(item => item.id === SNAP));
    assert.ok(logs.some(line => line.startsWith('error') && /Storage Rescue \(test bas\)/.test(line)), 'suppressions signalées en console.error (alerte)');
  });

  await test('G25 : espace CRITIQUE (10 Mo, ENOSPC) → dernier recours sur les sauvegardes, jamais sur les médias ni les photos affichées', () => {
    disk.free = 10 * MB;
    // Sans écriture en attente et avec écriture encore possible : aucun dernier recours.
    A.emergencyFreeDisposableStorage({ reason: 'test sans écriture en attente' });
    assert.ok(A.listFullSnapshots().length >= 1, 'dernières sauvegardes gardées sans écriture refusée');
    assert.ok(exists('products.json.bak'));
    // Écriture refusée de 20 Mo (espace simulé constant) : dernier recours complet.
    A.emergencyFreeDisposableStorage({ reason: 'test ENOSPC', neededBytes: 20 * MB });
    assert.strictEqual(A.listFullSnapshots().length, 0, 'dernier snapshot supprimé seulement en critique');
    assert.ok(!exists('products.json.bak'));
    assert.ok(exists('conversation-media/2026-10/client-non-favori.jpg'), 'médias jamais supprimés automatiquement');
    assert.ok(exists('conversation-profile/avatar-utilise.jpg'));
    assert.ok(logs.some(line => line.startsWith('error') && /Stockage critique \(test ENOSPC\)/.test(line)));
    disk.free = 15 * GB;
  });

  await test('V6.46 — espace revenu : snapshot du jour recréé par la surveillance (avant : seulement au redémarrage)', () => {
    assert.strictEqual(A.listFullSnapshots().length, 0);
    disk.free = 15 * GB;
    A.runStorageGuardTick();
    const snapshots = A.listFullSnapshots();
    assert.strictEqual(snapshots.length, 1);
    assert.strictEqual(snapshots[0].reason, 'automatic-daily');
  });

  await test('V6.46 — disque plein, petite écriture refusée : le dernier recours s’arrête dès que la place suffit (dernier snapshot et .bak des données gardés)', () => {
    write('products.json.bak', [{ id: 'p1', name: 'Lit Bianca' }]);
    age(write('backups/json/products/products-20261103-120000-000.json', '[]'), 2);
    age(write('backups/json/settings/settings-20261003-120000-000.json', '{}'), 1);
    const jsonVersions = () => ['products', 'settings'].flatMap(dir => {
      const full = path.join(DATA_DIR, 'backups/json', dir);
      return fs.existsSync(full) ? fs.readdirSync(full) : [];
    });
    const versionsBefore = jsonVersions().length;
    disk.free = 0;
    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = function patchedUnlink(target, ...rest) {
      const result = originalUnlinkSync.call(this, target, ...rest);
      // Chaque version JSON supprimée libère un bloc de 64 Ko.
      if (String(target).includes(`${path.sep}backups${path.sep}json${path.sep}`)) disk.free += 64 * 1024;
      return result;
    };
    try {
      A.emergencyFreeDisposableStorage({ reason: 'test petite écriture', neededBytes: 1024 });
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
    assert.strictEqual(jsonVersions().length, versionsBefore - 1, 'une seule version JSON supprimée');
    assert.ok(exists('products.json.bak'), '.bak des produits gardé');
    assert.strictEqual(A.listFullSnapshots().length, 1, 'dernier snapshot gardé');
    disk.free = 15 * GB;
  });

  await test('V6.46 — écriture impossible SANS manque d’espace (EACCES, 50 Go libres) : niveau « unwritable », aucune sauvegarde supprimée', () => {
    disk.free = 50 * GB;
    write('settings.json.bak', { aiEnabled: true });
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function patchedWriteFile(target, ...rest) {
      if (String(target).includes('.write-test-')) {
        const error = new Error(`EACCES: permission denied, open '${target}'`);
        error.code = 'EACCES';
        throw error;
      }
      return originalWriteFileSync.call(this, target, ...rest);
    };
    let freed;
    try {
      assert.strictEqual(A.storageLevel(), 'unwritable');
      freed = A.emergencyFreeDisposableStorage({ reason: 'test EACCES' });
      A.runSafeStorageMaintenance({ reason: 'test EACCES' });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.strictEqual(freed, 0);
    assert.strictEqual(A.listFullSnapshots().length, 1, 'dernier snapshot gardé');
    assert.ok(exists('products.json.bak'), '.bak des données gardé');
    assert.ok(exists('backups/json/settings/settings-20261003-120000-000.json') || exists('backups/json/products/products-20261103-120000-000.json'), 'dernière version JSON gardée');
    assert.ok(logs.some(line => line.startsWith('error') && /test EACCES.*aucun fichier supprimé/.test(line)));
    disk.free = 15 * GB;
  });

  await test('G34 : purge des médias anciens seulement sur action explicite (bouton administrateur), favoris et pubs protégés', () => {
    A.runSafeStorageMaintenance({ forceEmergency: true, allowMediaPurge: true, reason: 'nettoyage administrateur' });
    assert.ok(!exists('conversation-media/2026-10/client-non-favori.jpg'), 'média ancien non protégé supprimé');
    assert.ok(exists('conversation-media/2026-10/customer-photo-sofa.jpg'), 'média d’une conversation favorite gardé');
  });

  await test('G30 : notifications plafonnées à chaque enregistrement et écrites de façon groupée', () => {
    const now = Date.now();
    const items = Array.from({ length: A.MAX_NOTIFICATION_ITEMS + 500 }, (_, i) => ({ id: `n${i}`, contact: '216', createdAt: new Date(now - (A.MAX_NOTIFICATION_ITEMS + 500 - i) * 1000).toISOString(), readBy: [] }));
    items.push({ id: 'trop-vieille', createdAt: new Date(now - 40 * DAY).toISOString() });
    const notificationsPath = path.join(DATA_DIR, 'notifications.json');
    const before = fs.existsSync(notificationsPath) ? fs.readFileSync(notificationsPath, 'utf8') : null;
    A.saveNotificationsStore({ items });
    const current = fs.existsSync(notificationsPath) ? fs.readFileSync(notificationsPath, 'utf8') : null;
    assert.strictEqual(current, before, 'aucune écriture synchrone');
    const memory = A.loadNotificationsStore().items;
    assert.strictEqual(memory.length, A.MAX_NOTIFICATION_ITEMS);
    assert.strictEqual(memory[memory.length - 1].id, `n${A.MAX_NOTIFICATION_ITEMS + 499}`, 'les plus récentes gardées, ordre conservé');
    assert.ok(!memory.some(item => item.id === 'trop-vieille'));
    A.flushNotificationsStore();
    assert.strictEqual(JSON.parse(fs.readFileSync(notificationsPath, 'utf8')).items.length, A.MAX_NOTIFICATION_ITEMS);
  });

  await test('G33/G24 : suppression définitive → journal réécrit atomiquement (ajout concurrent gardé), état reconstruit sans annuler une prise en main', async () => {
    const contact = '21698555001';
    const today = new Date().toISOString().slice(0, 10);
    const t1 = new Date(Date.now() - 60 * 1000).toISOString();
    const target = { contact, channel: 'whatsapp', message_id: 'wamid.SECRET', time: t1, incoming: 'mon adresse secrète', direction: 'incoming' };
    const other = { contact, channel: 'whatsapp', message_id: 'wamid.KEEP', time: t1, incoming: 'bonjour', direction: 'incoming' };
    const eventsPath = path.join(DATA_DIR, 'conversation-events', `conversation-events-${today}.jsonl`);
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, `${JSON.stringify(other)}\n${JSON.stringify(target)}\n`);
    A.updateConversationStateAdmin(contact, current => ({ ...current, channel: 'whatsapp', unreadCount: 3, manualTakeover: false }));

    // server.js ajoute un événement pendant la réécriture (entre lecture et rename).
    const concurrent = { contact: '21698555999', channel: 'whatsapp', message_id: 'wamid.CONCURRENT', time: new Date().toISOString(), incoming: 'nouveau client' };
    const originalWriteFile = fs.promises.writeFile;
    fs.promises.writeFile = async function patched(file, ...rest) {
      if (String(file).endsWith('.purge.tmp')) {
        fs.appendFileSync(eventsPath, `${JSON.stringify(concurrent)}\n`);
        // Prise en main par un commercial pendant la suppression.
        A.updateConversationStateAdmin(contact, current => ({ ...current, manualTakeover: true, assignedTo: 'Sami' }));
      }
      return originalWriteFile.call(this, file, ...rest);
    };
    let result;
    try {
      result = await A.purgeConversationMessagePart(target, 'incoming');
    } finally {
      fs.promises.writeFile = originalWriteFile;
    }
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(result.removed >= 1);
    assert.ok(!lines.some(line => line.incoming === 'mon adresse secrète'), 'texte effacé');
    assert.ok(lines.some(line => line.message_id === 'wamid.KEEP'), 'autres messages intacts');
    assert.ok(lines.some(line => line.message_id === 'wamid.CONCURRENT'), 'ajout concurrent conservé');
    assert.ok(!fs.readdirSync(path.dirname(eventsPath)).some(name => name.endsWith('.tmp')), 'aucun fichier temporaire');
    const state = A.getConversationStateSingle(contact);
    assert.strictEqual(state.manualTakeover, true, 'prise en main faite pendant la suppression conservée');
    assert.strictEqual(state.assignedTo, 'Sami');
    assert.ok(state.unreadCount <= 1, 'compteurs reconstruits');
  });

  await test('G33 : index message_id réécrit par fichier temporaire — disque plein pendant la réécriture → index d’origine intact', () => {
    fs.writeFileSync(A.MESSAGE_ID_INDEX_PATH, 'wamid.A\nwamid.B\nwamid.C\n');
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function patched(target, ...rest) {
      if (typeof target === 'number' || String(target).endsWith('.tmp')) {
        const error = new Error('ENOSPC: no space left on device, write');
        error.code = 'ENOSPC';
        throw error;
      }
      return originalWriteFileSync.call(this, target, ...rest);
    };
    try {
      assert.throws(() => A.purgeMessageIdsFromIndex({ message_id: 'wamid.B' }), /ENOSPC/);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.strictEqual(fs.readFileSync(A.MESSAGE_ID_INDEX_PATH, 'utf8'), 'wamid.A\nwamid.B\nwamid.C\n');
    A.purgeMessageIdsFromIndex({ message_id: 'wamid.B' });
    assert.strictEqual(fs.readFileSync(A.MESSAGE_ID_INDEX_PATH, 'utf8'), 'wamid.A\nwamid.C\n');
  });

  await test('G29 : empreintes de suppression illisibles → récupérées (les messages supprimés ne reviennent pas)', () => {
    const h1 = 'a'.repeat(64);
    const h2 = 'b'.repeat(64);
    fs.writeFileSync(A.PURGED_RECORD_HASHES_PATH, `{"version":1,"hashes":["${h1}","${h2}","cccc`);
    const set = A.loadPurgedRecordHashes();
    assert.ok(set.has(h1) && set.has(h2));
    assert.ok(fs.readdirSync(DATA_DIR).some(name => name.startsWith('.purged-record-hashes.json.corrupt-')));
  });

  await test('V6.46 — users.json, settings.json et empreintes de suppression vides (0 octet) → repris du .bak', () => {
    const users = [
      { id: 'u-admin', email: 'test-admin@mondeco.test', role: 'admin', active: true },
      { id: 'c1', email: 'c1@mondeco.test', role: 'commercial', active: true },
      { id: 'c2', email: 'c2@mondeco.test', role: 'commercial', active: true }
    ];
    const usersBefore = fs.readFileSync(A.USERS_PATH, 'utf8');
    fs.writeFileSync(`${A.USERS_PATH}.bak`, JSON.stringify(users));
    fs.writeFileSync(A.USERS_PATH, '');
    assert.deepStrictEqual(A.loadUsers().map(user => user.id), ['u-admin', 'c1', 'c2'], 'comptes des commerciaux gardés');
    assert.strictEqual(JSON.parse(fs.readFileSync(A.USERS_PATH, 'utf8')).length, 3, 'fichier actif réparé depuis le .bak');
    fs.writeFileSync(A.USERS_PATH, usersBefore);

    fs.writeFileSync(`${A.SETTINGS_PATH}.bak`, JSON.stringify({ aiEnabled: false }));
    fs.writeFileSync(A.SETTINGS_PATH, '');
    assert.strictEqual(A.getBotSettings().aiEnabled, false, 'IA toujours désactivée (avant : réglages par défaut, IA réactivée)');
    assert.strictEqual(JSON.parse(fs.readFileSync(A.SETTINGS_PATH, 'utf8')).aiEnabled, false);

    const hash = 'd'.repeat(64);
    fs.writeFileSync(`${A.PURGED_RECORD_HASHES_PATH}.bak`, JSON.stringify({ version: 1, hashes: [hash] }));
    fs.writeFileSync(A.PURGED_RECORD_HASHES_PATH, '');
    assert.ok(A.loadPurgedRecordHashes().has(hash), 'empreinte reprise du .bak');
  });

  await test('V6.46 — suppression définitive : journal raccourci pendant la réécriture → nouvel essai automatique, texte effacé', async () => {
    const contact = '21698555777';
    const today = new Date().toISOString().slice(0, 10);
    const t1 = new Date(Date.now() - 30 * 1000).toISOString();
    const target = { contact, channel: 'whatsapp', message_id: 'wamid.SECRET2', time: t1, incoming: 'mon code secret 4242', direction: 'incoming' };
    const other = { contact, channel: 'whatsapp', message_id: 'wamid.KEEP2', time: t1, incoming: 'bonjour', direction: 'incoming' };
    const eventsPath = path.join(DATA_DIR, 'conversation-events', `conversation-events-${today}.jsonl`);
    fs.writeFileSync(eventsPath, `${JSON.stringify(other)}\n${JSON.stringify(target)}\n`);
    const originalWriteFile = fs.promises.writeFile;
    let shrunk = false;
    fs.promises.writeFile = async function patched(file, ...rest) {
      if (!shrunk && String(file).endsWith('.purge.tmp')) {
        shrunk = true;
        // Restauration / rotation externe : fichier remplacé par une version plus courte.
        fs.writeFileSync(eventsPath, `${JSON.stringify(target)}\n`);
      }
      return originalWriteFile.call(this, file, ...rest);
    };
    try {
      await A.purgeConversationMessagePart(target, 'incoming');
    } finally {
      fs.promises.writeFile = originalWriteFile;
    }
    assert.ok(shrunk);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(!fs.readFileSync(eventsPath, 'utf8').includes('mon code secret 4242'), 'texte effacé au nouvel essai');
  });

  await test('réserve d’espace recréée quand l’espace redevient suffisant', () => {
    disk.free = 15 * GB;
    A.runStorageGuardTick();
    assert.ok(fs.existsSync(A.STORAGE_BALLAST_PATH));
    assert.strictEqual(fs.statSync(A.STORAGE_BALLAST_PATH).size, 1024 * 1024);
  });

  say(`ALL ${passed} DATA SAFETY ADMIN TESTS PASSED`);
  Object.assign(console, saved);
  try { A.flushConversationStatesWrite(); } catch {}
  setTimeout(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }, 50);
})().catch(error => {
  Object.assign(console, saved);
  console.error('FAIL', error);
  console.error(logs.slice(-40).join('\n'));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
