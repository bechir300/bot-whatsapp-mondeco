// ============================================================
// MONDECO — allègement des données publicitaires (adReferral)
// lib/ad-referral.js
//
// Mesuré en production (octobre 2026) : adReferral représentait 92,5 Mo
// sur les 135 Mo de conversation-state.json (38 435 conversations), dont :
// - raw (44,6 Mo) : copie brute du referral Meta, jamais relue par le code ;
// - mediaUrl (14,4 Mo) : lien Meta qui expire, inutile une fois l'image
//   copiée localement (storedMediaUrl), que l'interface affiche en priorité.
// Le fichier étant réécrit et resynchronisé dans SQLite à chaque écriture
// groupée, ce poids bloquait l'application plusieurs secondes.
//
// V6.45 — Visuel de la publicité d'origine. Bug réel : la carte « publicité
// d'origine » affichait 📣 pour toutes les pubs vidéo (le referral WhatsApp
// fournit media_type, video_url ET thumbnail_url, mais seul video_url était
// gardé), et un client revenu par une AUTRE pub gardait l'image de
// l'ancienne pub sous le titre de la nouvelle. Ce module regroupe la
// logique pure (sans réseau ni disque) :
// - champs média séparés : imageUrl / videoUrl / thumbnailUrl, mediaUrl
//   devenant l'IMAGE affichable (vignette pour une vidéo) ;
// - identité stable de la pub (adKey) : ad id / source_id, jamais ctwa_clid
//   (qui change à chaque clic) ;
// - fusion d'un nouveau referral : le visuel de l'ancienne pub est retiré
//   quand la pub change ;
// - allègement : mediaUrl n'est retiré que si la copie locale appartient à
//   la même pub.
// ============================================================

const crypto = require('crypto');

// Champs « liens distants » d'un visuel de pub (liens Meta signés, qui
// expirent) et champs du visuel enregistré localement.
const AD_REMOTE_MEDIA_FIELDS = ['mediaUrl', 'imageUrl', 'thumbnailUrl', 'videoUrl'];
const AD_STORED_VISUAL_FIELDS = ['storedMediaUrl', 'storedMediaType', 'storedMediaKey'];
const AD_FETCH_STATUS_FIELDS = ['mediaFetchError', 'mediaFetchFailedAt'];

const VIDEO_EXTENSION_RE = /\.(mp4|mov|webm|m4v)$/i;

