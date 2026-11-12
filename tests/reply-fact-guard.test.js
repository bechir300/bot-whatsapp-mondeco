// Tests V6.45 — garde-fou factuel des réponses IA (lib/reply-fact-guard.js).
const assert = require('assert');
const {
  parseAmountString,
  extractAmounts,
  productAllowedAmounts,
  extractFurnitureItems,
  checkReplyFacts,
  buildCatalogAnswer,
  buildDisambiguationQuestion,
  productFactsBlock,
  safeInstructionAmounts
} = require('../lib/reply-fact-guard');

const products = require('./fixtures/ai-catalog-bianca.json');
const BIANCA = products.find(product => product.woocommerceId === 60068);
const NUAGE = products.find(product => product.woocommerceId === 69255);
const BAD_REPLY = 'La Chambre à coucher Bianca (comprenant un lit et deux tables de nuit) est au prix de 2800 dt.';

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}

test('montants : séparateurs de milliers, millimes, chiffres arabes-indiens', () => {
  assert.strictEqual(parseAmountString('6 590'), 6590);
  assert.strictEqual(parseAmountString('6.590'), 6590);
  assert.strictEqual(parseAmountString('6590.000'), 6590);
  assert.strictEqual(parseAmountString('٦٥٩٠'), 6590);
  assert.deepStrictEqual(
    extractAmounts('6 590 DT au lieu de 7200 dt, ٦٥٩٠ د.ت, 12 270 TND, 990 dinars, lit 160 cm').map(item => item.value),
    [6590, 7200, 6590, 12270, 990]
  );
  assert.deepStrictEqual(extractAmounts('elle est au prix de 2800, livrée').map(item => item.value), [2800]);
  assert.deepStrictEqual(extractAmounts('lit de 160 cm, 2 places, garantie 2 ans').map(item => item.value), []);
});

test('montants autorisés : prix, promo, économie, variantes', () => {
  assert.deepStrictEqual(productAllowedAmounts(BIANCA).sort((a, b) => a - b), [610, 6590, 7200]);
  const nuage = productAllowedAmounts(NUAGE);
  assert.ok(nuage.includes(590) && nuage.includes(690));
});

test('réponse réelle « … 2800 dt » pour 60068 : rejetée (montant + composition)', () => {
  const check = checkReplyFacts(BAD_REPLY, { status: 'resolved', product: BIANCA });
  assert.strictEqual(check.ok, false);
  assert.deepStrictEqual(check.badAmounts, [2800]);
  assert.strictEqual(check.composition.ok, false);
});

test('« 6 590 DT au lieu de 7200 DT » et « ٦٥٩٠ د.ت » : acceptés', () => {
  assert.strictEqual(checkReplyFacts('La Chambre à Coucher Bianca est à 6 590 DT au lieu de 7200 DT.', { status: 'resolved', product: BIANCA }).ok, true);
  assert.strictEqual(checkReplyFacts('بيت النوم بيانكا بـ ٦٥٩٠ د.ت', { status: 'resolved', product: BIANCA }).ok, true);
});

test('aucun produit identifié : tout montant est refusé', () => {
  const check = checkReplyFacts('Le salon est à 1500 dt.', { status: 'none' });
  assert.strictEqual(check.ok, false);
  assert.deepStrictEqual(check.badAmounts, [1500]);
  assert.strictEqual(checkReplyFacts('Bonjour 😊 Quel modèle vous intéresse ?', { status: 'none' }).ok, true);
});

test('produits possibles : prix des candidats acceptés', () => {
  const pack = products.find(product => product.woocommerceId === 63995);
  const check = checkReplyFacts('Pack Mariage Bianca : 12270 dt, Chambre à Coucher Bianca : 6590 dt.', { status: 'ambiguous', candidates: [pack, BIANCA] });
  assert.strictEqual(check.ok, true);
});

