// Tests V6.45 — résolution déterministe du produit (lib/product-resolver.js)
// sur des fiches réelles du catalogue mondeco.tn (tests/fixtures), dont le
// cas réel « Chambre à coucher Bianca » et un produit local « Lit Bianca +
// 2 chevets » à 2800 dt.
const assert = require('assert');
const {
  foldArabic,
  normalizeText,
  tokenize,
  buildProductIndex,
  resolveProduct,
  cleanAdProductHint,
  displayProductName,
  unknownModelWords
} = require('../lib/product-resolver');

const products = require('./fixtures/ai-catalog-bianca.json');
const index = buildProductIndex(products);
const byWoo = id => products.find(product => product.woocommerceId === id);
const BIANCA = byWoo(60068);
const AD_BODY = '💍 قرب عرسك ومازلت تلوج على بيت نوم أنيق وعصري؟ 😍 ✨ اكتشف Chambre Bianca من MONDECO: تصميم عصري وتفاصيل راقية. 🚚 التوصيل و التركيب في كامل الجمهورية. 📲 ابعثلنا BIANCA على WhatsApp باش تعرف السعر والتفاصيل.';
const AD_BODY_NO_MODEL = 'ومازلت تلوج على بيت نوم أنيق وعصري؟ ✨ اكتشف';

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}

function resolvedId(result) {
  return result.status === 'resolved' ? (result.product.woocommerceId || result.product.id) : result.status;
}

test('pliage arabe avant NFD : la hamza ne coupe plus le mot', () => {
  assert.strictEqual(foldArabic('أنيق'), 'انيق');
  assert.strictEqual(normalizeText('أنيق'), 'انيق');
  assert.strictEqual(normalizeText('رائعة'), 'رايعه');
  assert.ok(normalizeText('بقداش بيت النوم').includes('chambre coucher'));
});

test('titre de pub découpé sur « | », « — » et « · »', () => {
  assert.strictEqual(cleanAdProductHint('Chambre à coucher Bianca · Chambre complète'), 'Chambre à coucher Bianca');
  assert.strictEqual(cleanAdProductHint('Table Opale | Image 01 | Test | Broad | WhatsApp'), 'Table Opale');
  assert.strictEqual(cleanAdProductHint('Salon Infinity — le confort qui s’adapte'), 'Salon Infinity');
});

test('pub « Chambre à coucher Bianca » + demande de prix explicite -> 60068', () => {
  const result = resolveProduct({
    adProductHint: 'Chambre à coucher Bianca',
    adHeadline: 'Chambre à coucher Bianca',
    adBody: AD_BODY,
    message: 'Bonjour, je veux le prix de la Chambre à coucher Bianca svp.'
  }, index);
  assert.strictEqual(resolvedId(result), 60068);
});

test('pub « … · Chambre complète » + « Prix » -> 60068 (pas Lit Bianca + 2 chevets)', () => {
  const result = resolveProduct({ adProductHint: 'Chambre à coucher Bianca · Chambre complète', message: 'Prix' }, index);
  assert.strictEqual(resolvedId(result), 60068);
  assert.strictEqual(result.source, 'ad');
});

test('« BIANCA » seul envoyé depuis la pub -> 60068 via la pub', () => {
  const result = resolveProduct({ adProductHint: 'Chambre à coucher Bianca · Chambre complète', message: 'BIANCA' }, index);
  assert.strictEqual(resolvedId(result), 60068);
});

test('tounsi « بقداش بيت النوم بيانكا » -> 60068', () => {
  assert.strictEqual(resolvedId(resolveProduct({ message: 'بقداش بيت النوم بيانكا' }, index)), 60068);
});

test('« prix bianca » sans pub -> ambigu (adulte, junior, pack)', () => {
  const result = resolveProduct({ message: 'prix bianca' }, index);
  assert.strictEqual(result.status, 'ambiguous');
  const ids = result.candidates.map(product => product.woocommerceId);
  for (const id of [60068, 65197, 63995]) assert.ok(ids.includes(id), `candidat ${id} absent : ${ids}`);
});

