// V6.45 — Test d'intégration de la synchronisation WooCommerce d'Admin.js
// (runWooCommerceSync réel, API /wc/v3 simulée) sur 15 vrais produits du
// site : les 7 produits Bianca, Maissa, Pouf Maya, Salon Baya / Baya+, les
// deux « Table à Manger Ronde Violine avec 4 Chaises » et deux produits
// variables. DATA_DIR temporaire : aucune donnée réelle n'est touchée.
//
// Admin.js n'exporte pas ses fonctions de synchronisation : un crochet de
// chargement ajoute, pour ce test uniquement, un export __wooSyncTest.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const adminPath = path.join(root, 'Admin.js');
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-woo-sync-'));

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

// Variations (REST v3) des deux produits variables du jeu d'essai.
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

const requests = [];
let failVariations = false;
globalThis.fetch = async url => {
  const target = new URL(String(url));
  requests.push(target.pathname);
  const json = (data, headers = {}) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  let match = target.pathname.match(/\/wp-json\/wc\/v3\/products\/(\d+)\/variations$/);
  if (match) {
    if (failVariations) return new Response('{"message":"panne"}', { status: 500 });
    return json(VARIATIONS[match[1]] || [], { 'x-wp-totalpages': '1' });
  }
  match = target.pathname.match(/\/wp-json\/wc\/v3\/products\/(\d+)$/);
  if (match) return json(fixtures.find(item => item.id === Number(match[1])) || {});
  if (target.pathname.endsWith('/wp-json/wc/v3/products')) {
    const page = Number(target.searchParams.get('page') || 1);
    const perPage = 6; // plusieurs pages, comme en production
    return json(fixtures.slice((page - 1) * perPage, page * perPage), {
      'x-wp-totalpages': String(Math.ceil(fixtures.length / perPage)),
      'x-wp-total': String(fixtures.length)
    });
  }
  throw new Error(`Requête inattendue : ${url}`);
};

// Fiches locales existantes avant la synchronisation.
fs.writeFileSync(path.join(tmpDataDir, 'products.json'), JSON.stringify([
  // Fiche manuelle ancienne, avec un prix périmé (cause possible du « 2800 »).
  { id: 'manual-chambre-bianca', name: 'Chambre Bianca', category: 'Chambre à coucher', price: '2800', composition: 'Lit + 2 tables de nuit', availability: 'in_stock', active: true },
  { id: 'manual-lit-bianca', name: 'Lit Bianca + 2 chevets', category: 'Chambre à coucher', price: '2800', availability: 'in_stock', active: true },
  // Fiche manuelle au nom exact du site : reprise par la synchronisation.
  { id: 'manual-adopted', name: 'Chambre à Coucher Bianca', price: '2800', composition: 'Lit + 2 tables de nuit', dimensions: 'ancienne mesure', availability: 'in_stock', active: true },
  // Fiche du site déjà synchronisée (Baya+) : ne doit plus « basculer » sur Salon Baya.
  { id: 'woo-baya-plus', name: 'Salon Baya+', price: '2800', active: true, syncSource: 'woocommerce', woocommerceId: 54253, woocommerceSlug: 'salon-baya-plus' },
  // Correction volontaire sur une fiche du site : conservée.
  { id: 'woo-fauteuil', name: 'Fauteuil de coiffure BIANCA', price: '290', active: true, syncSource: 'woocommerce', woocommerceId: 61301, description: 'Texte validé par le showroom', overrides: { description: { value: 'Texte validé par le showroom', by: 'Admin', at: '2026-11-01T10:00:00Z', source: 'admin' } } },
  // Ancien produit du site supprimé : désactivé.
  { id: 'woo-old', name: 'Chambre à coucher Bianca (ancienne fiche)', price: '2800', active: true, syncSource: 'woocommerce', woocommerceId: 41000, availability: 'in_stock' },
  // Fiche manuelle sans équivalent sur le site : intacte.
  { id: 'manual-opale', name: 'Table Opale', price: '890', active: true }
]));

const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compile(content, filename) {
  if (filename === adminPath) {
    content += '\n;module.exports.__wooSyncTest = { runWooCommerceSync, processWooCommerceWebhook, productToContext, loadProducts, getBusinessContext, loadWooCommerceSyncState };\n';
  }
  return originalCompile.call(this, content, filename);
};

