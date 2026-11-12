// V6.45 — Test d'intégration entre le paquet catalogue (synchronisation
// WooCommerce réelle d'Admin.js, API /wc/v3 simulée) et le paquet réponses IA
// (lib/product-resolver.js + lib/reply-fact-guard.js) : le résolveur et le
// garde-fou lisent les champs écrits par la synchronisation
// (duplicateOfWooId, variations, priceFrom / priceTo, composition décodée).
// DATA_DIR temporaire : aucune donnée réelle n'est touchée.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const adminPath = path.join(root, 'Admin.js');
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-catalog-ai-'));

Object.assign(process.env, {
  DATA_DIR: tmpDataDir,
  WOOCOMMERCE_URL: 'https://mondeco.tn',
  WOOCOMMERCE_CONSUMER_KEY: 'ck_test',
  WOOCOMMERCE_CONSUMER_SECRET: 'cs_test',
  WOOCOMMERCE_SYNC_ENABLED: 'false'
});

const fixtures = require('./fixtures/woo-v3-bianca-and-collisions.json')
  .map(product => ({ ...product }))
  .sort((a, b) => a.id - b.id);

const VARIATIONS = {
  69255: [
    { id: 69256, status: 'publish', sku: '', price: '690', regular_price: '690', sale_price: '', on_sale: false, stock_status: 'instock', attributes: [{ id: 5, name: 'Largeur Lit', option: '120 cm' }] },
    { id: 69257, status: 'publish', sku: '', price: '590', regular_price: '590', sale_price: '', on_sale: false, stock_status: 'instock', attributes: [{ id: 5, name: 'Largeur Lit', option: '90 cm' }] }
  ],
  61055: [
    { id: 61294, status: 'publish', sku: '', price: '2570', regular_price: '3060', sale_price: '2570', on_sale: true, stock_status: 'instock', attributes: [{ id: 2, name: 'couleur', option: 'BLEU' }] },
    { id: 61295, status: 'publish', sku: '', price: '3060', regular_price: '3060', sale_price: '', on_sale: false, stock_status: 'instock', attributes: [{ id: 2, name: 'couleur', option: 'ROSE' }] }
  ]
};

globalThis.fetch = async url => {
  const target = new URL(String(url));
  const json = (data, headers = {}) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  let match = target.pathname.match(/\/wp-json\/wc\/v3\/products\/(\d+)\/variations$/);
  if (match) return json(VARIATIONS[match[1]] || [], { 'x-wp-totalpages': '1' });
  match = target.pathname.match(/\/wp-json\/wc\/v3\/products\/(\d+)$/);
  if (match) return json(fixtures.find(item => item.id === Number(match[1])) || {});
  if (target.pathname.endsWith('/wp-json/wc/v3/products')) {
    return json(fixtures, { 'x-wp-totalpages': '1', 'x-wp-total': String(fixtures.length) });
  }
  throw new Error(`Requête inattendue : ${url}`);
};

// Fiches manuelles périmées (cause du « 2800 dt ») présentes avant la synchro.
fs.writeFileSync(path.join(tmpDataDir, 'products.json'), JSON.stringify([
  { id: 'manual-chambre-bianca', name: 'Chambre Bianca', category: 'Chambre à coucher', price: '2800', composition: 'Lit + 2 tables de nuit', availability: 'in_stock', active: true },
  { id: 'manual-lit-bianca', name: 'Lit Bianca + 2 chevets', category: 'Chambre à coucher', price: '2800', availability: 'in_stock', active: true },
  { id: 'manual-opale', name: 'Table Opale', price: '890', active: true }
]));

const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compile(content, filename) {
  if (filename === adminPath) {
    content += '\n;module.exports.__catalogAiTest = { runWooCommerceSync, loadProducts };\n';
  }
  return originalCompile.call(this, content, filename);
};
const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
console.log = () => {};
console.warn = () => {};
console.info = () => {};
console.error = () => {};
const admin = require(adminPath).__catalogAiTest;
Module.prototype._compile = originalCompile;
Object.assign(console, quiet);

const { resolveProduct } = require('../lib/product-resolver');
const { checkReplyFacts, buildCatalogAnswer, productAllowedAmounts } = require('../lib/reply-fact-guard');