test('« Chambre Bianca junior » -> 65197, « bureau bianca junior » -> 66328, pack -> 63995', () => {
  assert.strictEqual(resolvedId(resolveProduct({ message: 'Chambre Bianca junior' }, index)), 65197);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'bureau bianca junior' }, index)), 66328);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'pack mariage bianca combien' }, index)), 63995);
});

test('« lit bianca » -> produit local Lit Bianca + 2 chevets (type différent)', () => {
  assert.strictEqual(resolvedId(resolveProduct({ message: 'prix lit bianca' }, index)), 'local-lit-bianca');
});

test('fiche manuelle « Chambre Bianca » 2800 : la fiche du site l’emporte', () => {
  const withManual = buildProductIndex([...products, { id: 'manual-bianca', name: 'Chambre Bianca', price: '2800', composition: 'Lit + 2 tables de nuit', active: true }]);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'prix chambre bianca' }, withManual)), 60068);
  assert.strictEqual(resolvedId(resolveProduct({ adProductHint: 'Chambre Bianca | Reel 20s', message: 'Prix' }, withManual)), 60068);
});

test('V6.46 — doublon certain ignoré même quand la fiche du site est masquée dans l’Admin', () => {
  const hidden = products.map(product => (Number(product.woocommerceId) === 60068 ? { ...product, active: false, hiddenByAdmin: true } : product));
  const index = buildProductIndex([...hidden, { id: 'manual-bianca', name: 'Chambre Bianca', price: '2800', duplicateOfWooId: 60068, duplicateConfidence: 'high', active: true }]);
  const resolution = resolveProduct({ message: 'prix chambre bianca' }, index);
  assert.ok(!resolution.product || resolution.product.id !== 'manual-bianca', 'jamais l’ancienne copie à 2800 DT');
  assert.ok(!(resolution.candidates || []).some(candidate => candidate.id === 'manual-bianca'));
});

test('doublon local marqué duplicateOfWooId ignoré', () => {
  const withDuplicate = buildProductIndex([...products, { id: 'dup', name: 'Chambre à coucher Bianca', price: '2800', duplicateOfWooId: 60068, active: true }]);
  const result = resolveProduct({ message: 'chambre à coucher bianca' }, withDuplicate);
  assert.strictEqual(resolvedId(result), 60068);
});

test('pub générique + texte arabe sans modèle + « Prix » -> aucun produit', () => {
  const result = resolveProduct({ adProductHint: 'Mondeco.tn', adHeadline: 'Mondeco.tn', adBody: AD_BODY_NO_MODEL, adHeadlineGeneric: true, message: 'Prix' }, index);
  assert.strictEqual(result.status, 'none');
});

test('pub générique dont le texte cite Chambre Bianca -> 60068', () => {
  const result = resolveProduct({ adProductHint: '', adHeadline: 'Mondeco.tn', adBody: AD_BODY, adHeadlineGeneric: true, message: 'Prix' }, index);
  assert.strictEqual(resolvedId(result), 60068);
});

test('produit absent du catalogue (Table Opale, Zorglub) -> aucun produit', () => {
  assert.strictEqual(resolveProduct({ adProductHint: 'Table Opale', message: 'Prix' }, index).status, 'none');
  assert.strictEqual(resolveProduct({ message: 'Combien coûte le canapé modèle Zorglub 3000 ?' }, index).status, 'none');
  assert.deepStrictEqual(unknownModelWords('Combien coûte le canapé modèle Zorglub 3000 ?', index), ['zorglub']);
});

test('mots courants jamais pris pour un modèle', () => {
  for (const message of ['au bout de combien de temps la livraison ?', 'c’est cher', 'garantie combien d’ans ?', 'Bonjour ! Puis-je obtenir plus d’informations à ce sujet ?', 'chambre pour les mariés']) {
    assert.strictEqual(resolveProduct({ message }, index).status, 'none', message);
  }
});

test('arabe : ديانا trouve Diana (pas Dina), أوبرا trouve Opera, صالة دنيا trouve Donia', () => {
  assert.ok(/diana/i.test(resolveProduct({ message: 'بقداش صالون ديانا' }, index).product?.name || ''));
  assert.ok(/opera/i.test(resolveProduct({ message: 'بقداش شومبر أوبرا' }, index).product?.name || ''));
  assert.ok(/donia/i.test(resolveProduct({ message: 'بقداش صالة دنيا' }, index).product?.name || ''));
});

