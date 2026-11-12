// ============================================================
// MONDECO — visuel de la publicité d'origine : téléchargement,
// enregistrement et réparation
// lib/ad-visual.js
//
// V6.45 — Utilisé par server.js (referral WhatsApp entrant), par Admin.js
// (route POST /admin/api/conversations/:contact/ad-visual/refresh) et par
// scripts/backfill-ad-visuals.js. Les accès à l'état des conversations, au
// réseau et au disque sont injectés : le module est testable sans serveur.
//
// Un fichier par publicité (ad-visual-<empreinte de adKey>.<ext>) dans
// conversation-media : toutes les conversations issues de la même pub le
// partagent, et la réparation le retrouve sans rien télécharger.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchReadWithRetry, readResponseBufferWithLimit } = require('./http');
const { canSendMetaToken } = require('./meta-token-host');
const {
  adRecordKey,
  adVisualCandidates,
  metaUrlExpired,
  storedAdVisualBelongsToAd,
  storedAdVisualType
} = require('./ad-referral');

const AD_VISUAL_PREFIX = 'ad-visual-';
const AD_VISUAL_MAX_BYTES = 20 * 1024 * 1024;
const AD_VISUAL_TIMEOUT_MS = 20000;
const MEDIA_URL_PREFIX = '/admin/conversation-media/';
const IMAGE_EXTENSIONS = ['jpg', 'png', 'webp', 'gif'];
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'mp4v', 'MSNV']);

function clean(value) {
  return String(value ?? '').trim();
}

// Type réel d'après les premiers octets (le Content-Type de Meta est parfois
// faux : une image webp annoncée en image/jpeg était refusée). HEIC/AVIF,
// HTML, etc. sont refusés : non affichables dans le navigateur.
function sniffAdVisual(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { type: 'image', ext: 'jpg', mimetype: 'image/jpeg' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image', ext: 'png', mimetype: 'image/png' };
  }
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { type: 'image', ext: 'gif', mimetype: 'image/gif' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { type: 'image', ext: 'webp', mimetype: 'image/webp' };
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp' && MP4_BRANDS.has(buffer.subarray(8, 12).toString('ascii'))) {
    return { type: 'video', ext: 'mp4', mimetype: 'video/mp4' };
  }
  return null;
}

function adVisualStem(adKey) {
  return `${AD_VISUAL_PREFIX}${crypto.createHash('sha1').update(clean(adKey)).digest('hex').slice(0, 24)}`;
}

function adVisualFileName(adKey, ext) {
  return `${adVisualStem(adKey)}.${ext}`;
}

function mediaUrlForFile(filename) {
  return `${MEDIA_URL_PREFIX}${encodeURIComponent(filename)}`;
}

function basenameFromMediaUrl(url) {
  const value = clean(url);
  if (!value.startsWith(MEDIA_URL_PREFIX)) return '';
  const name = value.slice(MEDIA_URL_PREFIX.length).split(/[?#]/)[0];
  try { return path.basename(decodeURIComponent(name)); } catch { return path.basename(name); }
}

// Fichier déjà enregistré pour cette pub (le plus récent ; les images
// avant la vidéo).
function findAdVisualFile(mediaDir, adKey, { allowVideo = true } = {}) {
  if (!clean(adKey) || !mediaDir) return null;
  const stem = adVisualStem(adKey);
  let best = null;
  for (const ext of IMAGE_EXTENSIONS) {
    const filename = `${stem}.${ext}`;
    try {
      const stat = fs.statSync(path.join(mediaDir, filename));
      if (stat.isFile() && stat.size > 0 && (!best || stat.mtimeMs > best.mtimeMs)) {
        best = { filename, type: 'image', mtimeMs: stat.mtimeMs };
      }
    } catch {}
  }
  if (!best && allowVideo) {
    const filename = `${stem}.mp4`;
    try {
      const stat = fs.statSync(path.join(mediaDir, filename));
      if (stat.isFile() && stat.size > 0) best = { filename, type: 'video', mtimeMs: stat.mtimeMs };
    } catch {}
  }
  return best ? { filename: best.filename, type: best.type, url: mediaUrlForFile(best.filename) } : null;
}

function writeFileAtomic(target, buffer) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

// Enregistre (ou remplace) le visuel partagé de la pub.
function saveAdVisualFile({ mediaDir, adKey, buffer, sniffed = null, writeFile = writeFileAtomic }) {
  const detected = sniffed || sniffAdVisual(buffer);
  if (!detected) throw new Error('Visuel publicité : format non affichable.');
  if (!clean(adKey)) throw new Error('Visuel publicité : identifiant de publicité manquant.');
  fs.mkdirSync(mediaDir, { recursive: true });
  const filename = adVisualFileName(adKey, detected.ext);
  writeFile(path.join(mediaDir, filename), buffer);
  return {
    filename,
    url: mediaUrlForFile(filename),
    type: detected.type,
    mimetype: detected.mimetype,
    size: buffer.length
  };
}

async function cancelBody(response) {
  try { await response?.body?.cancel(); } catch {}
}

// Télécharge un visuel de pub. Le token n'est joint que vers un hôte Meta
// autorisé (lib/meta-token-host.js) ; les liens CDN signés sont lus sans.
async function downloadAdVisual(url, {
  token = '',
  fetchImpl = fetch,
  maxBytes = AD_VISUAL_MAX_BYTES,
  timeoutMs = AD_VISUAL_TIMEOUT_MS,
  retries = 1,
  allowVideo = true,
  canSendToken = canSendMetaToken
} = {}) {
  const target = clean(url);
  if (!/^https:\/\//i.test(target)) throw new Error('Visuel publicité : lien non HTTPS ignoré.');
  let response = null;
  if (token && canSendToken(target)) {
    try {
      response = await fetchReadWithRetry(target, { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } }, { timeoutMs, retries, fetchImpl });
    } catch {
      response = null;
    }
  }
  // Les liens de créatives Meta sont souvent déjà signés : sans token.
  if (!response || !response.ok) {
    await cancelBody(response);
    response = await fetchReadWithRetry(target, { headers: { Connection: 'close' } }, { timeoutMs, retries, fetchImpl });
  }
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`Téléchargement visuel publicité impossible (${response.status}).`);
  }
  const buffer = await readResponseBufferWithLimit(response, maxBytes);
  const sniffed = sniffAdVisual(buffer);
  if (!sniffed) throw new Error('Visuel publicité : contenu non affichable (ni JPEG/PNG/WEBP/GIF ni MP4).');
  if (sniffed.type === 'video' && !allowVideo) throw new Error('Visuel publicité : vidéo reçue au lieu d’une image.');
  return { buffer, sniffed };
}