let passed = 0;
async function test(label, fn) {
  const saved = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  passed++;
  console.log('PASS', label);
}

(async () => {
  let products;

  await test('synchronisation : fiches manuelles Bianca marquées doublons de la fiche du site', async () => {
    await admin.runWooCommerceSync('test');
    products = admin.loadProducts();
    const manual = products.find(item => item.id === 'manual-chambre-bianca');
    assert.strictEqual(Number(manual.duplicateOfWooId), 60068);
  });

  await test('résolveur : « Chambre Bianca » et la pub Bianca → fiche du site réf. 60068, jamais la fiche manuelle', async () => {
    for (const input of [
      { message: 'Chambre Bianca prix ?' },
      { message: 'Bonjour, le prix svp', adProductHint: 'Chambre à Coucher Bianca' }
    ]) {
      const resolution = resolveProduct(input, products);
      assert.strictEqual(resolution.status, 'resolved', JSON.stringify({ input, resolution: resolution.candidateNames }));
      assert.strictEqual(Number(resolution.product.woocommerceId), 60068, JSON.stringify(input));
    }
    // V6.45 — « Lit Bianca + 2 chevets » n'est qu'un doublon « possible »
    // (élément d'un ensemble) : il reste identifiable, comme dans le
    // contexte IA, au lieu de proposer des ensembles qui contredisent
    // « lit » et « chevets ». La fiche manuelle « Chambre Bianca »
    // (doublon certain) n'est jamais proposée.
    const lit = products.find(item => item.id === 'manual-lit-bianca');
    assert.strictEqual(lit.duplicateConfidence, 'possible');
    const vague = resolveProduct({ message: 'lit bianca avec 2 chevets combien ?' }, products);
    assert.strictEqual(vague.status, 'resolved', JSON.stringify(vague.candidateNames));
    assert.strictEqual(vague.product.id, 'manual-lit-bianca');
    for (const message of ['lit bianca avec 2 chevets combien ?', 'prix bianca', 'chambre bianca']) {
      const resolution = resolveProduct({ message }, products);
      const proposed = resolution.status === 'resolved' ? [resolution.product] : resolution.candidates;
      assert.ok(proposed.every(item => item.id !== 'manual-chambre-bianca'), JSON.stringify({ message, names: proposed.map(item => item.name) }));
    }
  });

  await test('garde-fou : 2800 dt refusé, 6590 / 7200 dt et composition du site acceptés', async () => {
    const product = products.find(item => Number(item.woocommerceId) === 60068);
    const answer = buildCatalogAnswer(product);
    assert.ok(/6590/.test(answer) && /7200/.test(answer), answer);
    assert.ok(/coiffeuse/.test(answer), answer);
    assert.strictEqual(checkReplyFacts('La Chambre Bianca est à 2800 dt.', { status: 'resolved', product }).ok, false);
    assert.strictEqual(checkReplyFacts(answer, { status: 'resolved', product }).ok, true);
  });

  await test('garde-fou : prix des variations (format catalogue regularPrice / salePrice) autorisés', async () => {
    const nuage = products.find(item => Number(item.woocommerceId) === 69255);
    const salma = products.find(item => Number(item.woocommerceId) === 61055);
    assert.ok(productAllowedAmounts(nuage).includes(590) && productAllowedAmounts(nuage).includes(690));
    assert.ok(productAllowedAmounts(salma).includes(2570) && productAllowedAmounts(salma).includes(3060));
    assert.strictEqual(checkReplyFacts('Le lit Nuage est à 590 dt en 90 cm et 690 dt en 120 cm.', { status: 'resolved', product: nuage }).ok, true);
    assert.strictEqual(checkReplyFacts('Le lit Nuage est à 650 dt.', { status: 'resolved', product: nuage }).ok, false);
    const salmaAnswer = buildCatalogAnswer(salma);
    assert.ok(/2570/.test(salmaAnswer) && /3060/.test(salmaAnswer), salmaAnswer);
  });

  console.log(`${passed} test(s) intégration catalogue → réponses IA OK`);
})()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 20);
  });
