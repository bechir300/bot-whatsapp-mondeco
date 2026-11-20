// Tests de l'allègement adReferral (lib/ad-referral.js).
const assert = require('assert');
const {
  slimAdReferral,
  slimConversationState,
  adReferralMediaFields,
  adReferralKey,
  adRecordKey,
  isSameAd,
  mergeAdReferral,
  mergeAdSourceContext,
  adVisualCandidates,
  storedAdVisualIsCurrent,
  isVideoUrl,
  metaUrlExpired
} = require('../lib/ad-referral');

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


// ------------------------------------------------------------
// V6.45 — visuel de la publicité d'origine
// ------------------------------------------------------------

// Cas réel de production (11/11) : pub vidéo (Reel) « Chambre à coucher
// Bianca · Chambre complète », referral WhatsApp avec media_type video,
// video_url ET thumbnail_url.
const BIANCA_VIDEO_REFERRAL = {
  source_url: 'https://fb.me/2AbCdEfGh',
  source_id: '120210000000000001',
  source_type: 'ad',
  headline: 'Chambre à coucher Bianca · Chambre complète',
  body: 'Lit, armoire, 2 tables de nuit, coiffeuse.',
  media_type: 'video',
  video_url: 'https://video.xx.fbcdn.net/o1/v/t2/f2/m69/bianca.mp4?oe=7FFFFFFF',
  thumbnail_url: 'https://scontent.xx.fbcdn.net/v/t15.5256-10/bianca_n.jpg?oe=7FFFFFFF',
  ctwa_clid: 'clic-1'
};

test('pub vidéo WhatsApp : mediaUrl = vignette, vidéo à part, type de la pub respecté', () => {
  const fields = adReferralMediaFields(BIANCA_VIDEO_REFERRAL);
  assert.deepStrictEqual(fields, {
    mediaType: 'video',
    mediaUrl: BIANCA_VIDEO_REFERRAL.thumbnail_url,
    videoUrl: BIANCA_VIDEO_REFERRAL.video_url
  });
});

test('pub image WhatsApp : mediaUrl = image_url, champs vides omis', () => {
  assert.deepStrictEqual(adReferralMediaFields({ media_type: 'IMAGE', image_url: 'https://cdn/x.jpg' }), {
    mediaType: 'image',
    mediaUrl: 'https://cdn/x.jpg'
  });
  assert.deepStrictEqual(adReferralMediaFields({ headline: 'Salon' }), {});
});

test('pub vidéo sans vignette : la vidéo devient mediaUrl (repli) et reste signalée par videoUrl', () => {
  assert.deepStrictEqual(adReferralMediaFields({ video_url: 'https://v/x.mp4' }), {
    mediaType: 'video',
    mediaUrl: 'https://v/x.mp4',
    videoUrl: 'https://v/x.mp4'
  });
});

test('Messenger/Instagram : ads_context_data.video_url est une vignette (image), photo_url prioritaire', () => {
  assert.deepStrictEqual(adReferralMediaFields({ ads_context_data: { video_url: 'https://c/thumb.jpg' } }), {
    mediaType: 'video',
    mediaUrl: 'https://c/thumb.jpg'
  });
  assert.deepStrictEqual(adReferralMediaFields({ ads_context_data: { photo_url: 'https://c/p.jpg', video_url: 'https://c/t.jpg' } }), {
    mediaType: 'image',
    mediaUrl: 'https://c/p.jpg',
    thumbnailUrl: 'https://c/t.jpg'
  });
});

test('adKey : ID de la pub, jamais ctwa_clid ; empreinte du titre en dernier recours', () => {
  assert.strictEqual(adReferralKey(BIANCA_VIDEO_REFERRAL), '120210000000000001');
  assert.strictEqual(adReferralKey({ ...BIANCA_VIDEO_REFERRAL, ctwa_clid: 'clic-2' }), '120210000000000001');
  assert.strictEqual(adReferralKey({ ad_id: '999' }), '999');
  assert.strictEqual(adReferralKey({ source_url: 'https://fb.me/x' }), 'https://fb.me/x');
  const hashed = adReferralKey({ ctwa_clid: 'a' }, { headline: 'Salon Linda', body: 'Texte' });
  assert.ok(/^h:[0-9a-f]{16}$/.test(hashed));
  assert.strictEqual(adReferralKey({ ctwa_clid: 'b' }, { headline: 'Salon Linda', body: 'Texte' }), hashed);
  assert.strictEqual(adReferralKey({}), '');
  // Un ancien enregistrement (sans adKey) donne la même identité.
  assert.strictEqual(adRecordKey({ sourceId: '120210000000000001' }), '120210000000000001');
  assert.strictEqual(adRecordKey({ headline: 'Salon Linda', body: 'Texte' }), hashed);
});

