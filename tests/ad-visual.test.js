// V6.45 — Tests du visuel de la publicité d'origine : téléchargement,
// enregistrement, réparation (lib/ad-visual.js), token Meta limité aux
// hôtes Meta (lib/meta-token-host.js), chaîne serveur réelle (fonctions
// extraites de server.js), rendu réel des cartes (Admin.html), route de
// réparation (Admin.js chargé avec un DATA_DIR temporaire), protection
// Storage Rescue et script de rattrapage. Aucune donnée réelle touchée.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-ad-visual-'));
const DATA_DIR = path.join(tmpRoot, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_EMAIL = 'test-admin@mondeco.test';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-123';
process.env.META_ADS_TOKEN = 'ADS-TOKEN-TEST';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
delete process.env.META_TOKEN_EXTRA_HOSTS;

const adReferralLib = require('../lib/ad-referral');
const adVisualLib = require('../lib/ad-visual');
const { canSendMetaToken, metaMediaHeaders, metaTokenHosts } = require('../lib/meta-token-host');

const quiet = { log() {}, warn() {}, error() {} };

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

// ---------- octets de test ----------
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(200, 3)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(400, 1)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(100, 1)]);
const HTML = Buffer.from('<!doctype html><html>login</html>');

// ---------- faux réseau (CDN Meta + API Graph) ----------
const requests = [];
const cdn = {
  'https://scontent.xx.fbcdn.net/bianca-thumb.jpg': { body: JPEG, type: 'image/jpeg' },
  'https://video.xx.fbcdn.net/bianca.mp4': { body: MP4, type: 'video/mp4' },
  'https://scontent.xx.fbcdn.net/salon.webp': { body: WEBP, type: 'image/jpeg' }, // mal étiqueté
  'https://scontent.xx.fbcdn.net/expired.jpg': { status: 403, body: Buffer.from('URL signature expired'), type: 'text/plain' },
  'https://scontent.xx.fbcdn.net/login.jpg': { body: HTML, type: 'text/html' },
  'https://scontent.xx.fbcdn.net/heic.jpg': { body: HEIC, type: 'image/heic' },
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1': { body: JPEG, type: 'image/jpeg', needsToken: 'WA-TOKEN' },
  'https://scontent.xx.fbcdn.net/graph-creative.jpg': { body: JPEG, type: 'image/jpeg' },
  'https://graph.facebook.com/v26.0/120210000000000777?fields=creative': { json: { creative: { id: '9988776655' } }, needsToken: 'ADS-TOKEN-TEST' },
  'https://graph.facebook.com/v26.0/9988776655?fields=image_url,thumbnail_url,object_type&thumbnail_width=600&thumbnail_height=600': {
    json: { thumbnail_url: 'https://scontent.xx.fbcdn.net/graph-creative.jpg', object_type: 'VIDEO' }, needsToken: 'ADS-TOKEN-TEST'
  }
};
const realFetch = global.fetch;
async function fakeFetch(url, options = {}) {
  const target = String(url);
  if (target.startsWith('http://127.0.0.1')) return realFetch(url, options);
  const auth = options?.headers?.Authorization || options?.headers?.authorization || '';
  requests.push({ url: target, auth });
  const entry = cdn[target];
  if (!entry) return new Response('not found', { status: 404 });
  if (entry.needsToken && auth !== `Bearer ${entry.needsToken}`) return new Response('{"error":{"message":"auth"}}', { status: 401 });
  if (entry.json) return new Response(JSON.stringify(entry.json), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(entry.body, { status: entry.status || 200, headers: { 'content-type': entry.type } });
}
global.fetch = fakeFetch;

// ---------- extraction de fonctions (server.js / Admin.html / Admin.js) ----------
function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Fonction introuvable : ${name}`);
  const start = match.index;
  let depth = 0;
  // Saute la liste des paramètres (valeurs par défaut avec accolades).
  let i = source.indexOf('(', start);
  let parens = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') parens++;
    if (source[i] === ')' && --parens === 0) break;
  }
  for (i = source.indexOf('{', i); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Fonction non terminée : ${name}`);
}

function extractConstLine(source, name) {
  const match = new RegExp(`^const ${name}\\s*=.*;$`, 'm').exec(source);
  if (!match) throw new Error(`Constante introuvable : ${name}`);
  return match[0];
}

const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'Admin.html'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'Admin.js'), 'utf8');

