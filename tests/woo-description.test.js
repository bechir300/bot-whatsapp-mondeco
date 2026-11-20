// V6.45 — Tests du décodage des fiches WooCommerce (lib/woo-description.js)
// et des règles catalogue (lib/woo-catalog.js) sur de vrais produits du site
// (format REST v3, tests/fixtures/woo-v3-bianca-and-collisions.json).
// Aucune donnée réelle n'est touchée : catalog-feed.js et product-named.js
// sont testés avec un DATA_DIR temporaire.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-woo-desc-'));
process.env.DATA_DIR = tmpDataDir;

const desc = require('../lib/woo-description');
const catalog = require('../lib/woo-catalog');
const fixtures = require('./fixtures/woo-v3-bianca-and-collisions.json');

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}
const byId = id => fixtures.find(item => item.id === id);

try {
  test('[vc_raw_html] base64 + URL décodé : composition exacte de la Chambre à Coucher Bianca', () => {
    const content = desc.parseWooProductContent(byId(60068));
    assert.strictEqual(
      content.composition,
      '1 lit + 1 dressing + 1 coiffeuse + 2 tables de nuit + 1 pouf de lit'
    );
    assert.strictEqual(content.specs.Dressing, 'L260 × P63 × H220 cm');
    assert.strictEqual(content.specs['Tables de nuit'], '2 unités — L55 × P42 × H48 cm chacune');
    assert.ok(content.dimensions.startsWith('Dressing : L260 × P63 × H220 cm ; Tables de nuit :'), content.dimensions);
    assert.ok(!/Composition/.test(content.dimensions));
  });

  test('aucune trace de shortcode ni de base64 dans les descriptions, longueur plafonnée', () => {
    for (const product of fixtures) {
      const content = desc.parseWooProductContent(product);
      assert.ok(!/\[\/?vc_/.test(content.description), `${product.id} garde un shortcode`);
      assert.ok(!/[A-Za-z0-9+/]{60,}/.test(content.description), `${product.id} garde du base64`);
      assert.ok(content.description.length <= 1202, `${product.id} : ${content.description.length}`);
      assert.ok(!/\[\/?vc_/.test(desc.htmlToText(desc.expandWooDescriptionHtml(product.description))));
    }
    // Pouf sans description courte : la description longue décodée est reprise.
    assert.ok(desc.parseWooProductContent(byId(61304)).description.length > 50);
  });

  test('fiche « pack » : la composition d’un seul élément n’est pas prise pour celle du pack', () => {
    const content = desc.parseWooProductContent(byId(63995));
    assert.strictEqual(content.composition, '');
    assert.ok(/Salon Diana — Dimensions : 350 × 220 cm/.test(content.dimensions), content.dimensions);
    assert.ok(/Table Ibiza — Composition : 1 table \+ 6 chaises/.test(desc.otherSpecsText(content.specs, 2000)));
  });

  // V6.45 — Fiches réelles « Pack Mariage Perla » et « Golden » : la seule
  // ligne « Composition » est celle du salon (Perla) ou de la table (Golden).
  const specRows = rows => rows
    .map(([label, value]) => `<div class="mondeco-spec-row"><span class="mondeco-spec-label">${label}</span><span class="mondeco-spec-value">${value}</span></div>`)
    .join('');
  test('pack mariage : jamais la composition d’un seul ensemble (Perla, Golden, Marbelle)', () => {
    const perla = desc.parseWooProductContent({
      name: 'Pack Mariage Perla',
      categories: [{ name: 'Pack Mariage' }],
      description: specRows([
        ['Modèle', 'Ivorie Premium'], ['Lit', '160 × 200 cm'], ['Dressing', 'L 243 × P 60 × H 215 cm'],
        ['Tables de nuit', '2 tables – L 49 × P 36 × H 48 cm'], ['Coiffeuse', 'Incluse'],
        ['Composition', '1 canapé 3 places + 1 canapé 2 places + 1 pouf'], ['Canapé 3 places', 'L 220 × P 93 cm']
      ])
    });
    assert.strictEqual(perla.composition, '');
    assert.strictEqual(perla.multiSet, true);

    const golden = desc.parseWooProductContent({
      name: 'Pack Mariage Golden',
      categories: [{ name: 'Pack Mariage' }],
      description: specRows([
        ['Modèle', 'Salma'], ['Lit', '160 × 200 cm'], ['Composition', '1 table + 6 chaises'],
        ['Chambre', 'Salma – Lit 160 × 200 cm, dressing, coiffeuse et 2 tables de nuit'],
        ['Salon', 'Plume L – Canapé d’angle 320 × 200 cm'],
        ['Salle à manger', 'Violette – Table de 160 × 90 cm et 6 chaises']
      ])
    });
    assert.strictEqual(
      golden.composition,
      'Chambre : Salma – Lit 160 × 200 cm, dressing, coiffeuse et 2 tables de nuit ; Salon : Plume L – Canapé d’angle 320 × 200 cm ; Salle à manger : Violette – Table de 160 × 90 cm et 6 chaises'
    );

    // Libellé « Composition de la chambre Toscana — Modèle » : pas une composition.
    assert.strictEqual(desc.compositionFromSpecs({
      'Composition de la chambre Toscana — Modèle': 'Toscana',
      'Composition du salon Jazz — Modèle': 'Jazz',
      'Composition de la salle à manger Azur — Composition': '1 table et 6 chaises'
    }), '');
    // Une ligne « Composition » par ensemble : composition du pack complète.
    assert.strictEqual(desc.compositionFromSpecs({
      'Chambre Silia — Composition': '1 lit + 1 dressing',
      'Salon Marita — Composition': 'Canapé d’angle + canapé 2 places',
      'Salon Marita — Mousse': 'Magic 35'
    }), 'Chambre Silia : 1 lit + 1 dressing ; Salon Marita : Canapé d’angle + canapé 2 places');
    // Fiche simple : inchangé.
    assert.strictEqual(desc.compositionFromSpecs({ Modèle: 'Bianca', Composition: '1 lit + 2 chevets' }), '1 lit + 2 chevets');
  });

  test('entités HTML décodées (noms, catégories), prix jamais repris des caractéristiques', () => {
    assert.strictEqual(desc.decodeHtmlEntities('Lit 90&#215;190 &#038; co &#8211; Blanc &amp; Beige&nbsp;!'), 'Lit 90×190 & co – Blanc & Beige !');
    assert.strictEqual(desc.cleanInlineText(' Salons &amp;  <b>Séjours</b> '), 'Salons & Séjours');
    assert.strictEqual(desc.decodeHtmlEntities('&unknown; &#xZZ;'), '&unknown; &#xZZ;');
    const specs = desc.extractSpecsFromHtml(
      '<table><tr><td>Prix</td><td>2800 DT</td></tr><tr><td>Matière</td><td>Bois</td></tr>' +
      '<tr><td>Disponibilité</td><td>En stock</td></tr></table>'
    );
    assert.deepStrictEqual(specs, { 'Matière': 'Bois' });
  });

  test('bloc [vc_raw_html] coupé par WordPress (<p>, &#61;) ou invalide', () => {
    const html = '<div class="mondeco-spec-row"><span class="mondeco-spec-label">Composition</span><span class="mondeco-spec-value">1 lit + 2 chevets</span></div>';
    const b64 = Buffer.from(encodeURIComponent(html)).toString('base64');
    const cut = `${b64.slice(0, 20)}<br />\n${b64.slice(20).replace(/=/g, '&#61;')}`;
    const description = `<p>[vc_row][vc_column][vc_raw_html]${cut}[/vc_raw_html][/vc_column][/vc_row]</p>`;
    assert.strictEqual(desc.parseWooProductContent({ description }).composition, '1 lit + 2 chevets');
    assert.strictEqual(desc.decodeVcRawHtml('[vc_raw_html]@@@ pas du base64 @@@[/vc_raw_html]'), '');
    assert.strictEqual(desc.htmlToText('[vc_raw_html]!!![/vc_raw_html]Texte'), 'Texte');
  });

  test('variations : prix « à partir de », promotions par variante', () => {
    const nuage = catalog.mapWooVariations([
      { id: 69256, status: 'publish', price: '690', regular_price: '690', sale_price: '', on_sale: false, stock_status: 'instock', attributes: [{ id: 5, name: 'Largeur Lit', option: '120 cm' }] },
      { id: 69257, status: 'publish', price: '590', regular_price: '590', sale_price: '', on_sale: false, stock_status: 'instock', attributes: [{ id: 5, name: 'Largeur Lit', option: '90 cm' }] },
      { id: 69258, status: 'private', price: '10', regular_price: '10', attributes: [] }
    ]);
    assert.deepStrictEqual(nuage.map(item => [item.label, item.price]), [['90 cm', '590'], ['120 cm', '690']]);
    const summary = catalog.summarizeVariationPrices(nuage);
    assert.deepStrictEqual(
      { from: summary.priceFrom, to: summary.priceTo, uniform: summary.uniform, price: summary.price, promo: summary.promoPrice },
      { from: '590', to: '690', uniform: false, price: '590', promo: '' }
    );
    const lines = catalog.variationContextLines({ variations: nuage });
    assert.strictEqual(lines.priceLines[0], "Prix : à partir de 590 TND (jusqu'à 690 TND selon la variante)");
    assert.strictEqual(lines.priceLines[1], 'Prix par variante (Largeur Lit) : 90 cm : 590 TND ; 120 cm : 690 TND');

    const salma = catalog.mapWooVariations([
      { id: 61294, price: '2570', regular_price: '3060', sale_price: '2570', on_sale: true, stock_status: 'instock', attributes: [{ name: 'couleur', option: 'BLEU' }] },
      { id: 61295, price: '3060', regular_price: '3060', sale_price: '', on_sale: false, stock_status: 'outofstock', attributes: [{ name: 'couleur', option: 'ROSE' }] }
    ]);
    const salmaLines = catalog.variationContextLines({ variations: salma });
    assert.ok(salmaLines.priceLines[1].includes('BLEU : 2570 TND en promotion au lieu de 3060 TND'), salmaLines.priceLines[1]);
    assert.ok(salmaLines.priceLines[1].includes('ROSE : 3060 TND (rupture)'));
    const salmaSummary = catalog.summarizeVariationPrices(salma);
    assert.strictEqual(salmaSummary.price, '3060');
    assert.strictEqual(salmaSummary.promoPrice, '2570');

    // Même prix partout : pas de « à partir de », les lignes habituelles restent valables.
    const same = catalog.mapWooVariations([
      { id: 1, price: '900', regular_price: '1000', sale_price: '900', on_sale: true, attributes: [{ name: 'couleur', option: 'Gris' }] },
      { id: 2, price: '900', regular_price: '1000', sale_price: '900', on_sale: true, attributes: [{ name: 'couleur', option: 'Beige' }] }
    ]);
    const sameLines = catalog.variationContextLines({ variations: same });
    assert.strictEqual(sameLines.priceLines, null);
    assert.ok(/Variantes \(couleur\) : .*Beige.*Gris.* même prix/.test(sameLines.detailLines[0]), sameLines.detailLines[0]);
    // Promotion programmée (pas encore active) : pas de prix promo.
    const scheduled = catalog.mapWooVariation({ id: 3, price: '1000', regular_price: '1000', sale_price: '800', on_sale: false, attributes: [] });
    assert.strictEqual(scheduled.onSale, false);
    assert.strictEqual(scheduled.price, '1000');
  });

  test('noms : le « + » est significatif, les entités sont décodées', () => {
    assert.notStrictEqual(catalog.foldProductName('Salon Baya'), catalog.foldProductName('Salon Baya+'));
    assert.strictEqual(catalog.foldProductName('Lit 90&#215;190 Élégance'), 'lit 90 x 190 elegance');
  });

  test('corrections volontaires : enregistrées sur une fiche du site, jamais sur un prix', () => {
    const before = { id: 'p', syncSource: 'woocommerce', composition: 'A', price: '100', description: 'site' };
    const after = { ...before, composition: 'B', price: '90' };
    const recorded = catalog.recordProductOverrides(before, after, { by: 'Sami', at: '2026-11-11T10:00:00Z', source: 'admin' });
    assert.deepStrictEqual(Object.keys(recorded.overrides), ['composition']);
    assert.deepStrictEqual(recorded.overrides.composition, { value: 'B', by: 'Sami', at: '2026-11-11T10:00:00Z', source: 'admin' });
    // Champ vidé : la correction est retirée.
    const cleared = catalog.recordProductOverrides(recorded, { ...recorded, composition: '' }, {});
    assert.strictEqual(cleared.overrides, undefined);
    // Fiche manuelle : rien n'est enregistré.
    const manual = { id: 'm', composition: 'A' };
    assert.strictEqual(catalog.recordProductOverrides(manual, { ...manual, composition: 'B' }, {}).overrides, undefined);
    // Espaces seuls : pas une modification.
    assert.strictEqual(catalog.recordProductOverrides(before, { ...before, description: ' site ' }, {}).overrides, undefined);
  });

  test('doublons manuels : « Chambre Bianca » et « Lit Bianca + 2 chevets » → Chambre à Coucher Bianca', () => {
    const woo = fixtures.map(item => ({
      id: `w${item.id}`,
      name: desc.cleanInlineText(item.name),
      woocommerceId: item.id,
      syncSource: 'woocommerce',
      active: true
    }));
    const manual = [
      { id: 'm1', name: 'Chambre Bianca', active: true },
      { id: 'm2', name: 'Lit Bianca + 2 chevets', active: true },
      { id: 'm3', name: 'Table Opale', active: true },
      { id: 'm4', name: 'Salon Baya', active: true },
      { id: 'm5', name: 'Chambre Bianca Junior', active: true },
      { id: 'm6', name: 'Chambre Bianca', active: true, notDuplicateOfWoo: true },
      { id: 'm7', name: 'Chambre Bianca', active: false },
      { id: 'm8', name: 'Salon moderne', active: true }
    ];
    const found = catalog.findManualDuplicates(manual, woo);
    const target = id => found.get(manual.find(item => item.id === id))?.wooId || null;
    assert.strictEqual(target('m1'), 60068);
    assert.strictEqual(target('m2'), 60068);
    assert.strictEqual(target('m3'), null);
    assert.strictEqual(target('m4'), 52452);
    assert.strictEqual(target('m5'), 65197);
    assert.strictEqual(target('m6'), null);
    assert.strictEqual(target('m7'), null);
    assert.strictEqual(target('m8'), null);
    // Doublon certain (même type, même public) ou seulement possible.
    assert.strictEqual(found.get(manual[0]).confidence, 'high');
    assert.strictEqual(found.get(manual[1]).confidence, 'possible');
  });

  test('V6.46 — fiche du site masquée / supprimée dans l’Admin mais publiée : l’ancienne fiche manuelle reste un doublon', () => {
    const woo = [
      { id: 'w1', name: 'Chambre à Coucher Bianca', woocommerceId: 60068, syncSource: 'woocommerce', active: false, hiddenByAdmin: true, woocommerceStatus: 'publish' },
      { id: 'w2', name: 'Salon Baya', woocommerceId: 52452, syncSource: 'woocommerce', active: false, woocommerceStatus: 'draft' },
      { id: 'w3', name: 'Table Opale', woocommerceId: 7, syncSource: 'woocommerce', active: false, hiddenByAdmin: true, woocommerceStatus: 'publish', wooMissingAt: '2026-11-01T00:00:00Z' }
    ];
    const manual = [
      { id: 'm1', name: 'Chambre Bianca', active: true },
      { id: 'm2', name: 'Salon Baya', active: true },
      { id: 'm3', name: 'Table Opale', active: true }
    ];
    const found = catalog.findManualDuplicates(manual, woo);
    assert.strictEqual(found.get(manual[0])?.wooId, 60068, 'Bianca masquée dans l’Admin, encore en vente sur le site');
    assert.strictEqual(found.get(manual[1]), undefined, 'brouillon du site : plus une cible');
    assert.strictEqual(found.get(manual[2]), undefined, 'retirée du site : plus une cible');
  });

  test('doublons manuels : tailles ou quantités différentes = produits différents', () => {
    const woo = [
      { id: 'a', name: 'Matelas Royal Confortex 160×190 cm', woocommerceId: 1, syncSource: 'woocommerce' },
      { id: 'b', name: 'Matelas Royal Confortex 160×200 cm', woocommerceId: 2, syncSource: 'woocommerce' },
      { id: 'c', name: 'Table à Manger Ibiza avec 8 Chaises', woocommerceId: 3, syncSource: 'woocommerce' }
    ];
    const manual = [
      { id: 'm1', name: 'Matelas Royal 160x200' },
      { id: 'm2', name: 'Matelas Royal 140x190' },
      { id: 'm3', name: 'Table Ibiza 6 chaises' },
      { id: 'm4', name: 'Table Ibiza 8 chaises' }
    ];
    const found = catalog.findManualDuplicates(manual, woo);
    assert.strictEqual(found.get(manual[0])?.wooId, 2);
    assert.strictEqual(found.get(manual[1]), undefined);
    assert.strictEqual(found.get(manual[2]), undefined);
    assert.strictEqual(found.get(manual[3])?.wooId, 3);
  });

  test('product-named.js et catalog-feed.js lisent products.json dans DATA_DIR', () => {
    fs.writeFileSync(path.join(tmpDataDir, 'products.json'), JSON.stringify([
      { id: 'w1', name: 'Chambre à Coucher Bianca', price: '7200', promoPrice: '6590', active: true, image: 'https://mondeco.tn/a.jpg', woocommerceId: 60068, syncSource: 'woocommerce' },
      { id: 'm1', name: 'Chambre Bianca', price: '2800', active: true, image: 'https://mondeco.tn/b.jpg', duplicateOfWooId: 60068 },
      { id: 'w2', name: 'Etagère Métallique &#8211; INDUS', price: '450', active: true, image: 'https://mondeco.tn/c.jpg' }
    ]));
    const named = require('../product-named');
    assert.ok(named.modelWords().has('bianca'), 'mot modèle lu depuis DATA_DIR');
    const feed = require('../catalog-feed').buildFeed();
    // V6.46 — identifiant WooCommerce (celui du pixel du site), plus l'UUID local.
    assert.ok(feed.includes('"60068"'));
    assert.ok(!feed.includes('"w1"'));
    assert.ok(!feed.includes('"m1"'), 'doublon manuel exclu du flux Meta');
    assert.ok(feed.includes('Etagère Métallique – INDUS'));
  });
} finally {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
}

console.log(`${passed} test(s) descriptions WooCommerce OK`);
