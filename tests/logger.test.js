// Tests de lib/logger.js : format JSON, corrélation, alertes groupées.
const assert = require('assert');
const { installConsoleLogger, withLogContext } = require('../lib/logger');

const lines = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
console.log = (...args) => lines.push(args.join(' '));
console.error = (...args) => lines.push(args.join(' '));
console.warn = (...args) => lines.push(args.join(' '));

const sent = [];
const logger = installConsoleLogger({
  format: 'json',
  alertWebhookUrl: 'https://alerts.example/hook',
  alertMinIntervalMs: 60000,
  fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; }
});

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  originalLog('PASS', label);
}

(async () => {
  await test('ligne JSON avec niveau et message', () => {
    console.log('Bonjour', 42);
    const line = JSON.parse(lines.at(-1));
    assert.strictEqual(line.level, 'info');
    assert.strictEqual(line.msg, 'Bonjour 42');
    assert.ok(line.time);
  });

  await test('identifiant de corrélation propagé dans l’asynchrone', async () => {
    await withLogContext({ requestId: 'abc123' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      console.warn('après attente');
    });
    const line = JSON.parse(lines.at(-1));
    assert.strictEqual(line.requestId, 'abc123');
    assert.strictEqual(line.level, 'warn');
  });

  await test('erreurs regroupées en une seule alerte', async () => {
    console.error('Erreur A');
    console.error('Erreur B');
    assert.strictEqual(sent.length, 0, 'pas d’envoi immédiat');
    await logger.flushAlerts();
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /2 erreur\(s\)/);
    assert.match(sent[0].text, /Erreur A/);
    assert.strictEqual(sent[0].content, sent[0].text);
  });

  logger.restore();
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  console.log(`ALL ${passed} LOGGER TESTS PASSED`);
})().catch(error => {
  logger.restore();
  originalError('FAIL', error);
  process.exit(1);
});
