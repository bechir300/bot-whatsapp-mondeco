// V6.46 — Webhook WooCommerce de bout en bout sur le serveur réel
// (server.js + Admin.js, DATA_DIR temporaire, Meta simulé) : une livraison
// product.updated encodée comme PHP la produit (wp_json_encode : « \/ »,
// « é ») et signée sur ces octets est acceptée et enregistrée. Avant,
// la signature était recalculée sur JSON.stringify(req.body) et toutes ces
// livraisons étaient refusées (401).
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SECRET = 'whsec_test_123';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// wp_json_encode() par défaut : « / » → « \/ », non-ASCII → \uXXXX.
function phpJson(value) {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u007f-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-woo-e2e-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const controlPath = path.join(dir, 'control.json');
  const sentPath = path.join(dir, 'sent.jsonl');
  fs.writeFileSync(controlPath, '{}');
  fs.writeFileSync(sentPath, '');
  const port = await freePort();
  const mockPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logPath = path.join(dir, 'server.log');
  const logStream = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'meta-mock-preload.js'), 'server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PORT: String(port),
      DATA_DIR: dataDir,
      WHATSAPP_TOKEN: 'test-token',
      PHONE_NUMBER_ID: '999',
      VERIFY_TOKEN: 'verify',
      GEMINI_API_KEY: 'test-key',
      META_APP_SECRET: 'e2e-app-secret',
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'Passw0rd!Test123',
      NODE_ENV: 'development',
      WOOCOMMERCE_WEBHOOK_SECRET: SECRET,
      WOOCOMMERCE_SYNC_ENABLED: 'false',
      MONDECO_TEST_CONTROL: controlPath,
      MONDECO_TEST_SENT: sentPath,
      MONDECO_TEST_MOCK_PORT: String(mockPort)
    },
    stdio: ['ignore', logStream, logStream]
  });

  const readProducts = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'products.json'), 'utf8'));
    } catch {
      return [];
    }
  };
  async function waitFor(predicate, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await predicate()) return true;
      await wait(100);
    }
    return false;
  }
  async function deliver(body, { signature, contentType = 'application/json', topic = 'product.updated', urlPath = '/admin/api/woocommerce/webhook' } = {}) {
    const response = await fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'user-agent': 'WooCommerce/9.4.0 Hookshot (WordPress/6.6.2)',
        'x-wc-webhook-topic': topic,
        'x-wc-webhook-signature': signature
      },
      body
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }
  const sign = bytes => crypto.createHmac('sha256', SECRET).update(bytes).digest('base64');

  const product = {
    id: 69317,
    name: 'Pack Mariage Liora',
    slug: 'pack-mariage-liora',
    permalink: 'https://mondeco.tn/produit/pack-mariage-liora/',
    type: 'simple',
    status: 'publish',
    price: '12490',
    regular_price: '12870',
    sale_price: '12490',
    on_sale: true,
    stock_status: 'instock',
    short_description: '<p>Chambre élégante, salon et table à manger</p>',
    categories: [{ id: 201, name: 'Pack Mariage', slug: 'pack-mariage' }],
    images: [{ src: 'https://mondeco.tn/wp-content/uploads/2026/11/promo-pack-liora.webp' }],
    date_modified_gmt: '2026-11-11T21:59:00'
  };

  try {
    const ready = await waitFor(async () => {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    }, 20000);
    assert.ok(ready, 'serveur démarré');

    await test('product.updated encodé par PHP et signé sur ses octets : accepté (200) et enregistré', async () => {
      const php = phpJson(product);
      assert.ok(php.includes('https:\\/\\/mondeco.tn') && php.includes('\\u00e9'));
      const result = await deliver(php, { signature: sign(php) });
      assert.strictEqual(result.status, 200, JSON.stringify(result.json));
      const stored = await waitFor(() => readProducts().some(item => Number(item.woocommerceId) === 69317));
      assert.ok(stored, 'fiche enregistrée');
      const liora = readProducts().find(item => Number(item.woocommerceId) === 69317);
      assert.strictEqual(liora.productUrl, 'https://mondeco.tn/produit/pack-mariage-liora/');
      assert.strictEqual(liora.promoPrice, '12490');
      assert.ok(liora.wooWebhookAt);
    });

    await test('signature calculée sur un autre encodage (JSON.stringify) : refusée (401)', async () => {
      const php = phpJson({ ...product, price: '9990' });
      const result = await deliver(JSON.stringify(JSON.parse(php)), { signature: sign(php) });
      assert.strictEqual(result.status, 401);
      const wrong = await deliver(php, { signature: sign(`${php} `) });
      assert.strictEqual(wrong.status, 401);
    });

    await test('livraison reçue en text/plain : signature vérifiée sur les octets, corps décodé', async () => {
      const php = phpJson({ ...product, regular_price: '12970', date_modified_gmt: '2026-11-12T08:00:00' });
      const result = await deliver(php, { signature: sign(php), contentType: 'text/plain' });
      assert.strictEqual(result.status, 200, JSON.stringify(result.json));
      const updated = await waitFor(() => readProducts().some(item => Number(item.woocommerceId) === 69317 && item.price === '12970'));
      assert.ok(updated, 'prix mis à jour');
    });

    await test('livraison plus ancienne que la fiche (ordre inversé) : ignorée', async () => {
      const php = phpJson({ ...product, regular_price: '10000', date_modified_gmt: '2026-11-05T08:00:00' });
      const result = await deliver(php, { signature: sign(php) });
      assert.strictEqual(result.status, 200);
      await wait(400);
      const liora = readProducts().find(item => Number(item.woocommerceId) === 69317);
      assert.strictEqual(liora.price, '12970');
    });

    await test('V6.46 — adresse saisie avec une barre oblique finale : signature vérifiée et livraison acceptée (avant : 403 CSRF)', async () => {
      const php = phpJson({ ...product, regular_price: '13070', date_modified_gmt: '2026-11-12T09:00:00' });
      const result = await deliver(php, { signature: sign(php), urlPath: '/admin/api/woocommerce/webhook/' });
      assert.strictEqual(result.status, 200, JSON.stringify(result.json));
      const updated = await waitFor(() => readProducts().some(item => Number(item.woocommerceId) === 69317 && item.price === '13070'));
      assert.ok(updated, 'prix mis à jour');
    });

    console.log(`${passed} test(s) webhook WooCommerce de bout en bout OK`);
  } catch (error) {
    console.error(error);
    try {
      console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n'));
    } catch {}
    process.exitCode = 1;
  } finally {
    child.kill('SIGKILL');
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