test('client revenu par une AUTRE pub : le visuel de l’ancienne pub est retiré', () => {
  const previous = {
    adKey: 'AD-SALON', sourceId: 'AD-SALON', headline: 'Salon Linda', productHint: 'Salon Linda', mediaType: 'image',
    storedMediaUrl: '/admin/conversation-media/ad-visual-salon.jpg', storedMediaType: 'image', storedMediaKey: 'AD-SALON',
    mediaFetchError: 'x'
  };
  const next = { adKey: '120210000000000001', sourceId: '120210000000000001', headline: 'Chambre à coucher Bianca', productHint: 'Chambre à coucher Bianca', mediaType: 'video', mediaUrl: 'https://cdn/thumb.jpg', videoUrl: 'https://cdn/v.mp4' };
  const merged = mergeAdReferral(previous, next);
  assert.strictEqual(merged.storedMediaUrl, undefined);
  assert.strictEqual(merged.storedMediaKey, undefined);
  assert.strictEqual(merged.mediaFetchError, undefined);
  assert.strictEqual(merged.mediaUrl, 'https://cdn/thumb.jpg');
  assert.strictEqual(merged.headline, 'Chambre à coucher Bianca');
  // Le nouveau lien n'est PAS supprimé par l'allègement (copie locale absente).
  assert.strictEqual(slimAdReferral(merged).mediaUrl, 'https://cdn/thumb.jpg');
});

test('client revenu par une autre pub SANS visuel : plus d’image de l’ancienne pub', () => {
  const previous = { sourceId: 'AD-SALON', headline: 'Salon Linda', storedMediaUrl: '/admin/conversation-media/a.jpg' };
  const merged = mergeAdReferral(previous, { adKey: 'AD-BIANCA', sourceId: 'AD-BIANCA', headline: 'Bianca', productHint: '' });
  assert.strictEqual(merged.storedMediaUrl, undefined);
  assert.strictEqual(merged.mediaUrl, undefined);
  // productHint : gardé si le nouveau webhook est moins riche (même pub ou
  // identité inconnue), jamais repris d'une AUTRE pub.
  assert.strictEqual(mergeAdReferral({ productHint: 'Salon' }, { adKey: 'X' }).productHint, 'Salon');
  assert.strictEqual(mergeAdReferral({ sourceId: 'X', productHint: 'Salon' }, { adKey: 'X' }).productHint, 'Salon');
  assert.strictEqual(merged.productHint, '');
});

test('même pub (nouveau clic, autre ctwa_clid) : visuel enregistré conservé', () => {
  const previous = { adKey: 'AD-1', sourceId: 'AD-1', storedMediaUrl: '/admin/conversation-media/v.jpg', storedMediaType: 'image', storedMediaKey: 'AD-1' };
  const merged = mergeAdReferral(previous, { adKey: 'AD-1', sourceId: 'AD-1', ctwaClid: 'nouveau', mediaUrl: 'https://cdn/x.jpg' });
  assert.strictEqual(merged.storedMediaUrl, '/admin/conversation-media/v.jpg');
  assert.strictEqual(merged.ctwaClid, 'nouveau');
  assert.ok(isSameAd(previous, merged));
  // Ancien enregistrement (sans adKey) de la même pub : reconnu par sourceId.
  assert.ok(isSameAd({ sourceId: 'AD-1' }, { adKey: 'AD-1' }));
  assert.ok(!isSameAd({}, { adKey: 'AD-1' }));
});

test('allègement : mediaUrl gardé si la copie locale vient d’une autre pub', () => {
  const ad = { adKey: 'AD-2', mediaUrl: 'https://cdn/new.jpg', storedMediaUrl: '/admin/conversation-media/old.jpg', storedMediaKey: 'AD-1' };
  assert.strictEqual(slimAdReferral(ad), ad);
});

test('allègement : liens retirés quand l’image de la MÊME pub est enregistrée', () => {
  const slim = slimAdReferral({ adKey: 'AD-1', mediaType: 'video', mediaUrl: 'https://cdn/t.jpg', videoUrl: 'https://cdn/v.mp4', storedMediaUrl: '/admin/conversation-media/ad-visual-1.jpg', storedMediaType: 'image', storedMediaKey: 'AD-1' });
  assert.deepStrictEqual(slim, { adKey: 'AD-1', mediaType: 'video', storedMediaUrl: '/admin/conversation-media/ad-visual-1.jpg', storedMediaType: 'image', storedMediaKey: 'AD-1' });
});

