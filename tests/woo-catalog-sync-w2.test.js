// V6.46 — Synchronisation WooCommerce d'Admin.js sur le VRAI catalogue
// mondeco.tn (522 produits, tests/fixtures/woo-v3-catalog-mondeco-522.json,
// extrait de la Store API du site au format REST v3) avec une API /wc/v3
// simulée : promotions programmées ou terminées, corrections de l'équipe
// gardées, suppression = masquage, webhook plus récent que la
// synchronisation, pagination décalée, garde-fou de désactivation en masse,
// réactivation des webhooks, signature sur le corps brut, fiche produit.
// DATA_DIR temporaire : aucune donnée réelle n'est touchée.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const adminPath = path.join(root, 'Admin.js');
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-woo-w2-'));
const WEBHOOK_SECRET = 'whsec_test_w2';

Object.assign(process.env, {
  DATA_DIR: tmpDataDir,
  WOOCOMMERCE_URL: 'https://mondeco.tn',
  WOOCOMMERCE_CONSUMER_KEY: 'ck_test',
  WOOCOMMERCE_CONSUMER_SECRET: 'cs_test',
  WOOCOMMERCE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  WOOCOMMERCE_SYNC_ENABLED: 'false'
});

const BASE_MODIFIED = '2026-11-01T10:00:00';
const catalog = require('./fixtures/woo-v3-catalog-mondeco-522.json')
  .map(product => ({ status: 'publish', date_modified_gmt: BASE_MODIFIED, ...product }));
const byId = new Map(catalog.map(product => [product.id, product]));