const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
console.log = () => {};
console.warn = () => {};
console.info = () => {};
console.error = () => {};
const adminModule = require(adminPath);
const admin = adminModule.__wooSyncTest;
const adminRouter = adminModule.adminRouter;
Module.prototype._compile = originalCompile;
Object.assign(console, quiet);

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
const byLocalId = (products, id) => products.find(item => item.id === id);

(async () => {
  let first;

  await test('15 produits du site → 15 fiches : Baya / Baya+ et les deux Violine sont conservés', async () => {
    first = await admin.runWooCommerceSync('test');
    const products = admin.loadProducts();
    for (const product of fixtures) {
      assert.strictEqual(byWooId(products, product.id).length, 1, `fiche du site ${product.id}`);
    }
    assert.strictEqual(products.filter(item => item.syncSource === 'woocommerce' && item.active !== false).length, 15);
    assert.strictEqual(byWooId(products, 52452)[0].price, '2200');
    assert.strictEqual(byWooId(products, 52452)[0].name, 'Salon Baya');
    assert.strictEqual(byWooId(products, 54253)[0].price, '2800');
    assert.strictEqual(byWooId(products, 54253)[0].id, 'woo-baya-plus');
    assert.strictEqual(byWooId(products, 58251)[0].price, '1790');
    assert.strictEqual(byWooId(products, 59861)[0].price, '1830');
    assert.strictEqual(byLocalId(products, 'woo-old').active, false);
    assert.strictEqual(byLocalId(products, 'manual-opale').active, true);
    assert.strictEqual(byLocalId(products, 'manual-opale').duplicateOfWooId, undefined);
  });

  await test('Chambre à Coucher Bianca : prix du site, composition décodée remplace la composition périmée', async () => {
    const products = admin.loadProducts();
    const bianca = byWooId(products, 60068)[0];
    assert.strictEqual(bianca.id, 'manual-adopted');
    assert.strictEqual(bianca.price, '7200');
    assert.strictEqual(bianca.promoPrice, '6590');
    assert.strictEqual(bianca.composition, '1 lit + 1 dressing + 1 coiffeuse + 2 tables de nuit + 1 pouf de lit');
    assert.ok(bianca.dimensions.startsWith('Dressing : L260 × P63 × H220 cm'), bianca.dimensions);
    assert.strictEqual(bianca.specs.Dressing, 'L260 × P63 × H220 cm');
    assert.ok(!/\[vc_|JTNDZGl2/.test(bianca.description));
  });

  await test('produits variables : variations lues, prix « à partir de » et promotion par variante', async () => {
    const products = admin.loadProducts();
    const nuage = byWooId(products, 69255)[0];
    assert.strictEqual(nuage.name, 'Lit Capitonné Nuage Enfant – 90 ou 120 cm');
    assert.strictEqual(nuage.priceFrom, '590');
    assert.strictEqual(nuage.priceTo, '690');
    assert.strictEqual(nuage.variations.length, 2);
    const salma = byWooId(products, 61055)[0];
    assert.strictEqual(salma.price, '3060');
    assert.strictEqual(salma.promoPrice, '2570');
    assert.strictEqual(salma.priceFrom, '2570');
    assert.strictEqual(salma.priceTo, '3060');
    assert.ok(requests.some(item => item.endsWith('/products/69255/variations')));
    assert.strictEqual(first.variations.variableProducts, 2);
    assert.strictEqual(first.variations.fetched, 2);
    // Produit simple : aucun champ de variation ajouté.
    assert.strictEqual(byWooId(products, 60068)[0].variations, undefined);
    assert.strictEqual(byWooId(products, 60068)[0].priceFrom, undefined);
  });

  await test('fiches manuelles en doublon : marquées (pas supprimées) et listées dans le rapport', async () => {
    const products = admin.loadProducts();
    const chambre = byLocalId(products, 'manual-chambre-bianca');
    assert.strictEqual(chambre.active, true);
    assert.strictEqual(chambre.duplicateOfWooId, 60068);
    assert.strictEqual(chambre.duplicateConfidence, 'high');
    assert.strictEqual(chambre.price, '2800'); // donnée conservée pour l'équipe
    const lit = byLocalId(products, 'manual-lit-bianca');
    assert.strictEqual(lit.duplicateOfWooId, 60068);
    assert.strictEqual(lit.duplicateConfidence, 'possible');
    const state = admin.loadWooCommerceSyncState();
    assert.strictEqual(state.lastDuplicateManualCount, 2);
    assert.deepStrictEqual(state.lastDuplicateManualProducts.map(item => item.id).sort(), ['manual-chambre-bianca', 'manual-lit-bianca']);
    assert.strictEqual(state.lastVariableProducts, 2);
    assert.strictEqual(state.lastOverridesCount, 1);
    assert.deepStrictEqual(state.lastOverrides[0].fields, ['description']);
  });

  await test('correction volontaire (product.overrides) conservée malgré la synchronisation', async () => {
    const fauteuil = byWooId(admin.loadProducts(), 61301)[0];
    assert.strictEqual(fauteuil.description, 'Texte validé par le showroom');
    assert.strictEqual(fauteuil.price, '290');
  });

  await test('bloc IA : « Produit : » en premier, libellés conservés, description plafonnée', async () => {
    const products = admin.loadProducts();
    const block = admin.productToContext(byWooId(products, 60068)[0]);
    const lines = block.split('\n');
    assert.strictEqual(lines[0], 'Produit : Chambre à Coucher Bianca');
    assert.ok(lines.includes('Prix normal : 7200 TND'));
    assert.ok(lines.includes('Prix promotionnel : 6590 TND'));
    assert.ok(lines.includes('Composition : 1 lit + 1 dressing + 1 coiffeuse + 2 tables de nuit + 1 pouf de lit'));
    assert.ok(lines.some(line => line.startsWith('Dimensions : Dressing : L260 × P63 × H220 cm')));
    assert.ok(lines.includes('Lien produit : https://mondeco.tn/produit/chambre-a-coucher-bianca-tunisie/'));
    for (const product of products.filter(item => item.active !== false)) {
      const text = admin.productToContext(product);
      const description = (text.split('\n').find(line => line.startsWith('Description : ')) || '').slice('Description : '.length);
      assert.ok(description.length <= 602, `${product.name} : description ${description.length}`);
      assert.ok(text.length < 2500, `${product.name} : bloc ${text.length}`);
      assert.ok(text.startsWith(`Produit : ${product.name}`));
    }

    const nuage = admin.productToContext(byWooId(products, 69255)[0]);
    assert.ok(nuage.includes("Prix : à partir de 590 TND (jusqu'à 690 TND selon la variante)"), nuage);
    assert.ok(nuage.includes('Prix par variante (Largeur Lit) : 90 cm : 590 TND ; 120 cm : 690 TND'));
    assert.ok(!nuage.includes('Prix normal :'));
    const salma = admin.productToContext(byWooId(products, 61055)[0]);
    assert.ok(salma.includes('BLEU : 2570 TND en promotion au lieu de 3060 TND'), salma);

    const duplicate = admin.productToContext(byLocalId(products, 'manual-chambre-bianca'));
    assert.ok(!/2800|Prix normal/.test(duplicate), duplicate);
    assert.ok(/doublon de la fiche du site réf\. 60068/.test(duplicate), duplicate);
    const possible = admin.productToContext(byLocalId(products, 'manual-lit-bianca'));
    assert.ok(possible.includes('Prix normal : 2800 TND'));
    assert.ok(/doublon possible/.test(possible));
  });

  await test('contexte IA : les fiches en doublon passent après la fiche du site', async () => {
    const context = admin.getBusinessContext();
    const siteIndex = context.indexOf('Produit : Chambre à Coucher Bianca');
    const duplicateIndex = context.indexOf('Produit : Chambre Bianca\n');
    assert.ok(siteIndex > 0 && duplicateIndex > siteIndex, `${siteIndex} / ${duplicateIndex}`);
  });

  await test('deuxième synchronisation identique : rien ne bascule, rien ne change', async () => {
    const before = JSON.stringify(admin.loadProducts().map(item => [item.id, item.woocommerceId, item.price, item.promoPrice, item.composition]));
    const second = await admin.runWooCommerceSync('test-2');
    assert.strictEqual(second.created, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.unchanged, 15);
    const after = JSON.stringify(admin.loadProducts().map(item => [item.id, item.woocommerceId, item.price, item.promoPrice, item.composition]));
    assert.strictEqual(after, before);
  });

  await test('variations illisibles : les précédentes sont gardées tant que le prix minimum concorde', async () => {
    failVariations = true;
    try {
      const result = await admin.runWooCommerceSync('test-panne');
      assert.strictEqual(result.variations.errors, 2);
      const products = admin.loadProducts();
      assert.strictEqual(byWooId(products, 69255)[0].priceTo, '690');
      assert.strictEqual(byWooId(products, 61055)[0].promoPrice, '2570');
    } finally {
      failVariations = false;
    }
  });

  await test('webhook : produit variable mis à jour avec ses variations ; variation → produit parent', async () => {
    VARIATIONS[69255][0] = { ...VARIATIONS[69255][0], price: '650', sale_price: '650', on_sale: true };
    await admin.processWooCommerceWebhook('product.updated', fixtures.find(item => item.id === 69255));
    let nuage = byWooId(admin.loadProducts(), 69255)[0];
    assert.strictEqual(nuage.priceTo, '650');
    assert.ok(admin.productToContext(nuage).includes('120 cm : 650 TND en promotion au lieu de 690 TND'));

    VARIATIONS[69255][1] = { ...VARIATIONS[69255][1], price: '560', regular_price: '560' };
    const count = admin.loadProducts().length;
    await admin.processWooCommerceWebhook('product.updated', { id: 69257, type: 'variation', parent_id: 69255, name: 'Lit Capitonné Nuage Enfant - 90 cm', price: '560' });
    const products = admin.loadProducts();
    assert.strictEqual(products.length, count, 'aucune fausse fiche créée pour la variation');
    nuage = byWooId(products, 69255)[0];
    assert.strictEqual(nuage.priceFrom, '560');
    assert.strictEqual(byWooId(products, 69257).length, 0);
  });

  // Appel direct du dernier gestionnaire d'une route (sans requireAuth ni
  // téléversement), avec un utilisateur simulé.
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
    await handlers[handlers.length - 1].handle({ params: {}, body: {}, user: { id: 'u1', name: 'Testeur' }, ...req }, res, () => {});
    return res;
  };

  await test('fiche produit / correction commerciale : correction volontaire enregistrée, prix jamais figé', async () => {
    const bianca = byWooId(admin.loadProducts(), 60068)[0];
    const put = await callRoute('put', '/api/products/:id', {
      params: { id: bianca.id },
      body: { ...bianca, composition: '1 lit + 1 dressing + 2 tables de nuit (showroom)', price: '1' }
    });
    assert.strictEqual(put.statusCode, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.overrides.composition.value, '1 lit + 1 dressing + 2 tables de nuit (showroom)');
    assert.strictEqual(put.body.overrides.composition.by, 'Testeur');
    assert.strictEqual(put.body.overrides.price, undefined);

    const correction = await callRoute('post', '/api/commercial-corrections/product', {
      body: { productId: bianca.id, field: 'promoPrice', value: '1000' }
    });
    assert.strictEqual(correction.statusCode, 200, JSON.stringify(correction.body));
    assert.ok(/prochaine synchronisation/.test(correction.body.warning));

    await admin.runWooCommerceSync('test-overrides');
    const after = byWooId(admin.loadProducts(), 60068)[0];
    assert.strictEqual(after.composition, '1 lit + 1 dressing + 2 tables de nuit (showroom)');
    assert.strictEqual(after.price, '7200');
    assert.strictEqual(after.promoPrice, '6590');

    // Champ vidé : la valeur du site revient à la synchronisation suivante.
    const cleared = await callRoute('post', '/api/commercial-corrections/product', {
      body: { productId: bianca.id, field: 'composition', value: '' }
    });
    assert.strictEqual(cleared.body.product.overrides, undefined);
    await admin.runWooCommerceSync('test-overrides-2');
    assert.strictEqual(
      byWooId(admin.loadProducts(), 60068)[0].composition,
      '1 lit + 1 dressing + 1 coiffeuse + 2 tables de nuit + 1 pouf de lit'
    );
  });

  console.log(`${passed} test(s) synchronisation WooCommerce OK`);
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