// V6.45 — Diagnostic du visuel d'une conversation issue d'une pub.
// status : 'ok' | 'video_only' (vidéo enregistrée alors qu'une image peut
// exister) | 'file_missing' | 'missing' | 'no_ad'.
function assessAdVisual(state, fileExists = () => true) {
  const ad = state?.adReferral && typeof state.adReferral === 'object' ? state.adReferral : null;
  if (!ad) return { status: 'no_ad', key: '' };
  const key = adRecordKey(ad);
  const storedUrl = clean(ad.storedMediaUrl);
  if (storedUrl && storedAdVisualBelongsToAd(ad)) {
    const filename = basenameFromMediaUrl(storedUrl);
    if (!filename || !fileExists(filename)) return { status: 'file_missing', key, url: storedUrl };
    const type = storedAdVisualType(ad);
    if (type === 'video') return { status: 'video_only', key, url: storedUrl, type };
    return { status: 'ok', key, url: storedUrl, type };
  }
  const source = state?.sourceContext && typeof state.sourceContext === 'object' ? state.sourceContext : null;
  const preview = clean(source?.previewUrl);
  if (source && clean(source.type) === 'ad' && preview.startsWith(MEDIA_URL_PREFIX)) {
    const sourceKey = adRecordKey(source.ad);
    const filename = basenameFromMediaUrl(preview);
    if ((!sourceKey || sourceKey === key) && filename && fileExists(filename)) {
      const type = clean(source.previewType).toLowerCase() === 'video' ? 'video' : 'image';
      return { status: type === 'video' ? 'video_only' : 'ok', key, url: preview, type };
    }
  }
  return { status: 'missing', key };
}

const GRAPH_ID_RE = /^\d{5,30}$/;
const GRAPH_POST_ID_RE = /^\d{5,30}(_\d{5,30})?$/;