test('allègement : vignette gardée tant que seule la vidéo est enregistrée', () => {
  const ad = { adKey: 'AD-1', mediaUrl: 'https://cdn/t.jpg', videoUrl: 'https://cdn/v.mp4', storedMediaUrl: '/admin/conversation-media/x.mp4', storedMediaType: 'video', storedMediaKey: 'AD-1' };
  assert.strictEqual(slimAdReferral(ad), ad);
  // Pub vidéo sans aucune vignette : la vidéo enregistrée suffit.
  const videoOnly = { adKey: 'AD-1', mediaUrl: 'https://cdn/v.mp4', videoUrl: 'https://cdn/v.mp4', storedMediaUrl: '/admin/conversation-media/x.mp4', storedMediaType: 'video', storedMediaKey: 'AD-1' };
  assert.deepStrictEqual(slimAdReferral(videoOnly), { adKey: 'AD-1', storedMediaUrl: '/admin/conversation-media/x.mp4', storedMediaType: 'video', storedMediaKey: 'AD-1' });
});

test('ancien enregistrement sans adKey : comportement d’allègement inchangé', () => {
  assert.deepStrictEqual(
    slimAdReferral({ mediaType: 'image', mediaUrl: 'https://meta/x', storedMediaUrl: '/admin/conversation-media/a.jpg', raw: {} }),
    { mediaType: 'image', storedMediaUrl: '/admin/conversation-media/a.jpg' }
  );
});

test('liens à télécharger : images d’abord, vidéo seulement sans image, https uniquement', () => {
  assert.deepStrictEqual(adVisualCandidates({ mediaUrl: 'https://c/t.jpg', videoUrl: 'https://c/v.mp4' }), [{ url: 'https://c/t.jpg', type: 'image' }]);
  assert.deepStrictEqual(adVisualCandidates({ mediaUrl: 'https://c/v', videoUrl: 'https://c/v' }), [{ url: 'https://c/v', type: 'video' }]);
  assert.deepStrictEqual(adVisualCandidates({ mediaUrl: 'http://c/x.jpg' }), []);
  assert.deepStrictEqual(adVisualCandidates({ imageUrl: 'https://c/i.jpg', thumbnailUrl: 'https://c/t.jpg', mediaUrl: 'https://c/i2.jpg' }).map(c => c.url), ['https://c/i.jpg', 'https://c/t.jpg', 'https://c/i2.jpg']);
});

test('visuel enregistré « à jour » seulement pour la même pub et en image', () => {
  const base = { storedMediaUrl: '/admin/conversation-media/a.jpg', storedMediaType: 'image', storedMediaKey: 'AD-1' };
  assert.ok(storedAdVisualIsCurrent(base, 'AD-1'));
  assert.ok(!storedAdVisualIsCurrent(base, 'AD-2'));
  assert.ok(!storedAdVisualIsCurrent({ storedMediaUrl: '/admin/conversation-media/a.jpg' }, 'AD-1'), 'ancien enregistrement : retéléchargé une fois');
  assert.ok(!storedAdVisualIsCurrent({ ...base, storedMediaType: 'video', mediaUrl: 'https://c/t.jpg' }, 'AD-1'), 'vidéo alors qu’une vignette existe');
});

test('expiration des liens Meta (paramètre oe) et détection vidéo', () => {
  assert.ok(metaUrlExpired('https://scontent.xx.fbcdn.net/x.jpg?oe=5F000000', Date.parse('2026-11-11')));
  assert.ok(!metaUrlExpired('https://scontent.xx.fbcdn.net/x.jpg?oe=7FFFFFFF', Date.parse('2026-11-11')));
  assert.ok(!metaUrlExpired('https://scontent.xx.fbcdn.net/x.jpg'));
  assert.ok(isVideoUrl('https://v/x.mp4?oe=1'));
  assert.ok(!isVideoUrl('https://v/x.jpg?name=a.mp4'));
});

test('contexte Instagram/Messenger : remplacé quand la pub change, fusionné pour la même pub', () => {
  const previous = { type: 'ad', previewUrl: '/admin/conversation-media/salon.webp', previewType: 'image', ad: { adKey: 'AD-SALON' } };
  assert.deepStrictEqual(mergeAdSourceContext(previous, { type: 'ad', ad: { adKey: 'AD-BIANCA' } }), { type: 'ad', ad: { adKey: 'AD-BIANCA' } });
  const same = mergeAdSourceContext(previous, { type: 'ad', ad: { adKey: 'AD-SALON', ctwaClid: 'x' } });
  assert.strictEqual(same.previewUrl, '/admin/conversation-media/salon.webp');
  assert.strictEqual(same.ad.ctwaClid, 'x');
});

console.log(`ALL ${passed} AD REFERRAL TESTS PASSED`);