test('composition : liste complète acceptée, liste partielle ou inventée refusée', () => {
  assert.deepStrictEqual(
    [...extractFurnitureItems('1 lit + 1 dressing + 1 coiffeuse + 2 tables de nuit + 1 pouf de lit')].sort(),
    [['armoire', 1], ['chevet', 2], ['coiffeuse', 1], ['lit', 1], ['pouf', 1]]
  );
  assert.strictEqual(checkReplyFacts('Elle comprend un lit, un dressing, une coiffeuse, deux tables de nuit et un pouf de lit.', { status: 'resolved', product: BIANCA }).ok, true);
  assert.strictEqual(checkReplyFacts('Elle comprend un lit et deux tables de nuit.', { status: 'resolved', product: BIANCA }).ok, false);
  assert.strictEqual(checkReplyFacts('Elle comprend un lit, une armoire et une commode.', { status: 'resolved', product: BIANCA }).ok, false);
  // Sans ligne Composition : un élément absent de la fiche est refusé.
  const noComposition = { ...BIANCA, composition: '', description: 'Tête de lit capitonnée, dressing, pouf et coiffeuse.' };
  assert.strictEqual(checkReplyFacts('Elle comprend un lit et deux tables de nuit.', { status: 'resolved', product: noComposition }).ok, false);
  assert.strictEqual(checkReplyFacts('Elle comprend un lit, un dressing, un pouf et une coiffeuse.', { status: 'resolved', product: noComposition }).ok, true);
});

test('montants des instructions : livraison oui, prix d’un meuble non', () => {
  const texts = ['Frais de livraison : 30 dt pour le Grand Tunis.', 'Chambre Bianca : lit + 2 tables de nuit, prix 2800 dt, livraison offerte.'];
  assert.deepStrictEqual(safeInstructionAmounts(texts), [30]);
  assert.strictEqual(checkReplyFacts('La livraison coûte 30 dt.', { status: 'resolved', product: BIANCA, instructionTexts: texts }).ok, true);
  assert.strictEqual(checkReplyFacts('Elle est à 2800 dt.', { status: 'resolved', product: BIANCA, instructionTexts: texts }).ok, false);
  assert.strictEqual(checkReplyFacts('Livraison : 45 dt.', { status: 'resolved', product: BIANCA, allowedAmounts: '45' }).ok, true);
});

test('réponse catalogue : nom, composition, promo + prix normal, lien', () => {
  const answer = buildCatalogAnswer(BIANCA);
  assert.ok(answer.includes('Chambre à Coucher Bianca'));
  assert.ok(answer.includes('2 tables de nuit'));
  assert.ok(/6590 dt au lieu de 7200 dt/.test(answer));
  assert.ok(answer.includes(BIANCA.productUrl));
  assert.ok(!answer.includes('2800'));
  assert.strictEqual(buildCatalogAnswer({ name: 'Sans prix' }), '');
  assert.ok(/590/.test(buildCatalogAnswer(NUAGE)) && /690/.test(buildCatalogAnswer(NUAGE)));
});

test('question de choix avec noms et prix', () => {
  const pack = products.find(product => product.woocommerceId === 63995);
  const junior = products.find(product => product.woocommerceId === 65197);
  const question = buildDisambiguationQuestion([pack, BIANCA, junior]);
  assert.ok(question.includes('Pack Mariage Bianca') && question.includes('Chambre à Coucher Bianca') && question.includes('Chambre Enfant Bianca Junior'));
  assert.ok(question.includes('6590 dt au lieu de 7200 dt'));
  assert.ok(!question.includes('Blenz'));
});

test('bloc PRODUIT ACTIF compact (description plafonnée)', () => {
  const pouf = products.find(product => product.woocommerceId === 61304);
  const block = productFactsBlock(pouf);
  assert.ok(block.length < 1200, `bloc trop long : ${block.length}`);
  assert.ok(productFactsBlock(BIANCA).includes('Prix promotionnel : 6590 TND'));
  assert.ok(productFactsBlock(BIANCA).includes('Composition : 1 lit + 1 dressing'));
  assert.ok(productFactsBlock({ ...BIANCA, composition: '' }).includes('non renseignée'));
});

console.log(`\n${passed} test(s) reply-fact-guard OK`);