// V6.45 — Visuel de la créative via l'API Graph (token « ads_read » :
// META_ADS_TOKEN). Pub image : image_url ; pub vidéo : thumbnail_url.
async function fetchGraphAdImageUrls(ad, { adsToken = '', graphVersion = 'v26.0', fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!adsToken || !ad || typeof ad !== 'object') return [];
  const version = /^v\d+\.\d+$/.test(clean(graphVersion)) ? clean(graphVersion) : 'v26.0';
  const graph = async pathAndQuery => {
    const response = await fetchReadWithRetry(
      `https://graph.facebook.com/${version}/${pathAndQuery}`,
      { headers: { Authorization: `Bearer ${adsToken}`, Connection: 'close' } },
      { timeoutMs, retries: 1, fetchImpl }
    );
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(clean(data?.error?.message) || `API Graph ${response.status}`);
    return data || {};
  };

  const urls = [];
  const push = value => {
    const url = clean(value);
    if (/^https:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
  };
  const sourceType = clean(ad.sourceType).toLowerCase();
  const adId = clean(ad.adId) || (sourceType !== 'post' ? clean(ad.sourceId) : '');
  let creativeId = clean(ad.creativeId);
  if (!GRAPH_ID_RE.test(creativeId) && GRAPH_ID_RE.test(adId)) {
    const data = await graph(`${encodeURIComponent(adId)}?fields=creative`);
    creativeId = clean(data?.creative?.id);
  }
  if (GRAPH_ID_RE.test(creativeId)) {
    const creative = await graph(`${encodeURIComponent(creativeId)}?fields=image_url,thumbnail_url,object_type&thumbnail_width=600&thumbnail_height=600`);
    push(creative?.image_url);
    push(creative?.thumbnail_url);
  }
  const postId = sourceType === 'post' ? clean(ad.sourceId) : clean(ad.postId);
  if (!urls.length && GRAPH_POST_ID_RE.test(postId)) {
    const post = await graph(`${encodeURIComponent(postId)}?fields=full_picture`);
    push(post?.full_picture);
  }
  return urls;
}

// V6.45 — Réparation à la demande du visuel d'une conversation, dans
// l'ordre : (1) fichier déjà enregistré pour cette pub, (2) visuel vérifié
// d'une autre conversation de la même pub, (3) liens Meta encore valides,
// (4) API Graph (META_ADS_TOKEN), (5) vidéo en dernier recours.
function createAdVisualRepair({
  mediaDir,
  getState,
  listStates = () => [],
  updateState,
  fileExists = filename => fs.existsSync(path.join(mediaDir, filename)),
  fetchImpl = fetch,
  adsToken = '',
  graphVersion = 'v26.0',
  maxBytes = AD_VISUAL_MAX_BYTES,
  writeFile = writeFileAtomic,
  cooldownMs = 10 * 60 * 1000,
  now = () => Date.now(),
  logger = console
} = {}) {
  if (!mediaDir || typeof getState !== 'function' || typeof updateState !== 'function') {
    throw new Error('createAdVisualRepair : mediaDir, getState et updateState sont obligatoires.');
  }
  const inFlight = new Map();
  const lastFailureAt = new Map();

  function linkVisual(contact, key, visual) {
    let applied = false;
    const updated = updateState(contact, current => {
      const ad = current?.adReferral && typeof current.adReferral === 'object' ? current.adReferral : null;
      // La pub a changé pendant la réparation : ne rien écrire.
      if (!ad || adRecordKey(ad) !== key) return current;
      const next = { ...ad, adKey: clean(ad.adKey) || key, storedMediaUrl: visual.url, storedMediaType: visual.type, storedMediaKey: key };
      delete next.mediaFetchError;
      delete next.mediaFetchFailedAt;
      applied = true;
      return { ...current, adReferral: next };
    });
    return { applied, state: updated };
  }

  function recordFailure(contact, key, message, clearDeadLink) {
    return updateState(contact, current => {
      const ad = current?.adReferral && typeof current.adReferral === 'object' ? current.adReferral : null;
      if (!ad || adRecordKey(ad) !== key) return current;
      const next = { ...ad, mediaFetchError: clean(message).slice(0, 200), mediaFetchFailedAt: new Date(now()).toISOString() };
      if (clearDeadLink) {
        delete next.storedMediaUrl;
        delete next.storedMediaType;
        delete next.storedMediaKey;
      }
      return { ...current, adReferral: next };
    });
  }

  function findSharedVisual(contact, key) {
    const own = findAdVisualFile(mediaDir, key, { allowVideo: false });
    if (own && fileExists(own.filename)) return { ...own, source: 'shared_file' };
    let entries = [];
    try {
      const listed = listStates();
      entries = Array.isArray(listed) ? listed : Object.entries(listed || {});
    } catch {}
    for (const [otherContact, other] of entries) {
      if (otherContact === contact) continue;
      const ad = other?.adReferral;
      if (!ad || typeof ad !== 'object') continue;
      // Seuls les visuels vérifiés (storedMediaKey) sont réutilisés : un
      // ancien enregistrement peut porter l'image d'une autre pub.
      if (clean(ad.storedMediaKey) !== key || adRecordKey(ad) !== key) continue;
      if (storedAdVisualType(ad) !== 'image') continue;
      const filename = basenameFromMediaUrl(ad.storedMediaUrl);
      if (filename && fileExists(filename)) {
        return { filename, url: clean(ad.storedMediaUrl), type: 'image', source: 'shared_conversation' };
      }
    }
    return null;
  }

  async function downloadAndSave(url, key, { allowVideo = false } = {}) {
    const { buffer, sniffed } = await downloadAdVisual(url, { fetchImpl, maxBytes, allowVideo });
    return saveAdVisualFile({ mediaDir, adKey: key, buffer, sniffed, writeFile });
  }

  async function runRepair(contact, { force = false } = {}) {
    const state = getState(contact);
    const ad = state?.adReferral && typeof state.adReferral === 'object' ? state.adReferral : null;
    if (!ad) return { ok: false, changed: false, reason: 'no_ad' };
    const assessment = assessAdVisual(state, fileExists);
    const key = assessment.key;
    if (!key) return { ok: false, changed: false, reason: 'no_ad_key', state };
    if (assessment.status === 'ok' && !force) {
      return { ok: true, changed: false, reason: 'already_ok', state };
    }

    const failedAt = lastFailureAt.get(contact) || 0;
    if (failedAt && now() - failedAt < cooldownMs) {
      return { ok: false, changed: false, reason: 'cooldown', state };
    }

    const currentUrl = clean(assessment.url);
    const errors = [];
    // Visuel trouvé : écrit dans l'état, sauf si la pub a changé entre-temps.
    const finish = (visual, source) => {
      const linked = linkVisual(contact, key, visual);
      return linked.applied
        ? { ok: true, changed: true, source, visual: { url: visual.url, type: visual.type }, state: linked.state }
        : { ok: false, changed: false, reason: 'ad_changed', state: linked.state };
    };

    // (1) et (2) : visuel déjà présent pour cette pub.
    const shared = findSharedVisual(contact, key);
    if (shared && (shared.url !== currentUrl || !force)) return finish(shared, shared.source);

    // (3) liens Meta du referral encore valides (contexte Instagram/Messenger
    // seulement s'il décrit la MÊME pub).
    const sourceAd = clean(state?.sourceContext?.type) === 'ad' && adRecordKey(state?.sourceContext?.ad) === key
      ? state.sourceContext.ad
      : {};
    const candidates = adVisualCandidates({ ...sourceAd, ...ad });
    for (const candidate of candidates.filter(item => item.type === 'image')) {
      if (metaUrlExpired(candidate.url, now())) {
        errors.push('lien Meta expiré');
        continue;
      }
      try {
        return finish(await downloadAndSave(candidate.url, key), 'remote');
      } catch (error) {
        errors.push(error.message);
      }
    }

    // (4) API Graph.
    if (adsToken) {
      try {
        const urls = await fetchGraphAdImageUrls(ad, { adsToken, graphVersion, fetchImpl });
        for (const url of urls) {
          try {
            return finish(await downloadAndSave(url, key), 'graph');
          } catch (error) {
            errors.push(error.message);
          }
        }
        if (!urls.length) errors.push('API Graph : aucun visuel pour cette publicité');
      } catch (error) {
        errors.push(`API Graph : ${error.message}`);
      }
    }

    // (5) Vidéo en dernier recours (pub sans aucune image), si rien n'est
    // déjà affichable.
    if (assessment.status !== 'video_only') {
      for (const candidate of candidates.filter(item => item.type === 'video')) {
        if (metaUrlExpired(candidate.url, now())) continue;
        try {
          return finish(await downloadAndSave(candidate.url, key, { allowVideo: true }), 'remote_video');
        } catch (error) {
          errors.push(error.message);
        }
      }
    }

    lastFailureAt.set(contact, now());
    if (lastFailureAt.size > 5000) lastFailureAt.delete(lastFailureAt.keys().next().value);
    const message = errors[0] || (adsToken ? 'aucun visuel disponible' : 'aucun visuel disponible (META_ADS_TOKEN non configuré)');
    const updated = recordFailure(contact, key, message, assessment.status === 'file_missing');
    try { logger.warn?.(`⚠️ Visuel publicité non réparé (${contact.slice(-4)}) : ${message}`); } catch {}
    return { ok: false, changed: assessment.status === 'file_missing', reason: 'unavailable', error: message, state: updated || state };
  }

  // Une seule réparation à la fois par conversation.
  function repairConversation(contact, options = {}) {
    const key = clean(contact);
    if (!key) return Promise.resolve({ ok: false, changed: false, reason: 'no_contact' });
    if (inFlight.has(key)) return inFlight.get(key);
    const task = runRepair(key, options)
      .catch(error => ({ ok: false, changed: false, reason: 'error', error: error.message }))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }

  return { repairConversation, findSharedVisual, assessAdVisual: state => assessAdVisual(state, fileExists) };
}

module.exports = {
  AD_VISUAL_PREFIX,
  AD_VISUAL_MAX_BYTES,
  sniffAdVisual,
  adVisualStem,
  adVisualFileName,
  basenameFromMediaUrl,
  findAdVisualFile,
  saveAdVisualFile,
  downloadAdVisual,
  assessAdVisual,
  fetchGraphAdImageUrls,
  createAdVisualRepair,
  writeFileAtomic
};