// --- API WooCommerce simulée -------------------------------------------
let site = catalog.map(product => ({ ...product }));
const fake = {
  pageDelayMs: 0,
  omitPageHeaders: false,
  beforePage: null,
  webhooks: [],
  puts: [],
  posts: [],
  requests: []
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

globalThis.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  const method = String(options.method || 'GET').toUpperCase();
  fake.requests.push(`${method} ${target.pathname}${target.search}`);
  const json = (data, headers = {}, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const pathname = target.pathname.replace(/^\/wp-json\/wc\/v3/, '');

  if (pathname === '/webhooks' && method === 'GET') return json(fake.webhooks);
  let match = pathname.match(/^\/webhooks\/(\d+)$/);
  if (match && method === 'PUT') {
    const body = JSON.parse(options.body);
    fake.puts.push({ id: Number(match[1]), body });
    const hook = fake.webhooks.find(item => item.id === Number(match[1]));
    Object.assign(hook, { status: body.status });
    return json(hook);
  }
  if (pathname === '/webhooks' && method === 'POST') {
    const body = JSON.parse(options.body);
    fake.posts.push(body);
    return json({ id: 900 + fake.posts.length, ...body });
  }
  if (/^\/products\/\d+\/variations$/.test(pathname)) return json([], { 'x-wp-totalpages': '1' });
  match = pathname.match(/^\/products\/(\d+)$/);
  if (match) {
    const product = site.find(item => item.id === Number(match[1]));
    return product ? json(product) : json({ code: 'woocommerce_rest_product_invalid_id' }, {}, 404);
  }
  if (pathname === '/products') {
    const sorted = site.slice().sort((a, b) => a.id - b.id);
    const include = target.searchParams.get('include');
    if (include) {
      const ids = new Set(include.split(',').map(Number));
      return json(sorted.filter(item => ids.has(item.id)));
    }
    const page = Number(target.searchParams.get('page') || 1);
    const perPage = Number(target.searchParams.get('per_page') || 10);
    if (page > 1 && fake.beforePage) await fake.beforePage(page);
    if (fake.pageDelayMs) await sleep(fake.pageDelayMs);
    const current = site.slice().sort((a, b) => a.id - b.id);
    const headers = fake.omitPageHeaders ? {} : {
      'x-wp-total': String(current.length),
      'x-wp-totalpages': String(Math.ceil(current.length / perPage))
    };
    return json(current.slice((page - 1) * perPage, page * perPage), headers);
  }
  throw new Error(`Requête inattendue : ${method} ${url}`);
};

// --- Admin.js réel, fonctions internes exposées pour ce test -----------
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compile(content, filename) {
  if (filename === adminPath) {
    content += '\n;module.exports.__wooW2Test = { runWooCommerceSync, processWooCommerceWebhook, productToContext, loadProducts, saveProducts, loadWooCommerceSyncState, verifyWooWebhookSignature, installWooCommerceWebhooks, mapWooCommerceProduct };\n';
  }
  return originalCompile.call(this, content, filename);
};
const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
console.log = () => {};
console.warn = () => {};
console.info = () => {};
console.error = () => {};
const adminModule = require(adminPath);
const admin = adminModule.__wooW2Test;
const adminRouter = adminModule.adminRouter;
Module.prototype._compile = originalCompile;
Object.assign(console, quiet);

const { buildProductCard } = require('../lib/whatsapp-interactive');
const { findProductForCard } = require('../lib/product-card-auto');

let passed = 0;
async function test(label, fn) {
  const saved = { log: console.log, warn: console.warn, debug: console.debug };
  console.log = () => {};
  console.warn = () => {};
  console.debug = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  passed++;
  console.log('PASS', label);
}

const byWooId = (products, id) => products.filter(item => Number(item.woocommerceId) === id);
const one = id => {
  const list = byWooId(admin.loadProducts(), id);
  assert.strictEqual(list.length, 1, `une seule fiche pour ${id}`);
  return list[0];
};
const setSite = (id, changes) => {
  site = site.map(item => (item.id === id ? { ...item, ...changes } : item));
};
const callRoute = async (method, routePath, req) => {
  const layer = adminRouter.stack.find(item =>
    item.route && item.route.path === routePath && item.route.methods[method]);
  assert.ok(layer, `route ${method} ${routePath}`);
  const handlers = layer.route.stack;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handlers[handlers.length - 1].handle({ params: {}, body: {}, query: {}, user: { id: 'u1', name: 'Testeur', role: 'admin' }, ...req }, res, () => {});
  return res;
};
const iso = ms => new Date(ms).toISOString().slice(0, 19);

const LIORA = 69317; // Pack Mariage Liora : en promotion sur le site
const NOVA = catalog.find(item => /^Salon Nova/.test(item.name)).id;
const MERMER = 59893; // Table basse bois marbre Mermer : en rupture sur le site
const FLORA = catalog.find(item => /FLORA/.test(item.name) && /&amp;/.test(item.name)).id;

(async () => {
  await test('vrai catalogue (522) : toutes les fiches créées, noms et catégories sans entités HTML', async () => {
    const result = await admin.runWooCommerceSync('test');
    assert.strictEqual(result.fetched, 522);
    assert.strictEqual(result.created, 522);
    assert.strictEqual(result.deactivated, 0);
    const products = admin.loadProducts();
    const entity = /&(#x?[0-9a-f]+|[a-z]{2,8});/i;
    for (const product of products) {
      assert.ok(!entity.test(product.name), product.name);
      assert.ok(!entity.test(product.category), product.category);
      assert.ok(!entity.test(product.description || ''), `${product.name} : ${product.description}`);
    }
    assert.ok(products.some(item => item.category.includes('Matelas Enfant & Ado')));
    assert.ok(/Bouclette & Design/.test(one(FLORA).name), one(FLORA).name);
    assert.strictEqual(admin.loadWooCommerceSyncState().lastAnnouncedTotal, 522);
  });

  await test('G1 — promotion programmée (on_sale faux) : jamais annoncée ; promo ≥ prix normal : ignorée', async () => {
    const startsAt = Date.now() + 15 * 86400000;
    setSite(NOVA, {
      regular_price: '3990', sale_price: '2990', price: '3990', on_sale: false,
      date_on_sale_from_gmt: iso(startsAt), date_on_sale_to_gmt: iso(startsAt + 3 * 86400000),
      date_modified_gmt: '2026-11-02T10:00:00'
    });
    // Ancienne charge utile sans on_sale : promo seulement si price = sale_price.
    const remote = admin.mapWooCommerceProduct({ ...byId.get(NOVA), on_sale: undefined, regular_price: '3990', sale_price: '2990', price: '3990' });
    assert.strictEqual(remote.promoPrice, '');
    const inverted = admin.mapWooCommerceProduct({ ...byId.get(NOVA), on_sale: true, regular_price: '3990', sale_price: '4290', price: '4290' });
    assert.strictEqual(inverted.promoPrice, '');

    await admin.runWooCommerceSync('test-scheduled');
    const nova = one(NOVA);
    assert.strictEqual(nova.price, '3990');
    assert.strictEqual(nova.promoPrice, '');
    assert.ok(!/Prix promotionnel/.test(admin.productToContext(nova)));
    assert.ok(!/au lieu de/.test(buildProductCard(nova).interactive.body.text));
  });

  await test('G1 — promotion terminée : retirée du contexte IA, de la fiche et du flux Meta avant la synchro suivante', async () => {
    const endsAt = Date.now() + 3600000;
    setSite(LIORA, { date_on_sale_from_gmt: iso(Date.now() - 86400000), date_on_sale_to_gmt: iso(endsAt), date_modified_gmt: '2026-11-02T11:00:00' });
    await admin.runWooCommerceSync('test-sale-dates');
    let liora = one(LIORA);
    assert.strictEqual(liora.promoPrice, '12490');
    assert.strictEqual(liora.promoEndsAt, iso(endsAt));
    assert.ok(admin.productToContext(liora).includes('Prix promotionnel : 12490 TND'));
    const feed = require('../catalog-feed');
    let row = feed.buildFeed().split('\n').find(line => line.startsWith('"69317"'));
    assert.ok(row && row.includes('"12490.00 TND"'), row);
    assert.ok(/"\d{4}-\d\d-\d\dT\d\d:\d\d\+00:00\/\d{4}-\d\d-\d\dT\d\d:\d\d\+00:00"/.test(row), row);

    // Une heure plus tard (date de fin enregistrée dépassée) : plus de promo.
    const products = admin.loadProducts().map(item =>
      Number(item.woocommerceId) === LIORA ? { ...item, promoEndsAt: iso(Date.now() - 60000) } : item);
    admin.saveProducts(products);
    liora = one(LIORA);
    assert.ok(!/Prix promotionnel/.test(admin.productToContext(liora)), admin.productToContext(liora));
    assert.strictEqual(buildProductCard(liora).interactive.body.text.split('\n')[1], '💰 12870 DT');
    row = feed.buildFeed().split('\n').find(line => line.startsWith('"69317"'));
    assert.ok(row.includes('"12870.00 TND","",""'), row);
  });

  await test('G2 — fiche du site modifiée dans l’Admin : disponibilité, description et masquage gardés, prix repris avec avertissement', async () => {
    const nova = one(NOVA);
    const put = await callRoute('put', '/api/products/:id', {
      params: { id: nova.id },
      body: { ...nova, active: 'false', promoPrice: '2490', availability: 'on_order', description: 'Délai 6 semaines, promo pas encore active' }
    });
    assert.strictEqual(put.statusCode, 200, JSON.stringify(put.body));
    assert.ok(/Prix promotionnel : produit synchronisé/.test(put.body.warning), put.body.warning);
    assert.strictEqual(put.body.hiddenByAdmin, true);
    assert.strictEqual(put.body.overrides.availability.value, 'on_order');
    assert.strictEqual(put.body.overrides.availability.siteValue, 'in_stock');
    assert.strictEqual(put.body.overrides.promoPrice, undefined);

    await admin.runWooCommerceSync('test-admin-edit');
    const after = one(NOVA);
    assert.strictEqual(after.active, false, 'reste masqué');
    assert.strictEqual(after.availability, 'on_order');
    assert.strictEqual(after.description, 'Délai 6 semaines, promo pas encore active');
    assert.strictEqual(after.promoPrice, '', 'prix promo : valeur du site');
    const state = admin.loadWooCommerceSyncState();
    assert.ok(state.lastHiddenByAdmin.some(item => item.woocommerceId === NOVA));

    // Actif recoché : la fiche revient au site.
    const back = await callRoute('put', '/api/products/:id', { params: { id: after.id }, body: { ...after, active: 'true' } });
    assert.strictEqual(back.body.hiddenByAdmin, undefined);
    await admin.runWooCommerceSync('test-admin-edit-2');
    assert.strictEqual(one(NOVA).active, true);
  });

  await test('G2 — prix figé sur demande : gardé, puis rendu au site dès que le site change ce prix', async () => {
    const nova = one(NOVA);
    const put = await callRoute('put', '/api/products/:id', {
      params: { id: nova.id }, body: { ...nova, price: '3 790 DT', lockPrice: 'true' }
    });
    assert.strictEqual(put.statusCode, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.price, '3790', 'prix saisi normalisé');
    assert.strictEqual(put.body.overrides.price.siteValue, '3990');
    assert.strictEqual(put.body.warning, undefined);
    await admin.runWooCommerceSync('test-lock');
    assert.strictEqual(one(NOVA).price, '3790');

    // Case décochée : prix rendu au site.
    const unlocked = await callRoute('put', '/api/products/:id', { params: { id: nova.id }, body: { ...one(NOVA), lockPrice: 'false' } });
    assert.strictEqual(unlocked.body.overrides.price, undefined);
    await admin.runWooCommerceSync('test-unlock');
    assert.strictEqual(one(NOVA).price, '3990');
    const relocked = await callRoute('put', '/api/products/:id', { params: { id: nova.id }, body: { ...one(NOVA), price: '3790', lockPrice: 'true' } });
    assert.strictEqual(relocked.body.overrides.price.value, '3790');

    setSite(NOVA, { regular_price: '3890', price: '3890', date_modified_gmt: '2026-11-03T10:00:00' });
    await admin.runWooCommerceSync('test-lock-expired');
    const after = one(NOVA);
    assert.strictEqual(after.price, '3890');
    assert.strictEqual(after.overrides?.price, undefined);
    assert.strictEqual(after.overrides.availability.value, 'on_order', 'autre correction intacte');

    const bad = await callRoute('put', '/api/products/:id', { params: { id: after.id }, body: { ...after, price: 'sur devis' } });
    assert.strictEqual(bad.statusCode, 400);
  });

  await test('G2 — correction commerciale : prix sans « figer » = avertissement ; avec « figer » = gardé', async () => {
    const liora = one(LIORA);
    const plain = await callRoute('post', '/api/commercial-corrections/product', {
      body: { productId: liora.id, field: 'price', value: '11 990' }
    });
    assert.strictEqual(plain.statusCode, 200, JSON.stringify(plain.body));
    assert.ok(/prochaine synchronisation/.test(plain.body.warning));
    assert.strictEqual(plain.body.correction.newValue, '11990');
    await admin.runWooCommerceSync('test-correction');
    assert.strictEqual(one(LIORA).price, '12870');

    const locked = await callRoute('post', '/api/commercial-corrections/product', {
      body: { productId: liora.id, field: 'price', value: '11990', lockPrice: true }
    });
    assert.ok(/prioritaire/.test(locked.body.warning), locked.body.warning);
    await admin.runWooCommerceSync('test-correction-locked');
    assert.strictEqual(one(LIORA).price, '11990');

    const availability = await callRoute('post', '/api/commercial-corrections/product', {
      body: { productId: liora.id, field: 'availability', value: 'Sur commande' }
    });
    assert.strictEqual(availability.statusCode, 200);
    await admin.runWooCommerceSync('test-correction-availability');
    assert.strictEqual(one(LIORA).availability, 'on_order');
  });

  await test('G2 — suppression d’une fiche du site : masquée et jamais recréée ; « Rendre au site » la réactive', async () => {
    const mermerBefore = one(MERMER);
    const count = admin.loadProducts().length;
    const removed = await callRoute('delete', '/api/products/:id', { params: { id: mermerBefore.id } });
    assert.strictEqual(removed.body.hidden, true);
    await admin.runWooCommerceSync('test-delete');
    const products = admin.loadProducts();
    assert.strictEqual(products.length, count, 'aucune fiche recréée');
    const mermer = one(MERMER);
    assert.strictEqual(mermer.id, mermerBefore.id, 'même identifiant (flux Meta stable)');
    assert.strictEqual(mermer.active, false);
    assert.strictEqual(mermer.deletedByAdmin, true);

    const reset = await callRoute('post', '/api/products/:id/site-reset', { params: { id: mermer.id } });
    assert.strictEqual(reset.statusCode, 200, JSON.stringify(reset.body));
    assert.strictEqual(reset.body.refreshed, true);
    assert.strictEqual(reset.body.product.active, true);
    assert.strictEqual(reset.body.product.deletedByAdmin, undefined);

    const resetLiora = await callRoute('post', '/api/products/:id/site-reset', { params: { id: one(LIORA).id } });
    assert.strictEqual(resetLiora.body.product.price, '12870');
    assert.strictEqual(resetLiora.body.product.overrides, undefined);
  });

  await test('G4 — fiche produit : disponibilité en mots, pas de fiche IA automatique pour un produit en rupture', async () => {
    const products = admin.loadProducts();
    const mermer = one(MERMER);
    assert.strictEqual(mermer.availability, 'out_of_stock');
    assert.strictEqual(findProductForCard(`La ${mermer.name} coûte ${mermer.price} DT.`, products), null);
    const text = buildProductCard(mermer).interactive.body.text;
    assert.ok(text.endsWith('📦 Rupture de stock'), text);
    assert.ok(!/in_stock|out_of_stock|unknown/.test(buildProductCard(one(LIORA)).interactive.body.text));
    const flora = one(FLORA);
    const card = findProductForCard(`Le ${flora.name.replace(/&amp;/g, '&')} est à ${flora.price} DT`, products);
    assert.strictEqual(card && card.id, flora.id);

    const picker = await callRoute('get', '/api/conversations/product-picker', { query: { q: 'mermer' } });
    assert.ok(picker.body.items[0].cardBody.includes('📦 Rupture de stock'), picker.body.items[0].cardBody);
  });

  await test('G6 — webhook reçu pendant la synchronisation : la donnée plus récente n’est pas écrasée', async () => {
    const id = LIORA;
    fake.pageDelayMs = 30;
    let webhookDone = null;
    const newProductId = 99001;
    fake.beforePage = async page => {
      if (page !== 3 || webhookDone) return;
      const newer = { ...site.find(item => item.id === id), sale_price: '9990', price: '9990', on_sale: true, date_modified_gmt: '2026-11-11T21:59:00' };
      webhookDone = admin.processWooCommerceWebhook('product.updated', newer)
        .then(() => admin.processWooCommerceWebhook('product.created', {
          ...site.find(item => item.id === id), id: newProductId, name: 'Salon Nouveau', slug: 'salon-nouveau', sku: '', date_modified_gmt: '2026-11-11T22:00:00'
        }));
      await webhookDone;
    };
    try {
      const result = await admin.runWooCommerceSync('test-race');
      assert.ok(result.stale >= 1, JSON.stringify(result.stale));
    } finally {
      fake.pageDelayMs = 0;
      fake.beforePage = null;
    }
    const liora = one(id);
    assert.strictEqual(liora.promoPrice, '9990');
    assert.strictEqual(liora.woocommerceModifiedAt, '2026-11-11T21:59:00');
    const created = one(newProductId);
    assert.strictEqual(created.active, true, 'produit créé par webhook pendant la lecture : pas désactivé');
    site.push({ ...site.find(item => item.id === id), id: newProductId, name: 'Salon Nouveau', slug: 'salon-nouveau', sku: '', date_modified_gmt: '2026-11-11T22:00:00' });
    setSite(id, { sale_price: '9990', price: '9990', on_sale: true, date_modified_gmt: '2026-11-11T21:59:00' });
  });

  await test('V6.46 — date du site qui recule (restauration, import) : la synchro complète reprend le prix ; « Rendre au site » relit vraiment la fiche', async () => {
    const before = one(NOVA);
    assert.ok(before.woocommerceModifiedAt, 'date du site enregistrée');
    setSite(NOVA, { regular_price: '3590', price: '3590', sale_price: '', on_sale: false, date_modified_gmt: '2026-10-20T10:00:00' });
    const result = await admin.runWooCommerceSync('test-date-recule');
    assert.strictEqual(one(NOVA).price, '3590', `prix repris malgré la date plus ancienne (stale=${result.stale})`);
    // Webhook plus ancien que la fiche : toujours ignoré (ordre des livraisons).
    const older = { ...site.find(item => item.id === NOVA), regular_price: '3490', price: '3490', date_modified_gmt: '2026-10-19T10:00:00' };
    await admin.processWooCommerceWebhook('product.updated', older);
    assert.strictEqual(one(NOVA).price, '3590', 'livraison plus ancienne ignorée');
    setSite(NOVA, { regular_price: '3490', price: '3490', date_modified_gmt: '2026-10-19T10:00:00' });
    const reset = await callRoute('post', '/api/products/:id/site-reset', { params: { id: one(NOVA).id } });
    assert.strictEqual(reset.statusCode, 200, JSON.stringify(reset.body));
    assert.strictEqual(reset.body.refreshed, true);
    assert.strictEqual(reset.body.product.price, '3490', '« Rendre au site » : valeur du site reprise');
  });

  await test('G9 — produit retiré entre deux pages : le produit décalé n’est pas désactivé ; le produit retiré l’est (synchro suivante)', async () => {
    const sorted = site.slice().sort((a, b) => a.id - b.id);
    const trashed = sorted[10].id; // page 1
    const shifted = sorted[100].id; // premier produit de la page 2
    fake.beforePage = async page => {
      if (page === 2) site = site.filter(item => item.id !== trashed);
    };
    let result;
    try {
      result = await admin.runWooCommerceSync('test-shift');
    } finally {
      fake.beforePage = null;
    }
    assert.strictEqual(one(shifted).active, true, 'produit décalé encore actif');
    assert.strictEqual(result.deactivated, 0);
    assert.ok(fake.requests.some(item => item.includes(`include=${shifted}`)), 'produit absent relu directement');
    // Le produit retiré avait été lu en page 1 : repéré à la synchronisation suivante.
    const next = await admin.runWooCommerceSync('test-shift-2');
    assert.strictEqual(next.deactivated, 1);
    assert.strictEqual(one(trashed).active, false, 'produit retiré désactivé');
    assert.strictEqual(one(shifted).active, true);
  });

  await test('G9 — sans en-tête de pagination : toutes les pages lues ; disparition en masse : aucune désactivation sans confirmation', async () => {
    fake.omitPageHeaders = true;
    try {
      const all = await admin.runWooCommerceSync('test-no-header');
      assert.strictEqual(all.fetched, site.length);
      assert.strictEqual(all.deactivated, 0);
    } finally {
      fake.omitPageHeaders = false;
    }

    const saved = site;
    site = site.slice(0, site.length - 120);
    try {
      const guarded = await admin.runWooCommerceSync('test-mass');
      assert.strictEqual(guarded.deactivated, 0);
      assert.ok(/aucune désactivation/.test(guarded.deactivationSkipped), guarded.deactivationSkipped);
      assert.ok(admin.loadWooCommerceSyncState().lastDeactivationSkipped);
      assert.strictEqual(admin.loadProducts().filter(item => item.syncSource === 'woocommerce' && item.active !== false).length >= 500, true);

      const confirmed = await admin.runWooCommerceSync('test-mass-confirmed', { allowMassDeactivation: true });
      assert.strictEqual(confirmed.deactivated, 120);
    } finally {
      site = saved;
    }
    await admin.runWooCommerceSync('test-restore');
  });

  await test('G0 — signature calculée sur les octets reçus (PHP), jamais sur une copie JSON.stringify', async () => {
    const payload = { id: LIORA, name: 'Pack Mariage Liora', permalink: 'https://mondeco.tn/produit/pack-mariage-liora/', short_description: 'Chambre élégante' };
    // wp_json_encode (PHP) : « \/ » et « \u00e9 ».
    const php = JSON.stringify(payload).replace(/\//g, '\\/').replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(php).digest('base64');
    const request = (rawBody, body) => ({ rawBody, body, get: name => (name.toLowerCase() === 'x-wc-webhook-signature' ? signature : '') });
    assert.strictEqual(admin.verifyWooWebhookSignature(request(Buffer.from(php), JSON.parse(php))), true);
    assert.strictEqual(admin.verifyWooWebhookSignature(request(undefined, JSON.parse(php))), false, 'pas de secours JSON.stringify');
    assert.strictEqual(admin.verifyWooWebhookSignature(request(Buffer.from(JSON.stringify(payload)), payload)), false);
  });

  await test('G0 — installation : webhooks désactivés ou en pause réactivés avec le secret actuel', async () => {
    const url = 'https://app.mondeco.tn/admin/api/woocommerce/webhook';
    fake.webhooks = [
      { id: 11, topic: 'product.created', delivery_url: url, status: 'active' },
      { id: 12, topic: 'product.updated', delivery_url: url, status: 'disabled' },
      { id: 13, topic: 'product.deleted', delivery_url: `${url}/`, status: 'paused' }
    ];
    const req = { headers: { 'x-forwarded-proto': 'https' }, protocol: 'http', get: name => (name === 'host' ? 'app.mondeco.tn' : '') };
    const result = await admin.installWooCommerceWebhooks(req);
    assert.deepStrictEqual(result.webhooks.map(item => [item.topic, item.status]), [
      ['product.created', 'already_exists'],
      ['product.updated', 'reactivated'],
      ['product.deleted', 'reactivated']
    ]);
    assert.deepStrictEqual(fake.puts.map(item => [item.id, item.body.status, item.body.secret]), [
      [12, 'active', WEBHOOK_SECRET],
      [13, 'active', WEBHOOK_SECRET]
    ]);
    assert.strictEqual(fake.posts.length, 0);
  });

  console.log(`${passed} test(s) catalogue WooCommerce (V6.46) OK`);
})()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    // Admin.js garde des minuteries actives : fin explicite du processus.
    setTimeout(() => process.exit(process.exitCode || 0), 20);
  });
