// Tests d'intégration V6.45 (réponses IA) : server.js est chargé avec un
// DATA_DIR temporaire (jamais les vraies données) et l'appel Gemini est
// intercepté. Rejoue le cas réel : pub « Chambre à coucher Bianca ·
// Chambre complète », message « je veux le prix de la Chambre à coucher
// Bianca », modèle qui répond « (lit + 2 tables de nuit) 2800 dt ».
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-ai-answers-'));
const products = require('./fixtures/ai-catalog-bianca.json');
const BIANCA = products.find(product => product.woocommerceId === 60068);

fs.writeFileSync(path.join(dataDir, 'products.json'), JSON.stringify(products));
fs.writeFileSync(path.join(dataDir, 'instructions.json'), JSON.stringify([
  { id: 'i1', title: 'Ton et style', content: 'Réponds poliment et brièvement.', active: true },
  { id: 'i2', title: 'Livraison', content: 'Frais de livraison : 30 dt pour le Grand Tunis.', active: true },
  { id: 'i3', title: 'Ancienne promo Bianca', content: 'Chambre Bianca : lit + 2 tables de nuit, prix 2800 dt.', active: true }
]));
fs.writeFileSync(path.join(dataDir, 'quick-replies.json'), JSON.stringify([
  { id: 'qr-generic', title: 'Chambre à coucher', shortcut: 'chambre', content: 'Nos chambres à coucher sont fabriquées en Tunisie.', active: true },
  { id: 'qr-bianca', title: 'Bianca', shortcut: 'bianca', content: 'Lit Bianca 160x200 avec 2 tables de nuit : 2800 dt ✨ Livraison partout en Tunisie.', active: true }
]));

process.env.DATA_DIR = dataDir;
process.env.PORT = '0';
process.env.WOOCOMMERCE_SYNC_ENABLED = 'false';
process.env.GEMINI_API_KEY = 'test-only-not-a-key';
process.env.ADMIN_PASSWORD = 'test-password-not-used-123';
process.env.AI_FACT_GUARD = '';
process.env.AI_PRODUCT_LINK = '';
for (const name of ['GROQ_API_KEY', 'WHATSAPP_TOKEN', 'AI_FACT_GUARD_ALLOWED_AMOUNTS']) delete process.env[name];

// Réponse du modèle simulée (aucun appel réseau).
let cannedReply = '';
let geminiRequests = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    geminiRequests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: cannedReply }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 2000 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`réseau bloqué pendant les tests : ${url}`);
};

// Expose les fonctions internes de server.js à ce test uniquement (le
// fichier n'est pas modifié) et fixe la plage horaire IA.
const serverPath = path.join(root, 'server.js');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compileWithTestExports(content, filename) {
  if (filename === serverPath) {
    content += `
;isWithinAiActiveHours = () => globalThis.__aiActiveHours !== false;
globalThis.__srv = { generateReply, generateReplySuggestion, generateVisionReply, buildBusinessPromptDetailed,
  buildSmartBusinessContextDetailed, resolveConversationProduct, findMatchingQuickReplyForAd, rememberAdReferral,
  getConversationState, getLimitedHistoryForAI, normalizeForSearch, scoreContextBlock, stripReasoningLeak,
  appendCategoryLink, inferAdProductHint, recordAiHistoryReply, getCurrentMonthAiCostUsd, httpServer,
  MAX_PRODUCT_CONTEXT_CHARS, MAX_PINNED_PRODUCT_CHARS };`;
  }
  return originalCompile.call(this, content, filename);
};