// Contexte « serveur » : vraies fonctions de server.js, état en mémoire.
function createServerHarness({ token = 'WA-TOKEN', mediaDir }) {
  const store = new Map();
  const context = vm.createContext({
    console: quiet,
    fs,
    path,
    URL,
    Date,
    Promise,
    Map,
    setTimeout,
    store,
    WHATSAPP_TOKEN: token,
    CONVERSATION_MEDIA_DIR: mediaDir,
    MAX_CONVERSATION_MEDIA_BYTES: 20 * 1024 * 1024,
    inferAdProductHint: referral => String(referral?.headline || '').split('·')[0].trim(),
    withStorageRetry: operation => operation(),
    normalizeChannel: value => String(value || 'whatsapp'),
    conversationChannel: () => 'whatsapp',
    conversationExternalId: contact => contact,
    getConversationStateSingle: contact => (store.has(contact) ? JSON.parse(JSON.stringify(store.get(contact))) : null),
    setConversationStateSingle: (contact, state) => store.set(contact, JSON.parse(JSON.stringify(state))),
    loadConversationStates: () => ({}),
    saveConversationStates: () => {},
    slimConversationState: adReferralLib.slimConversationState,
    ...adReferralLib,
    downloadAdVisual: (url, options) => adVisualLib.downloadAdVisual(url, { ...options, fetchImpl: fakeFetch }),
    saveAdVisualFile: adVisualLib.saveAdVisualFile,
    findAdVisualFile: adVisualLib.findAdVisualFile,
    writeAdVisualFileAtomic: adVisualLib.writeFileAtomic,
    canSendMetaToken
  });
  const names = [
    'safeString', 'getConversationState', 'updateConversationState', 'markCustomerMessage',
    'normalizeAdReferral', 'adVisualFileExists', 'storeAdVisualInState', 'downloadWhatsAppAdVisual',
    'persistWhatsAppAdReferralMedia', 'rememberAdReferral'
  ];
  vm.runInContext(
    'const adVisualDownloadsInFlight = new Map();\nconst AD_VISUAL_FETCH_TIMEOUT_MS = 20000;\n' +
    names.map(name => extractFunction(serverSource, name)).join('\n'),
    context
  );
  return context;
}

// Contexte « navigateur » : vraies fonctions d'Admin.html.
function createHtmlHarness() {
  const repairs = [];
  const context = vm.createContext({
    console: quiet,
    String, Number, Array, Object, RegExp, JSON, Date, Set, Map, Intl,
    setTimeout: fn => fn(),
    requestAdVisualRepair: (contact, force) => repairs.push({ contact, force }),
    repairs
  });
  const names = [
    'escapeHtml', 'safeConversationMediaUrl', 'formatDate', 'channelDisplayName', 'adOriginVisual',
    'adOriginMediaInnerHtml', 'adOriginMediaFrameHtml', 'adOriginContact',
    'conversationSourceCardHtml', 'conversationAdStickyHtml'
  ];
  vm.runInContext(
    [extractConstLine(htmlSource, 'AD_ORIGIN_PLACEHOLDER_HTML'), extractConstLine(htmlSource, 'adOriginFailedUrls'),
      ...names.map(name => extractFunction(htmlSource, name))].join('\n'),
    context
  );
  return context;
}

// Cas réel de production (11/11) : Reel « Chambre à coucher Bianca ·
// Chambre complète », referral WhatsApp media_type video + video_url +
// thumbnail_url. Avant : carte 📣 (vignette ignorée, MP4 téléchargé).
const BIANCA = {
  source_url: 'https://fb.me/2AbCdEfGh',
  source_id: '120210000000000001',
  source_type: 'ad',
  headline: 'Chambre à coucher Bianca · Chambre complète',
  body: 'Lit, armoire, 2 tables de nuit, coiffeuse.',
  media_type: 'video',
  video_url: 'https://video.xx.fbcdn.net/bianca.mp4',
  thumbnail_url: 'https://scontent.xx.fbcdn.net/bianca-thumb.jpg',
  ctwa_clid: 'ARAkLkA8rmlF-clic-1'
};
const SALON = {
  source_id: '120210000000000002',
  source_type: 'ad',
  headline: 'Salon Linda',
  body: 'Salon d’angle.',
  media_type: 'image',
  image_url: 'https://scontent.xx.fbcdn.net/salon.webp'
};

