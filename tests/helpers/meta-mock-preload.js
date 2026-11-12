// Préchargement de TEST uniquement (node -r) : remplace l'API Meta Graph
// (node:https et fetch) et Gemini (fetch) par des simulations locales.
// Réglages : fichier JSON MONDECO_TEST_CONTROL ; envois enregistrés dans
// MONDECO_TEST_SENT (une ligne JSON par message).
const https = require('node:https');
const http = require('node:http');
const fs = require('fs');

const CONTROL = process.env.MONDECO_TEST_CONTROL;
const SENT = process.env.MONDECO_TEST_SENT;
const MOCK_PORT = Number(process.env.MONDECO_TEST_MOCK_PORT);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function control() {
  try {
    return JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
  } catch {
    return {};
  }
}

let counter = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    const c = control();
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    if (req.method === 'POST' && /\/messages$/.test(req.url) && parsed.type) {
      if (c.graphSendDelayMs) await sleep(c.graphSendDelayMs);
      fs.appendFileSync(SENT, JSON.stringify({ t: new Date().toISOString(), to: parsed.to, type: parsed.type, text: parsed.text?.body }) + '\n');
      if (c.graphSendFail) {
        res.writeHead(c.graphSendFail, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock failure', code: 131000 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: parsed.to }], messages: [{ id: `wamid.MOCK${++counter}` }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"1","success":true}');
  });
});
mock.listen(MOCK_PORT, '127.0.0.1');
mock.unref();

const originalRequest = https.request;
https.request = function patchedRequest(options, callback) {
  if (options && typeof options === 'object' && options.hostname === 'graph.facebook.com') {
    const redirected = { ...options, protocol: 'http:', hostname: '127.0.0.1', port: MOCK_PORT };
    delete redirected.agent;
    delete redirected.family;
    return http.request(redirected, callback);
  }
  return originalRequest.apply(this, arguments);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(url, options = {}) {
  const target = new URL(String(url && url.url ? url.url : url));
  if (target.hostname === 'generativelanguage.googleapis.com') {
    const c = control();
    if (c.geminiDelayMs) await sleep(c.geminiDelayMs);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: c.geminiReply || 'Bonjour, voici la réponse IA de test.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (target.hostname === 'graph.facebook.com') {
    // Accusé de lecture (read-receipt.js) : enregistré avec l'indicateur
    // « en train d'écrire… » éventuel.
    let parsed = {};
    try { parsed = JSON.parse(String(options?.body || '')); } catch {}
    if (parsed.status === 'read' && SENT) {
      fs.appendFileSync(SENT, JSON.stringify({
        t: new Date().toISOString(),
        kind: 'read_receipt',
        message_id: parsed.message_id,
        typing: Boolean(parsed.typing_indicator)
      }) + '\n');
    }
    return new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') return originalFetch(url, options);
  throw new TypeError(`fetch failed (bloqué par le test : ${target.hostname})`);
};
