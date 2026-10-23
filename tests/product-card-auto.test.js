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
