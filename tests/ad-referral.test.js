// Tests de l'allègement adReferral (lib/ad-referral.js).
const assert = require('assert');
const { slimAdReferral, slimConversationState } = require('../lib/ad-referral');

let passed = 0;
function test(label, fn) { fn(); passed++; console.log('PASS', label); }

test('raw retiré, champs utiles conservés', () => {
  const slim = slimAdReferral({ headline: 'Salon', body: 'Texte', productHint: 'Salon Opale', raw: { big: 'x' }, mediaUrl: 'https://meta/x' });
  assert.deepStrictEqual(slim, { headline: 'Salon', body: 'Texte', productHint: 'Salon Opale', mediaUrl: 'https://meta/x' });
});

test('mediaUrl retiré seulement si l’image est copiée localement', () => {
  const slim = slimAdReferral({ mediaUrl: 'https://meta/x', storedMediaUrl: '/admin/conversation-media/a.jpg' });
  assert.deepStrictEqual(slim, { storedMediaUrl: '/admin/conversation-media/a.jpg' });
});

test('même objet renvoyé quand il n’y a rien à alléger (pas de copie inutile)', () => {
  const ad = { headline: 'Salon', mediaUrl: 'https://meta/x' };
  assert.strictEqual(slimAdReferral(ad), ad);
  const state = { adReferral: ad, lastCustomerAt: 'x' };
  assert.strictEqual(slimConversationState(state), state);
});

test('nouvel objet d’état si allègement (détection des changements par référence)', () => {
  const state = { adReferral: { raw: {}, headline: 'Salon' }, unreadCount: 2 };
  const slim = slimConversationState(state);
  assert.notStrictEqual(slim, state);
  assert.deepStrictEqual(slim, { adReferral: { headline: 'Salon' }, unreadCount: 2 });
  assert.ok('raw' in state.adReferral, 'l’objet d’origine n’est pas modifié');
});

test('valeurs absentes ou invalides inchangées', () => {
  assert.strictEqual(slimAdReferral(null), null);
  assert.strictEqual(slimConversationState(undefined), undefined);
  const noAd = { unreadCount: 0 };
  assert.strictEqual(slimConversationState(noAd), noAd);
});

console.log(`ALL ${passed} AD REFERRAL TESTS PASSED`);
