// Tests de la fiche produit envoyée par l'IA (lib/product-card-auto.js).
const assert = require('assert');
const {
  findProductForCard,
  productCardAllowed,
  recordProductCard,
  imageMimeFromBuffer,
  MAX_CARDS_PER_DAY
} = require('../lib/product-card-auto');

let passed = 0;
function test(label, fn) { fn(); passed++; console.log('PASS', label); }

const products = [
  { id: 'p1', name: 'Salon Fiorie', price: '3290', promoPrice: '2790' },
  { id: 'p2', name: 'Salon Fiorie XL', price: '3990' },
  { id: 'p3', name: 'Table Opale', price: '890' },
  { id: 'p4', name: 'Chambre Zina', price: '' },
  { id: 'p5', name: 'Bureau Nova', price: '450', active: false },
  { id: 'p6', name: 'Lit', price: '300' }
];

test('un seul produit cité, accents et casse ignorés', () => {
  assert.strictEqual(findProductForCard('La table opale est à 890 DT.', products).id, 'p3');
  assert.strictEqual(findProductForCard('Le SALON FIORIE est disponible', products).id, 'p1');
});

test('nom inclus dans un nom plus long : le plus précis est retenu', () => {
  assert.strictEqual(findProductForCard('Le Salon Fiorie XL mesure 320 cm', products).id, 'p2');
});

test('aucune fiche si plusieurs produits, sans prix, inactif, nom trop court ou transfert', () => {
  assert.strictEqual(findProductForCard('Salon Fiorie ou Table Opale ?', products), null);
  assert.strictEqual(findProductForCard('La Chambre Zina existe en rose', products), null);
  assert.strictEqual(findProductForCard('Le Bureau Nova est à 450 DT', products), null);
  assert.strictEqual(findProductForCard('Ce lit est confortable', products), null);
  assert.strictEqual(findProductForCard('[COMMERCIAL_REQUIRED]', products), null);
  assert.strictEqual(findProductForCard('Bonjour !', products), null);
});

test('V6.46 — fiche du produit identifié pour ce tour, jamais d’un doublon, de Baya au lieu de Baya+, ni après une question de choix', () => {
  const catalog = [
    { id: 'woo-60068', name: 'Chambre à Coucher Bianca', price: '7200', promoPrice: '6590', woocommerceId: 60068 },
    { id: 'manual-bianca', name: 'Chambre Bianca', price: '2800', duplicateOfWooId: 60068, duplicateConfidence: 'high' },
    { id: 'baya-plus', name: 'Salon Baya+', price: '2800' },
    { id: 'baya', name: 'Salon Baya', price: '2200' },
    { id: 'baya-gm', name: 'Salon Baya GM', price: '3200' },
    { id: 'twin-1', name: 'Table Opale', price: '890' },
    { id: 'twin-2', name: 'Table Opale', price: '990' }
  ];
  const bianca = catalog[0];
  const reply = 'La Chambre Bianca est à 6590 DT au lieu de 7200 DT (promotion en cours). Voir mondeco.tn';
  assert.strictEqual(findProductForCard(reply, catalog), null, 'doublon certain jamais choisi par son nom');
  assert.strictEqual(findProductForCard(reply, catalog, { kind: 'ai', product: bianca })?.id, 'woo-60068');
  assert.strictEqual(findProductForCard('Le Salon Baya+ est à 2800 DT', catalog)?.id, 'baya-plus');
  assert.strictEqual(findProductForCard('Le Salon Baya est à 2200 DT', catalog)?.id, 'baya');
  const question = 'Lequel vous intéresse ? • Salon Baya+ : 2800 dt • Salon Baya : 2200 dt • Salon Baya GM : 3200 dt';
  assert.strictEqual(findProductForCard(question, catalog, { kind: 'disambiguation' }), null);
  assert.strictEqual(findProductForCard(question, catalog), null, 'plusieurs produits cités');
  assert.strictEqual(findProductForCard('La Table Opale est à 890 DT', catalog), null, 'deux produits au même nom');
  // Produit identifié, mais la réponse en cite nommément un autre : aucune fiche.
  assert.strictEqual(findProductForCard('Le Salon Baya GM est à 3200 DT', catalog, { kind: 'ai', product: catalog[3] }), null);
  assert.strictEqual(findProductForCard('[COMMERCIAL_REQUIRED]', catalog, { kind: 'ai', product: bianca }), null);
});

test('pas deux fois la même fiche en 24 h, maximum par jour', () => {
  const now = Date.parse('2026-10-23T10:00:00Z');
  let state = {};
  assert.strictEqual(productCardAllowed(state, 'p1', now), true);
  state = { productCards: recordProductCard(state, 'p1', now) };
  assert.strictEqual(productCardAllowed(state, 'p1', now + 3600000), false);
  assert.strictEqual(productCardAllowed(state, 'p1', now + 25 * 3600000), true);
  for (let i = 2; i <= MAX_CARDS_PER_DAY; i++) state = { productCards: recordProductCard(state, `p${i}`, now) };
  assert.strictEqual(productCardAllowed(state, 'p9', now + 1000), false);
});

test('type d’image reconnu par ses premiers octets', () => {
  assert.strictEqual(imageMimeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.strictEqual(imageMimeFromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.strictEqual(imageMimeFromBuffer(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.strictEqual(imageMimeFromBuffer(Buffer.from('pas une image')), '');
});

console.log(`${passed} test(s) fiche produit IA OK`);
