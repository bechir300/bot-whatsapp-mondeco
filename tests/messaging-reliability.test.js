// V6.45 — Fiabilité des messages : transport Meta (la promesse se termine
// toujours, aucun renvoi après une coupure), file par client (garde-fou
// contre un traitement bloqué, abandon jamais silencieux) et journal des
// messages entrants (reprise après redémarrage).
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createMetaSendTransport, isPreflightNetworkFailure } = require('../lib/meta-send-transport');
const { createConversationQueue } = require('../lib/conversation-queue');
const { createInboundJournal } = require('../lib/inbound-journal');

const quiet = { log() {}, warn() {}, error() {} };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

function startServer(handler) {
  return new Promise(resolve => {
    const posts = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        posts.push(body);
        handler(req, res, posts.length);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, posts, url: `http://127.0.0.1:${server.address().port}/v26.0/999/messages` }));
  });
}

function transport(options = {}) {
  return createMetaSendTransport({
    https: http,
    agent: false,
    timeoutMs: 400,
    retryDelayMs: 5,
    logger: quiet,
    ...options
  });
}

async function settlesWithin(promise, ms) {
  let timer;
  const outcome = await Promise.race([
    promise.then(value => ({ value }), error => ({ error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ hung: true }), ms); })
  ]);
  clearTimeout(timer);
  return outcome;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-messaging-'));
  try {
    await test('transport : réponse normale', async () => {
      const { server, url } = await startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }));
      });
      try {
        const response = await transport().requestWithPreflightRetry(url, { method: 'POST', body: '{}' });
        assert.strictEqual(response.ok, true);
        assert.strictEqual((await response.json()).messages[0].id, 'wamid.OK');
      } finally {
        server.close();
      }
    });

    await test('régression F12a : coupure après les en-têtes → la promesse se termine (avant : jamais)', async () => {
      const { server, url } = await startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"messages":[');
        setTimeout(() => req.socket.destroy(), 30);
      });
      try {
        const outcome = await settlesWithin(transport({ timeoutMs: 5000 }).request(url, { method: 'POST', body: '{}' }), 2000);
        assert.ok(!outcome.hung, 'la promesse doit se terminer');
        assert.ok(outcome.error, 'doit être rejetée');
        assert.strictEqual(outcome.error.code, 'SEND_NETWORK_UNCERTAIN');
        assert.strictEqual(outcome.error.requestMayHaveReachedMeta, true);
      } finally {
        server.close();
      }
    });

    await test('transport : réponse bloquée → rejet au délai maximal', async () => {
      const sockets = [];
      const { server, url } = await startServer((req, res) => {
        sockets.push(req.socket);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"messages":[');
      });
      try {
        const outcome = await settlesWithin(transport({ timeoutMs: 300 }).request(url, { method: 'POST', body: '{}' }), 2000);
        assert.ok(!outcome.hung);
        assert.strictEqual(outcome.error.code, 'SEND_TIMEOUT_UNCERTAIN');
      } finally {
        sockets.forEach(socket => socket.destroy());
        server.close();
      }
    });

    await test('régression F12b : « socket hang up » après réception de la requête → un seul POST (avant : 3)', async () => {
      const { server, posts, url } = await startServer(req => req.socket.destroy());
      try {
        const outcome = await settlesWithin(transport().requestWithPreflightRetry(url, { method: 'POST', body: '{"to":"216"}' }), 3000);
        assert.ok(outcome.error);
        assert.strictEqual(outcome.error.code, 'SEND_NETWORK_UNCERTAIN');
        assert.strictEqual(isPreflightNetworkFailure(outcome.error), false);
        await wait(50);
        assert.strictEqual(posts.length, 1);
      } finally {
        server.close();
      }
    });

    await test('transport : connexion refusée → nouvelle tentative (rien n’est parti)', async () => {
      const { server, url } = await startServer(() => {});
      await new Promise(resolve => server.close(resolve));
      let attempts = 0;
      const counting = {
        request(...args) {
          attempts++;
          return http.request(...args);
        }
      };
      const outcome = await settlesWithin(transport({ https: counting }).requestWithPreflightRetry(url, { method: 'POST', body: '{}' }), 3000);
      assert.ok(outcome.error);
      assert.strictEqual(outcome.error.code, 'SEND_NETWORK_NOT_SENT');
      assert.strictEqual(isPreflightNetworkFailure(outcome.error), true);
      assert.strictEqual(attempts, 3);
    });

    await test('file : un traitement bloqué ne bloque plus le client indéfiniment', async () => {
      const queue = createConversationQueue({ stuckJobTimeoutMs: 60, logger: quiet });
      queue.run('whatsapp:216', () => new Promise(() => {}));
      const outcome = await settlesWithin(queue.run('whatsapp:216', async () => 'suivant traité'), 1000);
      assert.strictEqual(outcome.value, 'suivant traité');
    });

    await test('file : maxWaitMs par tâche (envoi commercial)', async () => {
      const queue = createConversationQueue({ stuckJobTimeoutMs: 0, logger: quiet });
      const order = [];
      queue.run('whatsapp:217', async () => { await wait(300); order.push('ia'); });
      const startedAt = Date.now();
      await queue.run('whatsapp:217', async () => { order.push('commercial'); }, { maxWaitMs: 50 });
      assert.ok(Date.now() - startedAt < 250);
      assert.deepStrictEqual(order, ['commercial']);
      // Sans dépassement, l'ordre est respecté.
      const ordered = [];
      queue.run('whatsapp:218', async () => { await wait(30); ordered.push(1); });
      await queue.run('whatsapp:218', async () => { ordered.push(2); }, { maxWaitMs: 1000 });
      assert.deepStrictEqual(ordered, [1, 2]);
    });

    await test('file : la tâche qui n’a pas attendu ne remplace pas la précédente (message suivant toujours après)', async () => {
      const queue = createConversationQueue({ stuckJobTimeoutMs: 2000, logger: quiet });
      const order = [];
      const a = queue.run('whatsapp:220', async () => { await wait(300); order.push('A'); });
      // Envoi commercial plafonné à 50 ms, en échec (erreur Meta).
      const commercial = queue.run('whatsapp:220', async () => { order.push('commercial'); throw new Error('Meta 500'); }, { maxWaitMs: 50 });
      await commercial.catch(() => {});
      const b = queue.run('whatsapp:220', async () => { order.push('B'); });
      await Promise.all([a, b]);
      assert.deepStrictEqual(order, ['commercial', 'A', 'B']);
      // Une tâche bloquée ne retient la suite qu'au plus stuckJobTimeoutMs.
      const bounded = createConversationQueue({ stuckJobTimeoutMs: 80, logger: quiet });
      bounded.run('whatsapp:221', () => new Promise(() => {}));
      bounded.run('whatsapp:221', async () => 'rapide', { maxWaitMs: 10 });
      const outcome = await settlesWithin(bounded.run('whatsapp:221', async () => 'suivant'), 1000);
      assert.strictEqual(outcome.value, 'suivant');
      // Rafale pendant une IA lente : le garde-fou compte à partir du début
      // du traitement précédent, pas de l'arrivée du message.
      const burst = createConversationQueue({ stuckJobTimeoutMs: 150, logger: quiet });
      const running = new Set();
      let overlap = false;
      const slow = label => async () => {
        if (running.size) overlap = true;
        running.add(label);
        await wait(100);
        running.delete(label);
      };
      await Promise.all([1, 2, 3, 4].map(n => burst.run('whatsapp:222', slow(n))));
      assert.strictEqual(overlap, false, 'deux messages du même client traités en parallèle');
    });

    await test('file : abandon d’un message → onGiveUp appelé une fois (jamais silencieux)', async () => {
      const logged = new Set();
      const queue = createConversationQueue({
        isMessageLogged: id => logged.has(id),
        retryDelaysMs: [5],
        logger: quiet
      });
      const givenUp = [];
      await queue.runWithRetry({
        queueKey: 'whatsapp:219',
        messageIds: ['wamid.X'],
        task: async () => { throw new Error('panne IA'); },
        onGiveUp: error => givenUp.push(error.message)
      }).catch(() => {});
      await wait(60);
      assert.deepStrictEqual(givenUp, ['panne IA']);
    });

    await test('journal des messages entrants : en attente jusqu’à « terminé », compactage', async () => {
      const filePath = path.join(root, 'inbound-journal.jsonl');
      const journal = createInboundJournal({ filePath, compactEvery: 1000, logger: quiet });
      journal.record('wamid.1', { message: { id: 'wamid.1', text: { body: 'Bonjour' } } });
      journal.record('wamid.2', { message: { id: 'wamid.2' } });
      journal.done('wamid.1');
      // « Redémarrage » : nouvelle instance sur le même fichier.
      const restarted = createInboundJournal({ filePath, logger: quiet });
      const pending = restarted.pending();
      assert.deepStrictEqual(pending.map(item => item.id), ['wamid.2']);
      assert.strictEqual(restarted.compact(), 1);
      assert.strictEqual(fs.readFileSync(filePath, 'utf8').trim().split('\n').length, 1);
      restarted.done('wamid.2');
      assert.deepStrictEqual(restarted.pending(), []);
    });

    console.log(`ALL ${passed} MESSAGING RELIABILITY TESTS PASSED`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
