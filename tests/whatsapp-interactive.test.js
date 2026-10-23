// Tests des messages WhatsApp interactifs (lib/whatsapp-interactive.js).
const assert = require('assert');
const {
  buildProductCard,
  buildReplyButtons,
  parseInteractiveReply,
  interactiveReplyAsTextMessage
} = require('../lib/whatsapp-interactive');

let passed = 0;
function test(label, fn) { fn(); passed++; console.log('PASS', label); }

const product = {
  name: 'Salon Fiorie', price: '3290', promoPrice: '2790 DT', dimensions: '280 x 180 cm',
  productUrl: 'https://mondeco.tn/produit/salon-fiorie/'
};

test('fiche produit avec lien : bouton « Voir le produit », photo en en-tête', () => {
  const { interactive, logText } = buildProductCard(product, { hasImage: true, intro: 'Voici le modèle 😊' });
  assert.strictEqual(interactive.type, 'cta_url');
  assert.deepStrictEqual(interactive.header, { type: 'image', image: {} });
  assert.deepStrictEqual(interactive.action, { name: 'cta_url', parameters: { display_text: 'Voir le produit', url: product.productUrl } });
  assert.strictEqual(interactive.body.text, 'Voici le modèle 😊\n\n*Salon Fiorie*\n💰 2790 DT au lieu de ~3290 DT~\n📐 280 x 180 cm');
  assert.strictEqual(interactive.footer.text, 'MONDECO');
  assert.ok(logText.includes('🔗 Voir le produit : https://mondeco.tn/produit/salon-fiorie/'));
  assert.ok(logText.includes('\nSalon Fiorie\n💰 2790 DT au lieu de 3290 DT'));
});

test('fiche produit sans lien ni photo : en-tête texte et 3 boutons de réponse', () => {
  const { interactive } = buildProductCard({ name: 'Table Opale', price: '890', productUrl: 'http://pas-https' });
  assert.strictEqual(interactive.type, 'button');
  assert.deepStrictEqual(interactive.header, { type: 'text', text: 'Table Opale' });
  assert.strictEqual(interactive.action.buttons.length, 3);
  for (const button of interactive.action.buttons) assert.ok(button.reply.title.length <= 20);
  assert.throws(() => buildProductCard({ name: '' }), /introuvable/);
});

test('corps tronqué à 1024 caractères', () => {
  const { interactive } = buildProductCard({ name: 'X', dimensions: 'd'.repeat(2000) });
  assert.ok(interactive.body.text.length <= 1024);
});

test('question à boutons : validation des limites WhatsApp', () => {
  const { interactive, logText } = buildReplyButtons('Comment continuer ?', ['Livraison', ' Visite showroom ', '']);
  assert.deepStrictEqual(interactive.action.buttons.map(b => [b.reply.id, b.reply.title]), [['btn_1', 'Livraison'], ['btn_2', 'Visite showroom']]);
  assert.strictEqual(logText, 'Comment continuer ?\n[Livraison] [Visite showroom]');
  assert.throws(() => buildReplyButtons('', ['A']), /question/);
  assert.throws(() => buildReplyButtons('Q', []), /au moins un/);
  assert.throws(() => buildReplyButtons('Q', ['A', 'B', 'C', 'D']), /3 boutons/);
  assert.throws(() => buildReplyButtons('Q', ['Un bouton beaucoup trop long']), /trop long/);
  assert.throws(() => buildReplyButtons('Q', ['Oui', 'oui']), /même texte/);
});

test('réponses des clients : bouton, liste, bouton de modèle', () => {
  assert.deepStrictEqual(
    parseInteractiveReply({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'btn_2', title: 'Visite showroom' } } }),
    { text: 'Visite showroom', id: 'btn_2', kind: 'button_reply' }
  );
  assert.deepStrictEqual(
    parseInteractiveReply({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'sfax', title: 'Sfax', description: 'Route de Tunis' } } }),
    { text: 'Sfax — Route de Tunis', id: 'sfax', kind: 'list_reply' }
  );
  assert.deepStrictEqual(
    parseInteractiveReply({ type: 'button', button: { text: 'Oui', payload: 'YES' } }),
    { text: 'Oui', id: 'YES', kind: 'template_button' }
  );
  assert.strictEqual(parseInteractiveReply({ type: 'text', text: { body: 'x' } }), null);
  assert.strictEqual(parseInteractiveReply({ type: 'interactive', interactive: { type: 'nfm_reply' } }), null);
});

test('conversion en message texte, le reste du message conservé', () => {
  const raw = { id: 'wamid.1', from: '21650000000', type: 'interactive', interactive: { button_reply: { id: 'btn_1', title: 'Livraison' } } };
  const converted = interactiveReplyAsTextMessage(raw);
  assert.strictEqual(converted.type, 'text');
  assert.deepStrictEqual(converted.text, { body: 'Livraison' });
  assert.strictEqual(converted.id, 'wamid.1');
  assert.strictEqual(converted.interactive_reply.id, 'btn_1');
  const plain = { type: 'text', text: { body: 'x' } };
  assert.strictEqual(interactiveReplyAsTextMessage(plain), plain);
});

console.log(`${passed} test(s) messages interactifs OK`);