(async () => {
  // ============================================================
  // Token Meta : seulement vers les hôtes Meta autorisés
  // ============================================================
  await test('token Meta : Graph et lookaside oui ; CDN, http, autre hôte, port exotique non', () => {
    assert.ok(canSendMetaToken('https://graph.facebook.com/v26.0/123'));
    assert.ok(canSendMetaToken('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'));
    assert.ok(!canSendMetaToken('https://scontent.xx.fbcdn.net/x.jpg'));
    assert.ok(!canSendMetaToken('http://lookaside.fbsbx.com/x'));
    assert.ok(!canSendMetaToken('https://evil.example/graph.facebook.com'));
    assert.ok(!canSendMetaToken('https://graph.facebook.com.evil.example/x'));
    assert.ok(!canSendMetaToken('https://user:pw@graph.facebook.com/x'));
    assert.ok(!canSendMetaToken('https://graph.facebook.com:8443/x'));
    assert.ok(!canSendMetaToken('pas une url'));
    assert.deepStrictEqual(metaMediaHeaders('https://scontent.xx.fbcdn.net/x.jpg', 'T', { Connection: 'close' }), { Connection: 'close' });
    assert.strictEqual(metaMediaHeaders('https://graph.facebook.com/x', 'T').Authorization, 'Bearer T');
    assert.ok(metaTokenHosts({ META_TOKEN_EXTRA_HOSTS: 'media.meta.example, *bad*' }).has('media.meta.example'));
    assert.ok(!metaTokenHosts({ META_TOKEN_EXTRA_HOSTS: '*bad*' }).has('*bad*'));
  });

  // ============================================================
  // lib/ad-visual.js : téléchargement / enregistrement
  // ============================================================
  const libMedia = path.join(tmpRoot, 'lib-media');

  await test('téléchargement : jamais de token vers le CDN, type réel lu sur les octets (webp mal étiqueté accepté)', async () => {
    requests.length = 0;
    const { sniffed } = await adVisualLib.downloadAdVisual('https://scontent.xx.fbcdn.net/salon.webp', { token: 'WA-TOKEN', fetchImpl: fakeFetch });
    assert.strictEqual(sniffed.ext, 'webp');
    assert.ok(requests.every(r => !r.auth), 'aucun en-tête Authorization vers fbcdn');
  });

  await test('téléchargement : token envoyé à lookaside.fbsbx.com (hôte Meta autorisé)', async () => {
    requests.length = 0;
    const { sniffed } = await adVisualLib.downloadAdVisual('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', { token: 'WA-TOKEN', fetchImpl: fakeFetch });
    assert.strictEqual(sniffed.type, 'image');
    assert.strictEqual(requests[0].auth, 'Bearer WA-TOKEN');
  });

  await test('téléchargement : 403, page HTML, HEIC, vidéo non voulue, lien http refusés', async () => {
    await assert.rejects(adVisualLib.downloadAdVisual('https://scontent.xx.fbcdn.net/expired.jpg', { fetchImpl: fakeFetch, retries: 0 }), /403/);
    await assert.rejects(adVisualLib.downloadAdVisual('https://scontent.xx.fbcdn.net/login.jpg', { fetchImpl: fakeFetch }), /non affichable/);
    await assert.rejects(adVisualLib.downloadAdVisual('https://scontent.xx.fbcdn.net/heic.jpg', { fetchImpl: fakeFetch }), /non affichable/);
    await assert.rejects(adVisualLib.downloadAdVisual('https://video.xx.fbcdn.net/bianca.mp4', { fetchImpl: fakeFetch, allowVideo: false }), /vidéo/);
    await assert.rejects(adVisualLib.downloadAdVisual('http://scontent.xx.fbcdn.net/x.jpg', { fetchImpl: fakeFetch }), /HTTPS/);
  });

  await test('un fichier par publicité, retrouvé par son identité (adKey)', () => {
    const saved = adVisualLib.saveAdVisualFile({ mediaDir: libMedia, adKey: 'AD-42', buffer: JPEG });
    assert.ok(/^ad-visual-[0-9a-f]{24}\.jpg$/.test(saved.filename));
    assert.strictEqual(saved.url, `/admin/conversation-media/${saved.filename}`);
    assert.strictEqual(adVisualLib.findAdVisualFile(libMedia, 'AD-42').url, saved.url);
    assert.strictEqual(adVisualLib.findAdVisualFile(libMedia, 'AD-43'), null);
    assert.throws(() => adVisualLib.saveAdVisualFile({ mediaDir: libMedia, adKey: 'AD-42', buffer: HTML }), /non affichable/);
    assert.strictEqual(adVisualLib.basenameFromMediaUrl('/admin/conversation-media/a%20b.jpg?x=1'), 'a b.jpg');
  });

  // ============================================================
  // Chaîne serveur réelle (server.js) — WhatsApp
  // ============================================================
  const serverMedia = path.join(DATA_DIR, 'conversation-media');
  fs.mkdirSync(serverMedia, { recursive: true });
  const server = createServerHarness({ mediaDir: serverMedia });
  const html = createHtmlHarness();
  const CONTACT = '21650000002';

  await test('CAS DE PRODUCTION : pub vidéo Bianca → vignette enregistrée en image, sans token vers le CDN', async () => {
    requests.length = 0;
    const normalized = server.normalizeAdReferral(BIANCA);
    assert.strictEqual(normalized.mediaType, 'video');
    assert.strictEqual(normalized.mediaUrl, BIANCA.thumbnail_url);
    assert.strictEqual(normalized.videoUrl, BIANCA.video_url);
    assert.strictEqual(normalized.adKey, '120210000000000001');
    assert.strictEqual(normalized.productHint, 'Chambre à coucher Bianca');

    server.markCustomerMessage(CONTACT, { id: 'wamid.1', type: 'text', text: { body: 'Prix ?' } }, true, { channel: 'whatsapp' });
    server.rememberAdReferral(CONTACT, BIANCA);
    // Le téléchargement ne bloque plus la réponse : l'appel rend la main tout de suite.
    const immediate = await server.persistWhatsAppAdReferralMedia(CONTACT, BIANCA, 'wamid.1');
    assert.strictEqual(immediate, null);
    const url = await server.persistWhatsAppAdReferralMedia(CONTACT, BIANCA, 'wamid.1', { wait: true });
    assert.ok(/\/admin\/conversation-media\/ad-visual-[0-9a-f]{24}\.jpg$/.test(url), url);

    const ad = server.getConversationState(CONTACT).adReferral;
    assert.strictEqual(ad.storedMediaUrl, url);
    assert.strictEqual(ad.storedMediaType, 'image');
    assert.strictEqual(ad.storedMediaKey, '120210000000000001');
    assert.strictEqual(ad.mediaType, 'video');
    assert.strictEqual(ad.mediaUrl, undefined, 'liens Meta allégés une fois l’image enregistrée');
    assert.ok(!requests.some(r => r.url.includes('bianca.mp4')), 'la vidéo n’est pas téléchargée');
    assert.ok(requests.every(r => !r.auth), 'aucun token vers fbcdn');
  });

  await test('CAS DE PRODUCTION : la carte affiche la vignette (image) avec le badge ▶, plus 📣', () => {
    const state = server.getConversationState(CONTACT);
    const sticky = html.conversationAdStickyHtml(state, CONTACT);
    const stored = state.adReferral.storedMediaUrl;
    assert.ok(sticky.includes(`<img class="inbox-ad-origin-thumb" src="${stored}"`), sticky);
    assert.ok(sticky.includes('onerror="adOriginVisualFailed(this)"'));
    assert.ok(sticky.includes('inbox-ad-origin-play'), 'badge vidéo');
    assert.ok(!sticky.includes('📣'));
    assert.ok(sticky.includes('Chambre à coucher Bianca'));
    const card = html.conversationSourceCardHtml(state);
    assert.ok(card.includes(`<img class="inbox-source-context-media" src="${stored}"`), card);
    assert.ok(!card.includes('<video'));
  });

  await test('même pub, nouveau clic : aucun nouveau téléchargement', async () => {
    requests.length = 0;
    const url = await server.persistWhatsAppAdReferralMedia(CONTACT, { ...BIANCA, ctwa_clid: 'clic-2' }, 'wamid.2', { wait: true });
    assert.strictEqual(url, server.getConversationState(CONTACT).adReferral.storedMediaUrl);
    assert.strictEqual(requests.length, 0);
  });

  await test('client revenu par une AUTRE pub : nouvelle image, plus celle de Bianca', async () => {
    server.rememberAdReferral(CONTACT, SALON);
    let state = server.getConversationState(CONTACT);
    assert.strictEqual(state.adReferral.storedMediaUrl, undefined, 'ancien visuel retiré dès le referral');
    assert.strictEqual(state.adReferral.mediaUrl, SALON.image_url, 'nouveau lien gardé (non allégé)');
    // Pendant le téléchargement, la carte montre le lien Meta de la NOUVELLE pub.
    assert.ok(html.conversationAdStickyHtml(state, CONTACT).includes(SALON.image_url));
    const url = await server.persistWhatsAppAdReferralMedia(CONTACT, SALON, 'wamid.3', { wait: true });
    state = server.getConversationState(CONTACT);
    assert.ok(url.endsWith('.webp'));
    assert.strictEqual(state.adReferral.storedMediaKey, '120210000000000002');
    assert.strictEqual(state.adReferral.headline, 'Salon Linda');
    assert.ok(!html.conversationAdStickyHtml(state, CONTACT).includes('inbox-ad-origin-play'), 'pub image : pas de badge');
  });

  await test('autre pub, téléchargement en échec : jamais l’image de l’ancienne pub, échec gardé pour réessayer', async () => {
    const CONTACT2 = '21650000003';
    const expired = { source_id: '120210000000000003', source_type: 'ad', headline: 'Table Opale', media_type: 'image', image_url: 'https://scontent.xx.fbcdn.net/expired.jpg' };
    server.rememberAdReferral(CONTACT2, SALON);
    await server.persistWhatsAppAdReferralMedia(CONTACT2, SALON, 'w1', { wait: true });
    server.rememberAdReferral(CONTACT2, expired);
    const result = await server.persistWhatsAppAdReferralMedia(CONTACT2, expired, 'w2', { wait: true });
    assert.strictEqual(result, null);
    const state = server.getConversationState(CONTACT2);
    assert.strictEqual(state.adReferral.storedMediaUrl, undefined, 'jamais l’image du salon sous « Table Opale »');
    assert.strictEqual(state.adReferral.mediaUrl, expired.image_url, 'lien gardé pour une nouvelle tentative');
    assert.ok(/403/.test(state.adReferral.mediaFetchError));
    assert.ok(state.adReferral.mediaFetchFailedAt);
    const sticky = html.conversationAdStickyHtml(state, CONTACT2);
    assert.ok(!sticky.includes('.webp'), 'pas de visuel du salon');
    assert.ok(sticky.includes('onerror="adOriginVisualFailed(this)"'), 'repli 📣 + réparation si le lien ne charge pas');
  });

  await test('pub vidéo sans vignette : MP4 en dernier recours, affiché par sa première image', async () => {
    const CONTACT3 = '21650000004';
    const videoOnly = { source_id: '120210000000000004', source_type: 'ad', headline: 'Reel Sfax', media_type: 'video', video_url: 'https://video.xx.fbcdn.net/bianca.mp4' };
    server.rememberAdReferral(CONTACT3, videoOnly);
    const url = await server.persistWhatsAppAdReferralMedia(CONTACT3, videoOnly, 'w', { wait: true });
    assert.ok(url.endsWith('.mp4'));
    const state = server.getConversationState(CONTACT3);
    assert.strictEqual(state.adReferral.storedMediaType, 'video');
    const sticky = html.conversationAdStickyHtml(state, CONTACT3);
    assert.ok(sticky.includes(`<video class="inbox-ad-origin-thumb" muted playsinline preload="metadata" src="${url}#t=0.1"`), sticky);
  });

  await test('Instagram/Messenger : contexte pub remplacé quand la pub change (markCustomerMessage)', () => {
    const IG = 'instagram:900';
    server.markCustomerMessage(IG, { id: 'm1' }, true, { channel: 'instagram', sourceContext: { type: 'ad', previewUrl: '/admin/conversation-media/salon.webp', previewType: 'image', ad: { adKey: 'AD-SALON' } } });
    server.markCustomerMessage(IG, { id: 'm2' }, true, { channel: 'instagram', sourceContext: { type: 'ad', ad: { adKey: 'AD-BIANCA' } } });
    const state = server.getConversationState(IG);
    assert.strictEqual(state.sourceContext.previewUrl, undefined);
    assert.strictEqual(state.sourceContext.ad.adKey, 'AD-BIANCA');
    // Message direct ensuite : le contexte pub est conservé (comportement inchangé).
    server.markCustomerMessage(IG, { id: 'm3' }, false, { channel: 'instagram', sourceContext: { type: 'direct' } });
    assert.strictEqual(server.getConversationState(IG).sourceContext.type, 'ad');
  });

  // ============================================================
  // Rendu des cartes (Admin.html)
  // ============================================================
  await test('cartes : anciens enregistrements (MP4 seul, JPEG Instagram d’une pub vidéo)', () => {
    const legacyMp4 = { adReferral: { mediaType: 'video', headline: 'Bianca', storedMediaUrl: '/admin/conversation-media/whatsapp-source-ad-wamid1-ad-0.mp4' } };
    assert.ok(html.conversationAdStickyHtml(legacyMp4, 'c').includes('<video class="inbox-ad-origin-thumb"'));
    // Instagram : vignette JPEG d'une pub vidéo (avant : 📣 car ad.mediaType = video).
    const igVideo = { channel: 'instagram', adReferral: { mediaType: 'video', storedMediaUrl: '/admin/conversation-media/instagram-source-m-0.jpg' }, sourceContext: { type: 'ad', previewType: 'image', previewUrl: '/admin/conversation-media/instagram-source-m-0.jpg' } };
    const sticky = html.conversationAdStickyHtml(igVideo, 'c');
    assert.ok(sticky.includes('<img class="inbox-ad-origin-thumb" src="/admin/conversation-media/instagram-source-m-0.jpg"'));
    assert.ok(html.conversationSourceCardHtml(igVideo).includes('<img class="inbox-source-context-media"'));
  });

  await test('cartes : visuel d’une autre pub ignoré, sans visuel → 📣 et réparation demandée', () => {
    html.repairs.length = 0;
    const mismatch = { adReferral: { adKey: 'AD-2', headline: 'Bianca', storedMediaUrl: '/admin/conversation-media/old.jpg', storedMediaKey: 'AD-1' } };
    const sticky = html.conversationAdStickyHtml(mismatch, '216123');
    assert.ok(!sticky.includes('old.jpg'));
    assert.ok(sticky.includes('📣'));
    assert.deepStrictEqual(html.repairs, [{ contact: '216123', force: false }]);
    // Aperçu Instagram d'une autre pub : ignoré aussi.
    const igOther = { adReferral: { adKey: 'AD-2' }, sourceContext: { type: 'ad', previewUrl: '/admin/conversation-media/old.webp', ad: { adKey: 'AD-1' } } };
    assert.strictEqual(html.adOriginVisual(igOther).url, '');
    // Lien distant non https : jamais affiché.
    assert.strictEqual(html.adOriginVisual({ adReferral: { mediaUrl: 'javascript:alert(1)' } }).url, '');
  });

  await test('cartes : un lien qui a échoué n’est plus réaffiché (repli 📣)', () => {
    const state = { adReferral: { headline: 'X', mediaUrl: 'https://scontent.xx.fbcdn.net/expired.jpg' } };
    assert.ok(html.conversationAdStickyHtml(state, 'c').includes('expired.jpg'));
    vm.runInContext("adOriginFailedUrls.add('https://scontent.xx.fbcdn.net/expired.jpg')", html);
    assert.ok(html.conversationAdStickyHtml(state, 'c').includes('📣'));
  });

  // ============================================================
  // Réparation à la demande (lib/ad-visual.js)
  // ============================================================
  await test('réparation : visuel d’une autre conversation de la même pub, puis API Graph', async () => {
    const media = path.join(tmpRoot, 'repair-media');
    fs.mkdirSync(media, { recursive: true });
    const states = {
      a: { adReferral: { adKey: 'AD-9', sourceId: 'AD-9', storedMediaUrl: '/admin/conversation-media/shared.jpg', storedMediaType: 'image', storedMediaKey: 'AD-9' } },
      b: { adReferral: { sourceId: 'AD-9', headline: 'Même pub, image purgée', storedMediaUrl: '/admin/conversation-media/gone.jpg' } },
      c: { adReferral: { sourceId: '120210000000000777', sourceType: 'ad', mediaType: 'video', mediaUrl: 'https://scontent.xx.fbcdn.net/x.jpg?oe=5F000000' } }
    };
    fs.writeFileSync(path.join(media, 'shared.jpg'), JPEG);
    const repair = adVisualLib.createAdVisualRepair({
      mediaDir: media,
      getState: contact => states[contact] || null,
      listStates: () => Object.entries(states),
      updateState: (contact, updater) => (states[contact] = adReferralLib.slimConversationState(updater({ ...states[contact] }))),
      fetchImpl: fakeFetch,
      adsToken: 'ADS-TOKEN-TEST',
      logger: quiet
    });
    const shared = await repair.repairConversation('b');
    assert.strictEqual(shared.source, 'shared_conversation');
    assert.strictEqual(states.b.adReferral.storedMediaUrl, '/admin/conversation-media/shared.jpg');
    assert.strictEqual(states.b.adReferral.adKey, 'AD-9');

    requests.length = 0;
    const graph = await repair.repairConversation('c');
    assert.strictEqual(graph.source, 'graph', JSON.stringify(graph));
    assert.ok(/ad-visual-[0-9a-f]{24}\.jpg$/.test(states.c.adReferral.storedMediaUrl));
    assert.ok(!requests.some(r => r.url.includes('x.jpg')), 'lien expiré (oe) non téléchargé');
    assert.ok(requests.filter(r => r.url.startsWith('https://graph.facebook.com/')).every(r => r.auth === 'Bearer ADS-TOKEN-TEST'));
    assert.ok(requests.filter(r => r.url.includes('fbcdn')).every(r => !r.auth), 'token Graph jamais envoyé au CDN');

    const again = await repair.repairConversation('c');
    assert.strictEqual(again.reason, 'already_ok');
  });

  await test('réparation impossible : échec noté, lien mort retiré, puis pause avant nouvel essai', async () => {
    const media = path.join(tmpRoot, 'repair-media-2');
    fs.mkdirSync(media, { recursive: true });
    const states = { d: { adReferral: { sourceId: 'AD-404', storedMediaUrl: '/admin/conversation-media/purged.jpg' } } };
    let clock = Date.parse('2026-11-11T10:00:00Z');
    const repair = adVisualLib.createAdVisualRepair({
      mediaDir: media,
      getState: contact => states[contact],
      updateState: (contact, updater) => (states[contact] = updater({ ...states[contact] })),
      fetchImpl: fakeFetch,
      now: () => clock,
      logger: quiet
    });
    const first = await repair.repairConversation('d');
    assert.strictEqual(first.reason, 'unavailable');
    assert.strictEqual(states.d.adReferral.storedMediaUrl, undefined, 'lien mort retiré');
    assert.ok(/META_ADS_TOKEN/.test(states.d.adReferral.mediaFetchError));
    assert.strictEqual((await repair.repairConversation('d')).reason, 'cooldown');
    clock += 11 * 60 * 1000;
    assert.strictEqual((await repair.repairConversation('d')).reason, 'unavailable');
  });

  await test('réparation : la pub a changé pendant le téléchargement → rien n’est écrit', async () => {
    const media = path.join(tmpRoot, 'repair-media-3');
    const states = { e: { adReferral: { sourceId: 'AD-E', mediaUrl: 'https://scontent.xx.fbcdn.net/bianca-thumb.jpg' } } };
    const repair = adVisualLib.createAdVisualRepair({
      mediaDir: media,
      getState: contact => states[contact],
      updateState: (contact, updater) => {
        states[contact] = { adReferral: { sourceId: 'AD-NOUVELLE' } };
        return (states[contact] = updater({ ...states[contact] }));
      },
      fetchImpl: fakeFetch,
      logger: quiet
    });
    const result = await repair.repairConversation('e');
    assert.strictEqual(result.reason, 'ad_changed');
    assert.deepStrictEqual(states.e, { adReferral: { sourceId: 'AD-NOUVELLE' } });
  });

  // ============================================================
  // Storage Rescue : les visuels de pubs sont protégés (Admin.js)
  // ============================================================
  await test('Storage Rescue : images des pubs protégées (toutes conversations), vidéos non', () => {
    const media = path.join(tmpRoot, 'rescue-media');
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, 'ad-visual-abc.jpg'), JPEG);
    fs.writeFileSync(path.join(media, 'ad-visual-abc.mp4'), MP4);
    const context = vm.createContext({
      console: quiet,
      fs,
      CONVERSATION_MEDIA_DIR: media,
      safeString: value => String(value ?? '').trim(),
      decodeURIComponent,
      loadConversationStatesAdmin: () => ({
        x: { adReferral: { storedMediaUrl: '/admin/conversation-media/whatsapp-source-ad-w1-ad-0.jpg' } },
        y: { adReferral: { storedMediaUrl: '/admin/conversation-media/whatsapp-source-ad-w2-ad-0.mp4' } },
        z: { sourceContext: { type: 'ad', previewUrl: '/admin/conversation-media/instagram-source-m-0.webp', ad: { storedMediaUrl: '/admin/conversation-media/instagram-source-m-0.webp' } } },
        r: { sourceContext: { type: 'reel', previewUrl: '/admin/conversation-media/instagram-source-reel-0.jpg' } }
      })
    });
    vm.runInContext(extractFunction(adminSource, 'collectAdVisualMediaBasenames'), context);
    const names = [...vm.runInContext('collectAdVisualMediaBasenames()', context)].sort();
    assert.deepStrictEqual(names, ['ad-visual-abc.jpg', 'instagram-source-m-0.webp', 'whatsapp-source-ad-w1-ad-0.jpg']);
    assert.ok(/for \(const name of collectAdVisualMediaBasenames\(\)\) favoriteMedia\.add\(name\);/.test(adminSource), 'branché sur le nettoyage d’urgence');
  });

  // ============================================================
  // Route POST /admin/api/conversations/:contact/ad-visual/refresh
  // (Admin.js réel, DATA_DIR temporaire)
  // ============================================================
  await test('route de réparation : authentification exigée, puis visuel retrouvé via l’API Graph', async () => {
    const express = require('express');
    // Admin.js journalise beaucoup au chargement (DATA_DIR temporaire) : silence.
    const saved = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    let admin;
    try { admin = require('../Admin.js'); } finally { Object.assign(console, saved); }
    const app = express();
    app.use('/admin', admin.adminRouter);
    const httpServer = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    try {
      const contact = '21650009999';
      const state = {
        channel: 'whatsapp',
        cameFromAd: true,
        adReferral: { adKey: '120210000000000777', sourceId: '120210000000000777', sourceType: 'ad', headline: 'Chambre à coucher Bianca', mediaType: 'video' }
      };
      admin.setConversationStateSingle(contact, state);
      const all = admin.loadConversationStatesAdmin();
      all[contact] = state;
      admin.saveConversationStatesAdmin(all);

      const anonymous = await fetch(`${base}/admin/api/conversations/${contact}/ad-visual/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' });
      assert.ok([302, 401].includes(anonymous.status), `sans session : ${anonymous.status}`);

      const login = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
      });
      assert.strictEqual(login.status, 200, await login.clone().text());
      const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
      assert.ok(cookie.startsWith('mondeco_admin_session='));

      requests.length = 0;
      const response = await fetch(`${base}/admin/api/conversations/${contact}/ad-visual/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: '{}'
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.ok, true, JSON.stringify(body));
      assert.strictEqual(body.source, 'graph');
      assert.ok(/ad-visual-[0-9a-f]{24}\.jpg$/.test(body.adReferral.storedMediaUrl));
      assert.strictEqual(admin.getConversationStateSingle(contact).adReferral.storedMediaKey, '120210000000000777');

      // Le fichier est bien servi par la route média existante.
      const served = await fetch(`${base}${body.adReferral.storedMediaUrl}`, { headers: { cookie } });
      assert.strictEqual(served.status, 200);
      assert.strictEqual(served.headers.get('content-type'), 'image/jpeg');
      assert.ok(requests.filter(r => r.url.includes('fbcdn')).every(r => !r.auth));

      // Deuxième conversation de la même pub : réutilise le fichier, sans réseau.
      const other = '21650008888';
      admin.setConversationStateSingle(other, { channel: 'whatsapp', adReferral: { sourceId: '120210000000000777', headline: 'Bianca' } });
      requests.length = 0;
      const second = await (await fetch(`${base}/admin/api/conversations/${other}/ad-visual/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' })).json();
      assert.strictEqual(second.source, 'shared_file');
      assert.strictEqual(second.adReferral.storedMediaUrl, body.adReferral.storedMediaUrl);
      assert.strictEqual(requests.length, 0);
    } finally {
      httpServer.close();
    }
  });

  // ============================================================
  // Script de rattrapage (simulation par défaut)
  // ============================================================
  await test('rattrapage : simulation sans écriture, puis application (fichier + conversations)', async () => {
    const { runBackfill, parseArgs, legacyStemForMessageId } = require('../scripts/backfill-ad-visuals');
    assert.deepStrictEqual(parseArgs([]), { apply: false, writeStates: false, limit: Infinity, verbose: false });
    assert.throws(() => parseArgs(['--write-states']), /--apply/);
    const dir = path.join(tmpRoot, 'backfill');
    fs.mkdirSync(path.join(dir, 'conversation-media'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'conversation-events'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    // p1 : ancienne pub vidéo, seul le MP4 enregistré ; la vignette est dans la sauvegarde avant allègement.
    // p2 : image d'une AUTRE pub (Salon) sous la pub Bianca (ancien bug).
    // p3 : rien.
    fs.writeFileSync(path.join(dir, 'conversation-media', 'whatsapp-source-ad-wamidA-ad-0.mp4'), MP4);
    fs.writeFileSync(path.join(dir, 'conversation-media', 'whatsapp-source-ad-wamidS-ad-0.jpg'), JPEG);
    fs.writeFileSync(path.join(dir, 'conversation-media', 'whatsapp-source-ad-wamidT-ad-0.jpg'), JPEG);
    const states = {
      p1: { adReferral: { sourceId: '120210000000000001', headline: 'Bianca', mediaType: 'video', storedMediaUrl: '/admin/conversation-media/whatsapp-source-ad-wamidA-ad-0.mp4' } },
      p2: { adReferral: { sourceId: '120210000000000001', headline: 'Bianca', mediaType: 'image', storedMediaUrl: '/admin/conversation-media/whatsapp-source-ad-wamidS-ad-0.jpg' } },
      p3: { adReferral: { sourceId: '120210000000000001', headline: 'Bianca' } },
      ok: { adReferral: { sourceId: '120210000000000005', headline: 'Table', storedMediaUrl: '/admin/conversation-media/whatsapp-source-ad-wamidT-ad-0.jpg' } }
    };
    fs.writeFileSync(path.join(dir, 'conversation-state.json'), JSON.stringify(states));
    fs.writeFileSync(path.join(dir, 'backups', 'conversation-state-avant-allegement-2026-10-01.json'), JSON.stringify({
      p1: { adReferral: { sourceId: '120210000000000001', raw: { media_type: 'video', video_url: 'https://video.xx.fbcdn.net/bianca.mp4', thumbnail_url: 'https://scontent.xx.fbcdn.net/bianca-thumb.jpg' } } }
    }));
    fs.writeFileSync(path.join(dir, 'conversation-events', 'conversation-events-2026-10-01.jsonl'), [
      JSON.stringify({ message_id: 'wamid.S', contact: 'p2', ad_referral: { sourceId: '120210000000000002', headline: 'Salon' } }),
      JSON.stringify({ message_id: 'wamid.B', contact: 'p2', ad_referral: { sourceId: '120210000000000001', headline: 'Bianca' } })
    ].join('\n'));
    assert.strictEqual(legacyStemForMessageId('wamid.S'), 'wamidS-ad');

    const logs = [];
    const before = fs.readFileSync(path.join(dir, 'conversation-state.json'), 'utf8');
    requests.length = 0;
    const dry = await runBackfill({ dataDir: dir, fetchImpl: fakeFetch, adsToken: '', log: line => logs.push(line) });
    assert.deepStrictEqual(dry.categories, { video_only: 1, stale_other_ad: 1, missing: 1, ok: 1 });
    assert.strictEqual(dry.ads, 1);
    assert.strictEqual(requests.length, 0, 'simulation : aucun appel réseau');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'conversation-state.json'), 'utf8'), before, 'simulation : aucune écriture');
    assert.ok(logs.some(line => line.includes('serait téléchargé')));

    const applied = await runBackfill({ dataDir: dir, apply: true, writeStates: true, fetchImpl: fakeFetch, adsToken: '', log: () => {} });
    assert.strictEqual(applied.downloads, 1, 'un seul téléchargement pour la pub');
    assert.strictEqual(applied.conversationsUpdated, 3);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'conversation-state.json'), 'utf8'));
    for (const contact of ['p1', 'p2', 'p3']) {
      assert.ok(/ad-visual-[0-9a-f]{24}\.jpg$/.test(after[contact].adReferral.storedMediaUrl), contact);
      assert.strictEqual(after[contact].adReferral.storedMediaKey, '120210000000000001');
    }
    assert.strictEqual(after.ok.adReferral.storedMediaUrl, states.ok.adReferral.storedMediaUrl);
  });

  global.fetch = realFetch;
  console.log(`ALL ${passed} AD VISUAL TESTS PASSED`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch(error => {
  console.error('❌', error);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