function clean(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// V6.45 — Vrai si le chemin du lien désigne une vidéo (.mp4, .mov…).
function isVideoUrl(url) {
  const raw = clean(url);
  if (!raw) return false;
  let pathname = raw;
  try { pathname = new URL(raw, 'https://local.invalid').pathname; } catch {}
  return VIDEO_EXTENSION_RE.test(pathname);
}

// V6.45 — Les liens CDN Meta portent leur date d'expiration dans le
// paramètre `oe` (secondes Unix en hexadécimal). Sans `oe`, l'expiration
// est inconnue : on considère le lien comme utilisable.
function metaUrlExpired(url, nowMs = Date.now()) {
  try {
    const oe = new URL(clean(url)).searchParams.get('oe');
    if (!oe || !/^[0-9a-f]+$/i.test(oe)) return false;
    return parseInt(oe, 16) * 1000 <= nowMs;
  } catch {
    return false;
  }
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

// V6.45 — Champs média d'un referral Meta.
// WhatsApp (Click-to-WhatsApp) : media_type ('image' | 'video'), image_url,
// video_url, thumbnail_url (vignette de la vidéo).
// Messenger / Instagram : ads_context_data.photo_url (image) et
// ads_context_data.video_url, qui est documenté par Meta comme la VIGNETTE
// de la vidéo (une image).
// mediaType = type de la PUBLICITÉ (une pub vidéo reste 'video') ; mediaUrl =
// image affichable (image, sinon vignette), la vidéo n'y étant mise qu'en
// l'absence de toute image. Les champs vides sont omis, et imageUrl /
// thumbnailUrl ne sont gardés que s'ils diffèrent de mediaUrl (allègement).
function adReferralMediaFields(referral) {
  const ref = isPlainObject(referral) ? referral : {};
  const adsContext = isPlainObject(ref.ads_context_data) ? ref.ads_context_data : {};

  const imageUrl = clean(ref.image_url) || clean(adsContext.photo_url);
  const videoUrl = clean(ref.video_url);
  const thumbnailUrl = clean(ref.thumbnail_url) || clean(adsContext.video_url);
  const declaredType = clean(ref.media_type).toLowerCase();

  let mediaType = '';
  if (declaredType === 'image' || declaredType === 'video') {
    mediaType = declaredType;
  } else if (videoUrl || (clean(adsContext.video_url) && !clean(adsContext.photo_url))) {
    mediaType = 'video';
  } else if (imageUrl || thumbnailUrl) {
    mediaType = 'image';
  }

  const mediaUrl = imageUrl || thumbnailUrl || videoUrl;
  const fields = {};
  if (mediaType) fields.mediaType = mediaType;
  if (mediaUrl) fields.mediaUrl = mediaUrl;
  if (imageUrl && imageUrl !== mediaUrl) fields.imageUrl = imageUrl;
  if (thumbnailUrl && thumbnailUrl !== mediaUrl) fields.thumbnailUrl = thumbnailUrl;
  // videoUrl est gardé même s'il est égal à mediaUrl : c'est ce qui indique
  // que mediaUrl est une vidéo (pub vidéo sans vignette).
  if (videoUrl) fields.videoUrl = videoUrl;
  return fields;
}

// V6.45 — Identité stable de la publicité : l'ID de la pub (source_id /
// ad_id), sinon le lien ou la publication, sinon une empreinte du titre et
// du texte. Jamais ctwa_clid, qui change à chaque clic.
function adReferralKey(referral, { headline = '', body = '' } = {}) {
  const ref = isPlainObject(referral) ? referral : {};
  const adsContext = isPlainObject(ref.ads_context_data) ? ref.ads_context_data : {};
  const direct = clean(ref.source_id) || clean(ref.ad_id) || clean(ref.source_url) ||
    clean(ref.post_id) || clean(adsContext.post_id);
  if (direct) return direct;
  const text = `${clean(headline)}|${clean(body)}`;
  if (text !== '|') return `h:${shortHash(text)}`;
  // Ni identifiant ni texte : empreinte du lien du visuel (sans la
  // signature, qui change à chaque envoi).
  const media = adReferralMediaFields(ref).mediaUrl;
  return media ? `m:${shortHash(mediaUrlWithoutQuery(media))}` : '';
}

function mediaUrlWithoutQuery(url) {
  try {
    const parsed = new URL(clean(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return clean(url).split(/[?#]/)[0];
  }
}

// Même identité, calculée sur un adReferral déjà normalisé (y compris les
// anciens enregistrements, qui n'ont pas de champ adKey).
function adRecordKey(record) {
  if (!isPlainObject(record)) return '';
  const direct = clean(record.adKey) || clean(record.sourceId) || clean(record.sourceUrl) || clean(record.postId);
  if (direct) return direct;
  const text = `${clean(record.headline)}|${clean(record.body)}`;
  if (text !== '|') return `h:${shortHash(text)}`;
  const media = clean(record.mediaUrl);
  return media ? `m:${shortHash(mediaUrlWithoutQuery(media))}` : '';
}

function isSameAd(previous, next) {
  const previousKey = adRecordKey(previous);
  const nextKey = adRecordKey(next);
  return Boolean(previousKey && nextKey && previousKey === nextKey);
}

// Retire tout ce qui décrit le visuel d'une publicité (liens distants,
// copie locale, échec de téléchargement).
function withoutAdVisual(record) {
  if (!isPlainObject(record)) return {};
  const rest = { ...record };
  for (const field of [...AD_REMOTE_MEDIA_FIELDS, ...AD_STORED_VISUAL_FIELDS, ...AD_FETCH_STATUS_FIELDS, 'mediaType']) {
    delete rest[field];
  }
  return rest;
}

// V6.45 — Fusion d'un nouveau referral dans l'adReferral existant. Si la
// publicité a changé, le visuel de l'ancienne pub est retiré : sinon le
// titre de la nouvelle pub s'affichait au-dessus de l'image de l'ancienne
// (un commercial a déjà répondu avec le mauvais produit, voir V6.36.100).
// productHint : comportement inchangé (gardé si Meta renvoie un webhook
// moins riche).
function mergeAdReferral(previous, next) {
  const prev = isPlainObject(previous) ? previous : {};
  const incoming = isPlainObject(next) ? next : {};
  const base = isSameAd(prev, incoming) ? prev : withoutAdVisual(prev);
  return {
    ...base,
    ...incoming,
    productHint: clean(incoming.productHint) || clean(prev.productHint)
  };
}

// V6.45 — Contexte « publicité » Instagram/Messenger : remplacé (et non
// fusionné) quand la publicité change, pour que l'aperçu de l'ancienne pub
// ne survive pas à un téléchargement raté de la nouvelle.
function mergeAdSourceContext(previous, next) {
  const incoming = isPlainObject(next) ? next : {};
  const prev = isPlainObject(previous) ? previous : null;
  if (prev && clean(prev.type) === 'ad' && isSameAd(prev.ad, incoming.ad)) {
    return {
      ...prev,
      ...incoming,
      ad: { ...(isPlainObject(prev.ad) ? prev.ad : {}), ...(isPlainObject(incoming.ad) ? incoming.ad : {}) }
    };
  }
  return { ...incoming };
}

// Type du fichier enregistré : storedMediaType, sinon l'extension.
function storedAdVisualType(record) {
  if (!isPlainObject(record)) return '';
  const url = clean(record.storedMediaUrl);
  if (!url) return '';
  const declared = clean(record.storedMediaType).toLowerCase();
  if (declared === 'image' || declared === 'video') return declared;
  return isVideoUrl(url) ? 'video' : 'image';
}

// La copie locale appartient-elle à la publicité décrite par ce record ?
// Les anciens enregistrements (sans adKey ni storedMediaKey) sont présumés
// cohérents, comme avant.
function storedAdVisualBelongsToAd(record) {
  if (!isPlainObject(record) || !clean(record.storedMediaUrl)) return false;
  const adKey = clean(record.adKey);
  if (!adKey) return true;
  return clean(record.storedMediaKey) === adKey;
}

// Liens à télécharger, dans l'ordre : images (image, vignette), puis la
// vidéo seulement s'il n'existe aucune image.
function adVisualCandidates(record) {
  if (!isPlainObject(record)) return [];
  const video = clean(record.videoUrl);
  const output = [];
  const push = (url, type) => {
    const value = clean(url);
    if (!/^https:\/\//i.test(value)) return;
    if (output.some(item => item.url === value)) return;
    output.push({ url: value, type });
  };
  for (const url of [record.imageUrl, record.thumbnailUrl, record.mediaUrl]) {
    const value = clean(url);
    if (value && value !== video && !isVideoUrl(value)) push(value, 'image');
  }
  if (!output.length) {
    push(video, 'video');
    push(record.mediaUrl, 'video');
  }
  return output;
}

function hasImageCandidate(record) {
  return adVisualCandidates(record).some(item => item.type === 'image');
}

// V6.45 — La copie locale est-elle le bon visuel pour cette pub ? Une image
// de la même pub : oui. Une vidéo (anciens enregistrements, ou pub sans
// vignette) : seulement si aucune image n'est disponible.
function storedAdVisualIsCurrent(record, adKey = '') {
  if (!isPlainObject(record)) return false;
  const url = clean(record.storedMediaUrl);
  if (!url.startsWith('/admin/conversation-media/')) return false;
  const key = clean(adKey) || adRecordKey(record);
  if (!key || clean(record.storedMediaKey) !== key) return false;
  const type = storedAdVisualType(record);
  return type === 'image' || (type === 'video' && !hasImageCandidate(record));
}

function slimAdReferral(ad) {
  if (!ad || typeof ad !== 'object' || Array.isArray(ad)) return ad;
  // V6.45 — les liens distants ne sont retirés que si la copie locale
  // provient de CETTE publicité (sinon on perdait le visuel de la nouvelle
  // pub), et, pour une copie vidéo, seulement s'il n'existe aucune image à
  // récupérer (vignette).
  const hasStoredMedia = storedAdVisualBelongsToAd(ad);
  const removable = hasStoredMedia &&
    (storedAdVisualType(ad) === 'image' || !hasImageCandidate(ad))
    ? AD_REMOTE_MEDIA_FIELDS.filter(field => field in ad)
    : [];
  if (!('raw' in ad) && !removable.length) return ad;

  const { raw, ...rest } = ad;
  for (const field of removable) delete rest[field];
  return rest;
}

// Renvoie le même objet si rien ne change (aucune copie inutile), sinon un
// nouvel objet d'état avec adReferral allégé.
function slimConversationState(state) {
  if (!state || typeof state !== 'object' || !state.adReferral) return state;
  const slim = slimAdReferral(state.adReferral);
  return slim === state.adReferral ? state : { ...state, adReferral: slim };
}

module.exports = {
  slimAdReferral,
  slimConversationState,
  // V6.45 — visuel de la publicité d'origine
  AD_REMOTE_MEDIA_FIELDS,
  AD_STORED_VISUAL_FIELDS,
  adReferralMediaFields,
  adReferralKey,
  adRecordKey,
  isSameAd,
  withoutAdVisual,
  mergeAdReferral,
  mergeAdSourceContext,
  adVisualCandidates,
  hasImageCandidate,
  storedAdVisualType,
  storedAdVisualBelongsToAd,
  storedAdVisualIsCurrent,
  isVideoUrl,
  metaUrlExpired
};