// Journaux du serveur masqués : seules les lignes PASS sont affichées.
const quiet = () => {};
const say = line => process.stdout.write(`${line}\n`);
console.log = quiet;
console.warn = quiet;
console.info = quiet;
console.error = quiet;
require(serverPath);
const S = globalThis.__srv;
// Les écritures groupées (ai-history.json…) sont vidées à la sortie par le
// serveur : le dossier temporaire est supprimé après elles.
process.on('exit', () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

const AD_BODY = '💍 قرب عرسك ومازلت تلوج على بيت نوم أنيق وعصري؟ 😍 ✨ اكتشف Chambre Bianca من MONDECO: تصميم عصري وتفاصيل راقية. 🚚 التوصيل و التركيب في كامل الجمهورية. 📲 ابعثلنا BIANCA على WhatsApp باش تعرف السعر والتفاصيل.';
const BAD_MODEL_TEXT = 'La Chambre à coucher Bianca (comprenant un lit et deux tables de nuit) est au prix de 2800 dt.';

function rememberBiancaAd(contact) {
  S.rememberAdReferral(contact, {
    source_type: 'ad',
    source_id: '1136390428757516',
    source_url: 'https://fb.me/test',
    headline: 'Chambre à coucher Bianca · Chambre complète',
    body: AD_BODY,
    media_type: 'video'
  });
}

function systemPromptOf(request) {
  return (request?.systemInstruction?.parts || []).map(part => part.text).join('\n');
}

let passed = 0;
async function test(label, fn) {
  geminiRequests = [];
  await fn();
  passed++;
  say(`PASS ${label}`);
}

(async () => {
  await test('cas réel Bianca : contexte = Chambre à Coucher Bianca 6590/7200, réponse 2800 rejetée', async () => {
    const contact = '21698000001';
    rememberBiancaAd(contact);
    cannedReply = BAD_MODEL_TEXT;
    const reply = await S.generateReply(contact, 'Bonjour, je veux le prix de la Chambre à coucher Bianca svp.', 'whatsapp');

    assert.strictEqual(geminiRequests.length, 1, 'le modèle doit être appelé une fois');
    const prompt = systemPromptOf(geminiRequests[0]);
    const contextStart = prompt.indexOf('CONTEXTE MONDECO PERTINENT');
    const firstBlock = prompt.indexOf('--- PRODUIT ACTIF ---', contextStart);
    assert.ok(firstBlock > contextStart, 'bloc PRODUIT ACTIF absent');
    assert.ok(prompt.slice(firstBlock, firstBlock + 120).includes('Produit : Chambre à Coucher Bianca'));
    assert.ok(prompt.includes('Prix promotionnel : 6590 TND'));
    assert.ok(prompt.includes('Composition : 1 lit + 1 dressing + 1 coiffeuse + 2 tables de nuit + 1 pouf de lit'));
    assert.ok(!prompt.includes('Produit : Chambre enfant Maissa'), 'Maissa ne doit pas être envoyée');
    assert.ok(!/AUTRES PRODUITS[\s\S]*Produit : Lit Bianca \+ 2 chevets[\s\S]*FIN DU CONTEXTE/.test(prompt) || prompt.includes('différents du produit actif'));

    assert.ok(!reply.includes('2800'), `réponse envoyée : ${reply}`);
    assert.ok(reply.includes('6590') && reply.includes('7200'));
    assert.ok(reply.includes('2 tables de nuit + 1 pouf de lit'));
    assert.ok(!reply.includes('/categorie-produit/chambres/'));

    const history = S.getLimitedHistoryForAI(contact);
    assert.ok(history.every(item => !item.content.includes('2800')), 'la réponse rejetée ne doit pas entrer dans l’historique');
    assert.strictEqual(S.getConversationState(contact).activeProduct.id, BIANCA.id);
  });

  await test('bonne réponse du modèle : envoyée telle quelle + lien du produit (pas de lien par mot-clé)', async () => {
    const contact = '21698000002';
    rememberBiancaAd(contact);
    cannedReply = 'La Chambre à Coucher Bianca est à 6590 dt au lieu de 7200 dt 😊 Elle comprend un dressing de 260 cm.';
    const reply = await S.generateReply(contact, 'Prix', 'whatsapp');
    assert.ok(reply.startsWith(cannedReply));
    assert.ok(reply.endsWith(`Voir le produit : ${BIANCA.productUrl}`));
    assert.ok(!reply.includes('/categorie-produit/dressing/'));
  });

  await test('« BIANCA » seul depuis la pub : le produit de la pub est épinglé', async () => {
    const contact = '21698000003';
    rememberBiancaAd(contact);
    cannedReply = 'La Chambre à Coucher Bianca est à 6590 dt au lieu de 7200 dt.';
    await S.generateReply(contact, 'BIANCA', 'whatsapp');
    assert.ok(systemPromptOf(geminiRequests[0]).includes('--- PRODUIT ACTIF ---\nProduit : Chambre à Coucher Bianca'));
  });

  await test('« prix bianca » sans pub : question de choix sans IA, puis transfert si toujours ambigu', async () => {
    const contact = '21698000004';
    const first = await S.generateReply(contact, 'prix bianca', 'whatsapp');
    assert.strictEqual(geminiRequests.length, 0);
    assert.ok(first.includes('Chambre à Coucher Bianca') && first.includes('Pack Mariage Bianca') && first.includes('Chambre Enfant Bianca Junior'));
    const second = await S.generateReply(contact, 'combien bianca ?', 'whatsapp');
    assert.strictEqual(second, '[COMMERCIAL_REQUIRED]');
  });

  await test('réponse « la chambre à coucher » après la question de choix -> produit résolu', async () => {
    const contact = '21698000005';
    await S.generateReply(contact, 'prix bianca', 'whatsapp');
    cannedReply = 'La Chambre à Coucher Bianca est à 6590 dt au lieu de 7200 dt.';
    await S.generateReply(contact, 'la chambre à coucher', 'whatsapp');
    assert.strictEqual(geminiRequests.length, 1);
    assert.ok(systemPromptOf(geminiRequests[0]).includes('--- PRODUIT ACTIF ---\nProduit : Chambre à Coucher Bianca'));
    assert.strictEqual(S.getConversationState(contact).activeProduct.id, BIANCA.id);
  });

  await test('aucun produit : transfert direct (« C’est combien ? », modèle inconnu)', async () => {
    assert.strictEqual(await S.generateReply('21698000006', 'C’est combien ?', 'whatsapp'), '[COMMERCIAL_REQUIRED]');
    assert.strictEqual(await S.generateReply('21698000007', 'Combien coûte le canapé modèle Zorglub 3000 ?', 'whatsapp'), '[COMMERCIAL_REQUIRED]');
    assert.strictEqual(geminiRequests.length, 0);
  });

  await test('réponse IA avec un montant sans produit identifié -> transfert', async () => {
    cannedReply = 'Nos salons commencent à 1500 dt.';
    const reply = await S.generateReply('21698000008', 'Vous avez des salons ?', 'whatsapp');
    assert.strictEqual(reply, '[COMMERCIAL_REQUIRED]');
  });

  await test('montant de livraison issu des instructions accepté', async () => {
    const contact = '21698000009';
    rememberBiancaAd(contact);
    cannedReply = 'Pour la Chambre à Coucher Bianca, la livraison coûte 30 dt sur le Grand Tunis.';
    const reply = await S.generateReply(contact, 'la livraison coûte combien sur Tunis ?', 'whatsapp');
    assert.ok(reply.startsWith(cannedReply), reply);
  });

  await test('historique IA : jamais [COMMERCIAL_REQUIRED], réponses humaines ajoutées', async () => {
    const contact = '21698000010';
    rememberBiancaAd(contact);
    globalThis.__aiActiveHours = false;
    const reply = await S.generateReply(contact, 'Bonjour, vous êtes ouverts dimanche ?', 'whatsapp');
    globalThis.__aiActiveHours = true;
    assert.strictEqual(reply, '[COMMERCIAL_REQUIRED]');
    S.recordAiHistoryReply(contact, 'Oui, le showroom de Sousse est ouvert dimanche de 9h à 18h.');
    const history = S.getLimitedHistoryForAI(contact);
    assert.ok(history.every(item => !item.content.includes('COMMERCIAL_REQUIRED')));
    assert.deepStrictEqual(history.map(item => item.role), ['user', 'assistant']);
    cannedReply = 'Le samedi aussi, de 9h à 19h.';
    await S.generateReply(contact, 'Merci ! Et samedi ?', 'whatsapp');
    const contents = geminiRequests[0].contents.map(item => `${item.role}:${item.parts[0].text}`);
    assert.ok(contents.some(item => item.startsWith('model:Oui, le showroom de Sousse')), contents.join(' | '));
  });

  await test('réponse rapide de pub : jamais si elle contredit la fiche ou si le client pose une question', async () => {
    const adReferral = { productHint: 'Chambre à coucher Bianca', headline: 'Chambre à coucher Bianca · Chambre complète' };
    const resolution = S.resolveConversationProduct('', 'Bonjour', { adContext: adReferral });
    assert.strictEqual(S.findMatchingQuickReplyForAd(adReferral, { message: 'Bonjour ! Puis-je obtenir plus d’informations à ce sujet ?', resolution }), null);
    const litAd = { productHint: 'Lit BIANCA + 2 Chevets', headline: 'Lit BIANCA + 2 Chevets | MONDECO' };
    const litResolution = S.resolveConversationProduct('', 'BIANCA', { adContext: litAd });
    assert.strictEqual(S.findMatchingQuickReplyForAd(litAd, { message: 'BIANCA', resolution: litResolution })?.id, 'qr-bianca');
    assert.strictEqual(S.findMatchingQuickReplyForAd(litAd, { message: 'prix de la chambre complète ?', resolution: litResolution }), null);
    assert.strictEqual(S.findMatchingQuickReplyForAd({ productHint: 'Salon Villeneuve' }, { message: 'Bonjour' }), null);
  });

  await test('copilote : brouillon avec un mauvais prix remplacé par la fiche', async () => {
    const contact = '21698000011';
    rememberBiancaAd(contact);
    cannedReply = 'Bonjour ! La Chambre à coucher Bianca est à 2800 dt.';
    const result = await S.generateReplySuggestion({
      contact,
      entries: [{ incoming: 'Prix de la chambre à coucher Bianca ?', time: '2026-11-11T10:00:00.000Z' }],
      actor: { id: 'agent-1' }
    });
    assert.strictEqual(result.ok, true);
    assert.ok(!result.draft.includes('2800') && result.draft.includes('6590'), result.draft);
  });

  await test('image d’un client de pub : prompt avec la fiche, prix faux remplacé ; pub hors catalogue -> transfert', async () => {
    const contact = '21698000012';
    rememberBiancaAd(contact);
    cannedReply = 'Ce modèle est à 2800 dt.';
    const image = { buffer: Buffer.from('fake-image'), mimetype: 'image/jpeg' };
    const reply = await S.generateVisionReply(contact, 'prix ?', image, 'Chambre à coucher Bianca');
    assert.ok(systemPromptOf(geminiRequests[0]).includes('--- PRODUIT ACTIF ---\nProduit : Chambre à Coucher Bianca'));
    assert.ok(!reply.includes('2800') && reply.includes('6590'));
    geminiRequests = [];
    const unknown = await S.generateVisionReply('21698000013', 'prix ?', image, 'Table Opale');
    assert.strictEqual(unknown, '[COMMERCIAL_REQUIRED]');
    assert.strictEqual(geminiRequests.length, 0);
  });

  await test('budget : les jetons de réflexion Gemini sont comptés', async () => {
    // 11 appels Gemini ci-dessus : 1000 jetons d'entrée + (100 + 2000) de sortie chacun.
    const perCall = 1000 * 0.75 / 1e6 + 2100 * 3.75 / 1e6;
    const cost = S.getCurrentMonthAiCostUsd();
    assert.ok(cost >= perCall * 5, `coût ${cost}`);
    assert.ok(Math.abs(cost / perCall - Math.round(cost / perCall)) < 1e-6);
  });

  await test('filtre anti-fuite : puces françaises acceptées, raisonnement anglais bloqué', async () => {
    assert.strictEqual(S.stripReasoningLeak('Voici :\n* Prix : 6590 dt\n* Dimensions: 260 cm'), 'Voici :\n* Prix : 6590 dt\n* Dimensions: 260 cm');
    assert.strictEqual(S.stripReasoningLeak('* Language: French\n* Tone: friendly'), '[COMMERCIAL_REQUIRED]');
  });

  await test('lien : jamais par mot-clé, jamais sur une clarification', async () => {
    assert.strictEqual(S.appendCategoryLink('La chambre avec dressing est très demandée.'), 'La chambre avec dressing est très demandée.');
    assert.strictEqual(S.appendCategoryLink('Quel modèle vous intéresse ?', { product: BIANCA }), 'Quel modèle vous intéresse ?');
    assert.strictEqual(S.appendCategoryLink('Bianca : 6590 dt', { product: BIANCA, kind: 'clarification' }), 'Bianca : 6590 dt');
  });

  await test('recherche arabe : أنيق non coupé, « نوم » ne compte plus sur « ergonomique »', async () => {
    assert.strictEqual(S.normalizeForSearch('أنيق'), 'انيق');
    assert.strictEqual(S.scoreContextBlock('--- PRODUIT 1 ---\nProduit : Chaise ergonomique\nDescription : nombreux réglages', ['nom', 'نوم']), 0);
  });

  await test('contexte : budget respecté avec la fiche de 18 000 caractères (Pouf Luxe Bianca)', async () => {
    const pouf = products.find(product => product.woocommerceId === 61304);
    const resolution = { status: 'resolved', product: pouf, productKey: pouf.id, displayName: pouf.name, candidates: [pouf] };
    const details = S.buildSmartBusinessContextDetailed('prix pouf chambre luxe bianca', { resolution });
    const active = details.text.split('==================================================')[0];
    assert.ok(active.includes('Produit : Pouf Chambre Luxe Bianca'));
    assert.ok(active.length <= S.MAX_PINNED_PRODUCT_CHARS + 200);
    const others = details.text.slice(details.text.indexOf('AUTRES PRODUITS'));
    assert.ok(others.length <= S.MAX_PRODUCT_CONTEXT_CHARS + 200);
    assert.ok(details.productNames.length >= 1);
    const plain = S.buildSmartBusinessContextDetailed('prix pouf chambre luxe bianca', {});
    assert.ok(plain.productNames.includes('Pouf Chambre Luxe Bianca'), 'la fiche longue est tronquée, plus ignorée');
  });

  await test('productHint de pub : « · », titre générique, « mot » entier', async () => {
    assert.strictEqual(S.inferAdProductHint({ headline: 'Chambre à coucher Bianca · Chambre complète' }), 'Chambre à coucher Bianca');
    assert.strictEqual(S.inferAdProductHint({ headline: 'Mondeco.tn', body: 'Profitez de notre promotion sur la chambre à coucher Bianca !' }), 'Chambre à Coucher Bianca');
    // Sans produit trouvé, le titre générique reste (un productHint vide ferait
    // garder celui d'une pub précédente) mais il n'est jamais pris pour un produit.
    assert.strictEqual(S.inferAdProductHint({ headline: 'Envoyer un message WhatsApp', body: 'Le confort au quotidien.' }), 'Envoyer un message WhatsApp');
    assert.strictEqual(S.inferAdProductHint({ headline: 'Mondeco.tn', body: 'Nouveau motif capitonné, livraison partout.' }), 'Mondeco.tn');
    assert.strictEqual(S.resolveConversationProduct('', 'Prix', { adContext: { headline: 'Mondeco.tn', productHint: 'Mondeco.tn', body: 'Nouveau motif capitonné' } }).status, 'none');
    assert.strictEqual(S.inferAdProductHint({ headline: 'Mondeco.tn', body: 'Écrivez ZINA en commentaire' }), 'ZINA');
    assert.strictEqual(S.inferAdProductHint({ headline: 'Mondeco.tn', body: 'Envoyez le mot : ZINA, on vous répond' }), 'ZINA');
  });

  say(`\n${passed} test(s) ai-answers (intégration) OK`);
  try { S.httpServer.close(); } catch {}
  setTimeout(() => process.exit(0), 100);
})().catch(error => {
  say(`ÉCHEC ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
