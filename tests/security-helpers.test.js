// Tests des garde-fous ajoutés en V6.36. Admin.html n'est pas un module : ses
// fonctions sont extraites du fichier puis évaluées isolément. Les helpers
// serveur sont importés depuis lib/.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

function extractFunction(source, name) {
  const start = source.search(new RegExp(`function ${name}\\s*\\(`));
  if (start < 0) throw new Error(`Fonction introuvable : ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Fonction non terminée : ${name}`);
}

function loadFunctions(file, names, prelude = '') {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(prelude + names.map(name => extractFunction(source, name)).join('\n'), context);
  return context;
}

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

(async () => {
  const html = loadFunctions('Admin.html', ['escapeHtml', 'jsArg', 'safeHttpUrl']);

  await test('jsArg neutralise une apostrophe dans un onclick', () => {
    const payload = "x');alert(document.cookie);//";
    const attribute = `openMediaLightbox(${html.jsArg(payload)})`;
    // Le navigateur décode les entités avant d'exécuter l'attribut.
    const decoded = attribute.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    let received = null;
    vm.runInNewContext(decoded, { openMediaLightbox: value => { received = value; } });
    assert.strictEqual(received, payload);
  });

  await test('jsArg ne laisse aucun guillemet brut dans l’attribut', () => {
    assert.ok(!/["']/.test(html.jsArg(`a"b'c`)));
  });

  await test('safeHttpUrl bloque javascript: et accepte https', () => {
    assert.strictEqual(html.safeHttpUrl('javascript:alert(1)'), '');
    assert.strictEqual(html.safeHttpUrl(' JaVaScRiPt:alert(1)'), '');
    assert.strictEqual(html.safeHttpUrl('https://facebook.com/p/1'), 'https://facebook.com/p/1');
  });

  const privacy = require('../lib/log-privacy').createLogPrivacy({ logMessageContent: false });
  const { createConversationQueue } = require('../lib/conversation-queue');
  const queue = createConversationQueue();
  const server = {
    maskPhoneForLog: privacy.maskPhoneForLog,
    messageContentForLog: privacy.messageContentForLog,
    runInConversationQueue: queue.run
  };

  await test('maskPhoneForLog ne garde que les 4 derniers chiffres', () => {
    assert.strictEqual(server.maskPhoneForLog('+216 50 123 456'), '***3456');
  });

  await test('messageContentForLog masque le contenu', () => {
    assert.strictEqual(server.messageContentForLog('Bonjour'), '[7 caractère(s) masqué(s)]');
  });

  await test('runInConversationQueue sérialise une même conversation', async () => {
    const order = [];
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await Promise.all([
      server.runInConversationQueue('whatsapp:1', async () => { order.push('a-start'); await wait(30); order.push('a-end'); }),
      server.runInConversationQueue('whatsapp:1', async () => { order.push('b-start'); order.push('b-end'); }),
      server.runInConversationQueue('whatsapp:2', async () => { order.push('c'); })
    ]);
    assert.deepStrictEqual(order.filter(step => step !== 'c'), ['a-start', 'a-end', 'b-start', 'b-end']);
    assert.ok(order.indexOf('c') < order.indexOf('a-end'), 'une autre conversation reste parallèle');
  });

  await test('runInConversationQueue continue après une erreur', async () => {
    await assert.rejects(server.runInConversationQueue('k', async () => { throw new Error('boom'); }));
    assert.strictEqual(await server.runInConversationQueue('k', async () => 'ok'), 'ok');
  });

  console.log(`ALL ${passed} SECURITY HELPER TESTS PASSED`);
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
