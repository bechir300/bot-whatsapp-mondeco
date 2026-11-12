// V6.46 — Règles catalogue sans serveur : prix saisis à la main, promotion
// en vigueur, corrections de l'équipe sur les fiches du site, fiche produit
// WhatsApp, flux Meta (identifiants, prix, disponibilité), dossier de
// données commun, photo du site pour les fiches, « matelas » reconnu.
// DATA_DIR temporaire : aucune donnée réelle n'est touchée.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-catalog-w2-'));
process.env.DATA_DIR = tmpDataDir;
delete process.env.CATALOG_FEED_ID;

const catalog = require('../lib/woo-catalog');
const { productCardBody, buildProductCard } = require('../lib/whatsapp-interactive');
const { findProductForCard } = require('../lib/product-card-auto');
const resolver = require('../lib/product-resolver');
const { resolveDataDir } = require('../lib/data-dir');
const productImage = require('../lib/product-image');

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 1)]);
const response = (buffer, type = 'image/jpeg', status = 200) =>
  new Response(buffer, { status, headers: { 'content-type': type } });

(async () => {
  try {
    await test('G10 — prix saisis à la main : « 4 190 », « 4190 DT », « 4.190 » = 4190 ; « 104.500 » = 104,5 ; texte libre refusé', async () => {
      const cases = {
        '4 190': 4190, '4190 DT': 4190, '4.190': 4190, '4,190 TND': 4190, '12.500': 12500,
        '1.290.000': 1290000, '1.290,5': 1290.5, '4,5': 4.5, '104.500': 104.5, '0.500': 0.5,
        '4190.500': 4190.5, '3 990 dinars': 3990, ' 2790 ': 2790
      };
      for (const [input, expected] of Object.entries(cases)) {
        assert.strictEqual(catalog.parsePriceInput(input), expected, input);
      }
      for (const input of ['', 'sur devis', '4190-4590', '-20%', '0']) {
        assert.strictEqual(catalog.parsePriceInput(input), null, input);
      }
      assert.strictEqual(catalog.normalizePriceInput('4 190 DT'), '4190');
      assert.strictEqual(catalog.normalizePriceInput('104.500'), '104.5');
    });

    await test('G1 — promotion en vigueur : jamais ≥ prix normal, jamais hors des dates du site', async () => {
      const now = Date.parse('2026-11-20T12:00:00Z');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '3990', promoPrice: '2990' }, now), '2990');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '3990', promoPrice: '4290' }, now), '');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '3990', promoPrice: '3990' }, now), '');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '3290', promoPrice: '2790 DT' }, now), '2790 DT');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '3990', promoPrice: '2990', promoStartsAt: '2026-11-27T00:00:00' }, now), '', 'Black Friday pas encore commencé');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '3990', promoPrice: '2990', promoEndsAt: '2026-11-19T22:59:59' }, now), '', 'promotion terminée');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '3990', promoPrice: '2990', promoStartsAt: '2026-11-19T00:00:00', promoEndsAt: '2026-11-30T22:59:59' }, now), '2990');
      assert.strictEqual(catalog.effectivePromoPrice({ price: '', promoPrice: '2990' }, now), '2990', 'sans prix normal : inchangé');
    });

    await test('G2 — corrections de l’équipe : disponibilité gardée, prix seulement sur demande, retirées quand le site change', async () => {
      const before = { syncSource: 'woocommerce', price: '3990', promoPrice: '2990', availability: 'in_stock', description: 'Site' };
      const meta = { by: 'Sami', at: '2026-11-10T10:00:00Z' };
      let after = catalog.recordProductOverrides(before, { ...before, availability: 'on_order', price: '3790', promoPrice: '' }, meta);
      assert.deepStrictEqual(Object.keys(after.overrides), ['availability']);
      assert.strictEqual(after.overrides.availability.siteValue, 'in_stock');
      assert.deepStrictEqual(catalog.siteManagedChanges(before, { ...before, price: '3790', promoPrice: '' }), ['price', 'promoPrice']);

      after = catalog.recordProductOverrides(before, { ...before, price: '3790', promoPrice: '' }, { ...meta, lockPrice: true });
      assert.strictEqual(after.overrides.price.value, '3790');
      assert.strictEqual(after.overrides.price.siteValue, '3990');
      assert.strictEqual(after.overrides.promoPrice.value, '', 'promotion retirée = correction valable');
      assert.deepStrictEqual(catalog.siteManagedChanges(before, after, { lockPrice: true }), []);

      // Retour à la valeur du site : correction retirée.
      const back = catalog.recordProductOverrides(after, { ...after, price: '3990' }, { ...meta, lockPrice: true, fields: ['price'] });
      assert.strictEqual(back.overrides.price, undefined);

      const kept = catalog.resolveSiteOverrides(after.overrides, { price: '3990.0', promoPrice: '2990', availability: 'in_stock' });
      assert.deepStrictEqual(kept.expired, []);
      const changed = catalog.resolveSiteOverrides(after.overrides, { price: '3890', promoPrice: '2990', availability: 'in_stock' });
      assert.deepStrictEqual(changed.expired, ['price']);
      assert.ok(changed.overrides.promoPrice);

      // Produit variable à prix par variante : jamais figé ici (avertissement).
      const variable = { syncSource: 'woocommerce', price: '590', variations: [
        { label: '90 cm', price: '590', regularPrice: '590' }, { label: '120 cm', price: '690', regularPrice: '690' }
      ] };
      assert.strictEqual(catalog.recordProductOverrides(variable, { ...variable, price: '500' }, { lockPrice: true }).overrides, undefined);
      assert.deepStrictEqual(catalog.siteManagedChanges(variable, { ...variable, price: '500' }, { lockPrice: true }), ['price', 'variations']);

      // Ancien format (V6.45) : description seule, toujours lue.
      assert.deepStrictEqual(Object.keys(catalog.sanitizeOverrides({ description: { value: 'x' }, foo: { value: 'y' } })), ['description']);
      // Fiche manuelle : rien n'est enregistré.
      const manual = { name: 'Table Opale', price: '890' };
      assert.strictEqual(catalog.recordProductOverrides(manual, { ...manual, price: '790' }, { lockPrice: true }).overrides, undefined);
    });

    await test('G2 — masquage par l’équipe et suppression (tombstone) d’une fiche du site', async () => {
      const synced = { id: 'p1', syncSource: 'woocommerce', active: true, woocommerceStatus: 'publish' };
      const hidden = catalog.applyAdminVisibility(synced, { ...synced, active: false }, { by: 'Sami' });
      assert.strictEqual(hidden.hiddenByAdmin, true);
      assert.strictEqual(hidden.hiddenByAdminBy, 'Sami');
      const shown = catalog.applyAdminVisibility(hidden, { ...hidden, active: true });
      assert.strictEqual(shown.hiddenByAdmin, undefined);
      const tomb = catalog.adminTombstone(synced, { by: 'Sami' });
      assert.strictEqual(tomb.active, false);
      assert.strictEqual(tomb.deletedByAdmin, true);
      assert.strictEqual(tomb.id, 'p1');
      // Fiche du site non publiée réactivée ici : avertissement.
      const draft = { ...synced, active: false, woocommerceStatus: 'draft' };
      assert.deepStrictEqual(catalog.siteManagedChanges(draft, { ...draft, active: true }), ['active']);
      const manual = { id: 'm1', active: true };
      assert.strictEqual(catalog.applyAdminVisibility(manual, { ...manual, active: false }).hiddenByAdmin, undefined);
    });

    await test('G4 — fiche produit : disponibilité en mots, « À confirmer » masqué, entités décodées, promo cohérente', async () => {
      const body = productCardBody({ name: 'Salon Flora Bouclette &amp; Design', price: '3990', promoPrice: '2990', availability: 'in_stock', colors: 'Blanc &amp; Beige' });
      assert.strictEqual(body, '*Salon Flora Bouclette & Design*\n💰 2990 DT au lieu de ~3990 DT~\n🎨 Blanc & Beige\n📦 En stock');
      assert.ok(!productCardBody({ name: 'Salon', price: '1', availability: 'unknown' }).includes('📦'));
      assert.ok(productCardBody({ name: 'Salon', price: '1', availability: 'out_of_stock' }).endsWith('📦 Rupture de stock'));
      assert.ok(productCardBody({ name: 'Salon', price: '1', availability: 'on_order' }).endsWith('📦 Sur commande'));
      assert.strictEqual(productCardBody({ name: 'Salon Nova', price: '3990', promoPrice: '4290' }), '*Salon Nova*\n💰 3990 DT');
      assert.strictEqual(buildProductCard({ name: 'Lit 90&#215;190' }).interactive.header.text, 'Lit 90×190');
    });

    await test('G4 — fiche IA automatique : jamais pour un produit en rupture (ni pour son nom plus précis)', async () => {
      const products = [
        { id: 'a', name: 'Table basse Mermer', price: '790', availability: 'out_of_stock' },
        { id: 'b', name: 'Salon Fiorie', price: '3290', availability: 'in_stock' },
        { id: 'c', name: 'Salon Fiorie XL', price: '3990', availability: 'out_of_stock' },
        { id: 'd', name: 'Salon Panoramique FLORA Bouclette &amp; Design', price: '4990' }
      ];
      assert.strictEqual(findProductForCard('La Table basse Mermer coûte 790 DT.', products), null);
      assert.strictEqual(findProductForCard('Le Salon Fiorie XL mesure 320 cm', products), null);
      assert.strictEqual(findProductForCard('Le Salon Fiorie est à 3290 DT', products).id, 'b');
      assert.strictEqual(findProductForCard('Le Salon Panoramique FLORA Bouclette & Design est à 4990 DT', products).id, 'd');
    });

    await test('« matelas », « tapis », « bois », « gris » gardent leur « s » (types et descriptifs reconnus)', async () => {
      assert.deepStrictEqual(resolver.tokenize('matelas tapis bois gris velours chaises'), ['matelas', 'tapis', 'bois', 'gris', 'velours', 'chaise']);
      assert.deepStrictEqual(resolver.messageTypeWords('je cherche un matelas et un tapis'), ['matelas', 'tapis']);
      const products = [
        { id: 'a', name: 'Matelas Luna 160x200', price: '890', woocommerceId: 1, syncSource: 'woocommerce' },
        { id: 'b', name: 'Lit Luna 160x200', price: '1290', woocommerceId: 2, syncSource: 'woocommerce' }
      ];
      // Avant : « matela » n'était pas un type, la simple demande d'un
      // matelas désignait le seul produit au nom contenant ce mot.
      assert.strictEqual(resolver.resolveProduct({ message: 'je veux un matelas' }, products).status, 'none');
      assert.strictEqual(resolver.resolveProduct({ message: 'le matelas luna' }, products).product.id, 'a');
    });

    await test('G3/G10 — flux Meta : identifiant WooCommerce, prix saisis lisibles, « Sur commande », doublons d’identifiant', async () => {
      fs.writeFileSync(path.join(tmpDataDir, 'products.json'), JSON.stringify([
        { id: 'uuid-liora', woocommerceId: 69317, syncSource: 'woocommerce', name: 'Pack Mariage Liora', price: '12870', promoPrice: '12490', availability: 'in_stock', image: 'https://mondeco.tn/a.jpg', active: true },
        { id: 'uuid-copy', woocommerceId: 69317, syncSource: 'woocommerce', name: 'Pack Mariage Liora (copie)', price: '12870', image: 'https://mondeco.tn/a.jpg', active: true },
        { id: 'm1', name: 'Salon Manuel A', price: '4 190', availability: 'unknown', image: 'https://mondeco.tn/m1.jpg' },
        { id: 'm2', name: 'Salon Manuel B', price: '4.190', availability: 'on_order', image: 'https://mondeco.tn/m2.jpg' },
        { id: 'm3', name: 'Salon Manuel C', price: '4190 DT', promoPrice: '4290', image: 'https://mondeco.tn/m3.jpg' },
        { id: 'm4', name: 'Salon Manuel D', price: 'sur devis', image: 'https://mondeco.tn/m4.jpg' },
        { id: 'w2', woocommerceId: 70002, syncSource: 'woocommerce', name: 'Table Mermer', price: '790', availability: 'out_of_stock', image: 'https://mondeco.tn/t.jpg' }
      ]));
      const feed = require('../catalog-feed');
      const rows = feed.buildFeed(Date.parse('2026-11-20T12:00:00Z')).trim().split('\n');
      assert.strictEqual(rows[0], 'id,title,description,availability,condition,price,sale_price,sale_price_effective_date,link,image_link,brand,product_type');
      const row = id => rows.find(line => line.startsWith(`"${id}"`));
      assert.ok(row('69317').includes('"in stock","new","12870.00 TND","12490.00 TND"'), row('69317'));
      assert.strictEqual(rows.filter(line => line.startsWith('"69317"')).length, 1, 'identifiant unique');
      assert.ok(!rows.some(line => line.includes('uuid-liora')));
      assert.ok(row('m1').includes('"in stock","new","4190.00 TND"'), row('m1'));
      assert.ok(row('m2').includes('"available for order","new","4190.00 TND"'), row('m2'));
      assert.ok(row('m3').includes('"4190.00 TND","",""'), row('m3'));
      assert.strictEqual(row('m4'), undefined, 'prix illisible : absent (comme avant)');
      assert.ok(row('70002').includes('"out of stock"'));
      assert.strictEqual(feed.feedAvailability('clearance'), 'in stock');
    });

    await test('G7 — même dossier de données partout : DATA_DIR, sinon volume Railway, sinon dossier de l’application', async () => {
      const appDir = path.join(__dirname, '..');
      assert.strictEqual(resolveDataDir({ DATA_DIR: ' /x ' }), '/x');
      assert.strictEqual(resolveDataDir({ RAILWAY_VOLUME_MOUNT_PATH: '/vol' }), '/vol');
      assert.strictEqual(resolveDataDir({}), appDir);
      // Mêmes expressions dans server.js et Admin.js.
      for (const file of ['server.js', 'Admin.js']) {
        const source = fs.readFileSync(path.join(appDir, file), 'utf8');
        assert.ok(/process\.env\.DATA_DIR \|\|\s+process\.env\.RAILWAY_VOLUME_MOUNT_PATH \|\|\s+(__dirname|APP_DIR)/.test(source), file);
      }
      // Volume Railway seul : le flux et product-named lisent le même fichier.
      const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-volume-'));
      fs.writeFileSync(path.join(volume, 'products.json'), JSON.stringify([
        { id: 'w1', woocommerceId: 60068, syncSource: 'woocommerce', name: 'Chambre à Coucher Bianca', price: '7200', image: 'https://mondeco.tn/a.jpg' }
      ]));
      const script = "const f=require('./catalog-feed');const n=require('./product-named');process.stdout.write(JSON.stringify({feed:f.buildFeed(),words:[...n.modelWords()]}))";
      const env = { PATH: process.env.PATH, RAILWAY_VOLUME_MOUNT_PATH: volume };
      const child = spawnSync(process.execPath, ['-e', script], { cwd: appDir, env, encoding: 'utf8' });
      fs.rmSync(volume, { recursive: true, force: true });
      assert.strictEqual(child.status, 0, child.stderr);
      const out = JSON.parse(child.stdout);
      assert.ok(out.feed.includes('"60068"'));
      assert.ok(out.words.includes('bianca'));
    });

    await test('G5 — photo de la fiche : fichier local, sinon JPEG/PNG du site ; WebP refusé pour WhatsApp, accepté pour la simulation', async () => {
      const localPath = path.join(tmpDataDir, 'product-local.jpg');
      fs.writeFileSync(localPath, JPEG);
      let calls = 0;
      const neverFetch = async () => { calls++; throw new Error('pas de réseau'); };
      const local = await productImage.loadProductImage({ image: '/admin/uploads/product-local.jpg' }, { localPath, fetchImpl: neverFetch });
      assert.strictEqual(local.source, 'local');
      assert.strictEqual(calls, 0);

      const synced = { image: 'https://mondeco.tn/wp-content/uploads/2026/10/liora.jpg', imageFilename: '' };
      const remote = await productImage.loadProductImage(synced, { fetchImpl: async () => response(JPEG) });
      assert.strictEqual(remote.mimetype, 'image/jpeg');
      assert.strictEqual(remote.source, 'remote');

      const webp = { image: 'https://mondeco.tn/a.webp' };
      assert.strictEqual(await productImage.loadProductImage(webp, { fetchImpl: async () => response(WEBP, 'image/webp') }), null);
      const forSimulation = await productImage.loadProductImage(webp, { fetchImpl: async () => response(WEBP, 'image/webp'), allowedMimes: ['image/jpeg', 'image/png', 'image/webp'] });
      assert.strictEqual(forSimulation.mimetype, 'image/webp');

      assert.strictEqual(await productImage.loadProductImage({ image: 'http://mondeco.tn/a.jpg' }, { fetchImpl: neverFetch }), null);
      assert.strictEqual(await productImage.loadProductImage(synced, { fetchImpl: async () => response(JPEG, 'text/html') }), null);
      assert.strictEqual(await productImage.loadProductImage(synced, { fetchImpl: async () => response(JPEG, 'image/jpeg', 404) }), null);
      await assert.rejects(
        productImage.loadProductImage(synced, { fetchImpl: async () => response(Buffer.alloc(2048, 0xff)), maxBytes: 1024 }),
        /trop volumineux/
      );
      assert.strictEqual(calls, 0);
    });
  } finally {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
  console.log(`${passed} test(s) règles catalogue (V6.46) OK`);
})().catch(error => {
  console.error(error);
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  process.exit(1);
});