test('suivi court : produit actif réutilisé, « et le pouf ? » demande lequel', () => {
  assert.strictEqual(resolvedId(resolveProduct({ activeProductId: BIANCA.id, message: 'prix ?' }, index)), 60068);
  assert.strictEqual(resolvedId(resolveProduct({ activeProductId: BIANCA.id, message: 'la table de nuit ?' }, index)), 60068);
  const pouf = resolveProduct({ activeProductId: BIANCA.id, message: 'et le pouf ?' }, index);
  assert.strictEqual(pouf.status, 'ambiguous');
  assert.deepStrictEqual(pouf.candidates.map(product => product.woocommerceId), [60068, 61304]);
});

test('réponse à une question de choix : ordinal ou type', () => {
  const pending = [byWoo(63995).id, BIANCA.id, byWoo(65197).id];
  assert.strictEqual(resolvedId(resolveProduct({ pendingCandidateIds: pending, message: 'la deuxième' }, index)), 60068);
  assert.strictEqual(resolvedId(resolveProduct({ pendingCandidateIds: pending, message: 'la chambre à coucher' }, index)), 60068);
  assert.strictEqual(resolvedId(resolveProduct({ pendingCandidateIds: pending, message: 'enfant' }, index)), 65197);
});

test('historique client : « prix ? » après « chambre à coucher bianca »', () => {
  const result = resolveProduct({ message: 'prix ?', recentCustomerTexts: ['Bonjour', 'je veux la chambre à coucher bianca'] }, index);
  assert.strictEqual(resolvedId(result), 60068);
  assert.strictEqual(result.source, 'history');
});

test('« Oui » / « Prix » après « Vous parlez de la Chambre à coucher Bianca ? »', () => {
  const result = resolveProduct({ message: 'Oui', lastAssistantText: 'Vous parlez de la Chambre à coucher Bianca ?' }, index);
  assert.strictEqual(resolvedId(result), 60068);
  assert.strictEqual(resolveProduct({ message: 'Oui', lastAssistantText: 'Lequel : Pack Mariage Bianca ou Chambre Enfant Bianca Junior ?' }, index).status, 'none');
});

test('nom d’affichage sans le suffixe SEO', () => {
  assert.strictEqual(displayProductName(byWoo(65197)), 'Chambre Enfant Bianca Junior');
  assert.strictEqual(displayProductName(byWoo(66322)), 'Coiffeuse Murale avec Miroir LED Rond – Bianca Junior');
  assert.ok(tokenize('Chambres à coucher').includes('chambre'));
});

// V6.45 — Retours de revue (catalogue réel synchronisé).
const LARA = [
  { id: 'lara-1', woocommerceId: 9101, syncSource: 'woocommerce', name: 'Salon modulaire Lara', price: '2690', active: true },
  { id: 'lara-2', woocommerceId: 9102, syncSource: 'woocommerce', name: 'Salon Lara avec canapé', price: '4390', active: true },
  { id: 'lara-3', woocommerceId: 9103, syncSource: 'woocommerce', name: 'Salon modulaire Lara avec pouf', price: '3290', active: true },
  { id: 'lara-4', woocommerceId: 9104, syncSource: 'woocommerce', name: 'Canapé Modulable Lara sans pouf', price: '2190', active: true },
  { id: 'lara-5', woocommerceId: 9105, syncSource: 'woocommerce', name: 'Pouf pour salon Lara', price: '350', active: true }
];

