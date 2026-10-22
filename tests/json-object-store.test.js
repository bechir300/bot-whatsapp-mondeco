// Tests du magasin JSON partagé à écriture différée (lib/json-object-store.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJsonObjectStore, flushAllJsonStores } = require('../lib/json-object-store');

const quiet = { log() {}, warn() {}, error() {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-store-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeStore(name, options = {}) {
  const filePath = path.join(dir, name);
  const writes = [];
  const store = createJsonObjectStore({
    filePath,
    flushDelayMs: 20,
    maxDelayMs: 60,
    logger: quiet,
    write: (target, data) => {
      writes.push(Object.keys(data).length);
      fs.writeFileSync(target, JSON.stringify(data));
    },
    ...options
  });
  return { store, filePath, writes };
}

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

(async () => {
  await test('plusieurs mises à jour = une seule écriture disque', async () => {
    const { store, filePath, writes } = makeStore('a.json');
    for (let i = 0; i < 50; i++) store.update(`c${i}`, s => ({ ...s, n: i }));
    assert.strictEqual(writes.length, 0, 'aucune écriture synchrone');
    await wait(80);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(filePath))).length, 50);
  });

  await test('lecture immédiate de la valeur en mémoire avant écriture', () => {
    const { store } = makeStore('b.json');
    store.update('x', () => ({ ok: true }));
    assert.deepStrictEqual(store.get('x'), { ok: true });
    assert.strictEqual(store.getAll().x.ok, true);
  });

  await test('getAll renvoie une copie : une mutation non sauvegardée est sans effet', () => {
    const { store } = makeStore('c.json');
    const copy = store.getAll();
    copy.ghost = { a: 1 };
    assert.strictEqual(store.get('ghost'), null);
  });

  await test('fichier corrompu : restauration depuis .bak', () => {
    const filePath = path.join(dir, 'd.json');
    fs.writeFileSync(filePath, '{ cassé');
    fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ client: { ok: 1 } }));
    const { store } = makeStore('d.json');
    assert.deepStrictEqual(store.get('client'), { ok: 1 });
  });

  await test('fichier et .bak corrompus : aucune écriture (pas d’effacement)', async () => {
    const filePath = path.join(dir, 'e.json');
    fs.writeFileSync(filePath, '{ cassé');
    const { store, writes } = makeStore('e.json');
    store.update('nouveau', () => ({ a: 1 }));
    await wait(80);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '{ cassé');
  });

  await test('modification externe rechargée quand rien n’est en attente', async () => {
    const { store, filePath } = makeStore('f.json');
    store.update('a', () => ({ v: 1 }));
    store.flush();
    await wait(5);
    fs.writeFileSync(filePath, JSON.stringify({ a: { v: 2 }, b: { v: 3 } }));
    assert.deepStrictEqual(store.get('a'), { v: 2 });
    assert.deepStrictEqual(store.get('b'), { v: 3 });
  });

  await test('reload() après restauration abandonne les modifications en attente', () => {
    const { store, filePath } = makeStore('g.json');
    store.update('a', () => ({ v: 'mémoire' }));
    fs.writeFileSync(filePath, JSON.stringify({ a: { v: 'restauré' } }));
    store.reload();
    assert.deepStrictEqual(store.get('a'), { v: 'restauré' });
  });

  await test('échec d’écriture : les données restent en attente et sont réécrites', async () => {
    let fail = true;
    const { store, filePath } = makeStore('h.json', {
      write: (target, data) => {
        if (fail) throw new Error('ENOSPC');
        fs.writeFileSync(target, JSON.stringify(data));
      }
    });
    store.update('a', () => ({ v: 1 }));
    assert.strictEqual(store.flush(), false);
    fail = false;
    await wait(100);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath)).a, { v: 1 });
  });

  await test('flushAllJsonStores écrit immédiatement tout ce qui est en attente', () => {
    const { store, filePath } = makeStore('i.json');
    store.update('a', () => ({ v: 1 }));
    flushAllJsonStores();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath)).a, { v: 1 });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`ALL ${passed} JSON STORE TESTS PASSED`);
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