test('« salon modulaire Lara » -> ce produit, jamais « Salon Lara avec canapé » (salon ≠ salon + canapé)', () => {
  const laraIndex = buildProductIndex([...products, ...LARA]);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'Bonjour, quel est le prix du salon modulaire Lara ?' }, laraIndex)), 9101);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'prix salon lara avec canapé' }, laraIndex)), 9102);
  // Plusieurs salons Lara : on demande lequel au lieu de choisir le plus long.
  const vague = resolveProduct({ message: 'prix salon lara' }, laraIndex);
  assert.strictEqual(vague.status, 'ambiguous');
  assert.ok(!vague.candidates.some(product => product.woocommerceId === 9105), vague.candidateNames.join(' | '));
  const canape = resolveProduct({ message: 'prix canapé lara' }, laraIndex);
  assert.strictEqual(canape.status, 'ambiguous');
  assert.strictEqual(canape.candidates[0].woocommerceId, 9104);
});

test('vrais noms de modèles pris pour des descriptifs (Golden, Royal, Lune, INDUS) : produit identifiable', () => {
  const catalog = [
    ...products,
    { id: 'golden', woocommerceId: 9201, syncSource: 'woocommerce', name: 'Pack Mariage Golden', price: '8630', promoPrice: '8330', active: true },
    { id: 'royal', woocommerceId: 9202, syncSource: 'woocommerce', name: 'Salon Royal | Déstockage', price: '1990', active: true },
    { id: 'lune', woocommerceId: 9203, syncSource: 'woocommerce', name: 'Table LUNE', price: '690', active: true },
    { id: 'indus', woocommerceId: 9204, syncSource: 'woocommerce', name: 'Etagère Métallique – INDUS', price: '320', active: true },
    { id: 'blanche', woocommerceId: 9205, syncSource: 'woocommerce', name: 'Table de bout de canapé Blanche', price: '150', active: true }
  ];
  const fallbackIndex = buildProductIndex(catalog);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'prix pack mariage golden' }, fallbackIndex)), 9201);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'Bonjour, combien ?', adProductHint: 'Salon Royal | Déstockage' }, fallbackIndex)), 9202);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'la table lune svp' }, fallbackIndex)), 9203);
  assert.strictEqual(resolvedId(resolveProduct({ message: 'etagere indus prix' }, fallbackIndex)), 9204);
  // Une couleur ne devient jamais un nom de modèle.
  assert.strictEqual(resolveProduct({ message: 'vous avez une table blanche ?' }, fallbackIndex).status, 'none');
});

test('doublon « possible » (Lit Bianca + 2 chevets) gardé : la pub du lit trouve le lit, la pub Bianca la chambre', () => {
  const synced = products.map(product => product.id === 'local-lit-bianca'
    ? { ...product, duplicateOfWooId: 60068, duplicateConfidence: 'possible' }
    : product);
  const syncedIndex = buildProductIndex(synced);
  const lit = resolveProduct({ message: 'prix?', adProductHint: 'Lit BIANCA + 2 Chevets', adHeadline: 'Lit BIANCA + 2 Chevets | MONDECO' }, syncedIndex);
  assert.strictEqual(resolvedId(lit), 'local-lit-bianca');
  assert.strictEqual(resolvedId(resolveProduct({ message: 'prix?', adProductHint: 'Chambre à coucher Bianca' }, syncedIndex)), 60068);
  // Doublon certain : toujours ignoré.
  const certain = buildProductIndex(products.map(product => product.id === 'local-lit-bianca'
    ? { ...product, duplicateOfWooId: 60068, duplicateConfidence: 'high' }
    : product));
  assert.notStrictEqual(resolvedId(resolveProduct({ message: 'prix lit bianca' }, certain)), 'local-lit-bianca');
});

test('choix après la question : « le 2ème », « la 2 », « 2e », « التانية »', () => {
  const pending = [byWoo(63995).id, BIANCA.id, byWoo(65197).id];
  for (const message of ['le 2ème', 'la 2', 'la 2ème', '2e', 'التانية', 'c’est la 2']) {
    assert.strictEqual(resolvedId(resolveProduct({ pendingCandidateIds: pending, message }, index)), 60068, message);
  }
  assert.strictEqual(resolvedId(resolveProduct({ pendingCandidateIds: pending, message: 'le 1er' }, index)), 63995);
  assert.strictEqual(resolvedId(resolveProduct({ pendingCandidateIds: pending, message: 'la 3ème' }, index)), 65197);
});

console.log(`\n${passed} test(s) product-resolver OK`);
