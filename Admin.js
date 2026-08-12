// ============================================================
// MONDECO - ADMINISTRATION
// Admin.js
// Produits + Instructions + Personnalisation + Paramètres + Responsable commercial + SLA + Inbox commerciale omnicanale + commentaires sociaux + compteurs à répondre + avatars sociaux + temps équipe + récupération Facebook temps réel + favoris + rétention 15 jours — V6.35.0
// Stockage persistant Railway via /data
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const router = express.Router();

const APP_DIR = __dirname;
const DATA_DIR = (
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  APP_DIR
).trim();

const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const INSTRUCTIONS_PATH = path.join(DATA_DIR, 'instructions.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SECURE_IMAGE_MIGRATION_MARKER = path.join(DATA_DIR, '.secure-image-v676-migration-done');
const CUSTOMIZATIONS_PATH = path.join(DATA_DIR, 'customization-requests.json');
const COMMERCIAL_CORRECTIONS_PATH = path.join(DATA_DIR, 'commercial-corrections.json');
const QUICK_REPLIES_PATH = path.join(DATA_DIR, 'quick-replies.json');
// V6.33.1 — sessions persistantes : survivent aux redéploiements Railway.
const SESSIONS_PATH = path.join(DATA_DIR, 'admin-sessions.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const ADMIN_ENV_SYNC_PATH = path.join(DATA_DIR, '.admin-env-credentials-fingerprint');
const CONVERSATIONS_LOG_PATH = path.join(DATA_DIR, 'conversation-log.json');
// V6.19.4 — historique Instagram importé via Conversations API.
// Il reste séparé du journal temps réel afin de ne jamais être tronqué par
// la rotation du fichier conversation-log.json.
const INSTAGRAM_HISTORY_PATH = path.join(DATA_DIR, 'instagram-history.json');
const INSTAGRAM_HISTORY_SYNC_STATE_PATH = path.join(DATA_DIR, 'instagram-history-sync.json');
// V6.20 — historique Messenger importé via Conversations API.
const FACEBOOK_HISTORY_PATH = path.join(DATA_DIR, 'facebook-history.json');
const FACEBOOK_HISTORY_SYNC_STATE_PATH = path.join(DATA_DIR, 'facebook-history-sync.json');
const FACEBOOK_REALTIME_SYNC_STATE_PATH = path.join(DATA_DIR, 'facebook-realtime-sync.json');
// V6.26 — Centre d'interactions : publications + commentaires Facebook/Instagram.
// Les médias restent distants (URL Meta) afin de ne pas remplir le Volume Railway.
const SOCIAL_COMMENTS_PATH = path.join(DATA_DIR, 'social-comments.json');
const SOCIAL_POSTS_PATH = path.join(DATA_DIR, 'social-posts.json');
const SOCIAL_COMMENTS_SYNC_STATE_PATH = path.join(DATA_DIR, 'social-comments-sync.json');
const CONVERSATION_STATE_PATH_ADMIN = path.join(DATA_DIR, 'conversation-state.json');
const CONVERSATION_EVENTS_DIR = path.join(DATA_DIR, 'conversation-events');
const NOTIFICATIONS_PATH = path.join(DATA_DIR, 'notifications.json');
const MESSAGE_ID_INDEX_PATH = path.join(DATA_DIR, 'conversation-message-ids.jsonl');
// V6.34.2 — empreintes irréversibles des éléments supprimés. Aucun texte, nom, numéro ou contenu n'est conservé.
const PURGED_RECORD_HASHES_PATH = path.join(DATA_DIR, '.purged-record-hashes.json');
const RETENTION_15_MIGRATION_PATH = path.join(DATA_DIR, '.v630-retention-15.json');
const RETENTION_15_GRACE_MS = 12 * 60 * 60 * 1000;

const INSTAGRAM_ACCESS_TOKEN = (
  process.env.INSTAGRAM_ACCESS_TOKEN ||
  ''
).trim();

const INSTAGRAM_ACCOUNT_ID = (
  process.env.INSTAGRAM_ACCOUNT_ID ||
  ''
).trim();

const FACEBOOK_PAGE_ID = (
  process.env.FACEBOOK_PAGE_ID ||
  ''
).trim();

// V6.33.1 — deux tokens Facebook indépendants :
// - FACEBOOK_MESSENGER_TOKEN : Messenger, historique et rattrapage temps réel
// - FACEBOOK_COMMENTS_TOKEN  : Pages, publications et commentaires
// L'ancienne FACEBOOK_PAGE_ACCESS_TOKEN reste un fallback de compatibilité.
const FACEBOOK_LEGACY_PAGE_TOKEN = (
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
  ''
).trim();

const FACEBOOK_MESSENGER_TOKEN = (
  process.env.FACEBOOK_MESSENGER_TOKEN ||
  FACEBOOK_LEGACY_PAGE_TOKEN ||
  ''
).trim();

const FACEBOOK_COMMENTS_TOKEN = (
  process.env.FACEBOOK_COMMENTS_TOKEN ||
  FACEBOOK_LEGACY_PAGE_TOKEN ||
  ''
).trim();

const META_API_VERSION = (
  process.env.META_API_VERSION ||
  'v26.0'
).trim();

// V6.35.13 — Rétention réduite à 48h par défaut (au lieu de 15 jours), sur
// demande explicite : moins de données à importer/stocker/migrer = app
// plus légère et plus rapide. Réglable via la variable d'environnement
// HISTORY_IMPORT_DAYS si besoin de revenir à une fenêtre plus large.
// Une conversation ⭐ Favori OU encore SANS RÉPONSE reste protégée de la
// purge indéfiniment, quel que soit son âge (voir
// retentionProtectedConversationContacts ci-dessous) : réduire la fenêtre
// ne fait jamais disparaître un client qui attend encore une réponse.
const HISTORY_IMPORT_DAYS = Math.max(
  1,
  Math.min(30, Number(process.env.HISTORY_IMPORT_DAYS || 2) || 2)
);

// V6.33.1 — l'historique reste conservé 15 jours, mais la boîte de travail
// quotidienne n'affiche pas des milliers de conversations déjà traitées.
// Les conversations à répondre, non lues, prioritaires ou favorites restent
// toujours visibles. Les conversations déjà traitées quittent la vue active
// après cette fenêtre et restent accessibles via « Historique 15j ».
const ACTIVE_INBOX_HOURS = Math.max(
  2,
  Math.min(72, Number(process.env.ACTIVE_INBOX_HOURS || 12) || 12)
);

function activeInboxCutoffIso(reference = new Date()) {
  const base = reference instanceof Date ? reference : new Date(reference);
  const safeBase = Number.isFinite(base.getTime()) ? base : new Date();
  return new Date(
    safeBase.getTime() - ACTIVE_INBOX_HOURS * 60 * 60 * 1000
  ).toISOString();
}

function historyImportCutoffIso(reference = new Date()) {
  const base = reference instanceof Date ? reference : new Date(reference);
  const safeBase = Number.isFinite(base.getTime()) ? base : new Date();
  return new Date(
    safeBase.getTime() - HISTORY_IMPORT_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
}

function historyTimeIsRecent(value, cutoffAt) {
  const valueMs = Date.parse(safeString(value));
  const cutoffMs = Date.parse(safeString(cutoffAt));
  if (!Number.isFinite(cutoffMs)) return true;
  if (!Number.isFinite(valueMs)) return false;
  return valueMs >= cutoffMs;
}
const WOOCOMMERCE_SYNC_PATH = path.join(DATA_DIR, 'woocommerce-sync.json');
const SCHEDULES_PATH = path.join(DATA_DIR, 'schedules.json');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const SLA_EVENTS_PATH = path.join(DATA_DIR, 'sla-events.json');
const DAILY_REPORTS_PATH = path.join(DATA_DIR, 'daily-reports.json');
const ATTENDANCE_PATH = path.join(DATA_DIR, 'attendance-log.json');
const TEAM_ACTIVITY_PATH = path.join(DATA_DIR, 'team-activity.jsonl');
const TEAM_ACTIVITY_DIR = path.join(DATA_DIR, 'team-activity-days');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CUSTOMIZATIONS_DIR = path.join(DATA_DIR, 'customizations');
const CONVERSATION_MEDIA_DIR = path.join(DATA_DIR, 'conversation-media');
const CONVERSATION_PROFILE_DIR = path.join(DATA_DIR, 'conversation-profile');


// V6.33.1 — les médias de conversations et avatars quittent le Volume Railway.
// Railway conserve uniquement les données structurées; Cloudinary devient le
// stockage binaire. Les URLs Cloudinary ne sont pas envoyées directement au
// navigateur : les routes /admin/conversation-* restent protégées par auth et
// servent/proxifient l'asset depuis le cloud.
const CLOUDINARY_CLOUD_NAME = safeEnvValue(process.env.CLOUDINARY_CLOUD_NAME);
const CLOUDINARY_API_KEY = safeEnvValue(process.env.CLOUDINARY_API_KEY);
const CLOUDINARY_API_SECRET = safeEnvValue(process.env.CLOUDINARY_API_SECRET);
const CLOUDINARY_ROOT_FOLDER = (
  safeEnvValue(process.env.CLOUDINARY_MONDECO_FOLDER) || 'mondeco'
).replace(/[^a-zA-Z0-9_\/-]/g, '').replace(/^\/+|\/+$/g, '') || 'mondeco';
const CLOUD_STORAGE_ENABLED = Boolean(
  CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET
);
const CLOUD_MEDIA_MANIFEST_PATH = path.join(DATA_DIR, 'cloud-media-manifest.jsonl');
const CLOUD_MIGRATION_STATE_PATH = path.join(DATA_DIR, 'cloud-media-migration.json');
const CLOUD_MIGRATION_BATCH_FILES = Math.max(
  10,
  Math.min(1000, Number(process.env.CLOUDINARY_MIGRATION_BATCH_FILES || 150) || 150)
);
const CLOUD_MIGRATION_INTERVAL_MS = Math.max(
  60 * 1000,
  (Number(process.env.CLOUDINARY_MIGRATION_MINUTES || 5) || 5) * 60 * 1000
);

function safeEnvValue(value) {
  return String(value ?? '').trim();
}

const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const JSON_BACKUPS_DIR = path.join(BACKUPS_DIR, 'json');
const SNAPSHOTS_DIR = path.join(BACKUPS_DIR, 'snapshots');
const RECYCLE_DIR = path.join(BACKUPS_DIR, 'recycle');

const IS_RAILWAY = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME
);

// V6.20.6 — mode stockage compact.
// Sur Railway Free, le Volume est limité et les snapshots binaires complets
// peuvent dupliquer plusieurs fois les mêmes médias. Le mode compact conserve
// les données actives mais réduit fortement les copies de sauvegarde redondantes.
const COMPACT_STORAGE_MODE =
  String(
    process.env.MONDECO_STORAGE_MODE ||
    (IS_RAILWAY ? 'compact' : 'standard')
  )
    .trim()
    .toLowerCase() !== 'standard';

const MAX_JSON_BACKUPS_PER_FILE = Math.max(
  1,
  Math.min(
    50,
    Number(
      process.env.MONDECO_JSON_BACKUPS ||
      (COMPACT_STORAGE_MODE ? 2 : 50)
    ) || (COMPACT_STORAGE_MODE ? 2 : 50)
  )
);

const MAX_FULL_SNAPSHOTS = Math.max(
  1,
  Math.min(
    20,
    Number(
      process.env.MONDECO_FULL_SNAPSHOTS ||
      (COMPACT_STORAGE_MODE ? 1 : 20)
    ) || (COMPACT_STORAGE_MODE ? 1 : 20)
  )
);

const VERSIONED_BACKUP_MAX_BYTES = Math.max(
  256 * 1024,
  Number(
    process.env.MONDECO_VERSIONED_BACKUP_MAX_BYTES ||
    (COMPACT_STORAGE_MODE ? 2 * 1024 * 1024 : Number.MAX_SAFE_INTEGER)
  ) || (COMPACT_STORAGE_MODE ? 2 * 1024 * 1024 : Number.MAX_SAFE_INTEGER)
);

const STORAGE_RESCUE_TARGET_FREE_BYTES = Math.max(
  8 * 1024 * 1024,
  (Number(process.env.MONDECO_STORAGE_RESCUE_FREE_MB || 100) || 100) *
    1024 *
    1024
);

// V6.33.1 — garde-fou permanent contre ENOSPC.
// Le stockage doit garder une marge avant toute écriture JSON atomique.
const STORAGE_CRITICAL_FREE_BYTES = Math.max(
  16 * 1024 * 1024,
  (Number(process.env.MONDECO_STORAGE_CRITICAL_FREE_MB || 40) || 40) * 1024 * 1024
);

const STORAGE_GUARD_INTERVAL_MS = Math.max(
  60 * 1000,
  (Number(process.env.MONDECO_STORAGE_GUARD_MINUTES || 5) || 5) * 60 * 1000
);

const EMERGENCY_MEDIA_RETENTION_DAYS = Math.max(
  2,
  Math.min(15, Number(process.env.MONDECO_EMERGENCY_MEDIA_DAYS || 7) || 7)
);

const MAX_NOTIFICATION_ITEMS = Math.max(
  250,
  Math.min(5000, Number(process.env.MONDECO_MAX_NOTIFICATIONS || 2000) || 2000)
);

const MAX_MESSAGE_ID_LINES = Math.max(
  5000,
  Math.min(100000, Number(process.env.MONDECO_MAX_MESSAGE_IDS || 50000) || 50000)
);

let storageEmergencyCleanupRunning = false;
let storagePeriodicGuardRunning = false;

const PERSISTENCE_STRICT =
  String(
    process.env.PERSISTENCE_STRICT ?? 'true'
  ).trim().toLowerCase() !== 'false';

const LEGACY_PRODUCTS_PATH = path.join(APP_DIR, 'products.json');
const LEGACY_INSTRUCTIONS_PATH = path.join(APP_DIR, 'instructions.json');
const LEGACY_CUSTOMIZATIONS_PATH = path.join(APP_DIR, 'customization-requests.json');
const LEGACY_UPLOADS_DIR = path.join(APP_DIR, 'uploads');
const LEGACY_CUSTOMIZATIONS_DIR = path.join(APP_DIR, 'customizations');
const LEGACY_BUSINESS_INFO_PATH = path.join(APP_DIR, 'business-info.txt');

const INSTRUCTIONS_MIGRATION_MARKER = path.join(
  DATA_DIR,
  '.instructions-migration-done'
);

const ADMIN_HTML_PATH = path.join(APP_DIR, 'Admin.html');

const ADMIN_PASSWORD = (
  process.env.ADMIN_PASSWORD ||
  'mondeco2026'
).trim();

const ADMIN_EMAIL = (
  process.env.ADMIN_EMAIL ||
  'admin@mondeco.tn'
).trim().toLowerCase();


const WOOCOMMERCE_URL = (
  process.env.WOOCOMMERCE_URL ||
  'https://mondeco.tn'
)
  .trim()
  .replace(/\/+$/, '');

const WOOCOMMERCE_CONSUMER_KEY = (
  process.env.WOOCOMMERCE_CONSUMER_KEY ||
  ''
).trim();

const WOOCOMMERCE_CONSUMER_SECRET = (
  process.env.WOOCOMMERCE_CONSUMER_SECRET ||
  ''
).trim();

const WOOCOMMERCE_WEBHOOK_SECRET = (
  process.env.WOOCOMMERCE_WEBHOOK_SECRET ||
  ''
).trim();

const WOOCOMMERCE_SYNC_ENABLED =
  String(
    process.env.WOOCOMMERCE_SYNC_ENABLED ?? 'true'
  )
    .trim()
    .toLowerCase() !== 'false';

const WOOCOMMERCE_SYNC_MINUTES =
  Math.max(
    5,
    Math.min(
      1440,
      Number(
        process.env.WOOCOMMERCE_SYNC_MINUTES ||
        30
      ) || 30
    )
  );

const WOOCOMMERCE_SYNC_IMAGES =
  String(
    process.env.WOOCOMMERCE_SYNC_IMAGES ?? 'true'
  )
    .trim()
    .toLowerCase() !== 'false';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(CUSTOMIZATIONS_DIR, { recursive: true });
fs.mkdirSync(CONVERSATION_MEDIA_DIR, { recursive: true });
fs.mkdirSync(CONVERSATION_PROFILE_DIR, { recursive: true });
fs.mkdirSync(CONVERSATION_EVENTS_DIR, { recursive: true });
fs.mkdirSync(TEAM_ACTIVITY_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
fs.mkdirSync(JSON_BACKUPS_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
fs.mkdirSync(RECYCLE_DIR, { recursive: true });

router.use(express.json({ limit: '20mb' }));

// ============================================================
// HELPERS
// ============================================================

function safeString(value) {
  return String(value ?? '').trim();
}

function normalizePhone(value) {
  return safeString(value).replace(/\D/g, '');
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'non', 'off'].includes(
    String(value).trim().toLowerCase()
  );
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function fileExistsWithContent(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn('⚠️ Suppression fichier impossible :', error.message);
  }
}

function storageWriteProbe() {
  const testFile = path.join(
    DATA_DIR,
    `.write-test-${process.pid}-${Date.now()}`
  );

  try {
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    return {
      writable: true,
      errorCode: '',
      errorMessage: ''
    };
  } catch (error) {
    try {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    } catch {}

    return {
      writable: false,
      errorCode: safeString(error?.code),
      errorMessage: safeString(error?.message)
    };
  }
}

function storageIsWritable() {
  return storageWriteProbe().writable;
}

function storageSpaceInfo() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;

    const stat = fs.statfsSync(DATA_DIR);
    const blockSize = Number(stat?.bsize || stat?.frsize || 0);
    const totalBlocks = Number(stat?.blocks || 0);
    const availableBlocks = Number(stat?.bavail ?? stat?.bfree ?? 0);

    if (!blockSize || !totalBlocks) return null;

    const totalBytes = blockSize * totalBlocks;
    const freeBytes = Math.max(0, blockSize * availableBlocks);
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    return {
      totalBytes,
      freeBytes,
      usedBytes,
      freeRatio: totalBytes > 0 ? freeBytes / totalBytes : null
    };
  } catch {
    return null;
  }
}

function humanBytes(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}


// ============================================================
// V6.33.1 — CLOUDINARY / CLOUD STORAGE
// ============================================================

let cloudManifestLoaded = false;
const cloudManifest = new Map();
let cloudMigrationRunning = false;
let cloudMigrationLastResult = null;

function cloudManifestKey(kind, filename) {
  const safeKind = safeString(kind) === 'profile' ? 'profile' : 'media';
  return `${safeKind}:${path.basename(safeString(filename))}`;
}

function loadCloudManifest() {
  if (cloudManifestLoaded) return cloudManifest;
  cloudManifestLoaded = true;
  try {
    if (!fs.existsSync(CLOUD_MEDIA_MANIFEST_PATH)) return cloudManifest;
    const lines = fs.readFileSync(CLOUD_MEDIA_MANIFEST_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const key = safeString(entry?.key) || cloudManifestKey(entry?.kind, entry?.filename);
        if (key && safeString(entry?.secureUrl)) cloudManifest.set(key, entry);
      } catch {}
    }
  } catch (error) {
    console.warn('⚠️ Manifest Cloudinary illisible :', error.message);
  }
  return cloudManifest;
}

function cloudManifestEntry(kind, filename) {
  return loadCloudManifest().get(cloudManifestKey(kind, filename)) || null;
}

function appendCloudManifestEntry(entry) {
  const normalized = {
    ...entry,
    key: cloudManifestKey(entry?.kind, entry?.filename),
    filename: path.basename(safeString(entry?.filename)),
    updatedAt: new Date().toISOString()
  };
  if (!normalized.filename || !safeString(normalized.secureUrl)) {
    throw new Error('Entrée Cloudinary incomplète.');
  }
  // Une ligne JSONL est beaucoup moins coûteuse qu'une réécriture atomique de
  // tout le manifeste lorsque le Volume est déjà proche de sa limite.
  try { ensureStorageHeadroom(); } catch {}
  fs.mkdirSync(path.dirname(CLOUD_MEDIA_MANIFEST_PATH), { recursive: true });
  fs.appendFileSync(CLOUD_MEDIA_MANIFEST_PATH, `${JSON.stringify(normalized)}\n`, 'utf8');
  loadCloudManifest().set(normalized.key, normalized);
  return normalized;
}

function cloudinarySignedParams(params) {
  const stringToSign = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return crypto
    .createHash('sha1')
    .update(`${stringToSign}${CLOUDINARY_API_SECRET}`)
    .digest('hex');
}

function cloudPublicId(filename) {
  const base = path.basename(safeString(filename), path.extname(safeString(filename)))
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100) || crypto.randomUUID();
  return base;
}

async function cloudinaryUploadBuffer({ buffer, mimetype, filename, kind = 'media' }) {
  if (!CLOUD_STORAGE_ENABLED) return null;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Fichier Cloudinary vide.');

  const safeKind = kind === 'profile' ? 'profile' : 'media';
  const folder = `${CLOUDINARY_ROOT_FOLDER}/${safeKind === 'profile' ? 'profiles' : 'conversations'}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = cloudPublicId(filename);
  const params = {
    folder,
    overwrite: 'true',
    public_id: publicId,
    timestamp
  };
  const signature = cloudinarySignedParams(params);
  const form = new FormData();
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('overwrite', 'true');
  form.append('public_id', publicId);
  form.append('signature', signature);
  form.append(
    'file',
    new Blob([buffer], { type: safeString(mimetype) || 'application/octet-stream' }),
    path.basename(safeString(filename) || 'asset.bin')
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/auto/upload`,
      { method: 'POST', body: form, signal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }

  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || !safeString(body?.secure_url)) {
    throw new Error(
      safeString(body?.error?.message) || `Cloudinary HTTP ${response.status}`
    );
  }

  return appendCloudManifestEntry({
    kind: safeKind,
    filename: path.basename(filename),
    secureUrl: safeString(body.secure_url),
    publicId: safeString(body.public_id),
    resourceType: safeString(body.resource_type),
    format: safeString(body.format),
    bytes: Number(body.bytes || buffer.length || 0),
    createdAt: safeString(body.created_at) || new Date().toISOString()
  });
}

async function storeCloudAssetBuffer(options = {}) {
  if (!CLOUD_STORAGE_ENABLED) return null;
  try {
    return await cloudinaryUploadBuffer(options);
  } catch (error) {
    console.warn(`⚠️ Cloudinary ${safeString(options?.kind) || 'media'} :`, error.message);
    return null;
  }
}

function mimeFromFilename(filename) {
  const ext = path.extname(safeString(filename)).toLowerCase();
  const map = {
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif',
    '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm',
    '.mp3':'audio/mpeg','.m4a':'audio/mp4','.ogg':'audio/ogg','.wav':'audio/wav',
    '.pdf':'application/pdf','.txt':'text/plain','.doc':'application/msword',
    '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return map[ext] || 'application/octet-stream';
}

async function proxyCloudAsset(req, res, entry, { profile = false } = {}) {
  if (!entry || !safeString(entry.secureUrl)) return false;
  try {
    const headers = {};
    if (safeString(req.headers?.range)) headers.Range = req.headers.range;
    const upstream = await fetch(entry.secureUrl, { headers });
    if (!upstream.ok && upstream.status !== 206) return false;
    res.status(upstream.status);
    for (const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', profile ? 'private, max-age=86400' : 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
    return true;
  } catch (error) {
    console.warn('⚠️ Lecture Cloudinary impossible :', error.message);
    return false;
  }
}

function cloudStorageStats() {
  const manifest = loadCloudManifest();
  let mediaAssets = 0;
  let profileAssets = 0;
  let bytes = 0;
  for (const entry of manifest.values()) {
    if (entry?.kind === 'profile') profileAssets += 1;
    else mediaAssets += 1;
    bytes += Number(entry?.bytes || 0);
  }
  return {
    configured: CLOUD_STORAGE_ENABLED,
    cloudName: CLOUD_STORAGE_ENABLED ? CLOUDINARY_CLOUD_NAME : '',
    rootFolder: CLOUDINARY_ROOT_FOLDER,
    manifestAssets: manifest.size,
    mediaAssets,
    profileAssets,
    migratedBytes: bytes,
    localMediaBytes: pathSizeBytes(CONVERSATION_MEDIA_DIR),
    localProfileBytes: pathSizeBytes(CONVERSATION_PROFILE_DIR),
    migrationRunning: cloudMigrationRunning,
    lastMigration: cloudMigrationLastResult
  };
}

async function migrateCloudDirectory(directory, kind, budget) {
  const result = { scanned: 0, migrated: 0, freedBytes: 0, failed: 0 };
  if (!CLOUD_STORAGE_ENABLED || !fs.existsSync(directory) || budget <= 0) return result;
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => entry.name);

  for (const filename of files) {
    if (result.scanned >= budget) break;
    result.scanned += 1;
    const filePath = path.join(directory, filename);
    try {
      const existing = cloudManifestEntry(kind, filename);
      if (existing) {
        const size = Number(fs.statSync(filePath).size || 0);
        fs.unlinkSync(filePath);
        result.migrated += 1;
        result.freedBytes += size;
        continue;
      }
      const buffer = fs.readFileSync(filePath);
      const entry = await cloudinaryUploadBuffer({
        buffer,
        mimetype: mimeFromFilename(filename),
        filename,
        kind
      });
      if (!entry) throw new Error('Cloudinary sans résultat.');
      const size = Number(fs.statSync(filePath).size || buffer.length || 0);
      fs.unlinkSync(filePath);
      result.migrated += 1;
      result.freedBytes += size;
      // V6.35.7 — Petite pause entre chaque fichier migré. La migration
      // tourne en tâche de fond EN MÊME TEMPS que la synchro temps réel
      // Facebook/WhatsApp, sur la même connexion sortante du serveur.
      // Sans pause, une rafale de fichiers (surtout des vidéos) peut
      // saturer temporairement la bande passante disponible et provoquer
      // des "fetch failed" sur les appels Meta concurrents. Ce délai est
      // négligeable sur la durée totale de la migration (150 fichiers ×
      // 300ms ≈ 45s ajoutées sur un cycle de 5 minutes).
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      result.failed += 1;
      console.warn(`⚠️ Migration Cloudinary ${kind}/${filename} :`, error.message);
    }
  }
  return result;
}

async function runCloudStorageMigration({ maxFiles = CLOUD_MIGRATION_BATCH_FILES } = {}) {
  if (!CLOUD_STORAGE_ENABLED) {
    return { configured: false, migrated: 0, freedBytes: 0, error: 'Cloudinary non configuré.' };
  }
  if (cloudMigrationRunning) return { configured: true, running: true, skipped: true };
  cloudMigrationRunning = true;
  const startedAt = new Date().toISOString();
  try {
    // Obtenir d'abord quelques Mo de marge si Railway est déjà au bord de ENOSPC.
    try { ensureStorageHeadroom(); } catch {}
    const media = await migrateCloudDirectory(CONVERSATION_MEDIA_DIR, 'media', maxFiles);
    const remaining = Math.max(0, maxFiles - media.scanned);
    const profiles = await migrateCloudDirectory(CONVERSATION_PROFILE_DIR, 'profile', remaining);
    const result = {
      configured: true,
      startedAt,
      completedAt: new Date().toISOString(),
      scanned: media.scanned + profiles.scanned,
      migrated: media.migrated + profiles.migrated,
      failed: media.failed + profiles.failed,
      freedBytes: media.freedBytes + profiles.freedBytes,
      localMediaBytes: pathSizeBytes(CONVERSATION_MEDIA_DIR),
      localProfileBytes: pathSizeBytes(CONVERSATION_PROFILE_DIR)
    };
    cloudMigrationLastResult = result;
    try { writeJsonAtomic(CLOUD_MIGRATION_STATE_PATH, result); } catch {}
    if (result.migrated) {
      console.log('☁️ MONDECO Cloudinary migration', {
        migrated: result.migrated,
        freed: humanBytes(result.freedBytes),
        remainingMedia: humanBytes(result.localMediaBytes),
        remainingProfiles: humanBytes(result.localProfileBytes)
      });
    }
    return result;
  } finally {
    cloudMigrationRunning = false;
  }
}

function pathSizeBytes(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return 0;
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return Number(stat.size || 0);
    if (!stat.isDirectory()) return 0;

    return fs.readdirSync(targetPath).reduce(
      (sum, name) => sum + pathSizeBytes(path.join(targetPath, name)),
      0
    );
  } catch {
    return 0;
  }
}

function removePathForStorageRescue(targetPath, label = '') {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return 0;
    const bytes = pathSizeBytes(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    if (bytes > 0) {
      console.log(
        `🧹 Storage Rescue : ${label || path.basename(targetPath)} supprimé (${humanBytes(bytes)} estimés).`
      );
    }
    return bytes;
  } catch (error) {
    console.warn(
      `⚠️ Storage Rescue : suppression impossible (${label || targetPath}) :`,
      error.message
    );
    return 0;
  }
}

function pruneJsonBackupTreeForStorageRescue(keepPerFile = MAX_JSON_BACKUPS_PER_FILE) {
  let freed = 0;
  try {
    if (!fs.existsSync(JSON_BACKUPS_DIR)) return 0;

    for (const entry of fs.readdirSync(JSON_BACKUPS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(JSON_BACKUPS_DIR, entry.name);
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter(item => item.isFile())
        .map(item => {
          const fullPath = path.join(dir, item.name);
          try {
            const stat = fs.statSync(fullPath);
            return { fullPath, mtimeMs: stat.mtimeMs, size: Number(stat.size || 0) };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const file of files.slice(Math.max(0, keepPerFile))) {
        try {
          fs.unlinkSync(file.fullPath);
          freed += file.size;
        } catch (error) {
          console.warn('⚠️ Storage Rescue : ancien backup JSON non supprimé :', error.message);
        }
      }
    }
  } catch (error) {
    console.warn('⚠️ Storage Rescue : nettoyage backups JSON impossible :', error.message);
  }
  return freed;
}

function compactExistingSnapshotBinaryCopies() {
  let freed = 0;
  try {
    if (!fs.existsSync(SNAPSHOTS_DIR)) return 0;
    const duplicatedDirectories = [
      'uploads',
      'customizations',
      'conversation-media',
      'conversation-profile',
      'conversation-events'
    ];

    for (const entry of fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const snapshotDir = path.join(SNAPSHOTS_DIR, entry.name);
      for (const name of duplicatedDirectories) {
        const target = path.join(snapshotDir, name);
        if (!fs.existsSync(target)) continue;
        freed += removePathForStorageRescue(
          target,
          `${entry.name}/${name} (copie redondante)`
        );
      }
    }
  } catch (error) {
    console.warn('⚠️ Storage Rescue : compactage snapshots impossible :', error.message);
  }
  return freed;
}

function pruneFullSnapshotsForStorageRescue(keep = MAX_FULL_SNAPSHOTS) {
  let freed = 0;
  try {
    const snapshots = listFullSnapshots();
    for (const snapshot of snapshots.slice(Math.max(0, keep))) {
      freed += removePathForStorageRescue(
        path.join(SNAPSHOTS_DIR, snapshot.id),
        `snapshot ${snapshot.id}`
      );
    }
  } catch (error) {
    console.warn('⚠️ Storage Rescue : nettoyage snapshots impossible :', error.message);
  }
  return freed;
}

function cleanupStaleStorageTempFiles() {
  let freed = 0;
  try {
    if (!fs.existsSync(DATA_DIR)) return 0;
    const now = Date.now();
    for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const isTemp = name.includes('.tmp') || name.startsWith('.write-test-');
      if (!isTemp) continue;
      const fullPath = path.join(DATA_DIR, name);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs < 10 * 60 * 1000) continue;
        fs.unlinkSync(fullPath);
        freed += Number(stat.size || 0);
      } catch {}
    }
  } catch {}
  return freed;
}


function cleanupLooseBackupFilesForEmergency() {
  let freed = 0;
  try {
    if (!fs.existsSync(DATA_DIR)) return 0;
    for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.bak')) continue;
      const fullPath = path.join(DATA_DIR, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        fs.unlinkSync(fullPath);
        freed += Number(stat.size || 0);
      } catch {}
    }
  } catch {}
  return freed;
}

function pruneNotificationsForStorageRescue() {
  try {
    if (!fs.existsSync(NOTIFICATIONS_PATH)) return 0;
    const beforeSize = Number(fs.statSync(NOTIFICATIONS_PATH).size || 0);
    const parsed = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8') || '{}');
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const cutoff = Date.now() - HISTORY_IMPORT_DAYS * 24 * 60 * 60 * 1000;
    const kept = items
      .filter(item => {
        const ms = Date.parse(safeString(item?.createdAt));
        return !Number.isFinite(ms) || ms >= cutoff;
      })
      .sort((a, b) => (Date.parse(safeString(b?.createdAt)) || 0) - (Date.parse(safeString(a?.createdAt)) || 0))
      .slice(0, MAX_NOTIFICATION_ITEMS);

    if (kept.length === items.length && items.length <= MAX_NOTIFICATION_ITEMS) return 0;
    writeJsonAtomic(NOTIFICATIONS_PATH, { items: kept });
    const afterSize = fs.existsSync(NOTIFICATIONS_PATH) ? Number(fs.statSync(NOTIFICATIONS_PATH).size || 0) : 0;
    return Math.max(0, beforeSize - afterSize);
  } catch (error) {
    console.warn('⚠️ Storage Rescue : notifications non compactées :', error.message);
    return 0;
  }
}

function pruneMessageIdIndexForStorageRescue() {
  try {
    if (!fs.existsSync(MESSAGE_ID_INDEX_PATH)) return 0;
    const beforeSize = Number(fs.statSync(MESSAGE_ID_INDEX_PATH).size || 0);
    if (beforeSize < 4 * 1024 * 1024) return 0;
    const lines = fs.readFileSync(MESSAGE_ID_INDEX_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length <= MAX_MESSAGE_ID_LINES) return 0;
    const kept = lines.slice(-MAX_MESSAGE_ID_LINES);
    fs.writeFileSync(MESSAGE_ID_INDEX_PATH, `${kept.join('\n')}\n`, 'utf8');
    const afterSize = Number(fs.statSync(MESSAGE_ID_INDEX_PATH).size || 0);
    return Math.max(0, beforeSize - afterSize);
  } catch (error) {
    console.warn('⚠️ Storage Rescue : index message_id non compacté :', error.message);
    return 0;
  }
}

// Libère uniquement des caches et sauvegardes régénérables, sans toucher aux
// produits, instructions, utilisateurs, tâches, favoris ni conversation-state.
function emergencyFreeDisposableStorage() {
  if (storageEmergencyCleanupRunning) return 0;
  storageEmergencyCleanupRunning = true;
  let freed = 0;
  try {
    freed += cleanupStaleStorageTempFiles();
    freed += cleanupLooseBackupFilesForEmergency();
    freed += pruneJsonBackupTreeForStorageRescue(0);
    freed += compactExistingSnapshotBinaryCopies();
    freed += pruneFullSnapshotsForStorageRescue(0);

    if (fs.existsSync(RECYCLE_DIR)) {
      for (const entry of fs.readdirSync(RECYCLE_DIR, { withFileTypes: true })) {
        freed += removePathForStorageRescue(path.join(RECYCLE_DIR, entry.name), `recycle/${entry.name}`);
      }
    }

    // V6.33.1 : si Cloudinary est configuré, ne pas jeter les médias avant
    // leur migration. Le transfert cloud démarre juste après le Storage Rescue
    // et libère le Volume fichier par fichier. Sans Cloudinary, conserver
    // l'ancien comportement d'urgence.
    if (!CLOUD_STORAGE_ENABLED) {
      if (fs.existsSync(CONVERSATION_PROFILE_DIR)) {
        freed += removePathForStorageRescue(CONVERSATION_PROFILE_DIR, 'conversation-profile (cache)');
        try { fs.mkdirSync(CONVERSATION_PROFILE_DIR, { recursive: true }); } catch {}
      }

      const favoriteMedia = collectFavoriteConversationMediaBasenames(retentionProtectedConversationContacts());
      const mediaCutoff = Date.now() - EMERGENCY_MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      freed += pruneFilesOlderThan(
        CONVERSATION_MEDIA_DIR,
        mediaCutoff,
        'conversation-media urgence',
        { recursive: true, preserveBasenames: favoriteMedia }
      );
    }
  } catch (error) {
    console.warn('⚠️ Storage Rescue urgence :', error.message);
  } finally {
    storageEmergencyCleanupRunning = false;
  }
  return freed;
}

function ensureStorageHeadroom() {
  const space = storageSpaceInfo();
  const probe = storageWriteProbe();
  const critical =
    !probe.writable ||
    !space ||
    space.freeBytes < STORAGE_CRITICAL_FREE_BYTES ||
    (Number.isFinite(space.freeRatio) && space.freeRatio < 0.10);

  if (!critical) return { cleaned: false, freedBytes: 0, space, writable: probe.writable };
  const freedBytes = emergencyFreeDisposableStorage();
  const after = storageSpaceInfo();
  const afterProbe = storageWriteProbe();
  return {
    cleaned: true,
    freedBytes,
    space: after,
    writable: afterProbe.writable,
    errorCode: afterProbe.errorCode || ''
  };
}

function pruneFilesOlderThan(directory, cutoffMs, label, { recursive = false, preserveBasenames = new Set() } = {}) {
  let freed = 0;
  try {
    if (!fs.existsSync(directory)) return 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) freed += pruneFilesOlderThan(fullPath, cutoffMs, `${label}/${entry.name}`, { recursive, preserveBasenames });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (preserveBasenames?.has?.(entry.name)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoffMs) continue;
        fs.unlinkSync(fullPath);
        freed += Number(stat.size || 0);
      } catch (error) {
        console.warn(`⚠️ Storage Rescue : ${label} non supprimé :`, error.message);
      }
    }
  } catch (error) {
    console.warn(`⚠️ Storage Rescue : nettoyage ${label} impossible :`, error.message);
  }
  return freed;
}


function favoriteConversationContacts() {
  const states = loadConversationStatesAdmin();
  return new Set(
    Object.entries(states || {})
      .filter(([, state]) => state && state.favorite === true)
      .map(([contact]) => safeString(contact))
      .filter(Boolean)
  );
}

// V6.35.13 — Approximation légère de "conversation encore sans réponse",
// utilisable sans charger tout l'historique de messages (contrairement à
// conversationNeedsReplyFromEntries, qui a besoin des entries complètes).
// Suffisant pour une décision de rétention : en cas de doute, on protège
// plutôt que de risquer de purger un client qui attend encore.
function stateLooksUnanswered(state = {}) {
  if (!state || state.resolved === true) return false;
  const inboundMs = conversationTimeMs(state?.lastCustomerAt);
  if (!Number.isFinite(inboundMs) || inboundMs <= 0) return false;
  const responseMs = Math.max(
    Number(conversationTimeMs(state?.lastHumanAt)) || 0,
    Number(conversationTimeMs(state?.lastBotAt)) || 0,
    Number(conversationTimeMs(state?.lastAnsweredAt)) || 0,
    Number(conversationTimeMs(state?.lastBusinessAt)) || 0
  );
  return !(responseMs >= inboundMs);
}

// V6.35.13 — Ensemble des contacts protégés de la purge par rétention :
// favoris ET conversations encore sans réponse. Remplace
// favoriteConversationContacts() dans tous les points de purge (la fonction
// d'origine reste inchangée pour le comptage "favoris" affiché ailleurs).
function retentionProtectedConversationContacts() {
  const states = loadConversationStatesAdmin();
  const protectedContacts = new Set();
  for (const [contact, state] of Object.entries(states || {})) {
    if (!state) continue;
    if (state.favorite === true || stateLooksUnanswered(state)) {
      const safeContact = safeString(contact);
      if (safeContact) protectedContacts.add(safeContact);
    }
  }
  return protectedContacts;
}

function conversationRecordTimeMs(entry) {
  const candidates = [
    entry?.time,
    entry?.timestamp,
    entry?.created_time,
    entry?.createdAt,
    entry?.updated_time,
    entry?.updatedAt,
    entry?.event_time
  ];
  for (const value of candidates) {
    const ms = Date.parse(safeString(value));
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

function pruneConversationJsonArrayFile(filePath, label, favoriteContacts, cutoffMs) {
  let freed = 0;
  try {
    if (!fs.existsSync(filePath)) return 0;
    const beforeStat = fs.statSync(filePath);
    const items = readJsonArray(filePath, label);
    if (!items.length) return 0;

    const kept = items.filter(entry => {
      const contact = safeString(entry?.contact);
      if (contact && favoriteContacts.has(contact)) return true;
      const ms = conversationRecordTimeMs(entry);
      // Les anciens formats sans date sont conservés : on ne supprime jamais
      // une donnée dont l'âge ne peut pas être prouvé.
      if (!Number.isFinite(ms)) return true;
      return ms >= cutoffMs;
    });

    if (kept.length !== items.length) {
      writeJsonAtomic(filePath, kept);
      const afterSize = fs.existsSync(filePath) ? Number(fs.statSync(filePath).size || 0) : 0;
      freed = Math.max(0, Number(beforeStat.size || 0) - afterSize);
      console.log(`🧹 Rétention 15j : ${label} ${items.length} → ${kept.length} entrée(s), favoris préservés.`);
    }
  } catch (error) {
    console.warn(`⚠️ Rétention ${label} impossible :`, error.message);
  }
  return freed;
}

function conversationMediaBasenamesFromEntry(entry, output) {
  const add = value => {
    const raw = safeString(value);
    if (!raw) return;
    const fileName = safeString(raw.split('/').pop()).split('?')[0];
    if (fileName) {
      try { output.add(decodeURIComponent(fileName)); }
      catch { output.add(fileName); }
    }
  };

  add(entry?.attachment_url);
  add(entry?.attachment_filename);
  for (const attachment of Array.isArray(entry?.attachments) ? entry.attachments : []) {
    add(attachment?.filename);
    add(attachment?.url);
  }
}

function collectFavoriteConversationMediaBasenames(favoriteContacts) {
  const output = new Set();
  const inspect = entry => {
    if (!entry || !favoriteContacts.has(safeString(entry?.contact))) return;
    conversationMediaBasenamesFromEntry(entry, output);
  };

  for (const filePath of [CONVERSATIONS_LOG_PATH, INSTAGRAM_HISTORY_PATH, FACEBOOK_HISTORY_PATH]) {
    try {
      for (const entry of readJsonArray(filePath, path.basename(filePath))) inspect(entry);
    } catch {}
  }

  try {
    if (fs.existsSync(CONVERSATION_EVENTS_DIR)) {
      for (const entry of fs.readdirSync(CONVERSATION_EVENTS_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(CONVERSATION_EVENTS_DIR, entry.name);
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try { inspect(JSON.parse(line)); } catch {}
        }
      }
    }
  } catch {}

  return output;
}

function pruneConversationHistoryByRetention() {
  const cutoffMs = Date.now() - HISTORY_IMPORT_DAYS * 24 * 60 * 60 * 1000;
  const favorites = retentionProtectedConversationContacts();
  let freed = 0;
  freed += pruneConversationJsonArrayFile(CONVERSATIONS_LOG_PATH, 'conversation-log.json', favorites, cutoffMs);
  freed += pruneConversationJsonArrayFile(INSTAGRAM_HISTORY_PATH, 'instagram-history.json', favorites, cutoffMs);
  freed += pruneConversationJsonArrayFile(FACEBOOK_HISTORY_PATH, 'facebook-history.json', favorites, cutoffMs);
  return { freed, favorites, cutoffMs };
}

function pruneConversationEventsByRetention(favoriteContacts = retentionProtectedConversationContacts()) {
  let freed = 0;
  try {
    if (!fs.existsSync(CONVERSATION_EVENTS_DIR)) return 0;
    const cutoff = Date.now() - HISTORY_IMPORT_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(CONVERSATION_EVENTS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = /^conversation-events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry.name);
      if (!match) continue;
      const dayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
      if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue;

      const fullPath = path.join(CONVERSATION_EVENTS_DIR, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/).filter(Boolean);
        const keptLines = [];

        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (favoriteContacts.has(safeString(event?.contact))) keptLines.push(line);
          } catch {
            // Une ligne illisible n'est pas conservée dans un journal déjà hors rétention.
          }
        }

        if (keptLines.length) {
          fs.writeFileSync(fullPath, `${keptLines.join('\n')}\n`);
          const nextSize = Number(fs.statSync(fullPath).size || 0);
          freed += Math.max(0, Number(stat.size || 0) - nextSize);
        } else {
          fs.unlinkSync(fullPath);
          freed += Number(stat.size || 0);
        }
      } catch (error) {
        console.warn('⚠️ Storage Rescue : ancien journal conversation non nettoyé :', error.message);
      }
    }
  } catch (error) {
    console.warn('⚠️ Storage Rescue : rétention conversation-events impossible :', error.message);
  }
  return freed;
}

function pruneSafeConversationCaches({ emergency = false } = {}) {
  const retentionCutoff = Date.now() - HISTORY_IMPORT_DAYS * 24 * 60 * 60 * 1000;
  let freed = 0;

  // V6.33.1 : les gros historiques JSON sont réellement réduits à la fenêtre
  // de rétention. Les conversations ⭐ Favori restent intégralement conservées.
  const historyPrune = pruneConversationHistoryByRetention();
  freed += historyPrune.freed;
  const favoriteContacts = historyPrune.favorites || retentionProtectedConversationContacts();

  // Les journaux append-only sont eux aussi réduits, mais les lignes favorites
  // sont réécrites dans le fichier au lieu d'être supprimées.
  freed += pruneConversationEventsByRetention(favoriteContacts);

  // Les médias anciens sont supprimés, sauf s'ils sont encore référencés par
  // une conversation favorite.
  const favoriteMedia = collectFavoriteConversationMediaBasenames(favoriteContacts);
  freed += pruneFilesOlderThan(
    CONVERSATION_MEDIA_DIR,
    retentionCutoff,
    'conversation-media',
    { recursive: true, preserveBasenames: favoriteMedia }
  );

  // Les photos de profil sont un cache cosmétique. En manque d'espace, on peut
  // retirer les anciennes sans supprimer les conversations ni les données métier.
  if (emergency) {
    const profileCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    freed += pruneFilesOlderThan(CONVERSATION_PROFILE_DIR, profileCutoff, 'conversation-profile', { recursive: true });
  }
  return freed;
}

function storageBreakdown() {
  const sizeOfFile = filePath => {
    try { return fs.existsSync(filePath) ? Number(fs.statSync(filePath).size || 0) : 0; } catch { return 0; }
  };
  return {
    conversationMediaBytes: pathSizeBytes(CONVERSATION_MEDIA_DIR),
    conversationProfileBytes: pathSizeBytes(CONVERSATION_PROFILE_DIR),
    conversationEventsBytes: pathSizeBytes(CONVERSATION_EVENTS_DIR),
    backupsBytes: pathSizeBytes(BACKUPS_DIR),
    uploadsBytes: pathSizeBytes(UPLOADS_DIR),
    customizationsBytes: pathSizeBytes(CUSTOMIZATIONS_DIR),
    liveConversationLogBytes: sizeOfFile(CONVERSATIONS_LOG_PATH),
    instagramHistoryBytes: sizeOfFile(INSTAGRAM_HISTORY_PATH),
    facebookHistoryBytes: sizeOfFile(FACEBOOK_HISTORY_PATH),
    socialCommentsBytes: sizeOfFile(SOCIAL_COMMENTS_PATH),
    socialPostsBytes: sizeOfFile(SOCIAL_POSTS_PATH),
    notificationsBytes: sizeOfFile(NOTIFICATIONS_PATH),
    messageIdIndexBytes: sizeOfFile(MESSAGE_ID_INDEX_PATH),
    favoriteConversationCount: favoriteConversationContacts().size
  };
}


function loadRetention15MigrationState() {
  try {
    if (!fs.existsSync(RETENTION_15_MIGRATION_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(RETENTION_15_MIGRATION_PATH, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function ensureRetention15MigrationState() {
  let state = loadRetention15MigrationState();
  if (state) return state;
  state = {
    startedAt: new Date().toISOString(),
    appliedAt: '',
    retentionDays: HISTORY_IMPORT_DAYS
  };
  try { writeJsonAtomic(RETENTION_15_MIGRATION_PATH, state); } catch {}
  return state;
}

function retention15MigrationReady() {
  const state = ensureRetention15MigrationState();
  if (safeString(state?.appliedAt)) return true;
  const startedMs = Date.parse(safeString(state?.startedAt));
  return Number.isFinite(startedMs) && Date.now() - startedMs >= RETENTION_15_GRACE_MS;
}

function markRetention15MigrationApplied() {
  const state = ensureRetention15MigrationState();
  const next = {
    ...state,
    retentionDays: HISTORY_IMPORT_DAYS,
    appliedAt: safeString(state?.appliedAt) || new Date().toISOString()
  };
  try { writeJsonAtomic(RETENTION_15_MIGRATION_PATH, next); } catch {}
  return next;
}

function runSafeStorageMaintenance({ forceEmergency = false, skipConversationRetention = false } = {}) {
  const before = storageSpaceInfo();
  let freed = 0;

  // En urgence, commencer par ce qui ne nécessite aucune nouvelle écriture.
  // Cela crée immédiatement de la marge pour pouvoir ensuite compacter les JSON.
  if (forceEmergency) {
    freed += emergencyFreeDisposableStorage();
  } else {
    freed += cleanupStaleStorageTempFiles();
    freed += pruneJsonBackupTreeForStorageRescue(MAX_JSON_BACKUPS_PER_FILE);
    freed += compactExistingSnapshotBinaryCopies();
    freed += pruneFullSnapshotsForStorageRescue(MAX_FULL_SNAPSHOTS);
  }

  if (!skipConversationRetention) {
    freed += pruneSafeConversationCaches({ emergency: forceEmergency || (before && before.freeRatio < 0.20) });
  }

  freed += pruneNotificationsForStorageRescue();
  freed += pruneMessageIdIndexForStorageRescue();

  if (fs.existsSync(RECYCLE_DIR) && (forceEmergency || (before && before.freeRatio < 0.15))) {
    for (const entry of fs.readdirSync(RECYCLE_DIR, { withFileTypes: true })) {
      freed += removePathForStorageRescue(path.join(RECYCLE_DIR, entry.name), `recycle/${entry.name}`);
    }
  }
  const after = storageSpaceInfo();
  return { before, after, freedBytes: freed, breakdown: storageBreakdown() };
}

function runStartupStorageRescue() {
  if (!COMPACT_STORAGE_MODE) return;

  const before = storageSpaceInfo();
  const beforeProbe = storageWriteProbe();
  const lowSpace =
    !before ||
    before.freeBytes < STORAGE_RESCUE_TARGET_FREE_BYTES ||
    (Number.isFinite(before.freeRatio) && before.freeRatio < 0.20) ||
    !beforeProbe.writable;

  const retentionReady = retention15MigrationReady();
  // V6.33.1 : la période de grâce ne doit jamais laisser le Volume atteindre ENOSPC.
  // Si l'espace est critique, la rétention 15 jours demandée par l'administrateur
  // est appliquée immédiatement, tout en préservant les conversations ⭐ Favori.
  const emergencyRetentionOverride = lowSpace && !retentionReady;
  const result = runSafeStorageMaintenance({
    forceEmergency: lowSpace,
    skipConversationRetention: !retentionReady && !emergencyRetentionOverride
  });
  if (retentionReady || emergencyRetentionOverride) markRetention15MigrationApplied();
  const afterProbe = storageWriteProbe();

  if (!retentionReady && !emergencyRetentionOverride) {
    console.warn(
      '⭐ Migration rétention 15 jours : délai de sécurité actif pendant 12 h. ' +
      'Marquez maintenant les discussions importantes en Favori, puis utilisez « Nettoyer le stockage sûr » pour appliquer la rétention immédiatement.'
    );
  } else if (emergencyRetentionOverride) {
    console.warn(
      '🛟 Stockage critique : délai de grâce 15 jours annulé automatiquement pour éviter ENOSPC. Les conversations ⭐ Favori restent protégées.'
    );
  }

  console.log('🛟 MONDECO Storage Rescue', {
    mode: 'compact',
    retentionDays: HISTORY_IMPORT_DAYS,
    retentionApplied: retentionReady,
    estimatedFreed: humanBytes(result.freedBytes),
    freeBefore: result.before ? humanBytes(result.before.freeBytes) : 'inconnu',
    freeAfter: result.after ? humanBytes(result.after.freeBytes) : 'inconnu',
    writableBefore: beforeProbe.writable,
    writableAfter: afterProbe.writable,
    errorCode: afterProbe.errorCode || null
  });
}


function timestampId(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');

  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}-` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}-` +
    ms
  );
}

function ensurePersistenceSafety() {
  const persistentConfigured =
    !samePath(DATA_DIR, APP_DIR);

  const mountPath = safeString(
    process.env.RAILWAY_VOLUME_MOUNT_PATH
  );

  if (
    IS_RAILWAY &&
    PERSISTENCE_STRICT &&
    !persistentConfigured
  ) {
    throw new Error(
      'STOCKAGE PERSISTANT OBLIGATOIRE : Railway est actif mais DATA_DIR pointe vers /app. ' +
      'Montez un Volume sur /data et définissez DATA_DIR=/data.'
    );
  }

  if (
    IS_RAILWAY &&
    PERSISTENCE_STRICT &&
    mountPath &&
    !(
      samePath(DATA_DIR, mountPath) ||
      path.resolve(DATA_DIR).startsWith(
        path.resolve(mountPath) + path.sep
      )
    )
  ) {
    throw new Error(
      `STOCKAGE PERSISTANT MAL CONFIGURÉ : DATA_DIR=${DATA_DIR} ` +
      `mais le Volume Railway est monté sur ${mountPath}.`
    );
  }

  const writeProbe = storageWriteProbe();
  if (!writeProbe.writable) {
    const space = storageSpaceInfo();
    const details = [
      writeProbe.errorCode ? `code=${writeProbe.errorCode}` : '',
      space ? `libre=${humanBytes(space.freeBytes)}/${humanBytes(space.totalBytes)}` : '',
      writeProbe.errorMessage ? writeProbe.errorMessage : ''
    ].filter(Boolean).join(' • ');

    throw new Error(
      `Le dossier de données ${DATA_DIR} n'est pas accessible en écriture` +
      `${details ? ` (${details})` : ''}.`
    );
  }
}

function pruneFiles(directory, maxFiles) {
  try {
    if (!fs.existsSync(directory)) return;

    const files = fs
      .readdirSync(directory)
      .map(name => {
        const fullPath = path.join(directory, name);

        try {
          const stat = fs.statSync(fullPath);

          return stat.isFile()
            ? {
                name,
                fullPath,
                mtimeMs: stat.mtimeMs
              }
            : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files.slice(maxFiles)) {
      try {
        fs.unlinkSync(file.fullPath);
      } catch (error) {
        console.warn(
          '⚠️ Nettoyage ancien backup impossible :',
          error.message
        );
      }
    }
  } catch (error) {
    console.warn(
      '⚠️ Nettoyage des backups impossible :',
      error.message
    );
  }
}

function backupJsonVersion(filePath) {
  try {
    if (!fileExistsWithContent(filePath)) return null;

    if (COMPACT_STORAGE_MODE) {
      try {
        const stat = fs.statSync(filePath);
        if (Number(stat.size || 0) > VERSIONED_BACKUP_MAX_BYTES) {
          // Les gros historiques disposent déjà de leur fichier actif et de
          // l'écriture atomique. Ne pas multiplier les copies versionnées sur
          // un Volume Free de 500 MB.
          return null;
        }
      } catch {}
    }

    const baseName =
      path.basename(filePath, path.extname(filePath));

    const ext =
      path.extname(filePath) || '.json';

    const targetDir =
      path.join(JSON_BACKUPS_DIR, baseName);

    fs.mkdirSync(targetDir, { recursive: true });

    const backupPath =
      path.join(
        targetDir,
        `${baseName}-${timestampId()}${ext}`
      );

    fs.copyFileSync(
      filePath,
      backupPath
    );

    pruneFiles(
      targetDir,
      MAX_JSON_BACKUPS_PER_FILE
    );

    return backupPath;
  } catch (error) {
    console.warn(
      `⚠️ Backup versionné impossible pour ${path.basename(filePath)} :`,
      error.message
    );

    return null;
  }
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;

  fs.mkdirSync(targetDir, { recursive: true });

  const entries =
    fs.readdirSync(
      sourceDir,
      { withFileTypes: true }
    );

  for (const entry of entries) {
    const source =
      path.join(sourceDir, entry.name);

    const target =
      path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(
        source,
        target
      );
    } else if (entry.isFile()) {
      fs.copyFileSync(
        source,
        target
      );
    }
  }
}

function clearDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(
      directory,
      { recursive: true }
    );
    return;
  }

  for (
    const entry
    of fs.readdirSync(
      directory,
      { withFileTypes: true }
    )
  ) {
    const fullPath =
      path.join(
        directory,
        entry.name
      );

    if (entry.isDirectory()) {
      fs.rmSync(
        fullPath,
        {
          recursive: true,
          force: true
        }
      );
    } else {
      fs.unlinkSync(fullPath);
    }
  }
}

function archiveFileBeforeDelete(filePath, category = 'files') {
  try {
    if (
      !filePath ||
      !fs.existsSync(filePath)
    ) {
      return null;
    }

    const targetDir =
      path.join(
        RECYCLE_DIR,
        category
      );

    fs.mkdirSync(
      targetDir,
      { recursive: true }
    );

    const target =
      path.join(
        targetDir,
        `${timestampId()}-${path.basename(filePath)}`
      );

    fs.copyFileSync(
      filePath,
      target
    );

    deleteFileIfExists(
      filePath
    );

    return target;
  } catch (error) {
    console.warn(
      '⚠️ Archivage avant suppression impossible :',
      error.message
    );

    // Ne jamais bloquer une opération commerciale seulement
    // parce que la copie de sécurité n'a pas pu être créée.
    deleteFileIfExists(
      filePath
    );

    return null;
  }
}

function snapshotFiles() {
  return [
    {
      source: PRODUCTS_PATH,
      name: 'products.json'
    },
    {
      source: INSTRUCTIONS_PATH,
      name: 'instructions.json'
    },
    {
      source: SETTINGS_PATH,
      name: 'settings.json'
    },
    {
      source: CUSTOMIZATIONS_PATH,
      name: 'customization-requests.json'
    },
    {
      source: COMMERCIAL_CORRECTIONS_PATH,
      name: 'commercial-corrections.json'
    },
    {
      source: QUICK_REPLIES_PATH,
      name: 'quick-replies.json'
    }
,
    {
      source: USERS_PATH,
      name: 'users.json'
    }
,
    {
      source: CONVERSATION_STATE_PATH_ADMIN,
      name: 'conversation-state.json'
    },
    {
      source: CONVERSATIONS_LOG_PATH,
      name: 'conversation-log.json'
    },
    {
      source: INSTAGRAM_HISTORY_PATH,
      name: 'instagram-history.json'
    },
    {
      source: INSTAGRAM_HISTORY_SYNC_STATE_PATH,
      name: 'instagram-history-sync.json'
    },
    {
      source: FACEBOOK_HISTORY_PATH,
      name: 'facebook-history.json'
    },
    {
      source: FACEBOOK_HISTORY_SYNC_STATE_PATH,
      name: 'facebook-history-sync.json'
    },
    {
      source: SOCIAL_COMMENTS_PATH,
      name: 'social-comments.json'
    },
    {
      source: SOCIAL_POSTS_PATH,
      name: 'social-posts.json'
    },
    {
      source: SOCIAL_COMMENTS_SYNC_STATE_PATH,
      name: 'social-comments-sync.json'
    },
    {
      source: NOTIFICATIONS_PATH,
      name: 'notifications.json'
    },
    {
      source: MESSAGE_ID_INDEX_PATH,
      name: 'conversation-message-ids.jsonl'
    }
,
    {
      source: WOOCOMMERCE_SYNC_PATH,
      name: 'woocommerce-sync.json'
    },
    { source: SCHEDULES_PATH, name: 'schedules.json' },
    { source: TASKS_PATH, name: 'tasks.json' },
    { source: SLA_EVENTS_PATH, name: 'sla-events.json' },
    { source: DAILY_REPORTS_PATH, name: 'daily-reports.json' },
    { source: ATTENDANCE_PATH, name: 'attendance-log.json' },
    { source: TEAM_ACTIVITY_PATH, name: 'team-activity.jsonl' }
  ];
}

function snapshotMetadata(snapshotDir) {
  const filePath =
    path.join(
      snapshotDir,
      'snapshot-meta.json'
    );

  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    return JSON.parse(
      fs.readFileSync(
        filePath,
        'utf8'
      ) || '{}'
    );
  } catch {
    return {};
  }
}

function listFullSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(
      SNAPSHOTS_DIR,
      { withFileTypes: true }
    )
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const fullPath =
        path.join(
          SNAPSHOTS_DIR,
          entry.name
        );

      const stat =
        fs.statSync(fullPath);

      const meta =
        snapshotMetadata(fullPath);

      return {
        id: entry.name,
        createdAt:
          meta.createdAt ||
          stat.mtime.toISOString(),
        reason:
          meta.reason ||
          'manual',
        productCount:
          Number(meta.productCount || 0),
        instructionCount:
          Number(meta.instructionCount || 0),
        customizationCount:
          Number(meta.customizationCount || 0)
      };
    })
    .sort(
      (a, b) =>
        new Date(b.createdAt) -
        new Date(a.createdAt)
    );
}

function pruneFullSnapshots() {
  const snapshots =
    listFullSnapshots();

  for (
    const snapshot
    of snapshots.slice(
      MAX_FULL_SNAPSHOTS
    )
  ) {
    try {
      fs.rmSync(
        path.join(
          SNAPSHOTS_DIR,
          snapshot.id
        ),
        {
          recursive: true,
          force: true
        }
      );
    } catch (error) {
      console.warn(
        '⚠️ Suppression ancien snapshot impossible :',
        error.message
      );
    }
  }
}

function createFullSnapshot(reason = 'manual') {
  const id =
    `snapshot-${timestampId()}`;

  const snapshotDir =
    path.join(
      SNAPSHOTS_DIR,
      id
    );

  fs.mkdirSync(
    snapshotDir,
    { recursive: true }
  );

  const compactSnapshotNames = new Set([
    'products.json',
    'instructions.json',
    'settings.json',
    'customization-requests.json',
    'commercial-corrections.json',
    'quick-replies.json',
    'users.json',
    'conversation-state.json',
    'woocommerce-sync.json',
    'schedules.json',
    'tasks.json',
    'daily-reports.json'
  ]);

  const filesToSnapshot = COMPACT_STORAGE_MODE
    ? snapshotFiles().filter(item => compactSnapshotNames.has(item.name))
    : snapshotFiles();

  for (const item of filesToSnapshot) {
    if (fs.existsSync(item.source)) {
      fs.copyFileSync(
        item.source,
        path.join(
          snapshotDir,
          item.name
        )
      );
    }
  }

  if (!COMPACT_STORAGE_MODE) {
    copyDirectoryRecursive(
      UPLOADS_DIR,
      path.join(
        snapshotDir,
        'uploads'
      )
    );

    copyDirectoryRecursive(
      CUSTOMIZATIONS_DIR,
      path.join(
        snapshotDir,
        'customizations'
      )
    );

    copyDirectoryRecursive(
      CONVERSATION_MEDIA_DIR,
      path.join(
        snapshotDir,
        'conversation-media'
      )
    );

    copyDirectoryRecursive(
      CONVERSATION_PROFILE_DIR,
      path.join(
        snapshotDir,
        'conversation-profile'
      )
    );

    copyDirectoryRecursive(
      CONVERSATION_EVENTS_DIR,
      path.join(
        snapshotDir,
        'conversation-events'
      )
    );
  }

  const products =
    readJsonArray(
      PRODUCTS_PATH,
      'products.json'
    );

  const instructions =
    readJsonArray(
      INSTRUCTIONS_PATH,
      'instructions.json'
    );

  const customizations =
    readJsonArray(
      CUSTOMIZATIONS_PATH,
      'customization-requests.json'
    );

  const meta = {
    id,
    createdAt:
      new Date().toISOString(),
    reason:
      safeString(reason) || 'manual',
    productCount:
      products.length,
    instructionCount:
      instructions.length,
    customizationCount:
      customizations.length,
    storageMode:
      COMPACT_STORAGE_MODE ? 'compact' : 'standard',
    includesBinaryCopies:
      !COMPACT_STORAGE_MODE
  };

  fs.writeFileSync(
    path.join(
      snapshotDir,
      'snapshot-meta.json'
    ),
    JSON.stringify(
      meta,
      null,
      2
    ),
    'utf8'
  );

  pruneFullSnapshots();

  console.log(
    `💾 Snapshot créé : ${id}`
  );

  return meta;
}

function restoreFullSnapshot(snapshotId) {
  const safeId =
    path.basename(
      safeString(snapshotId)
    );

  if (!safeId) {
    throw new Error(
      'Sauvegarde invalide.'
    );
  }

  const snapshotDir =
    path.join(
      SNAPSHOTS_DIR,
      safeId
    );

  if (
    !fs.existsSync(snapshotDir) ||
    !fs.statSync(snapshotDir).isDirectory()
  ) {
    throw new Error(
      'Sauvegarde introuvable.'
    );
  }

  // Protection avant restauration.
  createFullSnapshot(
    `before-restore-${safeId}`
  );

  for (const item of snapshotFiles()) {
    const source =
      path.join(
        snapshotDir,
        item.name
      );

    if (fs.existsSync(source)) {
      backupJsonVersion(
        item.source
      );

      fs.copyFileSync(
        source,
        item.source
      );
    }
  }

  const snapshotUploads =
    path.join(
      snapshotDir,
      'uploads'
    );

  if (fs.existsSync(snapshotUploads)) {
    clearDirectory(
      UPLOADS_DIR
    );

    copyDirectoryRecursive(
      snapshotUploads,
      UPLOADS_DIR
    );
  }

  const snapshotCustomizations =
    path.join(
      snapshotDir,
      'customizations'
    );

  if (
    fs.existsSync(
      snapshotCustomizations
    )
  ) {
    clearDirectory(
      CUSTOMIZATIONS_DIR
    );

    copyDirectoryRecursive(
      snapshotCustomizations,
      CUSTOMIZATIONS_DIR
    );
  }

  const snapshotConversationMedia =
    path.join(
      snapshotDir,
      'conversation-media'
    );

  if (
    fs.existsSync(
      snapshotConversationMedia
    )
  ) {
    clearDirectory(
      CONVERSATION_MEDIA_DIR
    );

    copyDirectoryRecursive(
      snapshotConversationMedia,
      CONVERSATION_MEDIA_DIR
    );
  }

  const snapshotConversationProfile =
    path.join(
      snapshotDir,
      'conversation-profile'
    );

  if (
    fs.existsSync(
      snapshotConversationProfile
    )
  ) {
    clearDirectory(
      CONVERSATION_PROFILE_DIR
    );

    copyDirectoryRecursive(
      snapshotConversationProfile,
      CONVERSATION_PROFILE_DIR
    );
  }

  const snapshotConversationEvents =
    path.join(
      snapshotDir,
      'conversation-events'
    );

  if (
    fs.existsSync(
      snapshotConversationEvents
    )
  ) {
    clearDirectory(
      CONVERSATION_EVENTS_DIR
    );

    copyDirectoryRecursive(
      snapshotConversationEvents,
      CONVERSATION_EVENTS_DIR
    );
  }

  markInstructionsMigrationDone();

  console.log(
    `♻️ Snapshot restauré : ${safeId}`
  );

  return snapshotMetadata(
    snapshotDir
  );
}

function createExternalDataExport() {
  return {
    exportVersion: 1,
    createdAt:
      new Date().toISOString(),
    dataDir:
      DATA_DIR,
    products:
      loadProducts(),
    instructions:
      loadInstructions(),
    settings:
      getBotSettings(),
    customizations:
      loadCustomizations(),
    commercialCorrections:
      loadCommercialCorrections(),
    quickReplies:
      loadQuickReplies(),
    socialComments:
      loadSocialComments(),
    socialPosts:
      loadSocialPosts(),
    socialCommentsSync:
      loadSocialCommentsSyncState(),
    woocommerceSync:
      loadWooCommerceSyncState(),
    note:
      COMPACT_STORAGE_MODE
        ? 'Cet export JSON contient les données structurées. En mode stockage compact, les médias restent dans leurs dossiers actifs du Volume et ne sont pas dupliqués dans les snapshots.'
        : 'Cet export JSON contient les données structurées. Les images restent protégées dans le Volume et les snapshots complets /data/backups/snapshots.'
  };
}

function ensureDailySnapshot() {
  const space = storageSpaceInfo();
  if (space && (space.freeBytes < STORAGE_RESCUE_TARGET_FREE_BYTES || (Number.isFinite(space.freeRatio) && space.freeRatio < 0.25))) {
    console.warn('🧹 Snapshot quotidien ignoré : marge de stockage insuffisante.');
    return;
  }
  try {
    const today =
      new Date()
        .toISOString()
        .slice(0, 10);

    const existsToday =
      listFullSnapshots()
        .some(snapshot =>
          String(
            snapshot.createdAt
          ).slice(0, 10) === today
        );

    if (!existsToday) {
      createFullSnapshot(
        'automatic-daily'
      );
    }
  } catch (error) {
    console.warn(
      '⚠️ Snapshot quotidien impossible :',
      error.message
    );
  }
}


function writeJsonAtomic(filePath, data) {
  // V6.33.1 : écriture atomique avec garde-fou ENOSPC.
  // Quand le Volume manque d'espace, on supprime d'abord uniquement les caches
  // et sauvegardes régénérables puis on retente une seule fois.
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const backupPath = `${filePath}.bak`;
  const serialized = JSON.stringify(data, null, 2);
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  const spaceBefore = storageSpaceInfo();
  const lowHeadroom = Boolean(
    spaceBefore &&
    spaceBefore.freeBytes < Math.max(STORAGE_CRITICAL_FREE_BYTES, Math.ceil(serializedBytes * 1.35))
  );
  const keepFullBackup =
    !lowHeadroom &&
    (!COMPACT_STORAGE_MODE || serializedBytes <= VERSIONED_BACKUP_MAX_BYTES);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (fileExistsWithContent(filePath) && !lowHeadroom) {
    backupJsonVersion(filePath);

    if (keepFullBackup) {
      try {
        fs.copyFileSync(filePath, backupPath);
      } catch (error) {
        console.warn('⚠️ Backup JSON impossible :', error.message);
      }
    } else {
      deleteFileIfExists(backupPath);
    }
  } else if (lowHeadroom) {
    // Ne pas créer une nouvelle copie quand le Volume est déjà proche de la limite.
    deleteFileIfExists(backupPath);
  }

  const cleanupTemp = () => {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  };

  const atomicAttempt = () => {
    fs.writeFileSync(tempPath, serialized, 'utf8');
    fs.renameSync(tempPath, filePath);
  };

  try {
    atomicAttempt();
    return;
  } catch (error) {
    cleanupTemp();
    if (safeString(error?.code) !== 'ENOSPC') throw error;

    console.warn(`🛟 ENOSPC pendant ${path.basename(filePath)} : nettoyage automatique puis nouvelle tentative.`);
    emergencyFreeDisposableStorage();

    try {
      atomicAttempt();
      return;
    } catch (retryError) {
      cleanupTemp();
      if (safeString(retryError?.code) !== 'ENOSPC') throw retryError;

      // Dernier recours : lorsqu'on compacte un gros JSON vers une version plus
      // petite, l'écriture directe libère les blocs de l'ancien fichier au fur
      // et à mesure. Ce mode n'est utilisé qu'en situation ENOSPC.
      let currentSize = 0;
      try { currentSize = fs.existsSync(filePath) ? Number(fs.statSync(filePath).size || 0) : 0; } catch {}
      if (currentSize > serializedBytes) {
        console.warn(`🛟 Compactage direct d'urgence : ${path.basename(filePath)} ${humanBytes(currentSize)} → ${humanBytes(serializedBytes)}.`);
        fs.writeFileSync(filePath, serialized, 'utf8');
        return;
      }
      throw retryError;
    }
  } finally {
    cleanupTemp();
  }
}

function readJsonArray(filePath, label) {
  const backupPath = `${filePath}.bak`;

  function read(candidate) {
    if (!fileExistsWithContent(candidate)) return null;

    const parsed = JSON.parse(
      fs.readFileSync(candidate, 'utf8')
    );

    return Array.isArray(parsed) ? parsed : [];
  }

  try {
    const data = read(filePath);
    return data === null ? [] : data;
  } catch (error) {
    console.error(`❌ Lecture ${label} impossible :`, error.message);

    try {
      const backup = read(backupPath);
      if (backup !== null) {
        console.warn(`♻️ ${label} restauré depuis backup`);
        return backup;
      }
    } catch (backupError) {
      console.error(
        `❌ Backup ${label} invalide :`,
        backupError.message
      );
    }

    return [];
  }
}


// ============================================================
// V6.26 — STOCKAGE COMMENTAIRES / PUBLICATIONS SOCIALES
// ============================================================

// V6.34.2 — suppression définitive MONDECO.
// On conserve uniquement une empreinte SHA-256 irréversible pour empêcher
// qu'une synchronisation Meta réimporte un élément volontairement supprimé.
// L'empreinte ne permet pas de récupérer le texte, l'auteur ou la conversation.
let purgedRecordHashesCache = { stamp:'', set:new Set() };

function purgeRecordHash(kind, identity) {
  const raw = `${safeString(kind)}|${safeString(identity)}`;
  if (!safeString(identity)) return '';
  return crypto.createHash('sha256').update(`mondeco-purge-v1|${raw}`).digest('hex');
}

function loadPurgedRecordHashes() {
  const stamp = fileChangeStamp(PURGED_RECORD_HASHES_PATH);
  if (purgedRecordHashesCache.stamp === stamp) return purgedRecordHashesCache.set;
  let hashes = [];
  try {
    if (fs.existsSync(PURGED_RECORD_HASHES_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PURGED_RECORD_HASHES_PATH,'utf8') || '{}');
      hashes = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.hashes) ? parsed.hashes : []);
    }
  } catch (error) {
    console.warn('⚠️ Lecture empreintes suppression :', error.message);
  }
  const set = new Set(hashes.map(safeString).filter(Boolean));
  purgedRecordHashesCache = { stamp, set };
  return set;
}

function savePurgedRecordHashes(set) {
  const hashes = [...(set instanceof Set ? set : new Set())].map(safeString).filter(Boolean).slice(-100000);
  writeJsonAtomic(PURGED_RECORD_HASHES_PATH, { version:1, hashes });
  purgedRecordHashesCache = { stamp:fileChangeStamp(PURGED_RECORD_HASHES_PATH), set:new Set(hashes) };
}

function rememberPurgedHashes(values = []) {
  const set = new Set(loadPurgedRecordHashes());
  let changed = false;
  for (const value of Array.isArray(values) ? values : [values]) {
    const hash = safeString(value);
    if (hash && !set.has(hash)) { set.add(hash); changed = true; }
  }
  if (changed) savePurgedRecordHashes(set);
  return changed;
}

function conversationEntryBaseIdentity(entry = {}) {
  const channel = safeString(entry?.channel).toLowerCase() ||
    (safeString(entry?.contact).startsWith('instagram:') ? 'instagram' : safeString(entry?.contact).startsWith('facebook:') ? 'facebook' : 'whatsapp');
  const id = safeString(entry?.message_id || entry?.meta_message_id || entry?.mid || entry?.id);
  if (id) return `${channel}|id:${id}`;
  const attachments = Array.isArray(entry?.attachments) ? entry.attachments : [];
  const attachmentIds = attachments.map(item => safeString(item?.id || item?.media_id || item?.url)).filter(Boolean).join(',');
  return `${channel}|fp:${safeString(entry?.contact)}|${safeString(entry?.time || entry?.created_time || entry?.timestamp)}|${safeString(entry?.action)}|${safeString(entry?.source)}|${attachmentIds}`;
}

function conversationEntryPartPurgeHash(entry = {}, part = 'entry') {
  const base = conversationEntryBaseIdentity(entry);
  const value = part === 'incoming'
    ? `${base}|incoming|${safeString(entry?.incoming)}`
    : part === 'reply'
      ? `${base}|reply|${safeString(entry?.reply)}|${safeString(entry?.reply_time)}`
      : `${base}|entry`;
  return purgeRecordHash('conversation', value);
}

function socialCommentPurgeHash(comment = {}) {
  const channel = safeString(comment?.channel).toLowerCase();
  const id = safeString(comment?.commentId || comment?.id || comment?.comment_id);
  return purgeRecordHash('comment', `${channel}|${id}`);
}

function attachmentDirectionForPurge(entry = {}) {
  const explicit = safeString(entry?.attachment_direction).toLowerCase();
  if (explicit) return explicit;
  const source = safeString(entry?.source).toLowerCase();
  const sender = safeString(entry?.sender_kind).toLowerCase();
  const direction = safeString(entry?.direction).toLowerCase();
  if (direction === 'outgoing' || sender === 'human' || sender === 'meta' || source.startsWith('commercial')) return 'outgoing';
  return 'incoming';
}

function applyConversationPurgeTombstones(entry = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const hashes = loadPurgedRecordHashes();
  const incomingHash = conversationEntryPartPurgeHash(entry,'incoming');
  const replyHash = conversationEntryPartPurgeHash(entry,'reply');
  let next = { ...entry };
  let changed = false;

  if (safeString(next?.incoming) || attachmentDirectionForPurge(next) === 'incoming') {
    if (incomingHash && hashes.has(incomingHash)) {
      next.incoming = '';
      if (attachmentDirectionForPurge(next) === 'incoming') {
        next.attachments = [];
        next.attachment_type = '';
        next.attachment_url = '';
      }
      changed = true;
    }
  }
  if (safeString(next?.reply) || attachmentDirectionForPurge(next) === 'outgoing') {
    if (replyHash && hashes.has(replyHash)) {
      next.reply = '';
      next.reply_sent = false;
      if (attachmentDirectionForPurge(next) === 'outgoing') {
        next.attachments = [];
        next.attachment_type = '';
        next.attachment_url = '';
      }
      changed = true;
    }
  }

  const meaningful = Boolean(
    safeString(next?.incoming) || safeString(next?.reply) ||
    (Array.isArray(next?.attachments) && next.attachments.length) ||
    ['facebook_message_read','facebook_message_delivery','facebook_message_reaction'].includes(safeString(next?.action))
  );
  return meaningful ? next : null;
}

function loadSocialComments() {
  const hashes = loadPurgedRecordHashes();
  return readJsonArray(SOCIAL_COMMENTS_PATH, 'social-comments.json')
    .filter(item => {
      const hash = socialCommentPurgeHash(item);
      return !hash || !hashes.has(hash);
    });
}

function loadSocialPosts() {
  return readJsonArray(SOCIAL_POSTS_PATH, 'social-posts.json');
}

function pruneSocialRecords(items, timeFields = ['createdAt','updatedAt']) {
  const cutoff = Date.parse(historyImportCutoffIso());
  const sorted = (Array.isArray(items) ? items : [])
    .filter(item => item && typeof item === 'object')
    .filter(item => {
      const candidates = timeFields.map(field => Date.parse(safeString(item?.[field]))).filter(Number.isFinite);
      if (!candidates.length) return true;
      return Math.max(...candidates) >= cutoff;
    })
    .sort((a,b) => {
      const aMs = Date.parse(safeString(a?.createdAt || a?.updatedAt)) || 0;
      const bMs = Date.parse(safeString(b?.createdAt || b?.updatedAt)) || 0;
      return bMs - aMs;
    });
  // Limite de sécurité : 30 000 commentaires dans la fenêtre de rétention, sans dupliquer les médias.
  return sorted.slice(0, 30000);
}

function saveSocialComments(items) {
  writeJsonAtomic(SOCIAL_COMMENTS_PATH, pruneSocialRecords(items));
}

function saveSocialPosts(items) {
  writeJsonAtomic(SOCIAL_POSTS_PATH, pruneSocialRecords(items, ['createdAt','updatedAt','lastCommentAt']).slice(0, 5000));
}

function socialKey(channel, id) {
  const cleanChannel = safeString(channel).toLowerCase();
  const cleanId = safeString(id);
  return cleanChannel && cleanId ? `${cleanChannel}:${cleanId}` : '';
}

function mergeSocialRecords(current, incoming, keyField = 'key') {
  const map = new Map();
  for (const item of Array.isArray(current) ? current : []) {
    const key = safeString(item?.[keyField]);
    if (key) map.set(key, item);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = safeString(item?.[keyField]);
    if (!key) continue;
    const previous = map.get(key) || {};
    map.set(key, {
      ...previous,
      ...item,
      readBy: Array.isArray(item?.readBy)
        ? item.readBy
        : (Array.isArray(previous?.readBy) ? previous.readBy : []),
      updatedAt: safeString(item?.updatedAt) || new Date().toISOString()
    });
  }
  return [...map.values()];
}

function upsertSocialComments(records) {
  const hashes = loadPurgedRecordHashes();
  const accepted = (Array.isArray(records) ? records : []).filter(item => {
    const hash = socialCommentPurgeHash(item);
    return !hash || !hashes.has(hash);
  });
  const merged = mergeSocialRecords(loadSocialComments(), accepted, 'key');
  saveSocialComments(merged);
  return merged;
}

function upsertSocialPosts(records) {
  const merged = mergeSocialRecords(loadSocialPosts(), records, 'key');
  saveSocialPosts(merged);
  return merged;
}

function socialCommentReadByUser(comment, user) {
  const key = notificationUserKey(user);
  return Array.isArray(comment?.readBy) && comment.readBy.includes(key);
}

function markSocialCommentRead(commentKey, user) {
  const key = notificationUserKey(user);
  let found = null;
  const comments = loadSocialComments().map(comment => {
    if (safeString(comment?.key) !== safeString(commentKey)) return comment;
    const readBy = Array.isArray(comment?.readBy) ? [...comment.readBy] : [];
    if (!readBy.includes(key)) readBy.push(key);
    found = { ...comment, readBy };
    return found;
  });
  if (found) saveSocialComments(comments);
  return found;
}

function socialPostMediaFromFacebook(post) {
  const attachment = Array.isArray(post?.attachments?.data) ? post.attachments.data[0] : null;
  const media = attachment?.media || {};
  return {
    mediaType: safeString(attachment?.media_type || attachment?.type),
    mediaUrl: safeString(media?.image?.src || post?.full_picture),
    thumbnailUrl: safeString(media?.image?.src || post?.full_picture),
    sourceUrl: safeString(attachment?.target?.url || attachment?.url)
  };
}

function normalizeFacebookPost(post = {}) {
  const id = safeString(post?.id);
  if (!id) return null;
  const media = socialPostMediaFromFacebook(post);
  return {
    key: socialKey('facebook', id),
    channel: 'facebook',
    postId: id,
    mediaId: '',
    caption: safeString(post?.message),
    createdAt: safeString(post?.created_time),
    updatedAt: new Date().toISOString(),
    permalink: safeString(post?.permalink_url),
    ...media,
    source: 'meta_sync'
  };
}

function normalizeFacebookComment(comment = {}, postId = '') {
  const id = safeString(comment?.id || comment?.comment_id);
  if (!id) return null;
  const from = comment?.from && typeof comment.from === 'object' ? comment.from : {};
  const parentId = safeString(comment?.parent?.id || comment?.parent_id);
  const attachment = comment?.attachment && typeof comment.attachment === 'object' ? comment.attachment : {};
  return {
    key: socialKey('facebook', id),
    channel: 'facebook',
    commentId: id,
    postId: safeString(postId || comment?.post_id),
    mediaId: '',
    parentId,
    text: safeString(comment?.message),
    authorId: safeString(from?.id || comment?.sender_id),
    authorName: safeString(from?.name || comment?.sender_name || 'Client Facebook'),
    authorUsername: '',
    authorAvatar: safeString(from?.picture?.data?.url),
    direction: safeString(from?.id || comment?.sender_id) === FACEBOOK_PAGE_ID ? 'outgoing' : 'incoming',
    createdAt: safeString(comment?.created_time) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permalink: safeString(comment?.permalink_url),
    isHidden: comment?.is_hidden === true,
    canHide: comment?.can_hide !== false,
    canRemove: comment?.can_remove !== false,
    canReply: true,
    canReplyPrivately: comment?.can_reply_privately !== false,
    replyCount: Number(comment?.comment_count || 0),
    attachmentUrl: safeString(attachment?.media?.image?.src || attachment?.url),
    attachmentType: safeString(attachment?.type),
    deleted: false,
    source: 'meta_sync'
  };
}

function normalizeInstagramPost(media = {}) {
  const id = safeString(media?.id);
  if (!id) return null;
  return {
    key: socialKey('instagram', id),
    channel: 'instagram',
    postId: id,
    mediaId: id,
    caption: safeString(media?.caption),
    createdAt: safeString(media?.timestamp),
    updatedAt: new Date().toISOString(),
    permalink: safeString(media?.permalink),
    mediaType: safeString(media?.media_type),
    mediaUrl: safeString(media?.media_url),
    thumbnailUrl: safeString(media?.thumbnail_url || media?.media_url),
    sourceUrl: safeString(media?.permalink),
    source: 'meta_sync'
  };
}

function normalizeInstagramComment(comment = {}, mediaId = '', parentId = '') {
  const id = safeString(comment?.id);
  if (!id) return null;
  const from = comment?.from && typeof comment.from === 'object' ? comment.from : {};
  return {
    key: socialKey('instagram', id),
    channel: 'instagram',
    commentId: id,
    postId: safeString(mediaId || comment?.media?.id),
    mediaId: safeString(mediaId || comment?.media?.id),
    parentId: safeString(parentId || comment?.parent_id),
    text: safeString(comment?.text),
    authorId: safeString(from?.id),
    authorName: safeString(comment?.username || from?.username || 'Client Instagram'),
    authorUsername: safeString(comment?.username || from?.username),
    authorAvatar: '',
    direction: safeString(from?.id) === INSTAGRAM_ACCOUNT_ID ? 'outgoing' : 'incoming',
    createdAt: safeString(comment?.timestamp) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permalink: '',
    isHidden: comment?.hidden === true,
    canHide: true,
    canRemove: true,
    canReply: true,
    canReplyPrivately: true,
    replyCount: Number(comment?.replies?.data?.length || 0),
    likeCount: Number(comment?.like_count || 0),
    attachmentUrl: '',
    attachmentType: '',
    deleted: false,
    source: 'meta_sync'
  };
}


function socialConversationProfileIndex() {
  const byId = new Map();
  const byUsername = new Map();
  // Les états persistants sont la source principale des avatars. Le petit cache
  // live (max 5000) complète l'index sans charger 15 jours d'historique.
  const recentProfileEntries = [];
  forEachJsonArrayObjectSync(CONVERSATIONS_LOG_PATH, item => recentProfileEntries.push(item));
  for (const entry of recentProfileEntries) {
    const channel = safeString(entry?.channel).toLowerCase();
    if (!['facebook','instagram'].includes(channel)) continue;
    const picture = safeString(entry?.profile_picture || entry?.profilePicture);
    if (!picture) continue;
    const external = safeString(entry?.external_contact || entry?.externalContact);
    const username = safeString(entry?.instagram_username || entry?.instagramUsername).replace(/^@/,'').toLowerCase();
    if (external) byId.set(`${channel}:${external}`, picture);
    if (username) byUsername.set(`${channel}:${username}`, picture);
  }
  const states = loadConversationStatesAdmin();
  for (const [contact,state] of Object.entries(states)) {
    const channel = safeString(state?.channel).toLowerCase();
    if (!['facebook','instagram'].includes(channel)) continue;
    const picture = safeString(state?.profilePicture);
    if (!picture) continue;
    const external = safeString(state?.externalContact || String(contact).replace(/^(instagram|facebook):/i,''));
    const username = safeString(state?.instagramUsername).replace(/^@/,'').toLowerCase();
    if (external) byId.set(`${channel}:${external}`, picture);
    if (username) byUsername.set(`${channel}:${username}`, picture);
  }
  return { byId, byUsername };
}

async function resolveSocialCommentProfile(comment, profileIndex = null) {
  if (!comment || comment.direction === 'outgoing') return comment;
  const now = new Date().toISOString();
  const checkedMs = Date.parse(safeString(comment?.authorAvatarCheckedAt));
  const hasAvatar = Boolean(safeString(comment?.authorAvatar));
  if (hasAvatar && Number.isFinite(checkedMs) && Date.now() - checkedMs < 7 * 24 * 60 * 60 * 1000) return comment;
  if (!hasAvatar && Number.isFinite(checkedMs) && Date.now() - checkedMs < 24 * 60 * 60 * 1000) return comment;

  const index = profileIndex || socialConversationProfileIndex();
  const channel = safeString(comment?.channel).toLowerCase();
  const authorId = safeString(comment?.authorId);
  const username = safeString(comment?.authorUsername).replace(/^@/,'').toLowerCase();
  let avatar = safeString(comment?.authorAvatar);
  let name = safeString(comment?.authorName);
  let resolvedUsername = safeString(comment?.authorUsername);

  if (!avatar && authorId) avatar = safeString(index.byId.get(`${channel}:${authorId}`));
  if (!avatar && username) avatar = safeString(index.byUsername.get(`${channel}:${username}`));

  if (!avatar && authorId) {
    try {
      if (channel === 'instagram') {
        const profile = await getInstagramHistoryProfile(authorId);
        avatar = safeString(profile?.profilePicture);
        name = safeString(profile?.name || name);
        resolvedUsername = safeString(profile?.username || resolvedUsername);
      } else if (channel === 'facebook') {
        const profile = await getFacebookHistoryProfile(authorId);
        avatar = safeString(profile?.profilePicture);
        name = safeString(profile?.name || name);
        if (!avatar) {
          try {
            const picture = await facebookGraphRequestPath(`${encodeURIComponent(authorId)}/picture?redirect=0&type=normal`);
            const remote = safeString(picture?.data?.url);
            if (remote) avatar = await persistFacebookHistoryProfilePicture(remote, authorId);
          } catch {}
        }
      }
    } catch {}
  }
  return {
    ...comment,
    authorAvatar: avatar,
    authorName: name || safeString(comment?.authorName),
    authorUsername: resolvedUsername || safeString(comment?.authorUsername),
    authorAvatarCheckedAt: now
  };
}

async function enrichSocialCommentProfiles(records, maxProfiles = 30) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return [];
  const index = socialConversationProfileIndex();
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const identity = `${safeString(item?.channel)}:${safeString(item?.authorId || item?.authorUsername || item?.commentId)}`;
    if (!seen.has(identity)) { seen.add(identity); unique.push(item); }
  }
  const resolvedByIdentity = new Map();
  const queue = unique.slice(0, Math.max(1, Math.min(60, Number(maxProfiles)||30)));
  // Petits lots parallèles : rapide pour l'interface sans provoquer une rafale
  // de dizaines de requêtes Meta qui pourrait toucher les limites API.
  for (let start = 0; start < queue.length; start += 6) {
    const batch = queue.slice(start, start + 6);
    const results = await Promise.all(batch.map(item => resolveSocialCommentProfile(item, index)));
    results.forEach((resolved, i) => {
      const item = batch[i];
      const identity = `${safeString(item?.channel)}:${safeString(item?.authorId || item?.authorUsername || item?.commentId)}`;
      resolvedByIdentity.set(identity, resolved);
    });
  }
  return list.map(item => {
    const identity = `${safeString(item?.channel)}:${safeString(item?.authorId || item?.authorUsername || item?.commentId)}`;
    const resolved = resolvedByIdentity.get(identity);
    return resolved ? { ...item, authorAvatar:safeString(resolved.authorAvatar), authorName:safeString(resolved.authorName||item.authorName), authorUsername:safeString(resolved.authorUsername||item.authorUsername), authorAvatarCheckedAt:safeString(resolved.authorAvatarCheckedAt) } : item;
  });
}

function copyFileIfTargetMissing(source, target, label) {
  try {
    if (samePath(source, target)) return false;
    if (!fileExistsWithContent(source)) return false;
    if (fileExistsWithContent(target)) return false;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);

    console.log(`✅ Migration ${label} vers ${target}`);
    return true;
  } catch (error) {
    console.warn(`⚠️ Migration ${label} impossible :`, error.message);
    return false;
  }
}

function copyMissingFiles(sourceDir, targetDir, label) {
  try {
    if (samePath(sourceDir, targetDir)) return 0;
    if (!fs.existsSync(sourceDir)) return 0;

    fs.mkdirSync(targetDir, { recursive: true });

    let copied = 0;
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);

      if (fs.existsSync(target)) continue;

      fs.copyFileSync(source, target);
      copied += 1;
    }

    if (copied > 0) {
      console.log(`✅ ${copied} fichier(s) ${label} migré(s)`);
    }

    return copied;
  } catch (error) {
    console.warn(`⚠️ Migration ${label} impossible :`, error.message);
    return 0;
  }
}

function mimeTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();

  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function extensionFromMimeType(mimetype) {
  if (mimetype === 'image/png') return '.png';
  if (mimetype === 'image/webp') return '.webp';
  return '.jpg';
}

// ============================================================
// MIGRATION DONNÉES
// ============================================================

function migrateLegacyData() {
  if (samePath(DATA_DIR, APP_DIR)) return;

  copyFileIfTargetMissing(
    LEGACY_PRODUCTS_PATH,
    PRODUCTS_PATH,
    'products.json'
  );

  copyFileIfTargetMissing(
    LEGACY_CUSTOMIZATIONS_PATH,
    CUSTOMIZATIONS_PATH,
    'customization-requests.json'
  );

  copyMissingFiles(
    LEGACY_UPLOADS_DIR,
    UPLOADS_DIR,
    'images produits'
  );

  copyMissingFiles(
    LEGACY_CUSTOMIZATIONS_DIR,
    CUSTOMIZATIONS_DIR,
    'images personnalisations'
  );
}

// ============================================================
// INSTRUCTIONS
// ============================================================

function loadLegacyBusinessInfo() {
  try {
    if (!fs.existsSync(LEGACY_BUSINESS_INFO_PATH)) return '';
    return fs.readFileSync(LEGACY_BUSINESS_INFO_PATH, 'utf8');
  } catch (error) {
    console.error('❌ business-info.txt :', error.message);
    return '';
  }
}

function parseInstructionBlocks(text) {
  return safeString(text)
    .split(/\n\s*\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const lines = block
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      return {
        title: lines[0] || `Instruction ${index + 1}`,
        content:
          lines.length > 1
            ? lines.slice(1).join('\n')
            : (lines[0] || '')
      };
    });
}

function createInstructionsFromLegacyBusinessInfo() {
  const text = loadLegacyBusinessInfo().trim();
  if (!text) return [];

  const now = new Date().toISOString();

  return parseInstructionBlocks(text).map(item => ({
    id: crypto.randomUUID(),
    title: item.title,
    content: item.content,
    active: true,
    source: 'business-info.txt',
    createdAt: now,
    updatedAt: now
  }));
}

function markInstructionsMigrationDone() {
  try {
    fs.writeFileSync(
      INSTRUCTIONS_MIGRATION_MARKER,
      new Date().toISOString(),
      'utf8'
    );
  } catch (error) {
    console.warn(
      '⚠️ Impossible de créer le marqueur instructions :',
      error.message
    );
  }
}

function initializePersistentInstructions() {
  try {
    // 1. /data/instructions.json existe déjà
    if (fs.existsSync(INSTRUCTIONS_PATH)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(INSTRUCTIONS_PATH, 'utf8') || '[]'
        );

        if (Array.isArray(parsed)) {
          if (parsed.length > 0) {
            if (!fs.existsSync(INSTRUCTIONS_MIGRATION_MARKER)) {
              markInstructionsMigrationDone();
            }

            console.log(
              `📋 Instructions persistantes trouvées : ${parsed.length}`
            );

            return parsed;
          }

          if (
            parsed.length === 0 &&
            fs.existsSync(INSTRUCTIONS_MIGRATION_MARKER)
          ) {
            console.log(
              '📋 instructions.json existe et contient 0 instruction.'
            );
            return [];
          }
        }
      } catch (error) {
        console.warn(
          '⚠️ instructions.json invalide :',
          error.message
        );
      }
    }

    // 2. Ancien instructions.json dans /app
    if (
      !samePath(LEGACY_INSTRUCTIONS_PATH, INSTRUCTIONS_PATH) &&
      fileExistsWithContent(LEGACY_INSTRUCTIONS_PATH)
    ) {
      try {
        const legacyInstructions = JSON.parse(
          fs.readFileSync(LEGACY_INSTRUCTIONS_PATH, 'utf8')
        );

        if (
          Array.isArray(legacyInstructions) &&
          legacyInstructions.length > 0
        ) {
          writeJsonAtomic(
            INSTRUCTIONS_PATH,
            legacyInstructions
          );

          markInstructionsMigrationDone();

          console.log(
            `✅ ${legacyInstructions.length} instruction(s) migrée(s) depuis /app`
          );

          return legacyInstructions;
        }
      } catch (error) {
        console.warn(
          '⚠️ Ancien instructions.json invalide :',
          error.message
        );
      }
    }

    // 3. Import business-info.txt une seule fois
    if (!fs.existsSync(INSTRUCTIONS_MIGRATION_MARKER)) {
      const imported =
        createInstructionsFromLegacyBusinessInfo();

      if (imported.length > 0) {
        writeJsonAtomic(
          INSTRUCTIONS_PATH,
          imported
        );

        markInstructionsMigrationDone();

        console.log(
          `✅ Import automatique business-info.txt : ${imported.length} instruction(s)`
        );

        return imported;
      }
    }

    // 4. Rien à importer
    if (!fs.existsSync(INSTRUCTIONS_PATH)) {
      writeJsonAtomic(INSTRUCTIONS_PATH, []);
    }

    return [];
  } catch (error) {
    console.error(
      '❌ Initialisation instructions persistantes :',
      error
    );

    return [];
  }
}

function loadInstructions() {
  if (!fs.existsSync(INSTRUCTIONS_PATH)) {
    return initializePersistentInstructions();
  }

  return readJsonArray(
    INSTRUCTIONS_PATH,
    'instructions.json'
  );
}

function saveInstructions(instructions) {
  writeJsonAtomic(
    INSTRUCTIONS_PATH,
    instructions
  );

  markInstructionsMigrationDone();
}

function instructionFingerprint(title, content) {
  return (
    `${safeString(title).toLowerCase()}::` +
    safeString(content).toLowerCase()
  );
}

// ============================================================
// PRODUITS
// ============================================================

function loadProducts() {
  return readJsonArray(
    PRODUCTS_PATH,
    'products.json'
  );
}

function saveProducts(products) {
  writeJsonAtomic(
    PRODUCTS_PATH,
    products
  );
}

function getLocalProductImagePath(product) {
  if (!product) return null;

  if (product.imageFilename) {
    return path.join(
      UPLOADS_DIR,
      path.basename(product.imageFilename)
    );
  }

  if (
    safeString(product.image).includes('/admin/uploads/')
  ) {
    return path.join(
      UPLOADS_DIR,
      path.basename(product.image)
    );
  }

  return null;
}

// ============================================================
// PERSONNALISATIONS
// ============================================================

function loadCustomizations() {
  return readJsonArray(
    CUSTOMIZATIONS_PATH,
    'customization-requests.json'
  );
}

function saveCustomizations(items) {
  writeJsonAtomic(
    CUSTOMIZATIONS_PATH,
    items
  );
}

// ============================================================
// CORRECTIONS COMMERCIALES
// ============================================================

const COMMERCIAL_CORRECTION_STATUSES =
  new Set([
    'pending',
    'approved',
    'ignored'
  ]);

const COMMERCIAL_PRODUCT_FIELDS = {
  price: 'Prix normal',
  promoPrice: 'Prix promotionnel',
  availability: 'Disponibilité',
  dimensions: 'Dimensions',
  composition: 'Composition',
  colors: 'Couleurs',
  showrooms: 'Showrooms',
  productUrl: 'Lien produit',
  categoryUrl: 'Lien catégorie',
  description: 'Description'
};


const DEFAULT_QUICK_REPLIES = [
  {
    title: 'Demander le modèle',
    shortcut: 'modele',
    content:
      'Avec plaisir. Envoyez-moi le nom du modèle qui vous intéresse et je vous confirme les informations actuelles.'
  },
  {
    title: 'Demander la ville',
    shortcut: 'ville',
    content:
      'Vous êtes dans quelle ville ? Je vous oriente vers le showroom MONDECO le plus proche.'
  },
  {
    title: 'Demander les dimensions',
    shortcut: 'dimensions',
    content:
      'Vous pouvez me donner les dimensions de votre espace ? Comme ça je vous conseille le modèle le plus adapté.'
  },
  {
    title: 'Visite showroom',
    shortcut: 'showroom',
    content:
      'Vous souhaitez voir le produit en showroom ? Dites-moi votre ville et je vous envoie l’adresse, le numéro et l’itinéraire.'
  },
  {
    title: 'Préparer un devis',
    shortcut: 'devis',
    content:
      'Je peux vous préparer un devis. Envoyez-moi les modèles souhaités ainsi que votre ville de livraison.'
  },
  {
    title: 'Livraison',
    shortcut: 'livraison',
    content:
      'Nous assurons la livraison en Tunisie. Donnez-moi votre ville pour vous orienter sur la suite de la commande.'
  }
];

function normalizeQuickReplyShortcut(value) {
  return safeString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function initializeQuickReplies() {
  if (fs.existsSync(QUICK_REPLIES_PATH)) {
    return;
  }

  const now =
    new Date().toISOString();

  const items =
    DEFAULT_QUICK_REPLIES.map(
      item => ({
        id: crypto.randomUUID(),
        title: item.title,
        shortcut: item.shortcut,
        content: item.content,
        active: true,
        createdAt: now,
        updatedAt: now
      })
    );

  writeJsonAtomic(
    QUICK_REPLIES_PATH,
    items
  );
}

function loadQuickReplies() {
  initializeQuickReplies();

  return readJsonArray(
    QUICK_REPLIES_PATH,
    'quick-replies.json'
  );
}

function saveQuickReplies(items) {
  writeJsonAtomic(
    QUICK_REPLIES_PATH,
    Array.isArray(items)
      ? items.slice(-500)
      : []
  );
}


// ============================================================
// V6.33.1 — Le catalogue produit reste séparé des réponses rapides.
// Les helpers ci-dessous sont conservés uniquement pour compatibilité interne,
// mais /api/quick-replies ne les expose plus aux commerciaux.
// ============================================================

function productAvailabilityLabel(value) {
  const raw = safeString(value).toLowerCase();
  if (!raw || raw === 'unknown') return '';
  const labels = {
    in_stock: 'Disponible',
    instock: 'Disponible',
    available: 'Disponible',
    disponible: 'Disponible',
    out_of_stock: 'Indisponible',
    outofstock: 'Indisponible',
    unavailable: 'Indisponible',
    indisponible: 'Indisponible',
    preorder: 'Sur commande',
    backorder: 'Sur commande'
  };
  return labels[raw] || safeString(value);
}

function productQuickReplyContent(product) {
  const name = safeString(product?.name);
  if (!name) return '';

  const lines = [`Bonjour 👋 Voici les informations pour ${name} :`];

  const promo = safeString(product?.promoPrice);
  const price = safeString(product?.price);
  if (promo) {
    lines.push(`Prix : ${promo}${price && price !== promo ? ` (au lieu de ${price})` : ''}`);
  } else if (price) {
    lines.push(`Prix : ${price}`);
  }

  const availability = productAvailabilityLabel(product?.availability);
  if (availability) lines.push(`Disponibilité : ${availability}`);

  const dimensions = safeString(product?.dimensions);
  if (dimensions) lines.push(`Dimensions : ${dimensions}`);

  const composition = safeString(product?.composition);
  if (composition) lines.push(`Composition : ${composition}`);

  const colors = safeString(product?.colors);
  if (colors) lines.push(`Couleurs : ${colors}`);

  const showrooms = safeString(product?.showrooms);
  if (showrooms) lines.push(`Showrooms : ${showrooms}`);

  const description = safeString(product?.description);
  if (description) lines.push(description.slice(0, 700));

  const productUrl = safeString(product?.productUrl);
  if (productUrl) lines.push(productUrl);

  return lines.join('\n');
}


function productQuickReplyAliases(name) {
  const full = normalizeQuickReplyShortcut(name);
  const genericWords = new Set([
    'salon','canape','canape-angle','chambre','adulte','enfant','junior',
    'table','manger','salle','pack','lit','meuble','tv','bureau','chaise',
    'armoire','commode','chevet','coin','angle','u','set','collection'
  ]);

  const words = full.split('-').filter(Boolean);
  const modelWords = words.filter(word => !genericWords.has(word));
  const aliases = [
    modelWords.join('-'),
    modelWords.at(-1) || '',
    full
  ].filter(Boolean);

  return [...new Set(aliases)];
}

function generatedProductQuickReplies(existingShortcuts = new Set()) {
  const seen = new Set(existingShortcuts);
  const output = [];

  for (const product of loadProducts()) {
    if (!product || product.active === false) continue;
    const name = safeString(product?.name);
    const aliases = productQuickReplyAliases(name);
    const shortcut = aliases.find(alias => !seen.has(alias)) || '';
    const content = productQuickReplyContent(product);
    if (!name || !shortcut || !content) continue;

    const acceptedAliases = aliases.filter(alias => !seen.has(alias));
    if (!acceptedAliases.length) continue;
    for (const alias of acceptedAliases) seen.add(alias);

    output.push({
      id: `product:${safeString(product?.id) || shortcut}`,
      title: `📦 ${name}`,
      shortcut,
      aliases: acceptedAliases,
      content,
      active: true,
      generated: true,
      source: 'product',
      productId: safeString(product?.id)
    });
  }

  return output;
}

function loadCommercialCorrections() {
  return readJsonArray(
    COMMERCIAL_CORRECTIONS_PATH,
    'commercial-corrections.json'
  );
}

function saveCommercialCorrections(items) {
  const safeItems =
    Array.isArray(items)
      ? items.slice(-2000)
      : [];

  writeJsonAtomic(
    COMMERCIAL_CORRECTIONS_PATH,
    safeItems
  );
}

function createCommercialCorrectionCandidate(input = {}) {
  const phone =
    normalizePhone(input.phone);

  const question =
    safeString(input.question);

  const commercialReply =
    safeString(input.commercialReply);

  if (!commercialReply) {
    return null;
  }

  const source =
    safeString(input.source) ||
    'commercial';

  const now =
    new Date().toISOString();

  const corrections =
    loadCommercialCorrections();

  const duplicateWindowMs =
    10 * 60 * 1000;

  const duplicate =
    [...corrections]
      .reverse()
      .find(item => {
        const createdAt =
          Date.parse(
            item.createdAt ||
            ''
          );

        return (
          item.status === 'pending' &&
          normalizePhone(item.phone) === phone &&
          safeString(item.question) === question &&
          safeString(item.commercialReply) === commercialReply &&
          Number.isFinite(createdAt) &&
          Date.now() - createdAt < duplicateWindowMs
        );
      });

  if (duplicate) {
    return duplicate;
  }

  const correction = {
    id: crypto.randomUUID(),
    type: 'knowledge',
    status: 'pending',
    phone,
    question,
    commercialReply,
    source,
    createdAt: now,
    updatedAt: now,
    reviewedAt: null,
    instructionId: null
  };

  corrections.push(correction);
  saveCommercialCorrections(corrections);

  console.log(
    '🧠 Correction commerciale en attente :',
    correction.id
  );

  return correction;
}

function updateCommercialCorrection(id, updater) {
  const corrections =
    loadCommercialCorrections();

  const index =
    corrections.findIndex(
      item => item.id === id
    );

  if (index === -1) {
    return null;
  }

  const current =
    corrections[index];

  const updated =
    updater({ ...current }) ||
    current;

  corrections[index] = {
    ...updated,
    updatedAt:
      new Date().toISOString()
  };

  saveCommercialCorrections(
    corrections
  );

  return corrections[index];
}

function normalizeAvailabilityCorrection(value) {
  const normalized =
    safeString(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

  const map = {
    'en stock': 'in_stock',
    'stock': 'in_stock',
    'in_stock': 'in_stock',
    'sur commande': 'on_order',
    'commande': 'on_order',
    'on_order': 'on_order',
    'rupture': 'out_of_stock',
    'rupture de stock': 'out_of_stock',
    'out_of_stock': 'out_of_stock',
    'destockage': 'clearance',
    'déstockage': 'clearance',
    'clearance': 'clearance',
    'inconnu': 'unknown',
    'a confirmer': 'unknown',
    'à confirmer': 'unknown',
    'unknown': 'unknown'
  };

  return map[normalized] ||
    safeString(value);
}

// ============================================================
// PARAMÈTRES BOT
// ============================================================

const DEFAULT_SETTINGS = {
  aiEnabled: true,

  audience: 'all',

  timezone: 'Africa/Tunis',

  schedule: {
    mode: 'always',

    outOfHours: 'none',

    absenceMessage:
      'Merci pour votre message. Notre équipe MONDECO vous répondra dès que possible.',

    weekly: {
      mon: { enabled: true, start: '08:00', end: '19:00' },
      tue: { enabled: true, start: '08:00', end: '19:00' },
      wed: { enabled: true, start: '08:00', end: '19:00' },
      thu: { enabled: true, start: '08:00', end: '19:00' },
      fri: { enabled: true, start: '08:00', end: '19:00' },
      sat: { enabled: true, start: '08:00', end: '19:00' },
      sun: { enabled: true, start: '09:00', end: '18:00' }
    }
  },

  followUp: {
    enabled: false,
    delayMinutes: 60,
    maxFollowUps: 1,
    message:
      'Souhaitez-vous que je vous aide à choisir le modèle le plus adapté ? 😊'
  },

  imageHandling: 'secure_catalog',

  pauseWhenHumanReplies: true,

  humanPauseMinutes: 120,

  teamPhones: []
};

const ALLOWED_AUDIENCES = new Set([
  'all',
  'new',
  'ads',
  'team'
]);

const ALLOWED_OUT_OF_HOURS = new Set([
  'none',
  'message',
  'ai'
]);

const ALLOWED_IMAGE_HANDLING = new Set([
  'commercial',
  'secure_catalog',
  'analyze_only',
  'analyze_reply'
]);

const DAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun'
];

function validTime(value, fallback) {
  const str = safeString(value);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str)
    ? str
    : fallback;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(
      max,
      Math.round(number)
    )
  );
}

function normalizeSettings(input = {}) {
  const source =
    input &&
    typeof input === 'object'
      ? input
      : {};

  const sourceSchedule =
    source.schedule &&
    typeof source.schedule === 'object'
      ? source.schedule
      : {};

  const sourceWeekly =
    sourceSchedule.weekly &&
    typeof sourceSchedule.weekly === 'object'
      ? sourceSchedule.weekly
      : {};

  const weekly = {};

  for (const day of DAYS) {
    const fallback =
      DEFAULT_SETTINGS.schedule.weekly[day];

    const current =
      sourceWeekly[day] &&
      typeof sourceWeekly[day] === 'object'
        ? sourceWeekly[day]
        : {};

    weekly[day] = {
      enabled: parseBoolean(
        current.enabled,
        fallback.enabled
      ),
      start: validTime(
        current.start,
        fallback.start
      ),
      end: validTime(
        current.end,
        fallback.end
      )
    };
  }

  const audience =
    ALLOWED_AUDIENCES.has(source.audience)
      ? source.audience
      : DEFAULT_SETTINGS.audience;

  const outOfHours =
    ALLOWED_OUT_OF_HOURS.has(
      sourceSchedule.outOfHours
    )
      ? sourceSchedule.outOfHours
      : DEFAULT_SETTINGS.schedule.outOfHours;

  const imageHandling =
    ALLOWED_IMAGE_HANDLING.has(
      source.imageHandling
    )
      ? source.imageHandling
      : DEFAULT_SETTINGS.imageHandling;

  const followUp =
    source.followUp &&
    typeof source.followUp === 'object'
      ? source.followUp
      : {};

  let teamPhones = [];

  if (Array.isArray(source.teamPhones)) {
    teamPhones = source.teamPhones;
  } else if (typeof source.teamPhones === 'string') {
    teamPhones = source.teamPhones.split(/[\n,;]+/);
  }

  teamPhones = [
    ...new Set(
      teamPhones
        .map(normalizePhone)
        .filter(Boolean)
    )
  ];

  return {
    aiEnabled: parseBoolean(
      source.aiEnabled,
      DEFAULT_SETTINGS.aiEnabled
    ),

    audience,

    timezone:
      safeString(source.timezone) ||
      DEFAULT_SETTINGS.timezone,

    schedule: {
      mode:
        sourceSchedule.mode === 'custom'
          ? 'custom'
          : 'always',

      outOfHours,

      absenceMessage:
        safeString(
          sourceSchedule.absenceMessage
        ) ||
        DEFAULT_SETTINGS.schedule.absenceMessage,

      weekly
    },

    followUp: {
      enabled: parseBoolean(
        followUp.enabled,
        DEFAULT_SETTINGS.followUp.enabled
      ),

      delayMinutes: clampInteger(
        followUp.delayMinutes,
        15,
        1380,
        DEFAULT_SETTINGS.followUp.delayMinutes
      ),

      maxFollowUps: clampInteger(
        followUp.maxFollowUps,
        1,
        3,
        DEFAULT_SETTINGS.followUp.maxFollowUps
      ),

      message:
        safeString(followUp.message) ||
        DEFAULT_SETTINGS.followUp.message
    },

    imageHandling,

    pauseWhenHumanReplies: parseBoolean(
      source.pauseWhenHumanReplies,
      DEFAULT_SETTINGS.pauseWhenHumanReplies
    ),

    humanPauseMinutes: clampInteger(
      source.humanPauseMinutes,
      15,
      1440,
      DEFAULT_SETTINGS.humanPauseMinutes
    ),

    teamPhones
  };
}

function initializeSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    return;
  }

  writeJsonAtomic(
    SETTINGS_PATH,
    DEFAULT_SETTINGS
  );

  console.log(
    `⚙️ Paramètres initialisés : ${SETTINGS_PATH}`
  );
}


function migrateSecureImageModeV676() {
  if (
    fs.existsSync(
      SECURE_IMAGE_MIGRATION_MARKER
    )
  ) {
    return;
  }

  try {
    if (
      fs.existsSync(
        SETTINGS_PATH
      )
    ) {
      const parsed =
        JSON.parse(
          fs.readFileSync(
            SETTINGS_PATH,
            'utf8'
          ) || '{}'
        );

      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.imageHandling ===
          'commercial'
      ) {
        parsed.imageHandling =
          'secure_catalog';

        writeJsonAtomic(
          SETTINGS_PATH,
          normalizeSettings(
            parsed
          )
        );

        console.log(
          '🖼️ Mode images migré vers Capture intelligente sécurisée.'
        );
      }
    }

    fs.writeFileSync(
      SECURE_IMAGE_MIGRATION_MARKER,
      new Date().toISOString(),
      'utf8'
    );
  } catch (error) {
    console.warn(
      '⚠️ Migration mode image V6.7.6 :',
      error.message
    );
  }
}

function getBotSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      initializeSettings();
    }

    const parsed = JSON.parse(
      fs.readFileSync(SETTINGS_PATH, 'utf8') || '{}'
    );

    return normalizeSettings(parsed);
  } catch (error) {
    console.error(
      '❌ Lecture settings.json :',
      error.message
    );

    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

function saveBotSettings(settings) {
  const normalized =
    normalizeSettings(settings);

  writeJsonAtomic(
    SETTINGS_PATH,
    normalized
  );

  return normalized;
}

// ============================================================
// INITIALISATION
// ============================================================

// V6.20.4 : tenter d'abord de libérer uniquement les copies de sauvegarde
// redondantes. Cela permet à un Volume Railway Free presque plein de retrouver
// quelques dizaines de Mo avant le test d'écriture strict.
console.log('☁️ MONDECO Cloud Storage :', CLOUD_STORAGE_ENABLED
  ? `✅ Cloudinary actif (${CLOUDINARY_CLOUD_NAME}/${CLOUDINARY_ROOT_FOLDER})`
  : '⚠️ Cloudinary non configuré — fallback Railway actif');

runStartupStorageRescue();


// V6.33.1 — migration progressive des octets locaux vers Cloudinary.
// Elle s'exécute après le Storage Rescue afin d'avoir assez de marge pour
// écrire le petit manifeste avant de supprimer chaque fichier local migré.
if (CLOUD_STORAGE_ENABLED) {
  const cloudStartupTimer = setTimeout(() => {
    runCloudStorageMigration({ maxFiles: CLOUD_MIGRATION_BATCH_FILES })
      .catch(error => console.warn('⚠️ Migration Cloudinary démarrage :', error.message));
  }, 12000);
  if (typeof cloudStartupTimer.unref === 'function') cloudStartupTimer.unref();

  const cloudMigrationTimer = setInterval(() => {
    const stats = cloudStorageStats();
    if (stats.localMediaBytes <= 0 && stats.localProfileBytes <= 0) return;
    runCloudStorageMigration({ maxFiles: CLOUD_MIGRATION_BATCH_FILES })
      .catch(error => console.warn('⚠️ Migration Cloudinary périodique :', error.message));
  }, CLOUD_MIGRATION_INTERVAL_MS);
  if (typeof cloudMigrationTimer.unref === 'function') cloudMigrationTimer.unref();
}
ensurePersistenceSafety();
migrateLegacyData();
initializePersistentInstructions();
initializeSettings();
migrateSecureImageModeV676();
initializeQuickReplies();
initializeUsers();
syncBootstrapAdminFromEnvironment();
ensureDailySnapshot();

// V6.33.1 — surveillance préventive. Le Volume est contrôlé périodiquement
// afin d'éviter d'attendre le prochain redémarrage pour découvrir ENOSPC.
const storageGuardTimer = setInterval(() => {
  if (storagePeriodicGuardRunning) return;
  storagePeriodicGuardRunning = true;
  try {
    const space = storageSpaceInfo();
    if (!space) return;
    const critical =
      space.freeBytes < STORAGE_CRITICAL_FREE_BYTES ||
      (Number.isFinite(space.freeRatio) && space.freeRatio < 0.10);
    const low =
      critical ||
      space.freeBytes < STORAGE_RESCUE_TARGET_FREE_BYTES ||
      (Number.isFinite(space.freeRatio) && space.freeRatio < 0.20);
    if (!low) return;

    const result = runSafeStorageMaintenance({
      forceEmergency: critical,
      skipConversationRetention: false
    });
    if (critical) markRetention15MigrationApplied();
    console.log('🧹 Storage Guard périodique', {
      critical,
      freed: humanBytes(result.freedBytes),
      freeAfter: result.after ? humanBytes(result.after.freeBytes) : 'inconnu'
    });
  } catch (error) {
    console.warn('⚠️ Storage Guard périodique :', error.message);
  } finally {
    storagePeriodicGuardRunning = false;
  }
}, STORAGE_GUARD_INTERVAL_MS);
if (typeof storageGuardTimer.unref === 'function') storageGuardTimer.unref();

console.log(
  '💾 Stockage MONDECO :',
  {
    dataDir: DATA_DIR,
    persistentConfigured:
      DATA_DIR !== APP_DIR,
    writable:
      storageIsWritable()
  }
);

if (IS_RAILWAY) {
  console.log(
    `🛡️ Persistence Guard : ${PERSISTENCE_STRICT ? 'ACTIF' : 'DÉSACTIVÉ'}`
  );
}

// ============================================================
// CONTEXTE IA
// ============================================================

function availabilityLabel(value) {
  const labels = {
    in_stock: 'En stock',
    on_order: 'Sur commande',
    out_of_stock: 'Rupture',
    clearance: 'Déstockage',
    unknown: 'À confirmer'
  };

  return (
    labels[value] ||
    safeString(value) ||
    'À confirmer'
  );
}

function productToContext(product) {
  const lines = [];

  lines.push(
    `Produit : ${safeString(product.name)}`
  );

  if (product.category) {
    lines.push(
      `Catégorie : ${safeString(product.category)}`
    );
  }

  if (product.price) {
    lines.push(
      `Prix normal : ${safeString(product.price)} TND`
    );
  }

  if (product.promoPrice) {
    lines.push(
      `Prix promotionnel : ${safeString(product.promoPrice)} TND`
    );
  }

  if (product.availability) {
    lines.push(
      `Disponibilité : ${availabilityLabel(product.availability)}`
    );
  }

  if (product.dimensions) {
    lines.push(
      `Dimensions : ${safeString(product.dimensions)}`
    );
  }

  if (product.composition) {
    lines.push(
      `Composition : ${safeString(product.composition)}`
    );
  }

  if (product.colors) {
    lines.push(
      `Couleurs disponibles : ${safeString(product.colors)}`
    );
  }

  if (product.showrooms) {
    lines.push(
      `Showrooms : ${safeString(product.showrooms)}`
    );
  }

  if (product.productUrl) {
    lines.push(
      `Lien produit : ${safeString(product.productUrl)}`
    );
  }

  if (product.categoryUrl) {
    lines.push(
      `Lien catégorie : ${safeString(product.categoryUrl)}`
    );
  }

  const customizations = [];

  if (product.customizableColor === true) {
    customizations.push('couleur');
  }

  if (product.customizableFabric === true) {
    customizations.push('tissu');
  }

  if (product.customizableDimensions === true) {
    customizations.push('dimensions');
  }

  if (product.customizableCorner === true) {
    customizations.push('coin/orientation');
  }

  if (customizations.length) {
    lines.push(
      `Personnalisation possible : ${customizations.join(', ')}`
    );
  }

  if (product.description) {
    lines.push(
      `Description : ${safeString(product.description)}`
    );
  }

  return lines.join('\n');
}

function getBusinessContext() {
  const activeInstructions =
    loadInstructions()
      .filter(item => item.active !== false);

  const instructionsText =
    activeInstructions
      .map((item, index) => {
        return (
          `--- INSTRUCTION ${index + 1} ---\n` +
          `Titre : ${safeString(item.title)}\n` +
          `Contenu :\n${safeString(item.content)}`
        );
      })
      .join('\n\n');

  const activeProducts =
    loadProducts()
      .filter(product => product.active !== false);

  const productsText =
    activeProducts
      .map((product, index) => {
        return (
          `--- PRODUIT ${index + 1} ---\n` +
          productToContext(product)
        );
      })
      .join('\n\n');

  return [
    instructionsText
      ? `INSTRUCTIONS MONDECO\n\n${instructionsText}`
      : '',

    productsText
      ? `CATALOGUE PRODUITS MONDECO\n\n${productsText}`
      : ''
  ]
    .filter(Boolean)
    .join(
      '\n\n==================================================\n\n'
    );
}

// ============================================================
// AUTHENTIFICATION / UTILISATEURS / RÔLES
// ============================================================

// V6.33.1 — Sessions commerciales persistantes.
// Le cookie contient un token aléatoire; seul son SHA-256 est stocké sur le Volume.
// Un redéploiement Railway ne déconnecte donc plus les utilisateurs déjà connectés.
const SESSION_DURATION_DAYS = Math.max(
  1,
  Math.min(90, Number(process.env.MONDECO_SESSION_DAYS || 30) || 30)
);
const SESSION_DURATION = SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;
const SESSION_PERSIST_MIN_INTERVAL_MS = 60 * 1000;
let sessionStoreDirty = false;
let sessionStoreLastPersistAt = 0;

function sessionStorageKey(token) {
  const value = safeString(token);
  if (!value) return '';
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadPersistentSessions() {
  const map = new Map();
  let items = [];
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8') || '[]');
      items = Array.isArray(parsed) ? parsed : [];
    }
  } catch (error) {
    console.warn('⚠️ Sessions persistantes illisibles :', error.message);
  }

  const now = Date.now();
  for (const item of items) {
    const tokenHash = safeString(item?.tokenHash);
    const userId = safeString(item?.userId);
    const expiresAt = Number(item?.expiresAt || 0);
    if (!tokenHash || !userId || !expiresAt || expiresAt <= now) continue;
    map.set(tokenHash, {
      userId,
      createdAt: Number(item?.createdAt || now),
      lastSeenAt: Number(item?.lastSeenAt || item?.createdAt || now),
      lastPage: normalizePresencePage(item?.lastPage || ''),
      expiresAt
    });
  }
  return map;
}

const sessions = loadPersistentSessions();
const loginAttempts = new Map();

function persistSessions(force = false) {
  if (!sessionStoreDirty && !force) return;
  const now = Date.now();
  if (!force && now - sessionStoreLastPersistAt < SESSION_PERSIST_MIN_INTERVAL_MS) return;

  const payload = [...sessions.entries()]
    .map(([tokenHash, session]) => ({
      tokenHash,
      userId: safeString(session?.userId),
      createdAt: Number(session?.createdAt || now),
      lastSeenAt: Number(session?.lastSeenAt || session?.createdAt || now),
      lastPage: normalizePresencePage(session?.lastPage || ''),
      expiresAt: Number(session?.expiresAt || 0)
    }))
    .filter(item => item.tokenHash && item.userId && item.expiresAt > now)
    .slice(-5000);

  try {
    writeJsonAtomic(SESSIONS_PATH, payload);
    sessionStoreDirty = false;
    sessionStoreLastPersistAt = now;
  } catch (error) {
    console.warn('⚠️ Sauvegarde sessions persistantes :', error.message);
  }
}

// V6.17 — Présence équipe en temps réel.
// Le navigateur envoie un heartbeat toutes les 20 secondes.
// Un membre est considéré en ligne si son dernier heartbeat date de moins de 75 s,
// puis « inactif » pendant quelques minutes avant de passer hors ligne.
const PRESENCE_ONLINE_MS = 75 * 1000;
const PRESENCE_IDLE_MS = 5 * 60 * 1000;

const LOGIN_MAX_FAILURES = 8;
const LOGIN_BLOCK_MS =
  15 * 60 * 1000;

const ALLOWED_USER_ROLES =
  new Set([
    'admin',
    'responsable_commercial',
    'editor',
    'commercial'
  ]);

const ROLE_LABELS = {
  admin:
    'Administrateur',
  responsable_commercial:
    'Responsable commercial',
  editor:
    'Éditeur',
  commercial:
    'Commercial'
};

function normalizeEmail(value) {
  return safeString(value)
    .trim()
    .toLowerCase();
}

function hashUserPassword(
  password,
  saltHex = ''
) {
  const salt =
    saltHex ||
    crypto
      .randomBytes(16)
      .toString('hex');

  const hash =
    crypto
      .scryptSync(
        String(password),
        salt,
        64
      )
      .toString('hex');

  return {
    salt,
    hash
  };
}

function verifyUserPassword(
  password,
  user
) {
  const salt =
    safeString(
      user?.passwordSalt
    );

  const expectedHex =
    safeString(
      user?.passwordHash
    );

  if (
    !salt ||
    !expectedHex
  ) {
    return false;
  }

  try {
    const actual =
      Buffer.from(
        hashUserPassword(
          password,
          salt
        ).hash,
        'hex'
      );

    const expected =
      Buffer.from(
        expectedHex,
        'hex'
      );

    return (
      actual.length ===
        expected.length &&
      crypto.timingSafeEqual(
        actual,
        expected
      )
    );
  } catch {
    return false;
  }
}

function sanitizeUserForClient(user) {
  if (!user) {
    return null;
  }

  return {
    id:
      safeString(
        user.id
      ),
    name:
      safeString(
        user.name
      ),
    email:
      safeString(
        user.email
      ),
    role:
      safeString(
        user.role
      ),
    roleLabel:
      ROLE_LABELS[
        safeString(
          user.role
        )
      ] ||
      safeString(
        user.role
      ),
    active:
      user.active !==
      false,
    createdAt:
      safeString(
        user.createdAt
      ),
    updatedAt:
      safeString(
        user.updatedAt
      ),
    lastLoginAt:
      safeString(
        user.lastLoginAt
      )
  };
}

function loadUsers() {
  try {
    if (
      !fs.existsSync(
        USERS_PATH
      )
    ) {
      return [];
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          USERS_PATH,
          'utf8'
        ) ||
        '[]'
      );

    return Array.isArray(
      parsed
    )
      ? parsed
      : [];
  } catch (error) {
    console.warn(
      '⚠️ Lecture users.json :',
      error.message
    );

    return [];
  }
}

function saveUsers(users) {
  writeJsonAtomic(
    USERS_PATH,
    Array.isArray(users)
      ? users
      : []
  );
}

function initializeUsers() {
  const existing =
    loadUsers();

  if (existing.length) {
    return;
  }

  const now =
    new Date().toISOString();

  const credentials =
    hashUserPassword(
      ADMIN_PASSWORD
    );

  const initialAdmin = {
    id:
      crypto.randomUUID(),
    name:
      'Administrateur MONDECO',
    email:
      ADMIN_EMAIL,
    role:
      'admin',
    active:
      true,
    passwordSalt:
      credentials.salt,
    passwordHash:
      credentials.hash,
    createdAt:
      now,
    updatedAt:
      now,
    lastLoginAt:
      null
  };

  saveUsers([
    initialAdmin
  ]);

  console.log(
    `👤 Compte administrateur initial créé : ${ADMIN_EMAIL}`
  );
}


function adminEnvironmentFingerprint() {
  return crypto
    .createHash('sha256')
    .update(
      `${ADMIN_EMAIL}\n${ADMIN_PASSWORD}`,
      'utf8'
    )
    .digest('hex');
}

function syncBootstrapAdminFromEnvironment() {
  const fingerprint =
    adminEnvironmentFingerprint();

  let previousFingerprint =
    '';

  try {
    if (
      fs.existsSync(
        ADMIN_ENV_SYNC_PATH
      )
    ) {
      previousFingerprint =
        safeString(
          fs.readFileSync(
            ADMIN_ENV_SYNC_PATH,
            'utf8'
          )
        ).trim();
    }
  } catch (error) {
    console.warn(
      '⚠️ Lecture empreinte identifiants admin :',
      error.message
    );
  }

  if (
    previousFingerprint &&
    previousFingerprint ===
      fingerprint
  ) {
    return;
  }

  const users =
    loadUsers();

  const now =
    new Date().toISOString();

  const credentials =
    hashUserPassword(
      ADMIN_PASSWORD
    );

  const index =
    users.findIndex(
      user =>
        normalizeEmail(
          user.email
        ) ===
        ADMIN_EMAIL
    );

  if (index >= 0) {
    users[index] = {
      ...users[index],
      email:
        ADMIN_EMAIL,
      role:
        'admin',
      active:
        true,
      passwordSalt:
        credentials.salt,
      passwordHash:
        credentials.hash,
      updatedAt:
        now
    };

    console.log(
      `🔐 Identifiants administrateur Railway synchronisés : ${ADMIN_EMAIL}`
    );
  } else {
    users.push({
      id:
        crypto.randomUUID(),
      name:
        'Administrateur MONDECO',
      email:
        ADMIN_EMAIL,
      role:
        'admin',
      active:
        true,
      passwordSalt:
        credentials.salt,
      passwordHash:
        credentials.hash,
      createdAt:
        now,
      updatedAt:
        now,
      lastLoginAt:
        null
    });

    console.log(
      `🔐 Nouvel administrateur Railway créé : ${ADMIN_EMAIL}`
    );
  }

  saveUsers(
    users
  );

  try {
    fs.writeFileSync(
      ADMIN_ENV_SYNC_PATH,
      fingerprint,
      'utf8'
    );
  } catch (error) {
    console.warn(
      '⚠️ Sauvegarde empreinte identifiants admin :',
      error.message
    );
  }
}

function findUserById(id) {
  const wanted =
    safeString(id);

  return (
    loadUsers().find(
      user =>
        user.id ===
        wanted
    ) ||
    null
  );
}

function findUserByEmail(email) {
  const wanted =
    normalizeEmail(
      email
    );

  return (
    loadUsers().find(
      user =>
        normalizeEmail(
          user.email
        ) ===
        wanted
    ) ||
    null
  );
}

function countActiveAdmins(
  users
) {
  return users.filter(
    user =>
      user.role ===
        'admin' &&
      user.active !==
        false
  ).length;
}

function parseCookies(header = '') {
  const cookies = {};

  for (
    const part
    of header.split(';')
  ) {
    const index =
      part.indexOf('=');

    if (index === -1) {
      continue;
    }

    const key =
      part
        .slice(
          0,
          index
        )
        .trim();

    const value =
      part
        .slice(
          index + 1
        )
        .trim();

    if (!key) {
      continue;
    }

    try {
      cookies[key] =
        decodeURIComponent(
          value
        );
    } catch {
      cookies[key] =
        value;
    }
  }

  return cookies;
}

function cleanupSessions() {
  const now =
    Date.now();

  for (
    const [
      token,
      session
    ]
    of sessions.entries()
  ) {
    const expiresAt =
      typeof session ===
        'number'
        ? session
        : Number(
            session
              ?.expiresAt ||
            0
          );

    if (
      !expiresAt ||
      expiresAt <= now
    ) {
      sessions.delete(token);
      sessionStoreDirty = true;
    }
  }
  persistSessions(false);
}

function getSessionToken(req) {
  return (
    parseCookies(
      req.headers.cookie ||
      ''
    )
      .mondeco_admin_session ||
    ''
  );
}

function normalizePresencePage(value) {
  return safeString(value)
    .trim()
    .slice(0, 80);
}

function touchSessionPresence(req, page = '') {
  cleanupSessions();

  const token =
    getSessionToken(req);

  if (!token) {
    return null;
  }

  const sessionKey = sessionStorageKey(token);
  const session =
    sessions.get(sessionKey);

  if (
    !session ||
    typeof session !== 'object'
  ) {
    return null;
  }

  session.lastSeenAt = Date.now();

  const normalizedPage =
    normalizePresencePage(page);

  if (normalizedPage) {
    session.lastPage = normalizedPage;
  }

  sessions.set(sessionKey, session);
  sessionStoreDirty = true;
  persistSessions(false);
  return session;
}

function getPresenceForUser(userId) {
  cleanupSessions();

  const normalizedUserId =
    safeString(userId);

  let lastSeenAt = 0;
  let lastPage = '';
  let activeSessions = 0;

  for (const session of sessions.values()) {
    if (
      !session ||
      typeof session !== 'object' ||
      safeString(session.userId) !== normalizedUserId
    ) {
      continue;
    }

    activeSessions += 1;

    const seen = Number(
      session.lastSeenAt ||
      session.createdAt ||
      0
    );

    if (seen > lastSeenAt) {
      lastSeenAt = seen;
      lastPage = safeString(session.lastPage);
    }
  }

  const ageMs =
    lastSeenAt
      ? Math.max(0, Date.now() - lastSeenAt)
      : null;

  let status = 'offline';

  if (
    ageMs !== null &&
    ageMs <= PRESENCE_ONLINE_MS
  ) {
    status = 'online';
  } else if (
    ageMs !== null &&
    ageMs <= PRESENCE_IDLE_MS
  ) {
    status = 'idle';
  }

  return {
    status,
    online: status === 'online',
    idle: status === 'idle',
    lastSeenAt:
      lastSeenAt
        ? new Date(lastSeenAt).toISOString()
        : '',
    lastPage,
    activeSessions
  };
}

function getAuthenticatedUser(req) {
  cleanupSessions();

  const token =
    getSessionToken(
      req
    );

  if (!token) {
    return null;
  }

  const sessionKey = sessionStorageKey(token);
  const session =
    sessions.get(
      sessionKey
    );

  if (!session) {
    return null;
  }

  const expiresAt =
    typeof session ===
      'number'
      ? session
      : Number(
          session.expiresAt ||
          0
        );

  if (
    !expiresAt ||
    expiresAt <=
      Date.now()
  ) {
    sessions.delete(sessionKey);
    sessionStoreDirty = true;
    persistSessions(true);

    return null;
  }

  const userId =
    safeString(
      session.userId
    );

  if (!userId) {
    return null;
  }

  const user =
    findUserById(
      userId
    );

  if (
    !user ||
    user.active ===
      false
  ) {
    sessions.delete(sessionKey);
    sessionStoreDirty = true;
    persistSessions(true);

    return null;
  }

  return user;
}

function isAuthenticated(req) {
  return Boolean(
    getAuthenticatedUser(
      req
    )
  );
}

function pathStarts(
  reqPath,
  prefix
) {
  return (
    reqPath === prefix ||
    reqPath.startsWith(
      `${prefix}/`
    )
  );
}

function roleCanAccess(
  role,
  method,
  reqPath
) {
  if (
    role ===
    'admin'
  ) {
    return true;
  }

  if (
    reqPath ===
    '/'
  ) {
    return true;
  }

  // Assets protégés : accessibles à tous les comptes connectés.
  if (
    pathStarts(
      reqPath,
      '/uploads'
    ) ||
    pathStarts(
      reqPath,
      '/customizations'
    ) ||
    pathStarts(
      reqPath,
      '/conversation-media'
    ) ||
    pathStarts(
      reqPath,
      '/conversation-profile'
    ) ||
    reqPath ===
      '/api/me'
  ) {
    return true;
  }

  const commercialPrefixes = [
    '/api/conversations',
    '/api/commercial/send',
    '/api/commercial/send-media',
    '/api/whatsapp/calls',
    '/api/notifications',
    '/api/quick-replies',
    '/api/social-comments',
    '/api/tasks',
    '/api/my-workday'
  ];

  if (
    commercialPrefixes.some(
      prefix =>
        pathStarts(
          reqPath,
          prefix
        )
    )
  ) {
    return true;
  }

  if (
    role ===
    'responsable_commercial'
  ) {
    return (
      pathStarts(reqPath, '/api/conversations') ||
      pathStarts(reqPath, '/api/commercial/send') ||
      pathStarts(reqPath, '/api/commercial/send-media') ||
      pathStarts(reqPath, '/api/whatsapp/calls') ||
      pathStarts(reqPath, '/api/notifications') ||
      pathStarts(reqPath, '/api/instagram-history') ||
      pathStarts(reqPath, '/api/facebook-history') ||
      pathStarts(reqPath, '/api/social-comments') ||
      pathStarts(reqPath, '/api/quick-replies') ||
      pathStarts(reqPath, '/api/presence') ||
      pathStarts(reqPath, '/api/users') ||
      pathStarts(reqPath, '/api/schedules') ||
      pathStarts(reqPath, '/api/tasks') ||
      pathStarts(reqPath, '/api/team/operations')
    );
  }

  if (
    role ===
    'commercial'
  ) {
    return false;
  }

  if (
    role ===
    'editor'
  ) {
    if (
      pathStarts(
        reqPath,
        '/api/products'
      ) ||
      pathStarts(
        reqPath,
        '/api/instructions'
      ) ||
      pathStarts(
        reqPath,
        '/api/commercial-corrections'
      ) ||
      pathStarts(
        reqPath,
        '/api/customizations'
      ) ||
      pathStarts(
        reqPath,
        '/api/test-chat'
      ) ||
      reqPath ===
        '/api/stats'
    ) {
      return true;
    }

    if (
      reqPath ===
        '/api/woocommerce/status' ||
      reqPath ===
        '/api/woocommerce/test' ||
      reqPath ===
        '/api/woocommerce/sync'
    ) {
      return true;
    }

    if (
      (
        reqPath ===
          '/api/settings' &&
        method ===
          'GET'
      ) ||
      reqPath ===
        '/api/storage-status'
    ) {
      return true;
    }

    return false;
  }

  return false;
}

function conversationAssignedToUser(state, user) {
  if (!state || !user) return false;
  return Boolean(
    safeString(state.assignedUserId) &&
    safeString(state.assignedUserId) === safeString(user.id)
  );
}

function commercialCanWriteConversation(user, state) {
  if (safeString(user?.role) !== 'commercial') return true;
  return conversationAssignedToUser(state, user);
}

// V6.34.1 — verrou anti-double-réponse.
// Un commercial possède la conversation tant qu'il la traite. Si le client
// attend une réponse au-delà du délai SLA (5 min par défaut), un autre
// commercial autorisé peut reprendre la conversation. Le contrôle est fait
// côté serveur afin que deux navigateurs ne puissent pas contourner le verrou.
const DEFAULT_CONVERSATION_REPLY_LOCK_MINUTES = Math.max(
  1,
  Math.min(120, Number(process.env.CONVERSATION_REPLY_LOCK_MINUTES || 5) || 5)
);

function conversationStateChannel(contact, state = {}) {
  const explicit = safeString(state?.channel).toLowerCase();
  if (['whatsapp','instagram','facebook'].includes(explicit)) return explicit;
  const normalized = safeString(contact);
  if (normalized.startsWith('instagram:')) return 'instagram';
  if (normalized.startsWith('facebook:')) return 'facebook';
  return 'whatsapp';
}

function commercialReplyLockInfo(user, state = {}, contact = '', nowMs = Date.now()) {
  const isCommercial = safeString(user?.role) === 'commercial';
  if (!isCommercial) {
    return { canReply:true, assignedToMe:false, canTakeover:true, locked:false, reason:'manager' };
  }

  const viewerId = safeString(user?.id);
  const ownerId = safeString(state?.assignedUserId);
  const ownerNameFromState = safeString(state?.assignedTo);
  const channel = conversationStateChannel(contact, state);

  if (!ownerId) {
    return {
      canReply:true,
      assignedToMe:false,
      canTakeover:true,
      locked:false,
      reason:'unassigned',
      channel,
      ownerId:'',
      ownerName:''
    };
  }

  if (ownerId === viewerId) {
    return {
      canReply:true,
      assignedToMe:true,
      canTakeover:false,
      locked:false,
      reason:'owner',
      channel,
      ownerId,
      ownerName:ownerNameFromState || safeString(user?.name || user?.email)
    };
  }

  const owner = loadUsers().find(item => safeString(item?.id) === ownerId);
  const ownerName = ownerNameFromState || safeString(owner?.name || owner?.email) || 'Un autre commercial';

  // Si le propriétaire n'est plus actif ou n'est pas réellement dans une
  // mission active maintenant sur ce canal, la conversation peut être reprise
  // immédiatement. Ceci évite qu'un shift terminé bloque l'équipe suivante.
  const ownerHasActiveShift = Boolean(
    owner && owner.active !== false &&
    loadSchedules().some(schedule =>
      safeString(schedule?.userId) === ownerId &&
      scheduleIsActiveNow(schedule, new Date(nowMs), channel)
    )
  );
  if (!owner || owner.active === false || !ownerHasActiveShift) {
    return {
      canReply:true,
      assignedToMe:false,
      canTakeover:true,
      locked:false,
      reason:'owner_unavailable',
      channel,
      ownerId,
      ownerName
    };
  }

  const lastCustomerMs = Date.parse(safeString(state?.lastCustomerAt));
  const lastHumanMs = Date.parse(safeString(state?.lastHumanAt || state?.lastAnsweredAt));
  const customerWaiting = Number.isFinite(lastCustomerMs) && (!Number.isFinite(lastHumanMs) || lastCustomerMs > lastHumanMs);

  // Si le dernier message vient du commercial, on conserve naturellement
  // l'affectation : il attend le client, il n'y a rien à reprendre.
  if (!customerWaiting) {
    return {
      canReply:false,
      assignedToMe:false,
      canTakeover:false,
      locked:true,
      reason:'owned_waiting_customer',
      channel,
      ownerId,
      ownerName,
      retryAt:''
    };
  }

  const configuredMinutes = Math.max(
    1,
    Math.min(
      120,
      Number(state?.sla?.minutes || state?.slaMinutes || DEFAULT_CONVERSATION_REPLY_LOCK_MINUTES) || DEFAULT_CONVERSATION_REPLY_LOCK_MINUTES
    )
  );
  const ownerActivityCandidates = [
    state?.replyOwnerActivityAt,
    state?.assignedAt,
    state?.takeoverAt
  ]
    .map(value => Date.parse(safeString(value)))
    .filter(Number.isFinite);
  const ownerActivityMs = ownerActivityCandidates.length ? Math.max(...ownerActivityCandidates) : 0;
  const lockStartedAtMs = Math.max(lastCustomerMs, ownerActivityMs || 0);
  const unlockAtMs = lockStartedAtMs + configuredMinutes * 60 * 1000;
  const expired = Number(nowMs) >= unlockAtMs;

  return {
    canReply:expired,
    assignedToMe:false,
    canTakeover:expired,
    locked:!expired,
    reason:expired ? 'owner_timeout' : 'owner_active',
    channel,
    ownerId,
    ownerName,
    lockMinutes:configuredMinutes,
    retryAt:new Date(unlockAtMs).toISOString(),
    remainingMs:Math.max(0, unlockAtMs - Number(nowMs))
  };
}

function acquireCommercialConversationReply(req, res, contact, channel = '') {
  if (safeString(req.user?.role) !== 'commercial') return true;
  const resolvedChannel = safeString(channel).toLowerCase() || conversationStateChannel(contact, {});
  if (!requireCommercialMessageChannelAccess(req, res, resolvedChannel)) return false;

  const states = loadConversationStatesAdmin();
  const current = states[safeString(contact)] && typeof states[safeString(contact)] === 'object'
    ? states[safeString(contact)]
    : {};
  const info = commercialReplyLockInfo(req.user, current, contact);

  if (info.assignedToMe) {
    updateConversationStateAdmin(contact, state => ({
      ...state,
      replyOwnerActivityAt:new Date().toISOString()
    }));
    return true;
  }

  if (!info.canTakeover) {
    res.status(409).json({
      error: info.retryAt
        ? `Conversation déjà prise en charge par ${info.ownerName}. Reprise possible après ${info.lockMinutes || DEFAULT_CONVERSATION_REPLY_LOCK_MINUTES} min sans réponse.`
        : `Conversation déjà prise en charge par ${info.ownerName}.`,
      errorCode:'CONVERSATION_LOCKED',
      ownerUserId:info.ownerId,
      ownerName:info.ownerName,
      retryAt:info.retryAt || '',
      remainingMs:Number(info.remainingMs || 0)
    });
    return false;
  }

  const now = new Date().toISOString();
  updateConversationStateAdmin(contact, state => ({
    ...state,
    previousAssignedUserId:safeString(state?.assignedUserId),
    previousAssignedTo:safeString(state?.assignedTo),
    assignedUserId:safeString(req.user?.id),
    assignedTo:safeString(req.user?.name || req.user?.email),
    assignedAt:now,
    takeoverAt:info.ownerId ? now : safeString(state?.takeoverAt),
    replyOwnerActivityAt:now,
    takeoverReason:info.reason
  }));
  appendTeamActivity({
    type:info.ownerId ? 'conversation_takeover' : 'conversation_claim',
    userId:safeString(req.user?.id),
    userName:safeString(req.user?.name || req.user?.email),
    contact:safeString(contact),
    channel:resolvedChannel,
    previousUserId:info.ownerId,
    previousUserName:info.ownerName,
    reason:info.reason
  });
  return true;
}

function requireCommercialConversationWriteAccess(req, res, contact) {
  if (safeString(req.user?.role) !== 'commercial') return true;
  const normalizedContact = safeString(contact);
  const state = loadConversationStatesAdmin()[normalizedContact] || {};
  const channel = safeString(state?.channel).toLowerCase() ||
    (normalizedContact.startsWith('instagram:') ? 'instagram' :
      normalizedContact.startsWith('facebook:') ? 'facebook' : 'whatsapp');
  const scope = plannedChannelSetForUser(req.user);
  if (!channelScopeAllowsMessage(scope, channel)) {
    res.status(403).json({
      error: 'Accès refusé : ce canal de messages ne fait pas partie de votre planning du jour.'
    });
    return false;
  }
  if (conversationAssignedToUser(state, req.user)) return true;
  res.status(403).json({
    error: 'Lecture seule : cette conversation n’est pas affectée à votre compte.'
  });
  return false;
}

function requireAuth(
  req,
  res,
  next
) {
  const user =
    getAuthenticatedUser(
      req
    );

  if (!user) {
    if (
      req.path.startsWith(
        '/api/'
      )
    ) {
      return res
        .status(401)
        .json({
          error:
            'Non authentifié'
        });
    }

    return res.redirect(
      '/admin/login'
    );
  }

  req.user =
    user;

  if (
    !roleCanAccess(
      user.role,
      req.method,
      req.path
    )
  ) {
    if (
      req.path.startsWith(
        '/api/'
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            'Accès non autorisé pour votre rôle.'
        });
    }

    return res
      .status(403)
      .send(
        'Accès non autorisé.'
      );
  }

  return next();
}

function requireAdmin(
  req,
  res,
  next
) {
  const user =
    getAuthenticatedUser(
      req
    );

  if (!user) {
    return res
      .status(401)
      .json({
        error:
          'Non authentifié'
      });
  }

  if (
    user.role !==
    'admin'
  ) {
    return res
      .status(403)
      .json({
        error:
          'Administrateur requis.'
      });
  }

  req.user =
    user;

  return next();
}


function requireAdminOrCommercialManager(
  req,
  res,
  next
) {
  const user =
    getAuthenticatedUser(req);

  if (!user) {
    return res
      .status(401)
      .json({ error: 'Non authentifié' });
  }

  if (
    user.role !== 'admin' &&
    user.role !== 'responsable_commercial'
  ) {
    return res
      .status(403)
      .json({ error: 'Responsable commercial ou administrateur requis.' });
  }

  req.user = user;
  return next();
}

function isCommercialManager(user) {
  return safeString(user?.role) === 'responsable_commercial';
}

function secureCookie(req) {
  const forwardedProto =
    safeString(
      req.headers[
        'x-forwarded-proto'
      ]
    );

  return (
    forwardedProto ===
      'https' ||
    Boolean(
      process.env
        .RAILWAY_ENVIRONMENT_NAME
    )
  );
}


function loginAttemptKey(req) {
  return (
    safeString(
      req.headers[
        'x-forwarded-for'
      ]
    )
      .split(',')[0]
      .trim() ||
    safeString(
      req.ip
    ) ||
    'unknown'
  );
}

function getLoginAttemptState(req) {
  const key =
    loginAttemptKey(
      req
    );

  const current =
    loginAttempts.get(
      key
    ) || {
      failures:
        0,
      blockedUntil:
        0
    };

  if (
    current.blockedUntil &&
    current.blockedUntil <=
      Date.now()
  ) {
    loginAttempts.delete(
      key
    );

    return {
      key,
      failures:
        0,
      blockedUntil:
        0
    };
  }

  return {
    key,
    ...current
  };
}

function registerLoginFailure(req) {
  const state =
    getLoginAttemptState(
      req
    );

  const failures =
    Number(
      state.failures ||
      0
    ) +
    1;

  const blockedUntil =
    failures >=
      LOGIN_MAX_FAILURES
      ? Date.now() +
        LOGIN_BLOCK_MS
      : 0;

  loginAttempts.set(
    state.key,
    {
      failures,
      blockedUntil
    }
  );

  return {
    failures,
    blockedUntil
  };
}

function clearLoginFailures(req) {
  loginAttempts.delete(
    loginAttemptKey(
      req
    )
  );
}

function createSessionForUser(
  req,
  res,
  user
) {
  const token =
    crypto
      .randomBytes(32)
      .toString('hex');

  const sessionKey = sessionStorageKey(token);
  sessions.set(
    sessionKey,
    {
      userId:
        user.id,
      createdAt:
        Date.now(),
      lastSeenAt:
        Date.now(),
      lastPage:
        'connexion',
      expiresAt:
        Date.now() +
        SESSION_DURATION
    }
  );

  sessionStoreDirty = true;
  persistSessions(true);

  const cookieParts = [
    `mondeco_admin_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_DURATION / 1000)}`
  ];

  if (
    secureCookie(
      req
    )
  ) {
    cookieParts.push(
      'Secure'
    );
  }

  res.setHeader(
    'Set-Cookie',
    cookieParts.join('; ')
  );

  return token;
}


// ============================================================
// LOGO OFFICIEL MONDECO — intégré directement dans Admin.js
// ============================================================

const MONDECO_LOGO_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASQAAABbCAMAAADtJAh+AAAACXBIWXMAAAsTAAALEwEAmpwYAAA7p2lUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMwNjcgNzkuMTU3NzQ3LCAyMDE1LzAzLzMwLTIzOjQwOjQyICAgICAgICAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iCiAgICAgICAgICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgICAgICAgICB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIgogICAgICAgICAgICB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iCiAgICAgICAgICAgIHhtbG5zOnBob3Rvc2hvcD0iaHR0cDovL25zLmFkb2JlLmNvbS9waG90b3Nob3AvMS4wLyIKICAgICAgICAgICAgeG1sbnM6dGlmZj0iaHR0cDovL25zLmFkb2JlLmNvbS90aWZmLzEuMC8iCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPHhtcDpDcmVhdG9yVG9vbD5BZG9iZSBQaG90b3Nob3AgQ0MgMjAxNSAoV2luZG93cyk8L3htcDpDcmVhdG9yVG9vbD4KICAgICAgICAgPHhtcDpDcmVhdGVEYXRlPjIwMjAtMDUtMjFUMTM6NDg6MDYrMDE6MDA8L3htcDpDcmVhdGVEYXRlPgogICAgICAgICA8eG1wOk1ldGFkYXRhRGF0ZT4yMDIwLTEyLTA0VDEwOjUyOjAzKzAxOjAwPC94bXA6TWV0YWRhdGFEYXRlPgogICAgICAgICA8eG1wOk1vZGlmeURhdGU+MjAyMC0xMi0wNFQxMDo1MjowMyswMTowMDwveG1wOk1vZGlmeURhdGU+CiAgICAgICAgIDx4bXBNTTpJbnN0YW5jZUlEPnhtcC5paWQ6Y2NkYjllNGYtNzVhNC1iMTQ1LTkxZmQtNGEwMjIwNWY2NzQ1PC94bXBNTTpJbnN0YW5jZUlEPgogICAgICAgICA8eG1wTU06RG9jdW1lbnRJRD5hZG9iZTpkb2NpZDpwaG90b3Nob3A6NGQ2OWRjZDEtMzYxNi0xMWViLTgwNjctYjIxZWYyZjliMGMyPC94bXBNTTpEb2N1bWVudElEPgogICAgICAgICA8eG1wTU06T3JpZ2luYWxEb2N1bWVudElEPnhtcC5kaWQ6NWEyZDhkOGQtNzUxNS1mMDQ2LWFlZjAtODQwZGY5MDdjN2M4PC94bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ+CiAgICAgICAgIDx4bXBNTTpIaXN0b3J5PgogICAgICAgICAgICA8cmRmOlNlcT4KICAgICAgICAgICAgICAgPHJkZjpsaSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSI+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDphY3Rpb24+Y3JlYXRlZDwvc3RFdnQ6YWN0aW9uPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6aW5zdGFuY2VJRD54bXAuaWlkOjVhMmQ4ZDhkLTc1MTUtZjA0Ni1hZWYwLTg0MGRmOTA3YzdjODwvc3RFdnQ6aW5zdGFuY2VJRD4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OndoZW4+MjAyMC0wNS0yMVQxMzo0ODowNiswMTowMDwvc3RFdnQ6d2hlbj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OnNvZnR3YXJlQWdlbnQ+QWRvYmUgUGhvdG9zaG9wIENDIDIwMTUgKFdpbmRvd3MpPC9zdEV2dDpzb2Z0d2FyZUFnZW50PgogICAgICAgICAgICAgICA8L3JkZjpsaT4KICAgICAgICAgICAgICAgPHJkZjpsaSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSI+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDphY3Rpb24+c2F2ZWQ8L3N0RXZ0OmFjdGlvbj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0Omluc3RhbmNlSUQ+eG1wLmlpZDphNWZhOGMyNS1jYjU4LTkyNDgtYTFlNi0xOTI0ZDg1MGVlNWY8L3N0RXZ0Omluc3RhbmNlSUQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDp3aGVuPjIwMjAtMDUtMjFUMTM6NDg6MDYrMDE6MDA8L3N0RXZ0OndoZW4+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDpzb2Z0d2FyZUFnZW50PkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE1IChXaW5kb3dzKTwvc3RFdnQ6c29mdHdhcmVBZ2VudD4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OmNoYW5nZWQ+Lzwvc3RFdnQ6Y2hhbmdlZD4KICAgICAgICAgICAgICAgPC9yZGY6bGk+CiAgICAgICAgICAgICAgIDxyZGY6bGkgcmRmOnBhcnNlVHlwZT0iUmVzb3VyY2UiPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6YWN0aW9uPnNhdmVkPC9zdEV2dDphY3Rpb24+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDppbnN0YW5jZUlEPnhtcC5paWQ6Y2NkYjllNGYtNzVhNC1iMTQ1LTkxZmQtNGEwMjIwNWY2NzQ1PC9zdEV2dDppbnN0YW5jZUlEPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6d2hlbj4yMDIwLTEyLTA0VDEwOjUyOjAzKzAxOjAwPC9zdEV2dDp3aGVuPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6c29mdHdhcmVBZ2VudD5BZG9iZSBQaG90b3Nob3AgQ0MgMjAxNSAoV2luZG93cyk8L3N0RXZ0OnNvZnR3YXJlQWdlbnQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDpjaGFuZ2VkPi88L3N0RXZ0OmNoYW5nZWQ+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICA8L3JkZjpTZXE+CiAgICAgICAgIDwveG1wTU06SGlzdG9yeT4KICAgICAgICAgPGRjOmZvcm1hdD5pbWFnZS9wbmc8L2RjOmZvcm1hdD4KICAgICAgICAgPHBob3Rvc2hvcDpDb2xvck1vZGU+MzwvcGhvdG9zaG9wOkNvbG9yTW9kZT4KICAgICAgICAgPHRpZmY6T3JpZW50YXRpb24+MTwvdGlmZjpPcmllbnRhdGlvbj4KICAgICAgICAgPHRpZmY6WFJlc29sdXRpb24+NzIwMDAwLzEwMDAwPC90aWZmOlhSZXNvbHV0aW9uPgogICAgICAgICA8dGlmZjpZUmVzb2x1dGlvbj43MjAwMDAvMTAwMDA8L3RpZmY6WVJlc29sdXRpb24+CiAgICAgICAgIDx0aWZmOlJlc29sdXRpb25Vbml0PjI8L3RpZmY6UmVzb2x1dGlvblVuaXQ+CiAgICAgICAgIDxleGlmOkNvbG9yU3BhY2U+NjU1MzU8L2V4aWY6Q29sb3JTcGFjZT4KICAgICAgICAgPGV4aWY6UGl4ZWxYRGltZW5zaW9uPjI5MjwvZXhpZjpQaXhlbFhEaW1lbnNpb24+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj45MTwvZXhpZjpQaXhlbFlEaW1lbnNpb24+CiAgICAgIDwvcmRmOkRlc2NyaXB0aW9uPgogICA8L3JkZjpSREY+CjwveDp4bXBtZXRhPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgIAo8P3hwYWNrZXQgZW5kPSJ3Ij8+9Yhc8wAAAvdQTFRFR3BM7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7Rwk7RwkS8mN9wAAAPx0Uk5TAM+EjNXAL26kutQ/iCEQh+/GdMVv88ELzuABMQTu/DnD2gL9Bd3C02sell1QjvQ6HxLnx+UXmQPKeFr3PiPNIBVWE7glhr5D9VUZ+iskDP4i1+233zjMJ6Up4w6uu9k1PAos3vuDBm1+WR2R8kWmuan41qvssS03qtCcTrV3gU110fD56A9M4eoW6aBxikBU5kuNUw2XxKx8OzZXEUQIeqOa61tgdjCC9r1Bp3tomzNRy5IbWFyfoa9CvKIHyRQJsrYo3JgaR9u/Jn0YaXOJgNiT8dKoT2JnYcizlJ5flbA05ItlrUg9HFJ5cmTicIUujzJjkLRGnUpeakl/fj78cwAACkFJREFUeNrtm2dcFccaxl+kiZSIkYOASBeBgIA0RRERBIwNQcQoNmL32muM3VgTezd2jcaosdfYY/faU296T26Sm9xe5sM97uw5Z2Z3dmeW3Pttng/+OLPPzr77P3vemXlnBZCSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKS+n+rbdjGsFSDY9mZvLOzA2BLb4Do9b+4u7vfndFsWFiBkbXVEXcjHWnNPCOh1YhL4+aFh2e4fTpoZm/jIHpPqzPRLSM8PL3eX5Pb3WZanhFi0X+Tvq3LrrO2vLy8RnZFLjn+lt4QeuOPnG4nBcKdiQCxyKmgyKINTGsHZKxBevvgpPZNSEt41TvsEKZVhZO+sR8Oi9abnl0tAmnHz9qW5mPKDm87sHT4gNjghGLvMR4VYzbqzqpEnGfp1zjY3QKg8XPUPeccCNVb65pAelnnbvij3lV5TN/rshy978odnQ0FCjD6BZXSDb18FpztT7Vcm7LD57LmtO3pP5r36+UG3j46SAj13fSbIO2LZ/s6RNC+Nh+yfY18NR2eG/kfLqPSjMDfUw3uQSfzda7UdWO/oFuqN1f1rRUkhN4YUHtI94ydVHL5eK6hbwbd46meKIzDKAD1e3CXTEZRn09mGn13XKES5NOlELNNAFIsI8y4geKQ6Jy0ztgYdJTw3TXpEZ2iurwP3yMOpPjHYKtDPKSo2tBqQz2JT01/gtuoGR9S9M/bExM/yXrsE0KEOXcDA1KLPX56JfdnZ/hnX2wwc2Bb/7DSGU3VlvmEL8t1qTNbD3n5tx04bTeR7CPJPscBXOljymhrif12XZBS0RoTcxZJqakdUDHqwYXkGg+7JY3Jdcb5mh5SA25quOg4+/MG3xI5tGikvclGZgyHr/vQNsS0YVaGM4ERZg+AV9Eqk6v2Qn8C8HRCGoDeNg0yEb1KQYLdRAMP0hN1rOP4Oh++pINUxGPk57hHP01Syx+BUFvXx3cdvsQ02hfs7OEgBQmOIZO5Vv1bQEIKWcsJ88wEGhL0CbIECeDmDcYjjyE9xbm4r+Px2Kc/NtPb9Xc31fc84/HwnacebEdBgov1DC97Ih5ISEWI+8CjLBoSPOdpDRLAAzXMd61CWojPW5DA8eWpidyLdTDzvpoVV1OQAH1v0NvXKI2ENBxFcCFNQo6BaS3+7gYb3psRJFiJwyyJtQbpFj5tZEdOiJuwr+tAg+FcTUwnaEifoctM+wWEp3UOSOc8BaaeU+IcU4CfHGltlUVI8CIO8wdLkLqo2WwyL8J5jFkTqUL1SfanIIEfO3HYxgMJqRPKFIC0BS1VITVUW4ahQouQtgQpUWZYgjQd39orvADbqRNWY8cd7HiBhgQ1Sxjefz0EClJ5pNByeHyeBhKMQNHWIMEQHGaxFUh4mrWQG18gnkZ1MZsbYkswDSkffa1faKA3KUiNS34nBOly7nkNJGhx3SIkCKe+SxFI/TDXZrzwhgs8cKexpxUNCf6JdNWOOOd8H0Mali5YZYpqqYUEY6ssQkrG45QFSDMUS8pgXnTvYQDm2T1K8YzSQIJybT0g+RHQkMa3F4R0wlMHaREaYg1SBL6VQgrSfrOrViuWKm50ZxWfzdy0XzGFaCFBV2+60EZkaQxp6i1BSEnXdZDs87zmliBl499bKQUpcbi/VjcdU+vQ5YrlY250bopvurmpB/6OdJAiyHk7hM7ZCRpIcdcEIXWqSNNBgpdRmhVI6kq1JV0FaGJc/hjeVfnoxQvurQmKj5Neg1PYkGDlcuJDn3WggXS7olAQ0uqoHnpIMCXIEqSPlCj/wi2VLKPy9tgCXnAJMYqxJ6/2YQAJQo44/zw+AbSQvKLyRfcHPFYwIEGIzQokd2p4q8stpC3FM6tYXmy98KqNNyu3GUHqiByFy8yxETpIG8sChCEdYkFqrB12TSG9okT5d2FIxTjVhnJzgeLLXcSx3TCCBF/GqNeopIsSCqSwvudFIY1jPknQ0/nbEID0B5yquZDaURWAdO4MoDNet/HWwDmGkKAaj/Lrp4Ie0rdx3QQZdcE5SVMZVxYEhcKQxlMzIwwpd3F9rUauUB1heJLMe0KgYK9ifJNjW24MKTtml/3fX0uuMiBF15wWhNSrQkmfgbMYiSZbFNJsav6MISVfCNAqzZGE8p9XLP240eHVy05zkz8yhgSt0VUIDdkFDEjg0UAQUqsovEZi+CPjBCGl4Xv+GwVpqNlV4xTLe9zoXld85gVW+5pcKbqwIcGDvvC2ruiNIZVPFIR00NMQEpSMEoO0DKeOfPFlySnFwo8RD5ucJVYfxeRpAAlsbqNj2ZC8l4vm7fXGkApQQyFIuKLUyMLarQFOStwt6RX6rRP9cxxDPrl6SGnd9RtxGFKAwA9eqSCnZBpDgg3oGwFICfhO9liAhIcttJ5b7ypRfLPNPHhodcw4PYRuW60nxYutcLep3z8bEnijAj4ktTTZ2Uo9qREuXHMnAUuoOghLqdhxGGoB6RoKFjBnO9ZFBpBgVAoX0iEcZVNLlckkfNJH/Cq8or0vcXCjd2oDCSaIpO6TjgHMCBJERXIgdcNDG1E4ENoI2IHPWiU2vqEPjI4nqu9tQK0gTX6yU8md0U7iQYpG7qaQ/BfjKEeDNUg71Ul4f6FJN0JfsQ8PQpqvyBok+8jI9c7dDjxIUIgXEwaQNs9Ro8y3CAkqkfE+SAFR035K9Y1mpY816kFX1d8iJOjKy92XXOUDY0jwHbppBCnAuU1PZlYxSKmOU4t069xj9cm950eqr2Kz1jf5sHpoQXStIfmrvxQjjUCudMhYljhV9GR9woDUqU53x42OAB2k6bxAS53vgb1P7c/8w9PedsD1OTPIYayi3svodNDR3oR4j8IqJPs0J9nEmEWuYFu0NHF2qLGvSTGk0B6nfX19v2k97ctPiNfzRoEeUt0IX4b2EcPULOf5Nckzjyqgzre+p45WROX1NVeN8/Uhk5RfXW8v72rX5clSkWVI0BxdMvRFkvzNIcHDxzBwKn7TLYVRAXkBGJAMVEwYpxPtMSHnbJH1XL2PI1LQZ3MI48JKW1O37kRDClWQtw4J2mZ0Zw8f88OnXgBhSAFoFzzCkBbr71tbZTGFtJR0Ho8xNm4l81elsS+vDfxGSADb0bpUncerPEWzSDeHZJ9PNJti8M7kB7pXeU0h0S9yd3rawNZkjz9lXGnUnzah1AoSeK2dd/HfZENs0uiFXx0FS5Ds05p4JqQyxvvfFiABDElnueq20XYaMZrl89HtfeUKQarI0rb0G18T/+nW0rCEq90ikvyqa66v6aw7K/0LTrdZCO7dt0MifyBzprRjWcvNIOm2h4KHzNZYFmcx95qKR5XQvtw3NutdfxarojH+Z0Lsd2t8AnPy3Ka65bRfydzFSurB63f3gOIf7Iu9M2X17PKY3WHM/vkGLw/6RdUzkkcZqxTbfGh5ugo/KCfxGcNF56Kkk/F7VUBl297vCFJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUv9z/RcQv3dk7wgjIAAAAABJRU5ErkJggg==';

function renderLoginPage() {
  return `
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2311100f'/%3E%3Cpath d='M13 46V18L25 34L37 18V46' fill='none' stroke='white' stroke-width='4.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M41 19H43C53 19 58 24.5 58 32C58 39.5 53 45 43 45H41' fill='none' stroke='%23ed1c24' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="shortcut icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2311100f'/%3E%3Cpath d='M13 46V18L25 34L37 18V46' fill='none' stroke='white' stroke-width='4.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M41 19H43C53 19 58 24.5 58 32C58 39.5 53 45 43 45H41' fill='none' stroke='%23ed1c24' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E">
<meta name="theme-color" content="#11100f">
<title>MONDECO — Connexion</title>
<style>
*{box-sizing:border-box}
:root{--bg:#f7f4f0;--card:#fff;--sidebar:#11100f;--text:#1b1816;--muted:#756c65;--line:#e5ded8;--accent:#ed1c24;--accent-dark:#cf161d}
html,body{min-height:100%}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif;color:var(--text);background:var(--bg)}
.login-wrap{width:min(940px,100%);display:grid;grid-template-columns:330px minmax(0,1fr);min-height:545px;overflow:hidden;border:1px solid var(--line);border-radius:20px;background:var(--card)}
.brand-side{display:flex;flex-direction:column;justify-content:space-between;padding:34px 30px 30px;background:var(--sidebar);color:#fff}
.brand-logo{display:block;width:185px;max-width:90%;height:auto;object-fit:contain;filter:brightness(0) invert(1)}
.brand-kicker{margin-top:15px;color:#9f9791;font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.13em}
.brand-copy{margin-top:auto;padding-top:42px}
.brand-copy h1{margin:0 0 12px;font-family:Georgia,"Times New Roman",serif;font-size:31px;line-height:1.08;letter-spacing:-.03em}
.brand-copy p{margin:0;max-width:260px;color:#bbb3ad;font-size:13px;line-height:1.58}
.brand-foot{margin-top:30px;padding-top:16px;border-top:1px solid #2b2825;color:#77716c;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.form-side{display:flex;align-items:center;padding:48px clamp(34px,6vw,72px)}
.form-box{width:100%;max-width:390px;margin:auto}
.eyebrow{margin-bottom:10px;color:var(--accent);font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}
h2{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:36px;line-height:1.1;letter-spacing:-.035em}
.sub{margin:9px 0 27px;color:var(--muted);font-size:13.5px;line-height:1.55}
label{display:block;margin-bottom:8px;color:#4f4640;font-size:12px;font-weight:750}
.password-row{position:relative}
input{width:100%;min-height:50px;padding:12px 46px 12px 14px;border:1px solid var(--line);border-radius:11px;outline:none;background:#fff;color:var(--text);font-size:15px;transition:border-color .15s ease,box-shadow .15s ease}
input:focus{border-color:#d9a5a8;box-shadow:0 0 0 3px rgba(237,28,36,.06)}
.show-pass{position:absolute;top:50%;right:7px;width:36px;height:36px;margin:0;padding:0;transform:translateY(-50%);display:grid;place-items:center;border:0;border-radius:9px;background:transparent;color:#8d837b;cursor:pointer;font-size:14px}
.show-pass:hover{background:#f7f4f0;color:#312a26}
.submit-btn{width:100%;min-height:50px;margin-top:15px;border:0;border-radius:11px;background:var(--accent);color:#fff;font-size:14px;font-weight:800;cursor:pointer;transition:background .15s ease}
.submit-btn:hover{background:var(--accent-dark)}
.submit-btn:disabled{opacity:.65;cursor:wait}
.err{display:none;margin-top:12px;padding:10px 11px;border:1px solid #efc8ca;border-radius:10px;background:#fff7f7;color:#aa2026;font-size:12px;line-height:1.45}
.security-note{margin-top:20px;color:#92877f;font-size:11px;line-height:1.5}.security-note strong{color:#625951}
.mobile-logo{display:none;height:auto;object-fit:contain}
.login-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.login-version{display:inline-flex;align-items:center;min-height:24px;padding:3px 8px;border-radius:999px;background:#11100f;color:#fff;font-size:9px;font-weight:900;letter-spacing:.04em;white-space:nowrap}

@media(max-width:760px){
  html,body{min-height:100%;background:#fff}
  body{display:block;min-height:100svh;padding:0;background:#fff}
  .login-wrap{width:100%;min-height:100svh;display:block;border:0;border-radius:0;background:#fff}
  .brand-side{display:none}
  .form-side{
    min-height:100svh;
    align-items:flex-start;
    padding:calc(20px + env(safe-area-inset-top)) 22px calc(24px + env(safe-area-inset-bottom));
    background:#fff
  }
  .form-box{width:100%;max-width:480px;margin:0 auto}
  .mobile-logo{
    display:block;
    width:154px;
    max-width:48vw;
    margin:4px 0 32px;
    filter:none
  }
  .eyebrow{margin-bottom:7px;font-size:9px}
  .login-title-row{gap:8px;margin-bottom:0}
  .login-title-row h2{font-size:34px;line-height:1.05}
  .login-version{min-height:22px;padding:2px 7px;font-size:8.5px}
  .sub{margin:10px 0 23px;font-size:13px}
  label{font-size:12px}
  input{min-height:54px;font-size:16px}
  .submit-btn{min-height:54px;font-size:15px}
  .security-note{margin-top:18px;font-size:11px}
}

@media(max-width:390px){
  .form-side{padding-left:18px;padding-right:18px}
  .mobile-logo{width:145px;margin-bottom:28px}
  .login-title-row h2{font-size:31px}
  .sub{margin-bottom:20px}
}

@media(max-height:700px) and (max-width:760px){
  .form-side{padding-top:calc(12px + env(safe-area-inset-top))}
  .mobile-logo{width:132px;margin-bottom:20px}
  .sub{margin-bottom:16px}
  input{min-height:48px}
  .submit-btn{min-height:48px}
  .security-note{margin-top:14px}
}
</style>
</head>
<body>
<div class="login-wrap">
  <aside class="brand-side">
    <div>
      <img class="brand-logo" src="${MONDECO_LOGO_DATA_URL}" alt="MONDECO">
      <div class="brand-kicker">Agent WhatsApp + Instagram + Facebook • Administration</div>
    </div>
    <div class="brand-copy">
      <h1>Centre de pilotage MONDECO</h1>
      <p>Gérez WhatsApp, Instagram, la supervision Facebook, l’équipe commerciale, les produits et les paramètres depuis une interface unique.</p>
    </div>
    <div class="brand-foot">Accès réservé</div>
  </aside>
  <main class="form-side">
    <div class="form-box">
      <img class="mobile-logo" src="${MONDECO_LOGO_DATA_URL}" alt="MONDECO">
      <div class="eyebrow">Administration</div>
      <div class="login-title-row">
        <h2>Connexion</h2>
        <span class="login-version">V6.33.1</span>
      </div>
      <div class="sub">Connectez-vous avec votre compte MONDECO.</div>
      <form id="form">
        <label for="email">Adresse e-mail</label>
        <input id="email" type="email" required autofocus autocomplete="username" placeholder="nom@mondeco.tn">

        <label for="password" style="margin-top:14px">Mot de passe</label>
        <div class="password-row">
          <input id="password" type="password" required autocomplete="current-password" placeholder="Votre mot de passe">
          <button class="show-pass" id="togglePassword" type="button" aria-label="Afficher ou masquer le mot de passe" title="Afficher / masquer">◉</button>
        </div>
        <button class="submit-btn" id="btn" type="submit">Se connecter</button>
        <div id="err" class="err"></div>
      </form>
      <div class="security-note"><strong>Accès sécurisé.</strong> Chaque membre de l’équipe utilise son propre e-mail et son propre mot de passe.</div>
    </div>
  </main>
</div>
<script>
const form=document.getElementById('form');
const btn=document.getElementById('btn');
const err=document.getElementById('err');
const emailInput=document.getElementById('email');
const passwordInput=document.getElementById('password');
const togglePassword=document.getElementById('togglePassword');
togglePassword.addEventListener('click',()=>{const show=passwordInput.type==='password';passwordInput.type=show?'text':'password';togglePassword.textContent=show?'◌':'◉';});
form.addEventListener('submit',async event=>{event.preventDefault();err.style.display='none';btn.disabled=true;btn.textContent='Connexion...';try{const response=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:emailInput.value,password:passwordInput.value})});const data=await response.json();if(response.ok&&data.success){location.href='/admin';return;}err.textContent=data.error||'E-mail ou mot de passe incorrect.';err.style.display='block';}catch{err.textContent='Impossible de contacter le serveur.';err.style.display='block';}finally{btn.disabled=false;btn.textContent='Se connecter';}});
</script>
</body>
</html>
`;
}

router.get('/login', (req, res) => {
  if (isAuthenticated(req)) {
    return res.redirect('/admin');
  }

  return res
    .type('html')
    .send(renderLoginPage());
});

router.post('/login', (req, res) => {
  const attemptState =
    getLoginAttemptState(
      req
    );

  if (
    attemptState.blockedUntil >
    Date.now()
  ) {
    return res
      .status(429)
      .json({
        error:
          'Trop de tentatives. Réessayez dans quelques minutes.'
      });
  }

  const email =
    normalizeEmail(
      req.body?.email
    );

  const password =
    safeString(
      req.body?.password
    );

  if (
    !email ||
    !password
  ) {
    return res
      .status(400)
      .json({
        error:
          'E-mail et mot de passe obligatoires.'
      });
  }

  const users =
    loadUsers();

  const index =
    users.findIndex(
      user =>
        normalizeEmail(
          user.email
        ) ===
        email
    );

  if (
    index === -1 ||
    users[index].active ===
      false ||
    !verifyUserPassword(
      password,
      users[index]
    )
  ) {
    registerLoginFailure(
      req
    );

    return res
      .status(401)
      .json({
        error:
          'E-mail ou mot de passe incorrect.'
      });
  }

  clearLoginFailures(
    req
  );

  users[index] = {
    ...users[index],
    lastLoginAt:
      new Date().toISOString()
  };

  saveUsers(
    users
  );

  createSessionForUser(
    req,
    res,
    users[index]
  );

  return res.json({
    success:
      true,
    user:
      sanitizeUserForClient(
        users[index]
      )
  });
});

router.post('/logout', (req, res) => {
  const token = getSessionToken(req);

  if (token) {
    sessions.delete(sessionStorageKey(token));
    sessionStoreDirty = true;
    persistSessions(true);
  }

  const cookieParts = [
    'mondeco_admin_session=',
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0'
  ];

  if (secureCookie(req)) {
    cookieParts.push('Secure');
  }

  res.setHeader(
    'Set-Cookie',
    cookieParts.join('; ')
  );

  return res.json({
    success: true
  });
});

router.get('/', requireAuth, (req, res) => {
  if (!fs.existsSync(ADMIN_HTML_PATH)) {
    return res
      .status(500)
      .send('Admin.html introuvable.');
  }

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader(
    'Pragma',
    'no-cache'
  );
  res.setHeader(
    'Expires',
    '0'
  );

  return res.sendFile(
    ADMIN_HTML_PATH,
    {
      headers: {
        'Cache-Control':
          'no-store, no-cache, must-revalidate, proxy-revalidate'
      }
    }
  );
});

// ============================================================
// MULTER
// ============================================================

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);


const ALLOWED_COMMERCIAL_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // V6.23.0 — messages vocaux WhatsApp. OGG/Opus donne le rendu
  // « note vocale » natif ; MP4/M4A, MP3 et AMR restent acceptés comme audio.
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/amr'
]);

function commercialMediaFileFilter(req, file, callback) {
  if (!ALLOWED_COMMERCIAL_MEDIA_TYPES.has(file.mimetype)) {
    return callback(
      new Error(
        'Format non accepté. Utilisez PDF, DOC, DOCX, JPG, PNG, WEBP, OGG, M4A/MP4, MP3 ou AMR.'
      )
    );
  }

  return callback(null, true);
}

function imageFileFilter(req, file, callback) {
  if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
    return callback(
      new Error(
        'Format image non accepté. Utilisez JPG, PNG ou WEBP.'
      )
    );
  }

  return callback(null, true);
}

const productStorage =
  multer.diskStorage({
    destination(req, file, callback) {
      callback(null, UPLOADS_DIR);
    },

    filename(req, file, callback) {
      const extension =
        extensionFromMimeType(file.mimetype);

      callback(
        null,
        `product-${Date.now()}-${crypto.randomUUID()}${extension}`
      );
    }
  });

const productUpload =
  multer({
    storage: productStorage,

    limits: {
      fileSize: 8 * 1024 * 1024
    },

    fileFilter: imageFileFilter
  });

const memoryUpload =
  multer({
    storage: multer.memoryStorage(),

    limits: {
      fileSize: 8 * 1024 * 1024
    },

    fileFilter: imageFileFilter
  });


const commercialMediaUpload =
  multer({
    storage: multer.memoryStorage(),

    limits: {
      fileSize: 20 * 1024 * 1024
    },

    fileFilter: commercialMediaFileFilter
  });

function multerSingle(upload, fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(
      req,
      res,
      error => {
        if (!error) return next();

        if (error instanceof multer.MulterError) {
          if (error.code === 'LIMIT_FILE_SIZE') {
            return res
              .status(400)
              .json({
                error:
                  'Image trop volumineuse. Maximum 8 Mo.'
              });
          }

          return res
            .status(400)
            .json({
              error: error.message
            });
        }

        return res
          .status(400)
          .json({
            error:
              error.message ||
              'Image invalide.'
          });
      }
    );
  };
}

const uploadProductImage =
  multerSingle(productUpload, 'image');

const uploadTestImage =
  multerSingle(memoryUpload, 'image');

const uploadCustomizationImage =
  multerSingle(memoryUpload, 'referenceImage');


const uploadCommercialMedia = (req, res, next) => {
  commercialMediaUpload.single('file')(
    req,
    res,
    error => {
      if (!error) return next();

      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return res
            .status(400)
            .json({
              error:
                'Fichier trop volumineux. Maximum 20 Mo.'
            });
        }

        return res
          .status(400)
          .json({
            error: error.message
          });
      }

      return res
        .status(400)
        .json({
          error:
            error.message ||
            'Fichier invalide.'
        });
    }
  );
};

// ============================================================
// SERVIR IMAGES
// ============================================================

router.get(
  '/uploads/:filename',
  requireAuth,
  (req, res) => {
    const filename =
      path.basename(req.params.filename || '');

    if (!filename) return res.sendStatus(404);

    const filePath =
      path.join(UPLOADS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.sendStatus(404);
    }

    return res.sendFile(filePath);
  }
);

router.get(
  '/customizations/:filename',
  requireAuth,
  (req, res) => {
    const filename =
      path.basename(req.params.filename || '');

    if (!filename) return res.sendStatus(404);

    const filePath =
      path.join(
        CUSTOMIZATIONS_DIR,
        filename
      );

    if (!fs.existsSync(filePath)) {
      return res.sendStatus(404);
    }

    return res.sendFile(filePath);
  }
);

router.get(
  '/conversation-media/:filename',
  requireAuth,
  async (req, res) => {
    const filename = path.basename(req.params.filename || '');
    if (!filename) return res.sendStatus(404);
    const filePath = path.join(CONVERSATION_MEDIA_DIR, filename);

    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; sandbox");
    const extension = path.extname(filename).toLowerCase();
    if (['.pdf','.doc','.docx','.bin'].includes(extension)) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[\"\r\n]/g, '')}"`);
    }

    // Compatibilité : pendant la migration, les anciens fichiers locaux restent
    // servis. Dès qu'un asset est migré, le même URL /admin/... continue à marcher
    // mais les octets sont lus depuis Cloudinary sans réoccuper le Volume Railway.
    if (fs.existsSync(filePath)) {
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.sendFile(filePath);
    }

    const entry = cloudManifestEntry('media', filename);
    if (entry && await proxyCloudAsset(req, res, entry)) return;
    return res.sendStatus(404);
  }
);


router.get(
  '/conversation-profile/:filename',
  requireAuth,
  async (req, res) => {
    const filename = path.basename(req.params.filename || '');
    if (!filename) return res.sendStatus(404);
    const filePath = path.join(CONVERSATION_PROFILE_DIR, filename);
    if (fs.existsSync(filePath)) {
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.sendFile(filePath);
    }
    const entry = cloudManifestEntry('profile', filename);
    if (entry && await proxyCloudAsset(req, res, entry, { profile: true })) return;

    // V6.35.2 — Photo introuvable nulle part (disque local ET Cloudinary).
    // Sans ce correctif, l'état conversation gardait quand même l'ancienne
    // URL (non vide) : le prochain rattrapage temps réel considérait donc
    // la photo comme "déjà connue" et ne la retéléchargeait jamais depuis
    // Meta, même si le fichier réel avait été purgé du disque (nettoyage
    // 14 jours) après un échec de migration Cloudinary. On efface ici la
    // référence morte pour que la photo soit re-tentée au prochain cycle.
    const facebookMatch = filename.match(/^facebook-([a-zA-Z0-9_-]+)\.[a-zA-Z0-9]+$/);
    if (facebookMatch) {
      const customerId = facebookMatch[1];
      try {
        updateConversationStateAdmin(`facebook:${customerId}`, state => {
          if (safeString(state?.profilePicture)) {
            console.warn(`⚠️ Photo profil Facebook ${customerId} : lien mort (${filename}), sera retentée.`);
            return { ...state, profilePicture: '' };
          }
          return state;
        });
      } catch (error) {
        console.warn('⚠️ Nettoyage lien photo profil Facebook impossible :', error.message);
      }
    }

    return res.sendStatus(404);
  }
);



// ============================================================
// ÉQUIPE / UTILISATEURS / RAPPORTS
// ============================================================

function invalidateUserSessions(
  userId
) {
  let changed = false;
  for (
    const [
      tokenHash,
      session
    ]
    of sessions.entries()
  ) {
    if (
      safeString(
        session?.userId
      ) ===
      safeString(
        userId
      )
    ) {
      sessions.delete(tokenHash);
      changed = true;
    }
  }
  if (changed) {
    sessionStoreDirty = true;
    persistSessions(true);
  }
}

function safeTimezone(
  value
) {
  const candidate =
    safeString(
      value
    ) ||
    'Africa/Tunis';

  try {
    new Intl.DateTimeFormat(
      'fr-FR',
      {
        timeZone:
          candidate
      }
    ).format(
      new Date()
    );

    return candidate;
  } catch {
    return 'Africa/Tunis';
  }
}

function dateKeyInTimezone(
  value,
  timezone =
    'Africa/Tunis'
) {
  const date =
    value instanceof Date
      ? value
      : new Date(
          value
        );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '';
  }

  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone:
          safeTimezone(
            timezone
          ),
        year:
          'numeric',
        month:
          '2-digit',
        day:
          '2-digit'
      }
    ).formatToParts(
      date
    );

  const get =
    type =>
      parts.find(
        part =>
          part.type ===
          type
      )?.value ||
      '';

  return (
    `${get('year')}-${get('month')}-${get('day')}`
  );
}

function timeInTimezone(
  value,
  timezone =
    'Africa/Tunis'
) {
  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '';
  }

  return new Intl.DateTimeFormat(
    'fr-FR',
    {
      timeZone:
        safeTimezone(
          timezone
        ),
      hour:
        '2-digit',
      minute:
        '2-digit'
    }
  ).format(
    date
  );
}

function getCommercialDailyReport(
  requestedDate
) {
  const timezone =
    safeTimezone(
      getBotSettings()
        ?.timezone ||
      'Africa/Tunis'
    );

  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(
      safeString(
        requestedDate
      )
    )
      ? safeString(
          requestedDate
        )
      : dateKeyInTimezone(
          new Date(),
          timezone
        );

  const users =
    loadUsers();

  const commercialUsers =
    users.filter(
      user =>
        user.role ===
          'commercial'
    );

  // V6.35.0 : rapport journalier ciblé sur la date, sans charger toute l'Inbox.
  const log =
    loadPerformanceConversationEvents([date], timezone);

  const replies =
    log.filter(
      entry => {
        if (
          entry.action !==
            'commercial_reply' ||
          dateKeyInTimezone(
            entry.time,
            timezone
          ) !==
            date
        ) {
          return false;
        }

        const actorRole =
          safeString(
            entry.commercial_user_role
          );

        // Le classement quotidien concerne les comptes commerciaux.
        // Les anciennes réponses sans rôle restent signalées comme non attribuées.
        return (
          !actorRole ||
          actorRole ===
            'commercial'
        );
      }
    );

  const statsByUser =
    new Map();

  for (
    const user
    of commercialUsers
  ) {
    statsByUser.set(
      user.id,
      {
        userId:
          user.id,
        name:
          safeString(
            user.name
          ) ||
          safeString(
            user.email
          ),
        email:
          safeString(
            user.email
          ),
        role:
          user.role,
        active:
          user.active !==
          false,
        replies:
          0,
        conversations:
          new Set(),
        files:
          0,
        textReplies:
          0,
        firstReplyAt:
          '',
        lastReplyAt:
          ''
      }
    );
  }

  let unattributedReplies =
    0;

  for (
    const entry
    of replies
  ) {
    const userId =
      safeString(
        entry.commercial_user_id
      );

    const actorRole =
      safeString(
        entry.commercial_user_role
      );

    if (!userId) {
      if (
        !actorRole ||
        actorRole ===
          'commercial'
      ) {
        unattributedReplies +=
          1;
      }

      continue;
    }

    if (
      !statsByUser.has(
        userId
      ) &&
      actorRole ===
        'commercial'
    ) {
      statsByUser.set(
        userId,
        {
          userId,
          name:
            safeString(
              entry.commercial_user_name
            ) ||
            safeString(
              entry.commercial_user_email
            ) ||
            'Ancien commercial',
          email:
            safeString(
              entry.commercial_user_email
            ),
          role:
            'commercial',
          active:
            false,
          replies:
            0,
          conversations:
            new Set(),
          files:
            0,
          textReplies:
            0,
          firstReplyAt:
            '',
          lastReplyAt:
            ''
        }
      );
    }

    if (
      !statsByUser.has(
        userId
      )
    ) {
      continue;
    }

    const stat =
      statsByUser.get(
        userId
      );

    stat.replies +=
      1;

    if (
      safeString(
        entry.contact
      )
    ) {
      stat.conversations.add(
        safeString(
          entry.contact
        )
      );
    }

    if (
      safeString(
        entry.attachment_type
      )
    ) {
      stat.files +=
        1;
    }

    if (
      safeString(
        entry.reply
      )
    ) {
      stat.textReplies +=
        1;
    }

    const time =
      safeString(
        entry.time
      );

    if (
      time &&
      (
        !stat.firstReplyAt ||
        new Date(time) <
          new Date(
            stat.firstReplyAt
          )
      )
    ) {
      stat.firstReplyAt =
        time;
    }

    if (
      time &&
      (
        !stat.lastReplyAt ||
        new Date(time) >
          new Date(
            stat.lastReplyAt
          )
      )
    ) {
      stat.lastReplyAt =
        time;
    }
  }

  const ranking =
    [
      ...statsByUser
        .values()
    ]
      .map(
        stat => ({
          ...stat,
          conversations:
            stat.conversations.size,
          firstReplyTime:
            timeInTimezone(
              stat.firstReplyAt,
              timezone
            ),
          lastReplyTime:
            timeInTimezone(
              stat.lastReplyAt,
              timezone
            )
        })
      )
      .sort(
        (a, b) =>
          b.replies -
            a.replies ||
          b.conversations -
            a.conversations ||
          a.name.localeCompare(
            b.name,
            'fr'
          )
      )
      .map(
        (
          stat,
          index
        ) => ({
          rank:
            index + 1,
          ...stat
        })
      );

  return {
    date,
    timezone,
    summary: {
      totalReplies:
        ranking.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.replies,
          0
        ),
      totalConversations:
        new Set(
          replies
            .map(
              entry =>
                safeString(
                  entry.contact
                )
            )
            .filter(Boolean)
        ).size,
      activeCommercials:
        ranking.filter(
          item =>
            item.replies >
            0
        ).length,
      totalCommercials:
        commercialUsers.length,
      filesSent:
        ranking.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.files,
          0
        ),
      unattributedReplies
    },
    ranking
  };
}

router.get(
  '/api/me',
  requireAuth,
  (
    req,
    res
  ) => {
    return res.json(
      sanitizeUserForClient(
        req.user
      )
    );
  }
);

router.post(
  '/api/presence/heartbeat',
  requireAuth,
  (
    req,
    res
  ) => {
    const session =
      touchSessionPresence(
        req,
        req.body?.page
      );

    recordAttendance(req.user);

    return res.json({
      success: true,
      lastSeenAt:
        session?.lastSeenAt
          ? new Date(session.lastSeenAt).toISOString()
          : new Date().toISOString()
    });
  }
);

router.get(
  '/api/presence',
  requireAdminOrCommercialManager,
  (
    req,
    res
  ) => {
    // Le simple fait d'ouvrir la page Équipe maintient aussi la session admin présente.
    touchSessionPresence(
      req,
      'Équipe & rapports'
    );

    const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(safeString(req.query?.date))
      ? safeString(req.query.date)
      : dateKeyInTimezone(new Date(), timezone);
    const users =
      loadUsers()
        .map(user => ({
          ...sanitizeUserForClient(user),
          presence: getPresenceForUser(user.id),
          attendance: attendanceMetricsForUser(date, user.id)
        }))
        .sort(
          (a, b) => {
            const order = {
              online: 0,
              idle: 1,
              offline: 2
            };

            return (
              (order[a.presence?.status] ?? 9) -
              (order[b.presence?.status] ?? 9) ||
              a.name.localeCompare(
                b.name,
                'fr'
              )
            );
          }
        );

    return res.json({
      generatedAt:
        new Date().toISOString(),
      date,
      onlineCount:
        users.filter(
          user =>
            user.presence?.status === 'online'
        ).length,
      idleCount:
        users.filter(
          user =>
            user.presence?.status === 'idle'
        ).length,
      totalCount:
        users.length,
      users
    });
  }
);

router.get(
  '/api/users',
  requireAdminOrCommercialManager,
  (
    req,
    res
  ) => {
    const visibleUsers = isCommercialManager(req.user)
      ? loadUsers().filter(user => user.role === 'commercial')
      : loadUsers();

    return res.json(
      visibleUsers
        .map(
          sanitizeUserForClient
        )
        .sort(
          (a, b) =>
            a.name.localeCompare(
              b.name,
              'fr'
            )
        )
    );
  }
);

router.post(
  '/api/users',
  requireAdminOrCommercialManager,
  (
    req,
    res
  ) => {
    const name =
      safeString(
        req.body?.name
      ).trim();

    const email =
      normalizeEmail(
        req.body?.email
      );

    const role =
      safeString(
        req.body?.role
      );

    const password =
      safeString(
        req.body?.password
      );

    if (
      isCommercialManager(req.user) &&
      role !== 'commercial'
    ) {
      return res.status(403).json({
        error: 'Le responsable commercial peut uniquement créer des comptes commerciaux.'
      });
    }

    if (
      !name ||
      !email ||
      !role ||
      !password
    ) {
      return res
        .status(400)
        .json({
          error:
            'Nom, e-mail, rôle et mot de passe sont obligatoires.'
        });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            'Adresse e-mail invalide.'
        });
    }

    if (
      !ALLOWED_USER_ROLES.has(
        role
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            'Rôle invalide.'
        });
    }

    if (
      password.length <
      8
    ) {
      return res
        .status(400)
        .json({
          error:
            'Le mot de passe doit contenir au moins 8 caractères.'
        });
    }

    const users =
      loadUsers();

    if (
      users.some(
        user =>
          normalizeEmail(
            user.email
          ) ===
          email
      )
    ) {
      return res
        .status(409)
        .json({
          error:
            'Un compte utilise déjà cet e-mail.'
        });
    }

    const credentials =
      hashUserPassword(
        password
      );

    const now =
      new Date().toISOString();

    const user = {
      id:
        crypto.randomUUID(),
      name,
      email,
      role,
      active:
        true,
      passwordSalt:
        credentials.salt,
      passwordHash:
        credentials.hash,
      createdAt:
        now,
      updatedAt:
        now,
      lastLoginAt:
        null
    };

    users.push(
      user
    );

    saveUsers(
      users
    );

    return res
      .status(201)
      .json(
        sanitizeUserForClient(
          user
        )
      );
  }
);

router.put(
  '/api/users/:id',
  requireAdminOrCommercialManager,
  (
    req,
    res
  ) => {
    const users =
      loadUsers();

    const index =
      users.findIndex(
        user =>
          user.id ===
          req.params.id
      );

    if (
      index === -1
    ) {
      return res
        .status(404)
        .json({
          error:
            'Utilisateur introuvable.'
        });
    }

    const current =
      users[index];

    if (
      isCommercialManager(req.user) &&
      current.role !== 'commercial'
    ) {
      return res.status(403).json({
        error: 'Le responsable commercial peut uniquement modifier les comptes commerciaux.'
      });
    }

    const name =
      safeString(
        req.body?.name ??
        current.name
      ).trim();

    const email =
      normalizeEmail(
        req.body?.email ??
        current.email
      );

    const role =
      safeString(
        req.body?.role ??
        current.role
      );

    const active =
      req.body?.active ===
        undefined
        ? current.active !==
          false
        : req.body.active ===
          true;

    const password =
      safeString(
        req.body?.password
      );

    if (
      isCommercialManager(req.user) &&
      role !== 'commercial'
    ) {
      return res.status(403).json({
        error: 'Le responsable commercial ne peut pas changer le rôle d’un commercial.'
      });
    }

    if (
      !name ||
      !email ||
      !ALLOWED_USER_ROLES.has(
        role
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            'Nom, e-mail ou rôle invalide.'
        });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            'Adresse e-mail invalide.'
        });
    }

    if (
      users.some(
        user =>
          user.id !==
            current.id &&
          normalizeEmail(
            user.email
          ) ===
            email
      )
    ) {
      return res
        .status(409)
        .json({
          error:
            'Un autre compte utilise déjà cet e-mail.'
        });
    }

    const wouldRemoveAdmin =
      current.role ===
        'admin' &&
      current.active !==
        false &&
      (
        role !==
          'admin' ||
        active ===
          false
      );

    if (
      wouldRemoveAdmin &&
      countActiveAdmins(
        users
      ) <= 1
    ) {
      return res
        .status(400)
        .json({
          error:
            'Impossible de désactiver ou rétrograder le dernier administrateur actif.'
        });
    }

    const updated = {
      ...current,
      name,
      email,
      role,
      active,
      updatedAt:
        new Date().toISOString()
    };

    if (password) {
      if (
        password.length <
        8
      ) {
        return res
          .status(400)
          .json({
            error:
              'Le nouveau mot de passe doit contenir au moins 8 caractères.'
          });
      }

      const credentials =
        hashUserPassword(
          password
        );

      updated.passwordSalt =
        credentials.salt;

      updated.passwordHash =
        credentials.hash;
    }

    users[index] =
      updated;

    saveUsers(
      users
    );

    if (
      active ===
        false ||
      password
    ) {
      invalidateUserSessions(
        updated.id
      );
    }

    return res.json(
      sanitizeUserForClient(
        updated
      )
    );
  }
);

router.delete(
  '/api/users/:id',
  requireAdminOrCommercialManager,
  (
    req,
    res
  ) => {
    const users =
      loadUsers();

    const index =
      users.findIndex(
        user =>
          user.id ===
          req.params.id
      );

    if (
      index === -1
    ) {
      return res
        .status(404)
        .json({
          error:
            'Utilisateur introuvable.'
        });
    }

    const user =
      users[index];

    if (
      isCommercialManager(req.user) &&
      user.role !== 'commercial'
    ) {
      return res.status(403).json({
        error: 'Le responsable commercial peut uniquement supprimer des comptes commerciaux.'
      });
    }

    if (
      user.id ===
      req.user.id
    ) {
      return res
        .status(400)
        .json({
          error:
            'Vous ne pouvez pas supprimer votre propre compte.'
        });
    }

    if (
      user.role ===
        'admin' &&
      user.active !==
        false &&
      countActiveAdmins(
        users
      ) <= 1
    ) {
      return res
        .status(400)
        .json({
          error:
            'Impossible de supprimer le dernier administrateur actif.'
        });
    }

    users.splice(
      index,
      1
    );

    saveUsers(
      users
    );

    invalidateUserSessions(
      user.id
    );

    return res.json({
      success:
        true
    });
  }
);

router.get(
  '/api/reports/commercial-daily',
  requireAdmin,
  (
    req,
    res
  ) => {
    const requested = safeString(req.query?.date);
    const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
    const today = dateKeyInTimezone(new Date(), timezone);
    const reports = loadDailyReports();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;
    const report = reports[date] || ensureDailyReportGenerated(true, date);
    return res.json(report);
  }
);


// ============================================================
// V6.19 — RESPONSABLE COMMERCIAL / PLANNING / TÂCHES / SLA
// ============================================================

const DEFAULT_COMMERCIAL_SLA_MINUTES = 5;
const DAILY_REPORT_HOUR_TUNIS = 20;
const attendanceWriteThrottle = new Map();

function loadSchedules() {
  return readJsonArray(SCHEDULES_PATH, 'schedules.json');
}

function saveSchedules(items) {
  writeJsonAtomic(SCHEDULES_PATH, Array.isArray(items) ? items : []);
}

function taskEffectiveStatus(item) {
  const status = safeString(item?.status || 'todo');
  if (['done','cancelled'].includes(status)) return status;
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const today = dateKeyInTimezone(new Date(), timezone);
  const date = safeString(item?.date);
  if (date && date < today) return 'late';
  if (date === today) {
    const due = timeMinutes(item?.dueTime);
    if (due !== null && tunisMinutesNow() > due) return 'late';
  }
  return status;
}

function loadTasks() {
  return readJsonArray(TASKS_PATH, 'tasks.json').map(item => ({
    ...item,
    status: taskEffectiveStatus(item)
  }));
}

function saveTasks(items) {
  writeJsonAtomic(TASKS_PATH, Array.isArray(items) ? items : []);
}


// V6.35.0 — lecteurs JSON mémoire-sûrs.
// Les anciens fichiers peuvent devenir volumineux. On les parcourt par petits
// blocs au lieu de faire readFileSync(...).split(...), qui duplique le contenu
// complet plusieurs fois dans la RAM et peut provoquer un OOM Railway.
function forEachJsonlRecordSync(filePath, visitor) {
  if (!fs.existsSync(filePath) || typeof visitor !== 'function') return 0;
  const fd = fs.openSync(filePath, 'r');
  const decoder = new TextDecoder('utf-8');
  const buffer = Buffer.allocUnsafe(128 * 1024);
  let carry = '';
  let count = 0;
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      const chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead > 0 });
      const text = carry + chunk;
      const lines = text.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            visitor(item);
            count += 1;
          }
        } catch {}
      }
    } while (bytesRead > 0);
    carry += decoder.decode();
    if (carry.trim()) {
      try {
        const item = JSON.parse(carry);
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          visitor(item);
          count += 1;
        }
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

function forEachJsonArrayObjectSync(filePath, visitor) {
  if (!fs.existsSync(filePath) || typeof visitor !== 'function') return 0;
  const fd = fs.openSync(filePath, 'r');
  const decoder = new TextDecoder('utf-8');
  const buffer = Buffer.allocUnsafe(128 * 1024);
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = '';
  let count = 0;

  const feed = text => {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (!collecting) {
        if (ch === '{') {
          collecting = true;
          depth = 1;
          inString = false;
          escaped = false;
          current = '{';
        }
        continue;
      }

      current += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const item = JSON.parse(current);
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              visitor(item);
              count += 1;
            }
          } catch {}
          collecting = false;
          current = '';
        }
      }
    }
  };

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      feed(decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead > 0 }));
    } while (bytesRead > 0);
    feed(decoder.decode());
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

function conversationEventFilesSince(cutoffAt = historyImportCutoffIso()) {
  const cutoffMs = Date.parse(safeString(cutoffAt));
  const cutoffDay = Number.isFinite(cutoffMs)
    ? new Date(cutoffMs - 24 * 60 * 60 * 1000).toISOString().slice(0,10)
    : '';
  try {
    return fs.readdirSync(CONVERSATION_EVENTS_DIR)
      .filter(name => /^conversation-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .filter(name => !cutoffDay || name.slice('conversation-events-'.length, 'conversation-events-'.length + 10) >= cutoffDay)
      .sort();
  } catch {
    return [];
  }
}

function loadSlaEvents() {
  return readJsonArray(SLA_EVENTS_PATH, 'sla-events.json');
}

function saveSlaEvents(items) {
  const list = Array.isArray(items) ? items : [];
  writeJsonAtomic(SLA_EVENTS_PATH, list.slice(-5000));
}

function appendSlaEvent(event) {
  const items = loadSlaEvents();
  items.push({
    id: safeString(event?.id) || crypto.randomUUID(),
    ...event,
    time: safeString(event?.time) || new Date().toISOString()
  });
  saveSlaEvents(items);
}

function loadDailyReports() {
  try {
    if (!fs.existsSync(DAILY_REPORTS_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(DAILY_REPORTS_PATH, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('⚠️ Lecture daily-reports.json :', error.message);
    return {};
  }
}

function saveDailyReports(items) {
  writeJsonAtomic(DAILY_REPORTS_PATH, items && typeof items === 'object' ? items : {});
}

function loadAttendance() {
  try {
    if (!fs.existsSync(ATTENDANCE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(ATTENDANCE_PATH, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('⚠️ Lecture attendance-log.json :', error.message);
    return {};
  }
}

function saveAttendance(items) {
  writeJsonAtomic(ATTENDANCE_PATH, items && typeof items === 'object' ? items : {});
}

// V6.34 — journal d'activité léger pour les actions qui ne passent pas par
// conversation-log.json (ouverture d'une discussion, réponse à un commentaire,
// réponse privée depuis un commentaire). Il permet d'attribuer les rapports à
// un compte précis sans mesurer la présence comme KPI principal.
function teamActivityDayPath(date) {
  return path.join(TEAM_ACTIVITY_DIR, `team-activity-${safeString(date)}.jsonl`);
}

function appendTeamActivity(event = {}) {
  try {
    const item = {
      id: safeString(event.id) || crypto.randomUUID(),
      ...event,
      time: safeString(event.time) || new Date().toISOString()
    };
    const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
    const date = dateKeyInTimezone(item.time, timezone);
    fs.appendFileSync(teamActivityDayPath(date), `${JSON.stringify(item)}\n`, 'utf8');
    return item;
  } catch (error) {
    console.warn('⚠️ Journal activité équipe :', error.message);
    return null;
  }
}

function ensureLegacyTeamActivityDay(date) {
  const target = safeString(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return '';
  const targetPath = teamActivityDayPath(target);
  if (fs.existsSync(targetPath)) return targetPath;
  if (!fs.existsSync(TEAM_ACTIVITY_PATH)) return targetPath;

  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  let written = 0;
  try {
    const fd = fs.openSync(tempPath, 'w');
    try {
      forEachJsonlRecordSync(TEAM_ACTIVITY_PATH, item => {
        if (dateKeyInTimezone(item?.time, timezone) !== target) return;
        fs.writeSync(fd, `${JSON.stringify(item)}\n`, null, 'utf8');
        written += 1;
      });
    } finally {
      fs.closeSync(fd);
    }
    if (written > 0) fs.renameSync(tempPath, targetPath);
    else fs.unlinkSync(tempPath);
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    console.warn(`⚠️ Migration activité équipe ${target} :`, error.message);
  }
  return targetPath;
}

function loadTeamActivity(date = '') {
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const target = safeString(date);
  if (!target) return [];
  const today = dateKeyInTimezone(new Date(), timezone);
  if (target > teamDateAdd(today, 1)) return [];

  const filePath = ensureLegacyTeamActivityDay(target);
  if (!filePath || !fs.existsSync(filePath)) return [];
  const items = [];
  forEachJsonlRecordSync(filePath, item => {
    if (dateKeyInTimezone(item?.time, timezone) === target) items.push(item);
  });
  return items;
}

function timeMinutes(value) {
  const match = safeString(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function tunisClockParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Tunis',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const get = type => Number(parts.find(part => part.type === type)?.value || 0);
  return { hour: get('hour'), minute: get('minute') };
}

function tunisMinutesNow(value = new Date()) {
  const parts = tunisClockParts(value);
  return parts.hour * 60 + parts.minute;
}

const TEAM_ACCESS_CHANNELS = new Set([
  'whatsapp_messages',
  'instagram_messages',
  'instagram_comments',
  'facebook_messages',
  'facebook_comments'
]);

function normalizeChannels(value) {
  // V6.34.1 — faire la différence entre un ancien planning qui ne possède
  // vraiment pas le champ channels et une sélection explicitement vide.
  // Une sélection vide signifie désormais : AUCUN accès réseau.
  if (value === undefined || value === null) {
    return [...TEAM_ACCESS_CHANNELS];
  }
  const raw = Array.isArray(value) ? value : [value];
  const expanded = [];
  for (const item of raw) {
    const channel = safeString(item).toLowerCase().trim();
    if (!channel) continue;
    if (TEAM_ACCESS_CHANNELS.has(channel)) {
      expanded.push(channel);
      continue;
    }
    // Compatibilité avec les plannings V6.33.1 et antérieurs.
    if (channel === 'whatsapp') expanded.push('whatsapp_messages');
    if (channel === 'instagram') expanded.push('instagram_messages', 'instagram_comments');
    if (channel === 'facebook') expanded.push('facebook_messages', 'facebook_comments');
  }
  return [...new Set(expanded)];
}

function messageAccessKey(channel) {
  const value = safeString(channel).toLowerCase();
  if (value === 'instagram') return 'instagram_messages';
  if (value === 'facebook') return 'facebook_messages';
  return 'whatsapp_messages';
}

function commentAccessKey(channel) {
  const value = safeString(channel).toLowerCase();
  if (value === 'facebook') return 'facebook_comments';
  return 'instagram_comments';
}

function channelScopeAllowsMessage(scope, channel) {
  return !scope || scope.has(messageAccessKey(channel));
}

function channelScopeAllowsComment(scope, channel) {
  return !scope || scope.has(commentAccessKey(channel));
}

function commercialChannelScope(user, date = '') {
  return plannedChannelSetForUser(user, date);
}

function requireCommercialMessageChannelAccess(req, res, channel) {
  if (safeString(req.user?.role) !== 'commercial') return true;
  const scope = commercialChannelScope(req.user);
  if (channelScopeAllowsMessage(scope, channel)) return true;
  res.status(403).json({ error:'Accès refusé : ce canal de messages ne fait pas partie de votre planning du jour.' });
  return false;
}

function requireCommercialCommentChannelAccess(req, res, channel) {
  if (safeString(req.user?.role) !== 'commercial') return true;
  const scope = commercialChannelScope(req.user);
  if (channelScopeAllowsComment(scope, channel)) return true;
  res.status(403).json({ error:'Accès refusé : ce canal de commentaires ne fait pas partie de votre planning du jour.' });
  return false;
}

function scheduleWindowMs(schedule) {
  const date = safeString(schedule?.date);
  const start = tunisDateTimeMs(date, schedule?.startTime);
  let end = tunisDateTimeMs(date, schedule?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) end += 24 * 60 * 60 * 1000;
  return { start, end, crossesMidnight: end - start > 0 && safeString(schedule?.endTime) <= safeString(schedule?.startTime) };
}

function scheduleIsActiveNow(schedule, now = new Date(), channel = '') {
  if (schedule?.active === false) return false;
  const window = scheduleWindowMs(schedule);
  const nowMs = new Date(now).getTime();
  if (!window || !Number.isFinite(nowMs) || nowMs < window.start || nowMs >= window.end) return false;

  const breakStartMin = timeMinutes(schedule?.breakStart);
  const breakEndMin = timeMinutes(schedule?.breakEnd);
  if (breakStartMin !== null && breakEndMin !== null) {
    let breakStart = tunisDateTimeMs(safeString(schedule?.date), schedule?.breakStart);
    let breakEnd = tunisDateTimeMs(safeString(schedule?.date), schedule?.breakEnd);
    if (Number.isFinite(breakStart) && Number.isFinite(breakEnd)) {
      if (breakStart < window.start) breakStart += 24 * 60 * 60 * 1000;
      if (breakEnd <= breakStart) breakEnd += 24 * 60 * 60 * 1000;
      if (nowMs >= breakStart && nowMs < breakEnd) return false;
    }
  }

  const requestedChannel = safeString(channel).toLowerCase();
  if (!requestedChannel) return true;
  const scope = new Set(normalizeChannels(schedule?.channels));
  return channelScopeAllowsMessage(scope, requestedChannel);
}

function recordAttendance(user) {
  // V6.28 — suivi de présence pour tous les membres actifs de l'application,
  // pas uniquement les commerciaux. Le heartbeat reste volontairement léger.
  if (!user?.id || user.active === false) return;
  const nowMs = Date.now();
  const previousWrite = Number(attendanceWriteThrottle.get(user.id) || 0);
  if (nowMs - previousWrite < 60 * 1000) return;
  attendanceWriteThrottle.set(user.id, nowMs);
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const date = dateKeyInTimezone(new Date(), timezone);
  const key = `${date}:${user.id}`;
  const now = new Date(nowMs).toISOString();
  const attendance = loadAttendance();
  const current = attendance[key] && typeof attendance[key] === 'object' ? attendance[key] : {};
  const segments = Array.isArray(current.segments)
    ? current.segments.filter(item => item && typeof item === 'object').slice(-128)
    : [];
  const last = segments.length ? segments[segments.length - 1] : null;
  const lastMs = Date.parse(safeString(last?.lastAt));
  // Un trou > 2 minutes crée une nouvelle session. Les heartbeats navigateur
  // arrivent toutes les 20 s, mais on n'écrit sur disque qu'une fois/minute.
  if (last && Number.isFinite(lastMs) && nowMs - lastMs <= 2 * 60 * 1000) {
    last.lastAt = now;
  } else {
    segments.push({ startAt: now, lastAt: now });
  }
  attendance[key] = {
    ...current,
    date,
    userId: user.id,
    name: safeString(user.name || current.name),
    role: safeString(user.role || current.role),
    firstSeenAt: current.firstSeenAt || now,
    lastSeenAt: now,
    heartbeats: Number(current.heartbeats || 0) + 1,
    segments: segments.slice(-128)
  };
  saveAttendance(attendance);
}

function tunisDateTimeMs(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeString(date)) || timeMinutes(time) === null) return NaN;
  // La Tunisie utilise UTC+01:00 toute l'année. Ce format évite que le fuseau
  // du conteneur Railway modifie les horaires commerciaux enregistrés.
  return Date.parse(`${date}T${safeString(time)}:00+01:00`);
}

function scheduleIntervalsForDate(date, userId) {
  const intervals = [];
  const dayStart = Date.parse(`${date}T00:00:00+01:00`);
  const dayEnd = Date.parse(`${date}T23:59:59.999+01:00`);
  const previousDate = teamDateAdd(date, -1);
  const schedules = loadSchedules().filter(item =>
    safeString(item.userId) === safeString(userId) &&
    item.active !== false &&
    [safeString(date), previousDate].includes(safeString(item.date))
  );
  for (const schedule of schedules) {
    const window = scheduleWindowMs(schedule);
    if (!window) continue;
    let start = Math.max(dayStart, window.start);
    let end = Math.min(dayEnd, window.end);
    if (end <= start) continue;

    let breakStart = tunisDateTimeMs(safeString(schedule.date), schedule.breakStart);
    let breakEnd = tunisDateTimeMs(safeString(schedule.date), schedule.breakEnd);
    if (Number.isFinite(breakStart) && Number.isFinite(breakEnd)) {
      if (breakStart < window.start) breakStart += 24 * 60 * 60 * 1000;
      if (breakEnd <= breakStart) breakEnd += 24 * 60 * 60 * 1000;
      const clippedBreakStart = Math.max(start, breakStart);
      const clippedBreakEnd = Math.min(end, breakEnd);
      if (clippedBreakEnd > clippedBreakStart) {
        if (clippedBreakStart > start) intervals.push([start, clippedBreakStart]);
        if (clippedBreakEnd < end) intervals.push([clippedBreakEnd, end]);
        continue;
      }
    }
    intervals.push([start, end]);
  }
  return intervals;
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function attendanceMetricsForUser(date, userId, nowMs = Date.now()) {
  const attendance = loadAttendance();
  const record = attendance[`${date}:${userId}`] || {};
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const today = dateKeyInTimezone(new Date(nowMs), timezone);
  const dayStart = Date.parse(`${date}T00:00:00+01:00`);
  const dayEnd = Date.parse(`${date}T23:59:59.999+01:00`);
  const effectiveEnd = date === today ? Math.min(nowMs, dayEnd) : dayEnd;
  const segments = [];
  for (const item of Array.isArray(record.segments) ? record.segments : []) {
    const start = Date.parse(safeString(item?.startAt));
    const last = Date.parse(safeString(item?.lastAt));
    if (!Number.isFinite(start) || !Number.isFinite(last)) continue;
    // On ajoute une minute de grâce au dernier heartbeat, plafonnée à 75 s,
    // afin de représenter le temps réellement actif entre deux écritures disque.
    segments.push([Math.max(dayStart, start), Math.min(effectiveEnd, last + 75 * 1000)]);
  }
  let onlineMs = segments.reduce((sum, [start,end]) => sum + Math.max(0,end-start), 0);
  // Compatibilité avec les jours enregistrés avant V6.28 (sans segments).
  if (!segments.length && Number(record.heartbeats || 0) > 0) {
    const first = Date.parse(safeString(record.firstSeenAt));
    const last = Date.parse(safeString(record.lastSeenAt));
    const estimated = Number(record.heartbeats || 0) * 60 * 1000;
    if (Number.isFinite(first) && Number.isFinite(last)) {
      onlineMs = Math.max(0, Math.min(estimated, Math.max(60 * 1000, last - first + 60 * 1000)));
    } else {
      onlineMs = estimated;
    }
  }

  const planned = scheduleIntervalsForDate(date, userId);
  let scheduledElapsedMs = 0;
  let onlineScheduledMs = 0;
  for (const [start,end] of planned) {
    const clippedEnd = Math.min(end, effectiveEnd);
    if (clippedEnd <= start) continue;
    scheduledElapsedMs += clippedEnd - start;
    for (const [onlineStart,onlineEnd] of segments) {
      onlineScheduledMs += overlapMs(start, clippedEnd, onlineStart, onlineEnd);
    }
  }

  let offlineMs = 0;
  let basis = planned.length ? 'planning' : 'activité';
  if (planned.length) {
    // Si la journée est legacy et qu'on ne possède pas les segments, on utilise
    // l'estimation globale mais sans jamais dépasser le temps planifié écoulé.
    if (!segments.length) onlineScheduledMs = Math.min(scheduledElapsedMs, onlineMs);
    offlineMs = Math.max(0, scheduledElapsedMs - onlineScheduledMs);
  } else {
    const first = Date.parse(safeString(record.firstSeenAt));
    const trackedStart = Number.isFinite(first) ? Math.max(dayStart, first) : effectiveEnd;
    const trackedWindow = Math.max(0, effectiveEnd - trackedStart);
    offlineMs = Math.max(0, trackedWindow - Math.min(trackedWindow, onlineMs));
  }

  return {
    date,
    basis,
    onlineMs: Math.round(onlineMs),
    offlineMs: Math.round(offlineMs),
    scheduledElapsedMs: Math.round(scheduledElapsedMs),
    scheduledTotalMs: Math.round(planned.reduce((sum,[start,end]) => sum + Math.max(0,end-start),0)),
    firstSeenAt: safeString(record.firstSeenAt),
    lastSeenAt: safeString(record.lastSeenAt),
    heartbeats: Number(record.heartbeats || 0),
    sessions: segments.length || (record.heartbeats ? 1 : 0)
  };
}

function getSchedulesForDate(date) {
  return loadSchedules()
    .filter(item => safeString(item.date) === safeString(date))
    .sort((a,b) => safeString(a.startTime).localeCompare(safeString(b.startTime)));
}

function findAutomaticCommercial(channel, now = new Date()) {
  const users = loadUsers().filter(user => user.role === 'commercial' && user.active !== false);
  const validIds = new Set(users.map(user => user.id));
  const candidates = loadSchedules().filter(item => validIds.has(safeString(item.userId)) && scheduleIsActiveNow(item, now, channel));
  if (!candidates.length) return null;
  const states = loadConversationStatesAdmin();
  const loadByUser = new Map();
  for (const state of Object.values(states)) {
    const userId = safeString(state?.assignedUserId);
    const slaStatus = safeString(state?.sla?.status || state?.slaStatus);
    if (!userId || !['pending','late'].includes(slaStatus)) continue;
    loadByUser.set(userId, Number(loadByUser.get(userId) || 0) + 1);
  }
  candidates.sort((a,b) => {
    const loadDiff = Number(loadByUser.get(a.userId) || 0) - Number(loadByUser.get(b.userId) || 0);
    if (loadDiff) return loadDiff;
    return safeString(a.startTime).localeCompare(safeString(b.startTime));
  });
  const schedule = candidates[0];
  const user = users.find(item => item.id === schedule.userId);
  return user ? { user, schedule } : null;
}

function registerCommercialEscalation({
  contact,
  channel = 'whatsapp',
  reason = '',
  messageId = '',
  source = ''
} = {}) {
  const cleanContact = safeString(contact);
  if (!cleanContact) return null;
  const states = loadConversationStatesAdmin();
  const existing = states[cleanContact] && typeof states[cleanContact] === 'object' ? states[cleanContact] : {};
  const existingStatus = safeString(existing?.sla?.status || existing?.slaStatus);
  if (['pending','late'].includes(existingStatus)) return existing;

  const match = findAutomaticCommercial(channel, new Date());
  const slaMinutes = Math.max(1, Math.min(120, Number(match?.schedule?.slaMinutes || DEFAULT_COMMERCIAL_SLA_MINUTES) || DEFAULT_COMMERCIAL_SLA_MINUTES));
  const startedAt = new Date();
  const dueAt = new Date(startedAt.getTime() + slaMinutes * 60 * 1000);
  const slaId = crypto.randomUUID();
  const updated = {
    ...existing,
    channel: safeString(channel) || safeString(existing.channel) || 'whatsapp',
    commercialAttention: true,
    commercialAttentionReason: safeString(reason) || safeString(existing.commercialAttentionReason) || 'Intervention commerciale requise.',
    assignedTo: match ? (safeString(match.user.name) || safeString(match.user.email)) : safeString(existing.assignedTo),
    assignedUserId: match ? safeString(match.user.id) : safeString(existing.assignedUserId),
    assignedAt: match ? startedAt.toISOString() : safeString(existing.assignedAt),
    sla: {
      id: slaId,
      status: 'pending',
      startedAt: startedAt.toISOString(),
      dueAt: dueAt.toISOString(),
      minutes: slaMinutes,
      reason: safeString(reason),
      assignedUserId: match ? safeString(match.user.id) : safeString(existing.assignedUserId),
      messageId: safeString(messageId),
      source: safeString(source)
    }
  };
  states[cleanContact] = updated;
  saveConversationStatesAdmin(states);
  appendSlaEvent({
    id: slaId,
    event: 'started',
    contact: cleanContact,
    channel: updated.channel,
    reason: safeString(reason),
    messageId: safeString(messageId),
    assignedUserId: safeString(updated.assignedUserId),
    assignedTo: safeString(updated.assignedTo),
    startedAt: startedAt.toISOString(),
    dueAt: dueAt.toISOString(),
    slaMinutes
  });
  return updated;
}

function resolveCommercialSla({ contact, actor = {} } = {}) {
  const cleanContact = safeString(contact);
  if (!cleanContact) return null;
  const states = loadConversationStatesAdmin();
  const current = states[cleanContact] && typeof states[cleanContact] === 'object' ? states[cleanContact] : {};
  const sla = current.sla && typeof current.sla === 'object' ? current.sla : null;
  if (!sla || !['pending','late'].includes(safeString(sla.status))) return current;
  const answeredAt = new Date();
  const startedMs = Date.parse(sla.startedAt || '');
  const dueMs = Date.parse(sla.dueAt || '');
  const responseSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.round((answeredAt.getTime() - startedMs) / 1000)) : null;
  const late = Number.isFinite(dueMs) && answeredAt.getTime() > dueMs;
  const updatedSla = {
    ...sla,
    status: late ? 'late_resolved' : 'resolved',
    answeredAt: answeredAt.toISOString(),
    responseSeconds,
    lateSeconds: late && Number.isFinite(dueMs) ? Math.max(0, Math.round((answeredAt.getTime() - dueMs) / 1000)) : 0,
    answeredByUserId: safeString(actor?.id),
    answeredBy: safeString(actor?.name) || safeString(actor?.email)
  };
  const updated = {
    ...current,
    commercialAttention: false,
    commercialAttentionReason: '',
    imageNeedsCommercial: false,
    sla: updatedSla
  };
  states[cleanContact] = updated;
  saveConversationStatesAdmin(states);
  appendSlaEvent({
    event: 'resolved',
    slaId: safeString(sla.id),
    contact: cleanContact,
    channel: safeString(current.channel),
    assignedUserId: safeString(current.assignedUserId),
    answeredByUserId: safeString(actor?.id),
    answeredBy: safeString(actor?.name) || safeString(actor?.email),
    startedAt: safeString(sla.startedAt),
    dueAt: safeString(sla.dueAt),
    answeredAt: answeredAt.toISOString(),
    responseSeconds,
    late
  });
  return updated;
}

function computeLiveSla(state) {
  const sla = state?.sla && typeof state.sla === 'object' ? state.sla : null;
  if (!sla) return null;
  const dueMs = Date.parse(sla.dueAt || '');
  const nowMs = Date.now();
  const rawStatus = safeString(sla.status);
  const open = ['pending','late'].includes(rawStatus);
  const remainingMs = Number.isFinite(dueMs) ? dueMs - nowMs : null;
  const status = open && Number.isFinite(remainingMs) && remainingMs < 0 ? 'late' : rawStatus;
  return { ...sla, status, remainingMs };
}

function buildDetailedCommercialDailyReport(requestedDate) {
  const base = getCommercialDailyReport(requestedDate);
  const date = base.date;
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const schedules = getSchedulesForDate(date);
  const tasks = loadTasks().filter(item => safeString(item.date) === date);
  const attendance = loadAttendance();
  const slaEvents = loadSlaEvents();
  const started = slaEvents.filter(item => item.event === 'started' && dateKeyInTimezone(item.startedAt || item.time, timezone) === date);
  const resolved = slaEvents.filter(item => item.event === 'resolved' && dateKeyInTimezone(item.answeredAt || item.time, timezone) === date);
  const currentStates = loadConversationStatesAdmin();
  const nowMs = Date.now();

  const ranking = (base.ranking || []).map(item => {
    const userId = safeString(item.userId);
    const userSchedules = schedules.filter(s => safeString(s.userId) === userId);
    const userTasks = tasks.filter(t => safeString(t.userId) === userId);
    const userStarted = started.filter(e => safeString(e.assignedUserId) === userId);
    const userResolved = resolved.filter(e => safeString(e.answeredByUserId) === userId || (!safeString(e.answeredByUserId) && safeString(e.assignedUserId) === userId));
    const slaOnTime = userResolved.filter(e => e.late !== true).length;
    const slaLate = userResolved.filter(e => e.late === true).length;
    const resolvedIds = new Set(userResolved.map(e => safeString(e.slaId)).filter(Boolean));
    const slaMissed = userStarted.filter(e => {
      const id = safeString(e.id || e.slaId);
      if (resolvedIds.has(id)) return false;
      const dueMs = Date.parse(e.dueAt || '');
      return Number.isFinite(dueMs) && dueMs < nowMs;
    }).length;
    const slaTotal = Math.max(userStarted.length, slaOnTime + slaLate + slaMissed);
    const slaScore = slaTotal > 0 ? 40 * (slaOnTime / slaTotal) : 40;
    const missedScore = slaMissed === 0 ? 25 : Math.max(0, 25 - slaMissed * 8);

    const completedTasks = userTasks.filter(t => safeString(t.status) === 'done').length;
    const taskScore = userTasks.length ? 10 * (completedTasks / userTasks.length) : 10;

    const attendanceRecord = attendance[`${date}:${userId}`] || {};
    let lateStartMinutes = 0;
    let earlyLeaveMinutes = 0;
    if (userSchedules.length && attendanceRecord.firstSeenAt) {
      const earliestStart = Math.min(...userSchedules.map(s => timeMinutes(s.startTime)).filter(v => v !== null));
      const latestEnd = Math.max(...userSchedules.map(s => timeMinutes(s.endTime)).filter(v => v !== null));
      const first = tunisMinutesNow(attendanceRecord.firstSeenAt);
      const last = attendanceRecord.lastSeenAt ? tunisMinutesNow(attendanceRecord.lastSeenAt) : first;
      lateStartMinutes = Math.max(0, first - earliestStart);
      earlyLeaveMinutes = Math.max(0, latestEnd - last);
    } else if (userSchedules.length) {
      lateStartMinutes = 999;
      earlyLeaveMinutes = 999;
    }
    const planningPenalty = Math.min(15, Math.ceil(lateStartMinutes / 5) + Math.ceil(earlyLeaveMinutes / 10));
    const planningScore = userSchedules.length ? Math.max(0, 15 - planningPenalty) : 15;

    const openAssigned = Object.values(currentStates).filter(state => safeString(state?.assignedUserId) === userId && state?.resolved !== true && ['pending','late'].includes(safeString(state?.sla?.status)) && dateKeyInTimezone(state?.sla?.startedAt || '', timezone) === date).length;
    const followScore = Math.max(0, 10 - openAssigned * 3);
    const noActivityExpected = userSchedules.length === 0 && userTasks.length === 0 && Number(item.replies || 0) === 0 && slaTotal === 0;
    let score = noActivityExpected
      ? null
      : Math.round(Math.max(0, Math.min(100, slaScore + missedScore + planningScore + taskScore + followScore)));

    // Une absence complète pendant un service planifié ne peut jamais produire
    // une bonne note uniquement parce qu'il n'y avait aucun dossier SLA.
    if (userSchedules.length > 0 && !attendanceRecord.firstSeenAt) {
      score = Math.min(Number(score ?? 0), 40);
    }

    const avgResponseSeconds = userResolved.length
      ? Math.round(userResolved.reduce((sum,e) => sum + Number(e.responseSeconds || 0), 0) / userResolved.length)
      : 0;

    return {
      ...item,
      schedules: userSchedules,
      tasksAssigned: userTasks.length,
      tasksCompleted: completedTasks,
      slaTotal,
      slaOnTime,
      slaLate,
      slaMissed,
      slaCompliance: slaTotal ? Math.round((slaOnTime / slaTotal) * 1000) / 10 : 100,
      averageResponseSeconds: avgResponseSeconds,
      lateStartMinutes: lateStartMinutes === 999 ? null : lateStartMinutes,
      earlyLeaveMinutes: earlyLeaveMinutes === 999 ? null : earlyLeaveMinutes,
      attendanceFirstSeenAt: safeString(attendanceRecord.firstSeenAt),
      attendanceLastSeenAt: safeString(attendanceRecord.lastSeenAt),
      openAssigned,
      scoreBreakdown: {
        sla: Math.round(slaScore * 10) / 10,
        noMissed: Math.round(missedScore * 10) / 10,
        planning: Math.round(planningScore * 10) / 10,
        tasks: Math.round(taskScore * 10) / 10,
        followUp: Math.round(followScore * 10) / 10
      },
      score,
      rating: score === null ? 'Non planifié' : score >= 90 ? 'Excellent' : score >= 80 ? 'Très bien' : score >= 70 ? 'Bien' : score >= 60 ? 'À améliorer' : 'Insuffisant'
    };
  }).sort((a,b) => Number(b.score ?? -1) - Number(a.score ?? -1) || b.slaCompliance - a.slaCompliance || b.replies - a.replies)
    .map((item,index) => ({...item, rank:index+1}));

  return {
    ...base,
    generatedAt: new Date().toISOString(),
    reportHour: `${String(DAILY_REPORT_HOUR_TUNIS).padStart(2,'0')}:00`,
    scoreWeights: { sla:40, noMissed:25, planning:15, tasks:10, followUp:10 },
    ranking,
    summary: {
      ...base.summary,
      totalSla: ranking.reduce((sum,item) => sum + item.slaTotal, 0),
      slaOnTime: ranking.reduce((sum,item) => sum + item.slaOnTime, 0),
      slaMissed: ranking.reduce((sum,item) => sum + item.slaMissed, 0),
      tasksAssigned: ranking.reduce((sum,item) => sum + item.tasksAssigned, 0),
      tasksCompleted: ranking.reduce((sum,item) => sum + item.tasksCompleted, 0)
    }
  };
}

function ensureDailyReportGenerated(force = false, requestedDate = '') {
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const today = dateKeyInTimezone(new Date(), timezone);
  const date = safeString(requestedDate) || today;
  const reports = loadDailyReports();
  const clock = tunisClockParts();
  const isToday = date === today;
  const finalWindowOpen = !isToday || clock.hour >= DAILY_REPORT_HOUR_TUNIS;

  // Avant 20h, une consultation Admin peut créer un brouillon, mais aucune
  // notification "rapport quotidien" n'est envoyée.
  if (!force && !finalWindowOpen) {
    return null;
  }

  if (
    reports[date] &&
    !force &&
    reports[date].finalized === true
  ) {
    return reports[date];
  }

  const report = {
    ...buildDetailedCommercialDailyReport(date),
    finalized: finalWindowOpen
  };

  reports[date] = report;
  const keys = Object.keys(reports).sort().slice(-90);
  const compact = {};
  for (const key of keys) compact[key] = reports[key];
  saveDailyReports(compact);
  return report;
}


// ============================================================
// V6.33.1 — Équipe simple / planning quotidien / compte rendu
// ============================================================
function teamDateAdd(date, delta) {
  const ms = Date.parse(`${safeString(date)}T12:00:00+01:00`);
  if (!Number.isFinite(ms)) return safeString(date);
  return dateKeyInTimezone(new Date(ms + Number(delta || 0) * 86400000), 'Africa/Tunis');
}

function attendanceSegmentsForDay(date, userId) {
  const record = loadAttendance()[`${date}:${userId}`] || {};
  const dayStart = Date.parse(`${date}T00:00:00+01:00`);
  const dayEnd = Date.parse(`${date}T23:59:59.999+01:00`);
  const segments = [];
  for (const item of Array.isArray(record.segments) ? record.segments : []) {
    const start = Date.parse(safeString(item?.startAt));
    const last = Date.parse(safeString(item?.lastAt));
    if (!Number.isFinite(start) || !Number.isFinite(last)) continue;
    segments.push([Math.max(dayStart, start), Math.min(dayEnd, last + 75 * 1000)]);
  }
  if (!segments.length && record.firstSeenAt && record.lastSeenAt) {
    const start = Date.parse(record.firstSeenAt), end = Date.parse(record.lastSeenAt);
    if (Number.isFinite(start) && Number.isFinite(end)) segments.push([Math.max(dayStart,start),Math.min(dayEnd,end + 60*1000)]);
  }
  return segments.filter(([a,b]) => b > a);
}

function nightActivityMsForUser(date, userId) {
  const dayStart = Date.parse(`${date}T00:00:00+01:00`);
  const morningEnd = Date.parse(`${date}T08:00:00+01:00`);
  const eveningStart = Date.parse(`${date}T20:00:00+01:00`);
  const dayEnd = Date.parse(`${date}T23:59:59.999+01:00`);
  let total = 0;
  for (const [start,end] of attendanceSegmentsForDay(date,userId)) {
    total += overlapMs(start,end,dayStart,morningEnd);
    total += overlapMs(start,end,eveningStart,dayEnd);
  }
  return Math.round(total);
}

function replyChannel(entry) {
  const direct = safeString(entry?.channel || entry?.platform).toLowerCase();
  if (['whatsapp','instagram','facebook'].includes(direct)) return direct;
  const contact = safeString(entry?.contact).toLowerCase();
  if (contact.startsWith('instagram:')) return 'instagram';
  if (contact.startsWith('facebook:')) return 'facebook';
  return 'whatsapp';
}

function userCommercialRepliesForDay(date, userId) {
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  return loadPerformanceConversationEvents([date], timezone).filter(entry =>
    safeString(entry?.action) === 'commercial_reply' &&
    safeString(entry?.commercial_user_id) === safeString(userId) &&
    dateKeyInTimezone(entry?.time, timezone) === date
  );
}

function replyWasDuringPresence(entry, date, userId) {
  const ms = Date.parse(safeString(entry?.time));
  if (!Number.isFinite(ms)) return false;
  return attendanceSegmentsForDay(date,userId).some(([start,end]) => ms >= start - 60000 && ms <= end + 60000);
}

function isNightTimeInTunis(value) {
  const hour = tunisClockParts(value).hour;
  return hour < 8 || hour >= 20;
}

function simpleScheduleForUserDate(date, userId) {
  const rows = getSchedulesForDate(date).filter(s => safeString(s.userId) === safeString(userId));
  const accessRows = rows.filter(s =>
    s.accessConfigured === true ||
    (Object.prototype.hasOwnProperty.call(s || {}, 'channels') && normalizeChannels(s.channels).length > 0)
  );
  const activeShifts = rows.filter(s => s.active !== false);

  // V6.35.0 — règle MONDECO : si l'Admin n'a encore rien configuré pour la
  // journée, le commercial garde tous les canaux. L'Admin retire explicitement
  // les réseaux non planifiés. Une sélection vide enregistrée reste bien vide.
  if (!accessRows.length) {
    return {
      planned:false,
      accessConfigured:false,
      defaultAllAccess:true,
      channels:[...TEAM_ACCESS_CHANNELS],
      startTime:'09:00',
      endTime:'18:00',
      mission:''
    };
  }

  const channels = [...new Set(accessRows.flatMap(s => normalizeChannels(s.channels)))];
  const first = activeShifts[0] || accessRows[0] || {};
  return {
    planned:activeShifts.length > 0,
    accessConfigured:true,
    defaultAllAccess:false,
    channels,
    startTime:safeString(first?.startTime) || '09:00',
    endTime:safeString(first?.endTime) || '18:00',
    mission:safeString(first?.mission),
    crossesMidnight:Boolean(scheduleWindowMs(first)?.crossesMidnight),
    shiftIds:rows.map(s=>s.id).filter(Boolean)
  };
}

function plannedChannelSetForUser(user, date = '') {
  if (safeString(user?.role) !== 'commercial') return null;
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const explicitDate = safeString(date);
  const targetDate = explicitDate || dateKeyInTimezone(new Date(), timezone);
  const scheduleInfo = simpleScheduleForUserDate(targetDate, user.id);
  const scope = new Set(scheduleInfo.channels || []);

  // Après minuit, une mission de nuit 22:00 → 02:00 créée la veille garde ses
  // droits jusqu'à sa fin, même si les accès du nouveau jour ont été réduits.
  if (!explicitDate) {
    const previousDate = teamDateAdd(targetDate, -1);
    for (const schedule of loadSchedules().filter(item =>
      safeString(item.userId) === safeString(user.id) &&
      safeString(item.date) === previousDate &&
      item.active !== false &&
      Boolean(scheduleWindowMs(item)?.crossesMidnight) &&
      scheduleIsActiveNow(item, new Date())
    )) {
      for (const channel of normalizeChannels(schedule.channels)) scope.add(channel);
    }
  }
  return scope;
}

function pendingAssignedForUser(user, date = '') {
  const states = loadConversationStatesAdmin();
  const scope = plannedChannelSetForUser(user, date);
  let pending = 0, late = 0;
  for (const [contact, state] of Object.entries(states)) {
    if (safeString(state?.assignedUserId) !== safeString(user?.id) || state?.resolved === true) continue;
    const channel = safeString(state?.channel).toLowerCase() ||
      (safeString(contact).startsWith('instagram:') ? 'instagram' : safeString(contact).startsWith('facebook:') ? 'facebook' : 'whatsapp');
    if (!channelScopeAllowsMessage(scope, channel)) continue;
    const sla = computeLiveSla(state);
    const needs = state?.commercialAttention === true || state?.awaitingResponse === true || Number(state?.unreadCount || 0) > 0 || ['pending','late'].includes(safeString(sla?.status));
    if (!needs) continue;
    pending += 1;
    if (safeString(sla?.status) === 'late') late += 1;
  }
  return { pending, late };
}

function simpleTeamDayForUser(user, date) {
  const attendance = attendanceMetricsForUser(date, user.id);
  const replies = userCommercialRepliesForDay(date, user.id);
  const replyByChannel = { whatsapp:0, instagram:0, facebook:0 };
  let repliesWhileOnline = 0, nightReplies = 0;
  for (const entry of replies) {
    const channel = replyChannel(entry); replyByChannel[channel] = Number(replyByChannel[channel] || 0) + 1;
    if (replyWasDuringPresence(entry,date,user.id)) repliesWhileOnline += 1;
    if (isNightTimeInTunis(entry.time)) nightReplies += 1;
  }
  const contacts = new Set(replies.map(entry => safeString(entry.contact)).filter(Boolean));
  const pending = pendingAssignedForUser(user,date);
  const schedule = simpleScheduleForUserDate(date,user.id);
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const slaEvents = loadSlaEvents();
  const started = slaEvents.filter(e => e.event === 'started' && safeString(e.assignedUserId) === safeString(user.id) && dateKeyInTimezone(e.startedAt || e.time, timezone) === date);
  const resolvedIds = new Set(slaEvents.filter(e => e.event === 'resolved' && (safeString(e.answeredByUserId) === safeString(user.id) || safeString(e.assignedUserId) === safeString(user.id))).map(e => safeString(e.slaId || e.id)).filter(Boolean));
  const nowMs = Date.now();
  const slaMissed = started.filter(e => { const id=safeString(e.id || e.slaId); const due=Date.parse(e.dueAt || ''); return !resolvedIds.has(id) && Number.isFinite(due) && due < nowMs; }).length;
  return {
    attendance, schedule,
    activeDay: Number(attendance.onlineMs || 0) > 0 || replies.length > 0,
    replies: replies.length,
    repliesWhileOnline,
    repliesOutsidePresence: Math.max(0,replies.length-repliesWhileOnline),
    replyByChannel,
    conversations: contacts.size,
    pendingAssigned: pending.pending,
    lateAssigned: pending.late,
    nightMs: nightActivityMsForUser(date,user.id),
    nightReplies,
    slaMissed
  };
}


function teamEntryIsClientMessage(entry) {
  const direction = safeString(entry?.direction || entry?.attachment_direction).toLowerCase();
  if (direction === 'incoming' || safeString(entry?.sender_kind).toLowerCase() === 'client') return true;
  return Boolean(safeString(entry?.incoming)) && safeString(entry?.action) !== 'commercial_reply';
}

function likelyPriceOnlyText(value) {
  const text = safeString(value).trim().toLowerCase();
  if (!text) return false;
  const priceSignal = /(?:\bprix\b|\bprice\b|\b\d{2,6}(?:[.,]\d{1,3})?\s*(?:dt|tnd|dinars?)\b|بقداش|قداش)/i.test(text);
  const followQuestion = /\?|quel|quelle|ville|dimension|espace|livraison|showroom|commande|couleur|délai|delai|متوفر|ولاية|قياس/.test(text);
  return priceSignal && text.length <= 120 && !followQuestion;
}

function medianNumber(values) {
  const list = values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length/2);
  return list.length % 2 ? Math.round(list[mid]) : Math.round((list[mid-1]+list[mid])/2);
}

function performanceWindowForSchedule(schedule) {
  const window = scheduleWindowMs(schedule);
  if (!window) return null;
  return { ...window, startAt:new Date(window.start).toISOString(), endAt:new Date(window.end).toISOString() };
}

function commercialMissionMetrics(schedule, userId, messageReplies, activities, slaEvents) {
  const window = performanceWindowForSchedule(schedule);
  if (!window) return null;
  const inWindow = value => {
    const ms = Date.parse(safeString(value));
    return Number.isFinite(ms) && ms >= window.start && ms < window.end;
  };
  const messages = messageReplies.filter(item => inWindow(item.time));
  const comments = activities.filter(item =>
    safeString(item.userId) === safeString(userId) &&
    ['comment_reply','comment_private_reply'].includes(safeString(item.type)) &&
    inWindow(item.time)
  );
  const started = slaEvents.filter(item => item.event === 'started' && safeString(item.assignedUserId) === safeString(userId) && inWindow(item.startedAt || item.time));
  const resolved = slaEvents.filter(item => item.event === 'resolved' && safeString(item.answeredByUserId || item.assignedUserId) === safeString(userId) && inWindow(item.answeredAt || item.time));
  const actions = [...messages.map(x=>x.time), ...comments.map(x=>x.time)].map(Date.parse).filter(Number.isFinite).sort((a,b)=>a-b);
  const clients = new Set([
    ...messages.map(x=>`msg:${safeString(x.contact)}`).filter(x=>x !== 'msg:'),
    ...comments.map(x=>`comment:${safeString(x.authorId || x.commentId || x.key)}`).filter(x=>x !== 'comment:')
  ]);
  return {
    id:safeString(schedule.id),
    mission:safeString(schedule.mission || 'Mission commerciale'),
    channels:normalizeChannels(schedule.channels),
    startTime:safeString(schedule.startTime),
    endTime:safeString(schedule.endTime),
    crossesMidnight:window.crossesMidnight,
    startAt:window.startAt,
    endAt:window.endAt,
    messageReplies:messages.length,
    commentReplies:comments.length,
    clientsTreated:clients.size,
    assignedReceived:started.length,
    assignedHandled:resolved.length,
    assignedUnhandled:Math.max(0, started.length - resolved.length),
    firstActionAt:actions.length ? new Date(actions[0]).toISOString() : '',
    lastActionAt:actions.length ? new Date(actions[actions.length-1]).toISOString() : ''
  };
}

// V6.34.4 — lecture mémoire-sûre des événements nécessaires au pilotage.
// Le rapport commercial n'a besoin que de la journée demandée (et de la
// suivante pour les missions qui traversent minuit). Il ne doit surtout pas
// appeler loadWhatsAppLog(), qui fusionne et met en cache jusqu'à 90 jours
// d'historique Instagram/Facebook/WhatsApp en RAM.
function loadPerformanceConversationEvents(localDates = [], timezone = 'Africa/Tunis') {
  const wantedDates = new Set((Array.isArray(localDates) ? localDates : [localDates])
    .map(safeString)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)));
  if (!wantedDates.size) return [];

  const candidateFileDays = new Set();
  for (const date of wantedDates) {
    // Les journaux conversation-events sont nommés en date UTC. Une journée
    // locale peut donc chevaucher la veille/le lendemain UTC. Lire ±1 jour
    // reste borné à quelques fichiers et couvre aussi un changement de fuseau.
    candidateFileDays.add(teamDateAdd(date, -1));
    candidateFileDays.add(date);
    candidateFileDays.add(teamDateAdd(date, 1));
  }

  const entries = [];
  const pushIfWanted = item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const time = safeString(item.time || item.event_time || item.meta_created_time || item.created_time || item.timestamp);
    if (!time) return;
    const localDate = dateKeyInTimezone(time, timezone);
    if (!wantedDates.has(localDate)) return;
    entries.push(item);
  };

  for (const fileDay of candidateFileDays) {
    const filePath = path.join(CONVERSATION_EVENTS_DIR, `conversation-events-${fileDay}.jsonl`);
    if (!fs.existsSync(filePath)) continue;
    try {
      forEachJsonlRecordSync(filePath, pushIfWanted);
    } catch (error) {
      console.warn(`⚠️ Performance: lecture ${path.basename(filePath)} :`, error.message);
    }
  }

  // Compatibilité avec d'anciens déploiements : conversation-log.json est déjà
  // limité à 5000 entrées. On l'utilise uniquement comme petit filet de
  // sécurité, puis on déduplique avec le journal append-only.
  try {
    forEachJsonArrayObjectSync(CONVERSATIONS_LOG_PATH, pushIfWanted);
  } catch {}

  const merged = new Map();
  for (const entry of entries) {
    const key = conversationLogDedupeKey(entry);
    merged.set(key, mergeConversationLogEntries(merged.get(key), entry));
  }
  return [...merged.values()].sort(conversationEntryComparator);
}

function buildTeamPerformanceDashboard(date, onlyUserId = '') {
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const requestedUserId = safeString(onlyUserId);
  const users = loadUsers().filter(user =>
    user.role === 'commercial' &&
    (!requestedUserId || safeString(user.id) === requestedUserId)
  );
  const nextDate = teamDateAdd(date, 1);
  const performanceEvents = loadPerformanceConversationEvents([date, nextDate], timezone);
  const dayEntries = performanceEvents.filter(entry => dateKeyInTimezone(entry?.time, timezone) === date);
  const activities = loadTeamActivity(date);
  const missionActivities = [...activities, ...loadTeamActivity(nextDate)];
  const slaEvents = loadSlaEvents();
  const today = dateKeyInTimezone(new Date(), timezone);

  const raw = users.map(user => {
    const userId = safeString(user.id);
    const replies = dayEntries.filter(entry =>
      safeString(entry?.action) === 'commercial_reply' &&
      safeString(entry?.commercial_user_id) === userId
    );
    // Seulement la journée demandée + le lendemain local pour couvrir une
    // mission 22:00 → 02:00. Aucun historique 90 jours n'est dupliqué en RAM.
    const allUserReplies = performanceEvents.filter(entry =>
      safeString(entry?.action) === 'commercial_reply' &&
      safeString(entry?.commercial_user_id) === userId
    );
    const commentActivities = activities.filter(item =>
      safeString(item.userId) === userId &&
      ['comment_reply','comment_private_reply'].includes(safeString(item.type))
    );
    const openedContacts = new Set(activities.filter(item => safeString(item.userId) === userId && item.type === 'conversation_open').map(item => safeString(item.contact)).filter(Boolean));
    const contacts = [...new Set(replies.map(entry => safeString(entry.contact)).filter(Boolean))];
    let developedConversations = 0;
    let completeConversations = 0;
    let priceOnlyConversations = 0;
    let priceContinuedConversations = 0;

    for (const contact of contacts) {
      const thread = dayEntries.filter(entry => safeString(entry.contact) === contact).sort((a,b)=>(Date.parse(a.time)||0)-(Date.parse(b.time)||0));
      const clientMessages = thread.filter(teamEntryIsClientMessage);
      const ownReplies = thread.filter(entry => safeString(entry?.action) === 'commercial_reply' && safeString(entry?.commercial_user_id) === userId);
      const ownTexts = ownReplies.map(entry => safeString(entry.reply)).filter(Boolean);
      const hasPrice = ownTexts.some(likelyPriceOnlyText);
      if (clientMessages.length >= 2 && ownReplies.length >= 2) developedConversations += 1;
      if (clientMessages.length >= 3 && ownReplies.length >= 3) completeConversations += 1;
      if (ownReplies.length === 1 && hasPrice) priceOnlyConversations += 1;
      if (ownReplies.length >= 2 && hasPrice) priceContinuedConversations += 1;
    }

    const substantiveComments = commentActivities.filter(item => {
      const text = safeString(item.text);
      return text.length >= 20 && !likelyPriceOnlyText(text);
    }).length;
    const priceOnlyComments = commentActivities.filter(item => likelyPriceOnlyText(item.text)).length;
    const commentThreads = new Set(commentActivities.map(item => safeString(item.commentKey || item.commentId || item.key)).filter(Boolean)).size;
    const qualityDenominator = contacts.length + commentThreads;
    const qualityNumerator = developedConversations + substantiveComments;
    const qualityRate = qualityDenominator ? Math.min(100, Math.round((qualityNumerator / qualityDenominator) * 1000) / 10) : 0;

    const started = slaEvents.filter(item => item.event === 'started' && safeString(item.assignedUserId) === userId && dateKeyInTimezone(item.startedAt || item.time, timezone) === date);
    const resolved = slaEvents.filter(item => item.event === 'resolved' && (safeString(item.answeredByUserId) === userId || (!safeString(item.answeredByUserId) && safeString(item.assignedUserId) === userId)) && dateKeyInTimezone(item.answeredAt || item.time, timezone) === date);
    const resolvedIds = new Set(resolved.map(item => safeString(item.slaId || item.id)).filter(Boolean));
    const nowMs = Date.now();
    const missed = started.filter(item => {
      const id = safeString(item.id || item.slaId);
      if (resolvedIds.has(id)) return false;
      const due = Date.parse(item.dueAt || '');
      return Number.isFinite(due) && due < nowMs;
    });
    const onTime = resolved.filter(item => item.late !== true);
    const late = resolved.filter(item => item.late === true);
    const totalSla = Math.max(started.length, resolved.length + missed.length);
    const pending = pendingAssignedForUser(user, date);
    const handledRate = started.length ? Math.min(100, (resolved.length / started.length) * 100) : (replies.length || commentActivities.length ? 100 : 0);
    const responseCompliance = totalSla ? Math.max(0, Math.min(100, (onTime.length / totalSla) * 100)) : (replies.length || commentActivities.length ? 100 : 0);
    const continuityDenom = Math.max(1, contacts.length + commentThreads);
    const continuityRate = Math.max(0, Math.min(100, ((contacts.length + commentThreads - priceOnlyConversations - priceOnlyComments - missed.length) / continuityDenom) * 100));

    const persons = new Set([
      ...contacts.map(x=>`msg:${x}`),
      ...commentActivities.map(item=>`comment:${safeString(item.authorId || item.commentId || item.commentKey)}`).filter(x=>x !== 'comment:')
    ]);
    const byChannel = { whatsappMessages:0, instagramMessages:0, facebookMessages:0, instagramComments:0, facebookComments:0 };
    for (const reply of replies) {
      const channel = replyChannel(reply);
      if (channel === 'instagram') byChannel.instagramMessages += 1;
      else if (channel === 'facebook') byChannel.facebookMessages += 1;
      else byChannel.whatsappMessages += 1;
    }
    for (const item of commentActivities) {
      if (safeString(item.channel) === 'facebook') byChannel.facebookComments += 1;
      else byChannel.instagramComments += 1;
    }

    const schedules = getSchedulesForDate(date).filter(item => safeString(item.userId) === userId && item.active !== false);
    const missionMetrics = schedules.map(schedule => commercialMissionMetrics(schedule, userId, allUserReplies, missionActivities, slaEvents)).filter(Boolean);
    const nightMissions = missionMetrics.filter(item => item.crossesMidnight || safeString(item.startTime) >= '20:00' || safeString(item.startTime) < '08:00' || safeString(item.endTime) <= '08:00');

    return {
      userId,
      name:safeString(user.name) || safeString(user.email),
      email:safeString(user.email),
      active:user.active !== false,
      messageReplies:replies.length,
      commentReplies:commentActivities.length,
      totalReplies:replies.length + commentActivities.length,
      conversations:contacts.length,
      clientsTreated:persons.size,
      openedConversations:openedContacts.size,
      developedConversations,
      completeConversations,
      priceOnlyConversations,
      priceContinuedConversations,
      substantiveComments,
      priceOnlyComments,
      qualityRate,
      handledRate:Math.round(handledRate*10)/10,
      responseCompliance:Math.round(responseCompliance*10)/10,
      continuityRate:Math.round(continuityRate*10)/10,
      slaTotal:totalSla,
      slaOnTime:onTime.length,
      slaLate:late.length,
      slaMissed:missed.length,
      medianFirstResponseSeconds:medianNumber(resolved.map(item => item.responseSeconds)),
      unanswered:missed.length + (date === today ? Number(pending.pending || 0) : 0),
      currentlyLate:date === today ? Number(pending.late || 0) : 0,
      pendingAssigned:date === today ? Number(pending.pending || 0) : 0,
      lateAssigned:date === today ? Number(pending.late || 0) : 0,
      byChannel,
      missions:missionMetrics,
      nightMissions
    };
  });

  const maxClients = Math.max(1, ...raw.map(item => Number(item.clientsTreated || 0)));
  const ranking = raw.map(item => {
    const volumeScore = item.clientsTreated > 0 ? 10 * Math.sqrt(item.clientsTreated / maxClients) : 0;
    const qualityScore = 25 * (item.qualityRate / 100);
    const coverageScore = 30 * (item.handledRate / 100);
    const responseScore = 20 * (item.responseCompliance / 100);
    const continuityScore = 15 * (item.continuityRate / 100);
    const hasActivity = item.totalReplies > 0 || item.slaTotal > 0;
    const score = hasActivity ? Math.round(Math.max(0, Math.min(100, coverageScore + qualityScore + responseScore + continuityScore + volumeScore))) : null;
    return {
      ...item,
      score,
      scoreBreakdown:{
        coverage:Math.round(coverageScore*10)/10,
        quality:Math.round(qualityScore*10)/10,
        responsiveness:Math.round(responseScore*10)/10,
        continuity:Math.round(continuityScore*10)/10,
        volume:Math.round(volumeScore*10)/10
      }
    };
  }).sort((a,b)=>Number(b.score ?? -1)-Number(a.score ?? -1) || b.clientsTreated-a.clientsTreated || b.completeConversations-a.completeConversations || b.totalReplies-a.totalReplies)
    .map((item,index)=>({...item,rank:index+1}));

  return {
    ranking,
    summary:{
      clientsTreated:ranking.reduce((sum,item)=>sum+Number(item.clientsTreated||0),0),
      totalReplies:ranking.reduce((sum,item)=>sum+Number(item.totalReplies||0),0),
      messageReplies:ranking.reduce((sum,item)=>sum+Number(item.messageReplies||0),0),
      commentReplies:ranking.reduce((sum,item)=>sum+Number(item.commentReplies||0),0),
      developedConversations:ranking.reduce((sum,item)=>sum+Number(item.developedConversations||0),0),
      completeConversations:ranking.reduce((sum,item)=>sum+Number(item.completeConversations||0),0),
      priceOnly:ranking.reduce((sum,item)=>sum+Number(item.priceOnlyConversations||0)+Number(item.priceOnlyComments||0),0),
      unanswered:ranking.reduce((sum,item)=>sum+Number(item.unanswered||0),0),
      late:ranking.reduce((sum,item)=>sum+Number(item.slaLate||0)+Number(item.slaMissed||0),0),
      activeCommercials:ranking.filter(item=>item.totalReplies>0).length
    },
    scoreWeights:{ coverage:30, quality:25, responsiveness:20, continuity:15, volume:10 },
    definitions:{
      developed:'Au moins 2 messages client + 2 réponses du commercial dans la journée.',
      complete:'Au moins 3 messages client + 3 réponses du commercial dans la journée.',
      priceOnly:'Une seule réponse commerciale courte contenant principalement un prix, sans relance détectée.'
    }
  };
}

router.get('/api/team/simple-dashboard', requireAdminOrCommercialManager, (req,res) => {
  const startedAt = Date.now();
  try {
    const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(safeString(req.query?.date)) ? safeString(req.query.date) : dateKeyInTimezone(new Date(),timezone);
    const performance = buildTeamPerformanceDashboard(date);
    const performanceByUser = new Map((performance.ranking || []).map(item => [safeString(item.userId), item]));

    // V6.34.3 — IMPORTANT PERFORMANCE FIX:
    // l'ancien code appelait simpleTeamDayForUser() pour chaque commercial alors
    // que la vue Équipe n'utilise que planning + charge + présence. Cette fonction
    // relisait/reparcourait conversation-log, attendance, SLA et états plusieurs
    // fois par utilisateur et pouvait faire dépasser le timeout Railway (HTTP 502).
    const users = loadUsers().filter(user => user.role === 'commercial').map(user => {
      const userPerformance = performanceByUser.get(safeString(user.id)) || null;
      const schedule = simpleScheduleForUserDate(date, user.id);
      return {
        ...sanitizeUserForClient(user),
        presence:getPresenceForUser(user.id),
        schedule,
        pendingAssigned:Number(userPerformance?.pendingAssigned || 0),
        lateAssigned:Number(userPerformance?.lateAssigned || 0),
        performance:userPerformance
      };
    }).sort((a,b) => (a.presence?.status==='online'?0:a.presence?.status==='idle'?1:2)-(b.presence?.status==='online'?0:b.presence?.status==='idle'?1:2) || safeString(a.name||a.email).localeCompare(safeString(b.name||b.email),'fr'));

    const elapsedMs = Date.now() - startedAt;
    const memory = process.memoryUsage();
    const rssMb = Math.round(Number(memory.rss || 0) / 1024 / 1024);
    const heapMb = Math.round(Number(memory.heapUsed || 0) / 1024 / 1024);
    if (elapsedMs > 1500 || rssMb > 350) {
      console.warn(`⚠️ Team simple-dashboard: ${elapsedMs} ms | RSS ${rssMb} MB | heap ${heapMb} MB | ${users.length} commerciaux`);
    }
    return res.json({ date, generatedAt:new Date().toISOString(), elapsedMs, users, performance });
  } catch (error) {
    console.error('❌ Team simple-dashboard :', error);
    return res.status(500).json({
      error:'Le rapport commercial n’a pas pu être calculé. Réessayez dans quelques secondes.',
      code:'TEAM_DASHBOARD_CALCULATION_ERROR'
    });
  }
});

router.put('/api/team/simple-schedule/:userId', requireAdminOrCommercialManager, (req,res) => {
  const userId = safeString(req.params.userId);
  const user = loadUsers().find(item => item.id === userId && item.role === 'commercial');
  const date = safeString(req.body?.date);
  const rawChannels = Array.isArray(req.body?.channels) ? req.body.channels : [];
  const channels = normalizeChannels(rawChannels);
  const requestedActive = req.body?.active !== false && channels.length > 0;
  const startTime = safeString(req.body?.startTime || '09:00');
  const endTime = safeString(req.body?.endTime || '18:00');
  const mission = safeString(req.body?.mission).slice(0,1000);
  if (!user || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:'Commercial ou date invalide.'});
  if (requestedActive && (timeMinutes(startTime) === null || timeMinutes(endTime) === null || startTime === endTime)) return res.status(400).json({error:'Horaire invalide. Un service de nuit peut traverser minuit, par exemple 22:00 → 02:00.'});

  const items = loadSchedules();
  const existing = items.filter(item => safeString(item.userId) === userId && safeString(item.date) === date);
  const kept = items.filter(item => !(safeString(item.userId) === userId && safeString(item.date) === date));
  const first = existing[0] || {};

  // Toujours conserver une ligne d'accès, même si les 5 cases sont décochées.
  // Ainsi "aucun réseau" reste une décision explicite et ne redevient jamais
  // "tous les réseaux" au prochain chargement.
  kept.push({
    ...first,
    id:safeString(first.id)||crypto.randomUUID(),
    userId,
    userName:safeString(user.name),
    date,
    startTime,
    endTime,
    breakStart:safeString(first.breakStart),
    breakEnd:safeString(first.breakEnd),
    channels,
    accessConfigured:true,
    mission:mission || safeString(first.mission || (channels.length ? 'Mission commerciale' : '')),
    priority:safeString(first.priority || 'normal'),
    slaMinutes:Math.max(1,Math.min(120,Number(first.slaMinutes || DEFAULT_COMMERCIAL_SLA_MINUTES)||DEFAULT_COMMERCIAL_SLA_MINUTES)),
    active:requestedActive,
    createdBy:safeString(first.createdBy || req.user?.id),
    createdAt:safeString(first.createdAt)||new Date().toISOString(),
    updatedAt:new Date().toISOString()
  });

  saveSchedules(kept);
  return res.json({success:true, schedule:simpleScheduleForUserDate(date,userId)});
});

router.get('/api/team/commercial-report/:userId', requireAdminOrCommercialManager, (req,res) => {
  const startedAt = Date.now();
  try {
    const timezone=safeTimezone(getBotSettings()?.timezone||'Africa/Tunis');
    const date=/^\d{4}-\d{2}-\d{2}$/.test(safeString(req.query?.date))?safeString(req.query.date):dateKeyInTimezone(new Date(),timezone);
    const user=loadUsers().find(item=>item.id===safeString(req.params.userId)&&item.role==='commercial');
    if(!user)return res.status(404).json({error:'Commercial introuvable.'});

    // Le détail de présence n'est calculé qu'une seule fois pour la journée ouverte.
    const day=simpleTeamDayForUser(user,date);
    const performance=buildTeamPerformanceDashboard(date,user.id).ranking.find(item=>safeString(item.userId)===safeString(user.id))||null;
    const history=[];
    for(let i=0;i<7;i++){
      const d=teamDateAdd(date,-i);
      // V6.34.3 — historique ciblé sur un seul commercial. On ne recalcule plus
      // simpleTeamDayForUser() ni les performances de toute l'équipe 7 fois.
      const px=buildTeamPerformanceDashboard(d,user.id).ranking.find(item=>safeString(item.userId)===safeString(user.id))||{};
      history.push({
        date:d,
        replies:Number(px.totalReplies||0),
        clientsTreated:Number(px.clientsTreated||0),
        developedConversations:Number(px.developedConversations||0),
        completeConversations:Number(px.completeConversations||0),
        unanswered:Number(px.unanswered||0),
        score:px.score??null
      });
    }
    const elapsedMs=Date.now()-startedAt;
    if(elapsedMs>2000)console.warn(`⚠️ Team commercial-report lent: ${elapsedMs} ms (${date}, ${safeString(user.id)})`);
    return res.json({date,user:sanitizeUserForClient(user),presence:getPresenceForUser(user.id),day,performance,history,elapsedMs});
  } catch (error) {
    console.error('❌ Team commercial-report :', error);
    return res.status(500).json({
      error:'Le compte rendu n’a pas pu être calculé. Réessayez dans quelques secondes.',
      code:'COMMERCIAL_REPORT_CALCULATION_ERROR'
    });
  }
});

router.get('/api/schedules', requireAdminOrCommercialManager, (req,res) => {
  const date = safeString(req.query?.date);
  const items = date ? getSchedulesForDate(date) : loadSchedules();
  return res.json(items);
});

router.post('/api/schedules', requireAdminOrCommercialManager, (req,res) => {
  const userId = safeString(req.body?.userId);
  const user = loadUsers().find(item => item.id === userId && item.role === 'commercial' && item.active !== false);
  const date = safeString(req.body?.date);
  const startTime = safeString(req.body?.startTime);
  const endTime = safeString(req.body?.endTime);
  if (!user || !/^\d{4}-\d{2}-\d{2}$/.test(date) || timeMinutes(startTime) === null || timeMinutes(endTime) === null || startTime === endTime) {
    return res.status(400).json({error:'Commercial, date ou horaires invalides. Les services après minuit sont acceptés (ex. 22:00 → 02:00).'});
  }
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(), userId, userName:safeString(user.name), date, startTime, endTime,
    breakStart:safeString(req.body?.breakStart), breakEnd:safeString(req.body?.breakEnd),
    channels:normalizeChannels(req.body?.channels), mission:safeString(req.body?.mission).slice(0,1000),
    priority:safeString(req.body?.priority || 'normal'), slaMinutes:Math.max(1,Math.min(120,Number(req.body?.slaMinutes || DEFAULT_COMMERCIAL_SLA_MINUTES)||DEFAULT_COMMERCIAL_SLA_MINUTES)),
    active:true, createdBy:safeString(req.user?.id), createdAt:now, updatedAt:now
  };
  const items=loadSchedules(); items.push(item); saveSchedules(items); return res.status(201).json(item);
});

router.put('/api/schedules/:id', requireAdminOrCommercialManager, (req,res) => {
  const items=loadSchedules(); const index=items.findIndex(item=>item.id===req.params.id); if(index<0)return res.status(404).json({error:'Planning introuvable.'});
  const current=items[index]; const userId=safeString(req.body?.userId ?? current.userId); const user=loadUsers().find(item=>item.id===userId&&item.role==='commercial');
  const startTime=safeString(req.body?.startTime ?? current.startTime); const endTime=safeString(req.body?.endTime ?? current.endTime);
  if(!user||timeMinutes(startTime)===null||timeMinutes(endTime)===null||startTime===endTime)return res.status(400).json({error:'Planning invalide. Un service après minuit est accepté (ex. 22:00 → 02:00).'});
  items[index]={...current,userId,userName:safeString(user.name),date:safeString(req.body?.date??current.date),startTime,endTime,breakStart:safeString(req.body?.breakStart??current.breakStart),breakEnd:safeString(req.body?.breakEnd??current.breakEnd),channels:normalizeChannels(req.body?.channels??current.channels),mission:safeString(req.body?.mission??current.mission).slice(0,1000),priority:safeString(req.body?.priority??current.priority),slaMinutes:Math.max(1,Math.min(120,Number(req.body?.slaMinutes??current.slaMinutes??DEFAULT_COMMERCIAL_SLA_MINUTES)||DEFAULT_COMMERCIAL_SLA_MINUTES)),active:req.body?.active===undefined?current.active!==false:req.body.active===true,updatedAt:new Date().toISOString()};
  saveSchedules(items); return res.json(items[index]);
});

router.delete('/api/schedules/:id', requireAdminOrCommercialManager, (req,res) => { const items=loadSchedules(); const next=items.filter(item=>item.id!==req.params.id); if(next.length===items.length)return res.status(404).json({error:'Planning introuvable.'}); saveSchedules(next); return res.json({success:true}); });

router.get('/api/tasks', requireAuth, (req,res) => { const date=safeString(req.query?.date); let items=loadTasks().filter(item=>!date||safeString(item.date)===date); if(req.user?.role==='commercial'){items=items.filter(item=>safeString(item.userId)===safeString(req.user.id));}else if(!['admin','responsable_commercial'].includes(safeString(req.user?.role))){return res.status(403).json({error:'Accès non autorisé.'});} return res.json(items.sort((a,b)=>safeString(a.startTime).localeCompare(safeString(b.startTime)))); });

router.post('/api/tasks', requireAdminOrCommercialManager, (req,res) => {
  const userId=safeString(req.body?.userId); const title=safeString(req.body?.title); const date=safeString(req.body?.date);
  const users=loadUsers().filter(item=>item.role==='commercial'&&item.active!==false);
  const targets=userId==='__all__'?users:users.filter(item=>item.id===userId);
  if(!targets.length||!title||!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:'Commercial/équipe, date et tâche sont obligatoires.'});
  const requestedTaskChannel=safeString(req.body?.channel||'both').toLowerCase(); const taskChannel=['both','whatsapp','instagram','facebook'].includes(requestedTaskChannel)?requestedTaskChannel:'both';
  const now=new Date().toISOString(); const batchId=userId==='__all__'?crypto.randomUUID():''; const items=loadTasks();
  const created=targets.map(user=>({id:crypto.randomUUID(),batchId,userId:user.id,userName:safeString(user.name),date,channel:taskChannel,startTime:safeString(req.body?.startTime),dueTime:safeString(req.body?.dueTime),title:title.slice(0,180),details:safeString(req.body?.details).slice(0,1500),priority:safeString(req.body?.priority||'normal'),status:'todo',conversationContact:safeString(req.body?.conversationContact||req.body?.contact).slice(0,180),conversationMessageId:safeString(req.body?.conversationMessageId||req.body?.messageId).slice(0,260),clientName:safeString(req.body?.clientName).slice(0,180),createdBy:safeString(req.user?.id),createdAt:now,updatedAt:now}));
  items.push(...created);saveTasks(items);return res.status(201).json(userId==='__all__'?{success:true,created:created.length,batchId,items:created}:created[0]);
});

router.put('/api/tasks/:id', requireAuth, (req,res) => {
  const items=loadTasks();const index=items.findIndex(item=>item.id===req.params.id);if(index<0)return res.status(404).json({error:'Tâche introuvable.'});const current=items[index];
  const manager=req.user.role==='admin'||req.user.role==='responsable_commercial'; if(!manager&&!(req.user.role==='commercial'&&safeString(current.userId)===safeString(req.user.id)))return res.status(403).json({error:'Accès non autorisé à cette tâche.'});
  const allowedStatus=new Set(['todo','in_progress','done','late','cancelled']);const requestedStatus=safeString(req.body?.status||current.status);if(!allowedStatus.has(requestedStatus))return res.status(400).json({error:'Statut de tâche invalide.'});
  const editable=manager?{...current,...req.body}:{...current,status:requestedStatus};
  if(manager){
    const requestedChannel=safeString(editable.channel||current.channel||'both').toLowerCase();
    editable.channel=['both','whatsapp','instagram','facebook'].includes(requestedChannel)?requestedChannel:'both';
    editable.conversationContact=safeString(editable.conversationContact).slice(0,180);
    editable.conversationMessageId=safeString(editable.conversationMessageId).slice(0,260);
    editable.clientName=safeString(editable.clientName).slice(0,180);
  }
  items[index]={...editable,id:current.id,userId:current.userId,userName:current.userName,status:requestedStatus,completedAt:requestedStatus==='done'?(current.completedAt||new Date().toISOString()):null,updatedAt:new Date().toISOString()};saveTasks(items);return res.json(items[index]);
});

router.delete('/api/tasks/:id', requireAdminOrCommercialManager, (req,res) => {const items=loadTasks();const next=items.filter(item=>item.id!==req.params.id);if(next.length===items.length)return res.status(404).json({error:'Tâche introuvable.'});saveTasks(next);return res.json({success:true});});

router.get('/api/my-workday', requireAuth, (req,res) => {
  if(req.user?.role!=='commercial') return res.status(403).json({error:'Compte commercial requis.'});
  const timezone=safeTimezone(getBotSettings()?.timezone||'Africa/Tunis');
  const date=safeString(req.query?.date)||dateKeyInTimezone(new Date(),timezone);
  const schedules=getSchedulesForDate(date).filter(item=>safeString(item.userId)===safeString(req.user.id));
  const tasks=loadTasks().filter(item=>safeString(item.date)===date&&safeString(item.userId)===safeString(req.user.id));
  const attendance=attendanceMetricsForUser(date,req.user.id);
  const presence=getPresenceForUser(req.user.id);
  return res.json({date,schedules,tasks,attendance,presence});
});

router.get('/api/team/operations', requireAdminOrCommercialManager, (req,res) => {
  const timezone=safeTimezone(getBotSettings()?.timezone||'Africa/Tunis');const date=safeString(req.query?.date)||dateKeyInTimezone(new Date(),timezone);const states=loadConversationStatesAdmin();
  const users=loadUsers().filter(user=>user.role==='commercial').map(user=>{const presence=getPresenceForUser(user.id);const attendance=attendanceMetricsForUser(date,user.id);const shifts=getSchedulesForDate(date).filter(s=>s.userId===user.id);const tasks=loadTasks().filter(t=>t.date===date&&t.userId===user.id);const assigned=Object.values(states).filter(st=>safeString(st?.assignedUserId)===user.id&&st?.resolved!==true);const slas=assigned.map(st=>computeLiveSla(st)).filter(Boolean);return {...sanitizeUserForClient(user),presence,attendance,shifts,tasks,activeConversations:assigned.length,pendingSla:slas.filter(s=>['pending','late'].includes(s.status)).length,lateSla:slas.filter(s=>s.status==='late').length,nextSlaRemainingMs:slas.filter(s=>['pending','late'].includes(s.status)&&Number.isFinite(s.remainingMs)).sort((a,b)=>a.remainingMs-b.remainingMs)[0]?.remainingMs??null};});
  const allSla=Object.values(states).map(st=>computeLiveSla(st)).filter(Boolean);const tasks=loadTasks().filter(t=>t.date===date);return res.json({date,generatedAt:new Date().toISOString(),pendingSla:allSla.filter(s=>s.status==='pending').length,lateSla:allSla.filter(s=>s.status==='late').length,tasksLate:tasks.filter(t=>t.status==='late').length,users});
});

router.get('/api/reports/commercial-daily-v2', requireAdmin, (req,res) => { const report=ensureDailyReportGenerated(true, safeString(req.query?.date)); return res.json(report); });

setInterval(() => {
  try { ensureDailyReportGenerated(false); } catch (error) { console.warn('⚠️ Génération rapport quotidien :', error.message); }
}, 60 * 1000).unref?.();

// ============================================================
// WOOCOMMERCE — SYNCHRONISATION SITE
// ============================================================

const WOO_SYNC_DEFAULT_STATE = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: '',
  lastReason: '',
  lastDurationMs: 0,
  lastFetched: 0,
  lastCreated: 0,
  lastUpdated: 0,
  lastUnchanged: 0,
  lastDeactivated: 0,
  lastWebhookAt: null,
  lastWebhookTopic: '',
  lastWebhookProductId: null
};

let wooSyncRunning = false;
let wooSyncIntervalHandle = null;

function wooConfigured() {
  return Boolean(
    WOOCOMMERCE_URL &&
    WOOCOMMERCE_CONSUMER_KEY &&
    WOOCOMMERCE_CONSUMER_SECRET
  );
}

function loadWooCommerceSyncState() {
  try {
    if (!fs.existsSync(WOOCOMMERCE_SYNC_PATH)) {
      return {
        ...WOO_SYNC_DEFAULT_STATE
      };
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          WOOCOMMERCE_SYNC_PATH,
          'utf8'
        ) || '{}'
      );

    return {
      ...WOO_SYNC_DEFAULT_STATE,
      ...(
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
          ? parsed
          : {}
      )
    };
  } catch (error) {
    console.warn(
      '⚠️ Lecture woocommerce-sync.json :',
      error.message
    );

    return {
      ...WOO_SYNC_DEFAULT_STATE
    };
  }
}

function saveWooCommerceSyncState(patch = {}) {
  const next = {
    ...loadWooCommerceSyncState(),
    ...patch
  };

  writeJsonAtomic(
    WOOCOMMERCE_SYNC_PATH,
    next
  );

  return next;
}

function wooPublicStatus(req = null) {
  const sync =
    loadWooCommerceSyncState();

  const forwardedProto =
    safeString(
      req?.headers?.['x-forwarded-proto']
    )
      .split(',')[0]
      .trim();

  const protocol =
    forwardedProto ||
    safeString(req?.protocol) ||
    'https';

  const host =
    safeString(
      req?.get?.('host')
    );

  const webhookUrl =
    host
      ? `${protocol}://${host}/admin/api/woocommerce/webhook`
      : '';

  return {
    configured:
      wooConfigured(),

    siteUrl:
      WOOCOMMERCE_URL,

    consumerKeyPresent:
      Boolean(
        WOOCOMMERCE_CONSUMER_KEY
      ),

    consumerSecretPresent:
      Boolean(
        WOOCOMMERCE_CONSUMER_SECRET
      ),

    webhookSecretPresent:
      Boolean(
        WOOCOMMERCE_WEBHOOK_SECRET
      ),

    syncEnabled:
      WOOCOMMERCE_SYNC_ENABLED,

    syncMinutes:
      WOOCOMMERCE_SYNC_MINUTES,

    syncImages:
      WOOCOMMERCE_SYNC_IMAGES,

    running:
      wooSyncRunning,

    webhookUrl,

    ...sync
  };
}

function htmlToPlainText(value) {
  return safeString(value)
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      ' '
    )
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      ' '
    )
    .replace(
      /<[^>]+>/g,
      ' '
    )
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function normalizeWooLookup(value) {
  return safeString(value)
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}

function wooAttributeValue(
  product,
  acceptedNames
) {
  const wanted =
    new Set(
      acceptedNames.map(
        normalizeWooLookup
      )
    );

  const attributes =
    Array.isArray(
      product?.attributes
    )
      ? product.attributes
      : [];

  for (const attribute of attributes) {
    const normalizedName =
      normalizeWooLookup(
        attribute?.name ||
        attribute?.slug
      );

    if (
      !normalizedName ||
      !wanted.has(
        normalizedName
      )
    ) {
      continue;
    }

    const options =
      Array.isArray(
        attribute?.options
      )
        ? attribute.options
        : [];

    const value =
      options
        .map(safeString)
        .filter(Boolean)
        .join(', ');

    if (value) {
      return value;
    }
  }

  return '';
}

function wooDimensionsText(product) {
  const custom =
    wooAttributeValue(
      product,
      [
        'dimensions',
        'dimension',
        'mesures',
        'mesure'
      ]
    );

  if (custom) {
    return custom;
  }

  const dimensions =
    product?.dimensions &&
    typeof product.dimensions === 'object'
      ? product.dimensions
      : {};

  const length =
    safeString(
      dimensions.length
    );

  const width =
    safeString(
      dimensions.width
    );

  const height =
    safeString(
      dimensions.height
    );

  const parts = [];

  if (length) {
    parts.push(
      `L ${length}`
    );
  }

  if (width) {
    parts.push(
      `l ${width}`
    );
  }

  if (height) {
    parts.push(
      `H ${height}`
    );
  }

  return parts.join(' × ');
}

function wooAvailability(product) {
  const stockStatus =
    safeString(
      product?.stock_status
    ).toLowerCase();

  if (
    stockStatus ===
    'instock'
  ) {
    return 'in_stock';
  }

  if (
    stockStatus ===
    'outofstock'
  ) {
    return 'out_of_stock';
  }

  if (
    stockStatus ===
    'onbackorder'
  ) {
    return 'on_order';
  }

  return 'unknown';
}

function mapWooCommerceProduct(product) {
  const categories =
    Array.isArray(
      product?.categories
    )
      ? product.categories
      : [];

  const category =
    categories
      .map(item =>
        safeString(
          item?.name
        )
      )
      .filter(Boolean)
      .join(' / ') ||
    'WooCommerce';

  const primaryCategory =
    categories.find(
      item =>
        safeString(
          item?.slug
        ) &&
        ![
          'uncategorized',
          'non-classe',
          'non-classee'
        ].includes(
          normalizeWooLookup(
            item?.slug
          ).replace(
            /\s+/g,
            '-'
          )
        )
    ) ||
    categories.find(
      item =>
        safeString(
          item?.slug
        )
    ) ||
    null;

  const categoryUrl =
    primaryCategory?.slug
      ? (
          `${WOOCOMMERCE_URL}/categorie-produit/` +
          `${encodeURIComponent(safeString(primaryCategory.slug))}/`
        )
      : '';

  const colors =
    wooAttributeValue(
      product,
      [
        'couleur',
        'couleurs',
        'color',
        'colors'
      ]
    );

  const composition =
    wooAttributeValue(
      product,
      [
        'composition',
        'matiere',
        'matieres',
        'material',
        'materials'
      ]
    );

  const showrooms =
    wooAttributeValue(
      product,
      [
        'showroom',
        'showrooms',
        'magasin',
        'magasins'
      ]
    );

  const imageUrl =
    Array.isArray(
      product?.images
    ) &&
    product.images[0]
      ? safeString(
          product.images[0].src
        )
      : '';

  const regularPrice =
    safeString(
      product?.regular_price
    );

  const currentPrice =
    safeString(
      product?.price
    );

  return {
    woocommerceId:
      Number(
        product?.id
      ) || null,

    woocommerceSku:
      safeString(
        product?.sku
      ),

    woocommerceSlug:
      safeString(
        product?.slug
      ),

    woocommerceStatus:
      safeString(
        product?.status
      ),

    woocommerceType:
      safeString(
        product?.type
      ),

    woocommerceStockStatus:
      safeString(
        product?.stock_status
      ),

    woocommerceStockQuantity:
      product?.stock_quantity === null ||
      product?.stock_quantity === undefined
        ? null
        : Number(
            product.stock_quantity
          ),

    woocommerceModifiedAt:
      safeString(
        product?.date_modified_gmt ||
        product?.date_modified
      ),

    name:
      safeString(
        product?.name
      ),

    category,

    price:
      regularPrice ||
      currentPrice,

    promoPrice:
      safeString(
        product?.sale_price
      ),

    availability:
      wooAvailability(
        product
      ),

    dimensions:
      wooDimensionsText(
        product
      ),

    composition,

    colors,

    showrooms,

    productUrl:
      safeString(
        product?.permalink
      ),

    categoryUrl,

    description:
      htmlToPlainText(
        product?.short_description ||
        product?.description
      ),

    imageUrl,

    active:
      safeString(
        product?.status
      ) === 'publish'
  };
}

function findWooProductIndex(
  products,
  remote
) {
  if (
    remote.woocommerceId
  ) {
    const byId =
      products.findIndex(
        item =>
          Number(
            item?.woocommerceId
          ) ===
          Number(
            remote.woocommerceId
          )
      );

    if (byId >= 0) {
      return byId;
    }
  }

  if (
    remote.woocommerceSku
  ) {
    const sku =
      normalizeWooLookup(
        remote.woocommerceSku
      );

    const bySku =
      products.findIndex(
        item =>
          sku &&
          (
            normalizeWooLookup(
              item?.woocommerceSku
            ) === sku ||
            normalizeWooLookup(
              item?.sku
            ) === sku
          )
      );

    if (bySku >= 0) {
      return bySku;
    }
  }

  if (
    remote.woocommerceSlug
  ) {
    const slug =
      normalizeWooLookup(
        remote.woocommerceSlug
      );

    const bySlug =
      products.findIndex(
        item =>
          normalizeWooLookup(
            item?.woocommerceSlug
          ) === slug
      );

    if (bySlug >= 0) {
      return bySlug;
    }
  }

  const normalizedName =
    normalizeWooLookup(
      remote.name
    );

  if (!normalizedName) {
    return -1;
  }

  const sameNameIndexes =
    products
      .map(
        (
          item,
          index
        ) => ({
          index,
          name:
            normalizeWooLookup(
              item?.name
            )
        })
      )
      .filter(
        item =>
          item.name ===
          normalizedName
      )
      .map(
        item =>
          item.index
      );

  return (
    sameNameIndexes.length === 1
      ? sameNameIndexes[0]
      : -1
  );
}

function mergeWooProduct(
  current,
  remote,
  now
) {
  const currentImage =
    safeString(
      current?.image
    );

  const currentUsesWooImage =
    safeString(
      current?.syncSource
    ) === 'woocommerce' &&
    currentImage &&
    !currentImage.startsWith(
      '/admin/uploads/'
    );

  let image =
    currentImage;

  let imageFilename =
    safeString(
      current?.imageFilename
    );

  if (
    WOOCOMMERCE_SYNC_IMAGES &&
    remote.imageUrl &&
    (
      !currentImage ||
      currentUsesWooImage
    )
  ) {
    image =
      remote.imageUrl;

    imageFilename =
      '';
  }

  return {
    ...current,

    name:
      remote.name ||
      safeString(
        current?.name
      ),

    category:
      remote.category ||
      safeString(
        current?.category
      ) ||
      'WooCommerce',

    price:
      remote.price,

    promoPrice:
      remote.promoPrice,

    availability:
      remote.availability,

    dimensions:
      remote.dimensions ||
      safeString(
        current?.dimensions
      ),

    composition:
      remote.composition ||
      safeString(
        current?.composition
      ),

    colors:
      remote.colors ||
      safeString(
        current?.colors
      ),

    showrooms:
      remote.showrooms ||
      safeString(
        current?.showrooms
      ),

    productUrl:
      remote.productUrl ||
      safeString(
        current?.productUrl
      ),

    categoryUrl:
      remote.categoryUrl ||
      safeString(
        current?.categoryUrl
      ),

    description:
      remote.description ||
      safeString(
        current?.description
      ),

    image,
    imageFilename,

    woocommerceImageUrl:
      remote.imageUrl,

    woocommerceId:
      remote.woocommerceId,

    woocommerceSku:
      remote.woocommerceSku,

    woocommerceSlug:
      remote.woocommerceSlug,

    woocommerceStatus:
      remote.woocommerceStatus,

    woocommerceType:
      remote.woocommerceType,

    woocommerceStockStatus:
      remote.woocommerceStockStatus,

    woocommerceStockQuantity:
      remote.woocommerceStockQuantity,

    woocommerceModifiedAt:
      remote.woocommerceModifiedAt,

    syncSource:
      'woocommerce',

    active:
      remote.active,

    wooMissingAt:
      null,

    updatedAt:
      now
  };
}

function createLocalProductFromWoo(
  remote,
  now
) {
  return {
    id:
      crypto.randomUUID(),

    name:
      remote.name ||
      `Produit WooCommerce ${remote.woocommerceId || ''}`.trim(),

    category:
      remote.category ||
      'WooCommerce',

    price:
      remote.price,

    promoPrice:
      remote.promoPrice,

    availability:
      remote.availability,

    dimensions:
      remote.dimensions,

    composition:
      remote.composition,

    colors:
      remote.colors,

    showrooms:
      remote.showrooms,

    productUrl:
      remote.productUrl,

    categoryUrl:
      remote.categoryUrl,

    description:
      remote.description,

    customizableColor:
      false,

    customizableFabric:
      false,

    customizableDimensions:
      false,

    customizableCorner:
      false,

    active:
      remote.active,

    image:
      remote.imageUrl,

    imageFilename:
      '',

    woocommerceImageUrl:
      remote.imageUrl,

    woocommerceId:
      remote.woocommerceId,

    woocommerceSku:
      remote.woocommerceSku,

    woocommerceSlug:
      remote.woocommerceSlug,

    woocommerceStatus:
      remote.woocommerceStatus,

    woocommerceType:
      remote.woocommerceType,

    woocommerceStockStatus:
      remote.woocommerceStockStatus,

    woocommerceStockQuantity:
      remote.woocommerceStockQuantity,

    woocommerceModifiedAt:
      remote.woocommerceModifiedAt,

    syncSource:
      'woocommerce',

    wooMissingAt:
      null,

    createdAt:
      now,

    updatedAt:
      now
  };
}

function comparableWooProduct(
  product
) {
  const copy = {
    ...product
  };

  delete copy.updatedAt;
  delete copy.wooMissingAt;

  return copy;
}

function upsertWooProductInArray(
  products,
  wooProduct,
  now =
    new Date().toISOString()
) {
  const remote =
    mapWooCommerceProduct(
      wooProduct
    );

  if (
    !remote.woocommerceId
  ) {
    throw new Error(
      'Produit WooCommerce sans ID.'
    );
  }

  const index =
    findWooProductIndex(
      products,
      remote
    );

  if (index === -1) {
    const created =
      createLocalProductFromWoo(
        remote,
        now
      );

    products.push(
      created
    );

    return {
      action:
        'created',
      product:
        created
    };
  }

  const current =
    products[index];

  const updated =
    mergeWooProduct(
      current,
      remote,
      now
    );

  const changed =
    JSON.stringify(
      comparableWooProduct(
        current
      )
    ) !==
    JSON.stringify(
      comparableWooProduct(
        updated
      )
    );

  products[index] =
    changed
      ? updated
      : {
          ...current,
          woocommerceModifiedAt:
            remote.woocommerceModifiedAt,
          wooMissingAt:
            null
        };

  return {
    action:
      changed
        ? 'updated'
        : 'unchanged',
    product:
      products[index]
  };
}

function markWooProductDeleted(
  products,
  wooId,
  now =
    new Date().toISOString()
) {
  const numericId =
    Number(
      wooId
    );

  if (!numericId) {
    return false;
  }

  const index =
    products.findIndex(
      item =>
        Number(
          item?.woocommerceId
        ) === numericId
    );

  if (index === -1) {
    return false;
  }

  products[index] = {
    ...products[index],

    active:
      false,

    availability:
      'out_of_stock',

    woocommerceStatus:
      'deleted',

    wooMissingAt:
      now,

    updatedAt:
      now
  };

  return true;
}

function wooBasicAuthHeader() {
  return (
    'Basic ' +
    Buffer.from(
      `${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}`
    ).toString(
      'base64'
    )
  );
}

async function wooApiRequest(
  endpoint,
  options = {}
) {
  if (!wooConfigured()) {
    throw new Error(
      'WooCommerce n’est pas configuré. Ajoutez les variables Railway.'
    );
  }

  const cleanEndpoint =
    safeString(
      endpoint
    )
      .replace(
        /^\/+/,
        ''
      );

  const url =
    new URL(
      `${WOOCOMMERCE_URL}/wp-json/wc/v3/${cleanEndpoint}`
    );

  const query =
    options.query &&
    typeof options.query === 'object'
      ? options.query
      : {};

  for (
    const [key, value]
    of Object.entries(query)
  ) {
    if (
      value === undefined ||
      value === null ||
      value === ''
    ) {
      continue;
    }

    url.searchParams.set(
      key,
      String(value)
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      25000
    );

  try {
    const response =
      await fetch(
        url,
        {
          method:
            options.method ||
            'GET',

          headers: {
            Authorization:
              wooBasicAuthHeader(),

            Accept:
              'application/json',

            ...(
              options.body
                ? {
                    'Content-Type':
                      'application/json'
                  }
                : {}
            )
          },

          body:
            options.body
              ? JSON.stringify(
                  options.body
                )
              : undefined,

          signal:
            controller.signal
        }
      );

    const raw =
      await response.text();

    let data;

    try {
      data =
        raw
          ? JSON.parse(raw)
          : {};
    } catch {
      data =
        raw;
    }

    if (!response.ok) {
      const message =
        data
          ?.message ||
        data
          ?.data
          ?.message ||
        (
          typeof data === 'string'
            ? data
            : ''
        ) ||
        `WooCommerce HTTP ${response.status}`;

      throw new Error(
        String(message)
      );
    }

    return {
      data,
      headers:
        response.headers,
      status:
        response.status
    };
  } catch (error) {
    if (
      error?.name ===
      'AbortError'
    ) {
      throw new Error(
        'WooCommerce ne répond pas dans le délai prévu.'
      );
    }

    throw error;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

async function fetchAllWooProducts() {
  const products = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result =
      await wooApiRequest(
        'products',
        {
          query: {
            per_page:
              100,

            page,

            status:
              'any',

            orderby:
              'id',

            order:
              'asc'
          }
        }
      );

    if (
      !Array.isArray(
        result.data
      )
    ) {
      throw new Error(
        'Réponse WooCommerce produits invalide.'
      );
    }

    products.push(
      ...result.data
    );

    totalPages =
      Math.max(
        1,
        Number(
          result.headers.get(
            'x-wp-totalpages'
          )
        ) || 1
      );

    page += 1;
  } while (
    page <= totalPages
  );

  return products;
}

async function testWooCommerceConnection() {
  const result =
    await wooApiRequest(
      'products',
      {
        query: {
          per_page:
            1,
          page:
            1
        }
      }
    );

  return {
    success:
      true,

    reachable:
      true,

    sampleCount:
      Array.isArray(
        result.data
      )
        ? result.data.length
        : 0,

    totalProducts:
      Number(
        result.headers.get(
          'x-wp-total'
        )
      ) || null
  };
}

async function runWooCommerceSync(
  reason =
    'manual'
) {
  if (!wooConfigured()) {
    throw new Error(
      'WooCommerce n’est pas configuré dans Railway.'
    );
  }

  if (wooSyncRunning) {
    throw new Error(
      'Une synchronisation WooCommerce est déjà en cours.'
    );
  }

  wooSyncRunning =
    true;

  const startedAt =
    Date.now();

  saveWooCommerceSyncState({
    lastAttemptAt:
      new Date().toISOString(),

    lastReason:
      safeString(reason) ||
      'manual',

    lastError:
      ''
  });

  try {
    const remoteProducts =
      await fetchAllWooProducts();

    const products =
      loadProducts();

    const now =
      new Date().toISOString();

    const remoteIds =
      new Set();

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let deactivated = 0;

    for (
      const wooProduct
      of remoteProducts
    ) {
      const wooId =
        Number(
          wooProduct?.id
        );

      if (wooId) {
        remoteIds.add(
          wooId
        );
      }

      const result =
        upsertWooProductInArray(
          products,
          wooProduct,
          now
        );

      if (
        result.action ===
        'created'
      ) {
        created += 1;
      } else if (
        result.action ===
        'updated'
      ) {
        updated += 1;
      } else {
        unchanged += 1;
      }
    }

    for (
      let index = 0;
      index < products.length;
      index += 1
    ) {
      const product =
        products[index];

      if (
        safeString(
          product?.syncSource
        ) !== 'woocommerce'
      ) {
        continue;
      }

      const wooId =
        Number(
          product?.woocommerceId
        );

      if (
        !wooId ||
        remoteIds.has(
          wooId
        )
      ) {
        continue;
      }

      if (
        product.active !== false ||
        product.availability !==
          'out_of_stock'
      ) {
        products[index] = {
          ...product,
          active:
            false,
          availability:
            'out_of_stock',
          wooMissingAt:
            now,
          updatedAt:
            now
        };

        deactivated += 1;
      }
    }

    saveProducts(
      products
    );

    const syncState =
      saveWooCommerceSyncState({
        lastSuccessAt:
          now,

        lastError:
          '',

        lastDurationMs:
          Date.now() -
          startedAt,

        lastFetched:
          remoteProducts.length,

        lastCreated:
          created,

        lastUpdated:
          updated,

        lastUnchanged:
          unchanged,

        lastDeactivated:
          deactivated
      });

    console.log(
      '🔄 WooCommerce synchronisé :',
      {
        reason,
        fetched:
          remoteProducts.length,
        created,
        updated,
        unchanged,
        deactivated
      }
    );

    return {
      success:
        true,

      fetched:
        remoteProducts.length,

      created,
      updated,
      unchanged,
      deactivated,

      state:
        syncState
    };
  } catch (error) {
    saveWooCommerceSyncState({
      lastError:
        error.message,

      lastDurationMs:
        Date.now() -
        startedAt
    });

    console.error(
      '❌ Synchronisation WooCommerce :',
      error.message
    );

    throw error;
  } finally {
    wooSyncRunning =
      false;
  }
}

function verifyWooWebhookSignature(
  req
) {
  if (
    !WOOCOMMERCE_WEBHOOK_SECRET
  ) {
    return false;
  }

  const received =
    safeString(
      req.get(
        'x-wc-webhook-signature'
      )
    );

  if (!received) {
    return false;
  }

  const rawBody =
    Buffer.isBuffer(
      req.rawBody
    )
      ? req.rawBody
      : Buffer.from(
          JSON.stringify(
            req.body ||
            {}
          ),
          'utf8'
        );

  const expected =
    crypto
      .createHmac(
        'sha256',
        WOOCOMMERCE_WEBHOOK_SECRET
      )
      .update(
        rawBody
      )
      .digest(
        'base64'
      );

  const receivedBuffer =
    Buffer.from(
      received,
      'utf8'
    );

  const expectedBuffer =
    Buffer.from(
      expected,
      'utf8'
    );

  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    expectedBuffer
  );
}

async function processWooCommerceWebhook(
  topic,
  payload
) {
  const now =
    new Date().toISOString();

  const normalizedTopic =
    safeString(
      topic
    ).toLowerCase();

  const wooId =
    Number(
      payload?.id
    ) || null;

  if (
    normalizedTopic ===
      'product.created' ||
    normalizedTopic ===
      'product.updated'
  ) {
    const products =
      loadProducts();

    const result =
      upsertWooProductInArray(
        products,
        payload,
        now
      );

    saveProducts(
      products
    );

    saveWooCommerceSyncState({
      lastWebhookAt:
        now,
      lastWebhookTopic:
        normalizedTopic,
      lastWebhookProductId:
        wooId,
      lastError:
        ''
    });

    console.log(
      `⚡ WooCommerce webhook ${normalizedTopic} :`,
      wooId,
      result.action
    );

    return;
  }

  if (
    normalizedTopic ===
    'product.deleted'
  ) {
    const products =
      loadProducts();

    markWooProductDeleted(
      products,
      wooId,
      now
    );

    saveProducts(
      products
    );

    saveWooCommerceSyncState({
      lastWebhookAt:
        now,
      lastWebhookTopic:
        normalizedTopic,
      lastWebhookProductId:
        wooId,
      lastError:
        ''
    });

    console.log(
      '⚡ WooCommerce webhook product.deleted :',
      wooId
    );

    return;
  }

  saveWooCommerceSyncState({
    lastWebhookAt:
      now,
    lastWebhookTopic:
      normalizedTopic,
    lastWebhookProductId:
      wooId
  });
}

function getWooWebhookDeliveryUrl(
  req
) {
  const forwardedProto =
    safeString(
      req.headers[
        'x-forwarded-proto'
      ]
    )
      .split(',')[0]
      .trim();

  const protocol =
    forwardedProto ||
    req.protocol ||
    'https';

  const host =
    safeString(
      req.get('host')
    );

  return (
    `${protocol}://${host}` +
    '/admin/api/woocommerce/webhook'
  );
}

async function installWooCommerceWebhooks(
  req
) {
  if (
    !WOOCOMMERCE_WEBHOOK_SECRET
  ) {
    throw new Error(
      'Ajoutez WOOCOMMERCE_WEBHOOK_SECRET dans Railway avant d’installer les webhooks.'
    );
  }

  const deliveryUrl =
    getWooWebhookDeliveryUrl(
      req
    );

  const existingResult =
    await wooApiRequest(
      'webhooks',
      {
        query: {
          per_page:
            100
        }
      }
    );

  const existing =
    Array.isArray(
      existingResult.data
    )
      ? existingResult.data
      : [];

  const topics = [
    'product.created',
    'product.updated',
    'product.deleted'
  ];

  const results = [];

  for (
    const topic
    of topics
  ) {
    const found =
      existing.find(
        item =>
          safeString(
            item?.topic
          ) === topic &&
          safeString(
            item?.delivery_url
          ).replace(/\/+$/, '') ===
          deliveryUrl.replace(/\/+$/, '')
      );

    if (found) {
      results.push({
        topic,
        status:
          'already_exists',
        id:
          found.id
      });

      continue;
    }

    const created =
      await wooApiRequest(
        'webhooks',
        {
          method:
            'POST',

          body: {
            name:
              `MONDECO ${topic}`,

            topic,

            delivery_url:
              deliveryUrl,

            secret:
              WOOCOMMERCE_WEBHOOK_SECRET,

            status:
              'active'
          }
        }
      );

    results.push({
      topic,
      status:
        'created',
      id:
        created.data?.id ||
        null
    });
  }

  return {
    success:
      true,
    deliveryUrl,
    webhooks:
      results
  };
}

router.post(
  '/api/woocommerce/webhook',

  // Le ping initial WooCommerce n'a pas forcément un Content-Type
  // application/x-www-form-urlencoded selon la pile WordPress/PHP.
  // On lit donc tout corps NON déjà traité par express.json().
  express.text({
    type:
      () => true,
    limit:
      '64kb'
  }),

  (req, res) => {
    const userAgent =
      safeString(
        req.get(
          'user-agent'
        )
      );

    const webhookTopic =
      safeString(
        req.get(
          'x-wc-webhook-topic'
        )
      );

    const webhookSignature =
      safeString(
        req.get(
          'x-wc-webhook-signature'
        )
      );

    const pingBody =
      typeof req.body === 'string'
        ? safeString(
            req.body
          )
        : (
            Buffer.isBuffer(
              req.rawBody
            )
              ? safeString(
                  req.rawBody.toString(
                    'utf8'
                  )
                )
              : ''
          );

    const isWooHookshot =
      /woocommerce\/.+hookshot/i.test(
        userAgent
      );

    const isWooPing =
      isWooHookshot &&
      !webhookTopic &&
      !webhookSignature &&
      /^webhook_id=\d+$/.test(
        pingBody
      );

    // WooCommerce exige HTTP 200 au premier enregistrement.
    // Ce ping ne contient aucune donnée produit, n'est pas une
    // livraison signée et ne modifie aucune donnée MONDECO.
    if (isWooPing) {
      console.log(
        '✅ Ping initial WooCommerce accepté :',
        pingBody
      );

      return res
        .status(200)
        .json({
          received:
            true,
          type:
            'woocommerce_ping'
        });
    }

    if (
      !WOOCOMMERCE_WEBHOOK_SECRET
    ) {
      return res
        .status(503)
        .json({
          error:
            'Webhook WooCommerce non configuré.'
        });
    }

    if (
      !verifyWooWebhookSignature(
        req
      )
    ) {
      console.warn(
        '⚠️ Signature webhook WooCommerce invalide.'
      );

      return res
        .status(401)
        .json({
          error:
            'Signature webhook invalide.'
        });
    }

    const topic =
      safeString(
        req.get(
          'x-wc-webhook-topic'
        )
      );

    const payload =
      req.body ||
      {};

    res
      .status(200)
      .json({
        received:
          true
      });

    setImmediate(
      () => {
        processWooCommerceWebhook(
          topic,
          payload
        ).catch(
          error => {
            console.error(
              '❌ Traitement webhook WooCommerce :',
              error.message
            );

            saveWooCommerceSyncState({
              lastError:
                error.message
            });
          }
        );
      }
    );
  }
);


router.get(
  '/api/woocommerce/webhook',
  (req, res) => {
    return res
      .status(200)
      .json({
        status:
          'ok',
        endpoint:
          'woocommerce_webhook',
        configured:
          Boolean(
            WOOCOMMERCE_WEBHOOK_SECRET
          )
      });
  }
);

router.get(
  '/api/woocommerce/status',
  requireAuth,
  (req, res) => {
    return res.json(
      wooPublicStatus(
        req
      )
    );
  }
);

router.post(
  '/api/woocommerce/test',
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await testWooCommerceConnection();

      return res.json({
        ...result,
        status:
          wooPublicStatus(
            req
          )
      });
    } catch (error) {
      return res
        .status(502)
        .json({
          error:
            error.message
        });
    }
  }
);

router.post(
  '/api/woocommerce/sync',
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await runWooCommerceSync(
          'manual-admin'
        );

      return res.json({
        ...result,
        status:
          wooPublicStatus(
            req
          )
      });
    } catch (error) {
      return res
        .status(502)
        .json({
          error:
            error.message
        });
    }
  }
);

router.post(
  '/api/woocommerce/webhooks/install',
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await installWooCommerceWebhooks(
          req
        );

      return res.json(
        result
      );
    } catch (error) {
      return res
        .status(502)
        .json({
          error:
            error.message
        });
    }
  }
);

function startWooCommerceAutoSync() {
  if (
    !WOOCOMMERCE_SYNC_ENABLED ||
    !wooConfigured()
  ) {
    console.log(
      '🔄 WooCommerce auto-sync : désactivé ou non configuré.'
    );

    return;
  }

  if (
    wooSyncIntervalHandle
  ) {
    clearInterval(
      wooSyncIntervalHandle
    );
  }

  const intervalMs =
    WOOCOMMERCE_SYNC_MINUTES *
    60 *
    1000;

  console.log(
    `🔄 WooCommerce auto-sync : toutes les ${WOOCOMMERCE_SYNC_MINUTES} min`
  );

  setTimeout(
    () => {
      runWooCommerceSync(
        'startup'
      ).catch(
        error => {
          console.warn(
            '⚠️ Sync WooCommerce au démarrage :',
            error.message
          );
        }
      );
    },
    20000
  );

  wooSyncIntervalHandle =
    setInterval(
      () => {
        if (wooSyncRunning) {
          return;
        }

        runWooCommerceSync(
          'scheduled'
        ).catch(
          error => {
            console.warn(
              '⚠️ Sync WooCommerce planifiée :',
              error.message
            );
          }
        );
      },
      intervalMs
    );
}

startWooCommerceAutoSync();

// ============================================================
// API PRODUITS
// ============================================================

router.get(
  '/api/products',
  requireAuth,
  (req, res) => {
    return res.json(loadProducts());
  }
);

router.post(
  '/api/products',
  requireAuth,
  uploadProductImage,
  (req, res) => {
    try {
      const name =
        safeString(req.body?.name);

      const category =
        safeString(req.body?.category);

      if (!name) {
        if (req.file) {
          deleteFileIfExists(req.file.path);
        }

        return res
          .status(400)
          .json({
            error:
              'Le nom du produit est obligatoire.'
          });
      }

      if (!category) {
        if (req.file) {
          deleteFileIfExists(req.file.path);
        }

        return res
          .status(400)
          .json({
            error:
              'La catégorie est obligatoire.'
          });
      }

      if (req.user?.role === 'commercial') {
        const conversationKey = normalizePhone(externalContact);
        const state = loadConversationStatesAdmin()[conversationKey] || {};
        if (safeString(state.assignedUserId) !== safeString(req.user.id)) {
          return res.status(403).json({ error: 'Cette conversation n’est pas affectée à votre compte.' });
        }
      }

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              'La photo du produit est obligatoire.'
          });
      }

      const now =
        new Date().toISOString();

      const product = {
        id: crypto.randomUUID(),
        name,
        category,

        price:
          safeString(req.body?.price),

        promoPrice:
          safeString(req.body?.promoPrice),

        availability:
          safeString(req.body?.availability) ||
          'unknown',

        dimensions:
          safeString(req.body?.dimensions),

        composition:
          safeString(req.body?.composition),

        colors:
          safeString(req.body?.colors),

        showrooms:
          safeString(req.body?.showrooms),

        productUrl:
          safeString(req.body?.productUrl),

        categoryUrl:
          safeString(req.body?.categoryUrl),

        description:
          safeString(req.body?.description),

        customizableColor:
          parseBoolean(
            req.body?.customizableColor,
            false
          ),

        customizableFabric:
          parseBoolean(
            req.body?.customizableFabric,
            false
          ),

        customizableDimensions:
          parseBoolean(
            req.body?.customizableDimensions,
            false
          ),

        customizableCorner:
          parseBoolean(
            req.body?.customizableCorner,
            false
          ),

        active:
          parseBoolean(
            req.body?.active,
            true
          ),

        image:
          `/admin/uploads/${req.file.filename}`,

        imageFilename:
          req.file.filename,

        createdAt: now,
        updatedAt: now
      };

      const products = loadProducts();
      products.push(product);

      try {
        saveProducts(products);
      } catch (error) {
        deleteFileIfExists(req.file.path);
        throw error;
      }

      return res
        .status(201)
        .json(product);
    } catch (error) {
      console.error(
        '❌ Ajout produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible d\u2019ajouter le produit.'
        });
    }
  }
);

router.put(
  '/api/products/:id',
  requireAuth,
  uploadProductImage,
  (req, res) => {
    try {
      const products = loadProducts();

      const index =
        products.findIndex(
          item => item.id === req.params.id
        );

      if (index === -1) {
        if (req.file) {
          deleteFileIfExists(req.file.path);
        }

        return res
          .status(404)
          .json({
            error: 'Produit introuvable.'
          });
      }

      const current = products[index];

      const oldImagePath =
        getLocalProductImagePath(current);

      const name =
        req.body?.name !== undefined
          ? safeString(req.body.name)
          : safeString(current.name);

      const category =
        req.body?.category !== undefined
          ? safeString(req.body.category)
          : safeString(current.category);

      if (!name) {
        if (req.file) {
          deleteFileIfExists(req.file.path);
        }

        return res
          .status(400)
          .json({
            error:
              'Le nom ne peut pas être vide.'
          });
      }

      if (!category) {
        if (req.file) {
          deleteFileIfExists(req.file.path);
        }

        return res
          .status(400)
          .json({
            error:
              'La catégorie ne peut pas être vide.'
          });
      }

      if (!req.file && !current.image) {
        return res
          .status(400)
          .json({
            error:
              'Ce produit n\u2019a pas de photo. Ajoutez une image.'
          });
      }

      const updated = {
        ...current,
        name,
        category,

        price:
          req.body?.price !== undefined
            ? safeString(req.body.price)
            : safeString(current.price),

        promoPrice:
          req.body?.promoPrice !== undefined
            ? safeString(req.body.promoPrice)
            : safeString(current.promoPrice),

        availability:
          req.body?.availability !== undefined
            ? safeString(req.body.availability)
            : (
              safeString(current.availability) ||
              'unknown'
            ),

        dimensions:
          req.body?.dimensions !== undefined
            ? safeString(req.body.dimensions)
            : safeString(current.dimensions),

        composition:
          req.body?.composition !== undefined
            ? safeString(req.body.composition)
            : safeString(current.composition),

        colors:
          req.body?.colors !== undefined
            ? safeString(req.body.colors)
            : safeString(current.colors),

        showrooms:
          req.body?.showrooms !== undefined
            ? safeString(req.body.showrooms)
            : safeString(current.showrooms),

        productUrl:
          req.body?.productUrl !== undefined
            ? safeString(req.body.productUrl)
            : safeString(current.productUrl),

        categoryUrl:
          req.body?.categoryUrl !== undefined
            ? safeString(req.body.categoryUrl)
            : safeString(current.categoryUrl),

        description:
          req.body?.description !== undefined
            ? safeString(req.body.description)
            : safeString(current.description),

        customizableColor:
          req.body?.customizableColor !== undefined
            ? parseBoolean(
                req.body.customizableColor,
                false
              )
            : (
              current.customizableColor === true
            ),

        customizableFabric:
          req.body?.customizableFabric !== undefined
            ? parseBoolean(
                req.body.customizableFabric,
                false
              )
            : (
              current.customizableFabric === true
            ),

        customizableDimensions:
          req.body?.customizableDimensions !== undefined
            ? parseBoolean(
                req.body.customizableDimensions,
                false
              )
            : (
              current.customizableDimensions === true
            ),

        customizableCorner:
          req.body?.customizableCorner !== undefined
            ? parseBoolean(
                req.body.customizableCorner,
                false
              )
            : (
              current.customizableCorner === true
            ),

        active:
          req.body?.active !== undefined
            ? parseBoolean(
                req.body.active,
                true
              )
            : (
              current.active !== false
            ),

        updatedAt:
          new Date().toISOString()
      };

      if (req.file) {
        updated.image =
          `/admin/uploads/${req.file.filename}`;

        updated.imageFilename =
          req.file.filename;
      }

      products[index] = updated;

      try {
        saveProducts(products);
      } catch (error) {
        if (req.file) {
          deleteFileIfExists(req.file.path);
        }
        throw error;
      }

      if (
        req.file &&
        oldImagePath &&
        oldImagePath !== req.file.path
      ) {
        archiveFileBeforeDelete(oldImagePath, 'product-images');
      }

      return res.json(updated);
    } catch (error) {
      console.error(
        '❌ Modification produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible de modifier le produit.'
        });
    }
  }
);

router.delete(
  '/api/products/:id',
  requireAuth,
  (req, res) => {
    try {
      const products = loadProducts();

      const product =
        products.find(
          item => item.id === req.params.id
        );

      if (!product) {
        return res
          .status(404)
          .json({
            error: 'Produit introuvable.'
          });
      }

      saveProducts(
        products.filter(
          item => item.id !== req.params.id
        )
      );

      const imagePath =
        getLocalProductImagePath(product);

      if (imagePath) {
        archiveFileBeforeDelete(imagePath, 'product-images');
      }

      return res.json({
        success: true
      });
    } catch (error) {
      console.error(
        '❌ Suppression produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer le produit.'
        });
    }
  }
);

// ============================================================
// API INSTRUCTIONS
// ============================================================

router.get(
  '/api/instructions',
  requireAuth,
  (req, res) => {
    return res.json(loadInstructions());
  }
);

router.post(
  '/api/instructions',
  requireAuth,
  (req, res) => {
    try {
      const title =
        safeString(req.body?.title);

      const content =
        safeString(req.body?.content);

      if (!title) {
        return res
          .status(400)
          .json({
            error:
              'Le titre est obligatoire.'
          });
      }

      if (!content) {
        return res
          .status(400)
          .json({
            error:
              'L\u2019instruction est obligatoire.'
          });
      }

      const now =
        new Date().toISOString();

      const instruction = {
        id: crypto.randomUUID(),
        title,
        content,
        active: parseBoolean(
          req.body?.active,
          true
        ),
        createdAt: now,
        updatedAt: now
      };

      const instructions =
        loadInstructions();

      instructions.push(instruction);

      saveInstructions(instructions);

      return res
        .status(201)
        .json(instruction);
    } catch (error) {
      console.error(
        '❌ Ajout instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d\u2019ajouter l\u2019instruction.'
        });
    }
  }
);

router.put(
  '/api/instructions/:id',
  requireAuth,
  (req, res) => {
    try {
      const instructions =
        loadInstructions();

      const index =
        instructions.findIndex(
          item => item.id === req.params.id
        );

      if (index === -1) {
        return res
          .status(404)
          .json({
            error:
              'Instruction introuvable.'
          });
      }

      const current =
        instructions[index];

      const title =
        req.body?.title !== undefined
          ? safeString(req.body.title)
          : safeString(current.title);

      const content =
        req.body?.content !== undefined
          ? safeString(req.body.content)
          : safeString(current.content);

      if (!title) {
        return res
          .status(400)
          .json({
            error:
              'Le titre ne peut pas être vide.'
          });
      }

      if (!content) {
        return res
          .status(400)
          .json({
            error:
              'L\u2019instruction ne peut pas être vide.'
          });
      }

      instructions[index] = {
        ...current,
        title,
        content,

        active:
          req.body?.active !== undefined
            ? parseBoolean(
                req.body.active,
                true
              )
            : (
              current.active !== false
            ),

        updatedAt:
          new Date().toISOString()
      };

      saveInstructions(instructions);

      return res.json(
        instructions[index]
      );
    } catch (error) {
      console.error(
        '❌ Modification instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de modifier l\u2019instruction.'
        });
    }
  }
);

router.delete(
  '/api/instructions/:id',
  requireAuth,
  (req, res) => {
    try {
      const instructions =
        loadInstructions();

      const exists =
        instructions.some(
          item => item.id === req.params.id
        );

      if (!exists) {
        return res
          .status(404)
          .json({
            error:
              'Instruction introuvable.'
          });
      }

      saveInstructions(
        instructions.filter(
          item => item.id !== req.params.id
        )
      );

      return res.json({
        success: true
      });
    } catch (error) {
      console.error(
        '❌ Suppression instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer l\u2019instruction.'
        });
    }
  }
);

router.post(
  '/api/instructions/import',
  requireAuth,
  (req, res) => {
    try {
      const text =
        safeString(req.body?.text);

      if (req.user?.role === 'commercial') {
        const conversationKey = channel === 'instagram'
          ? `instagram:${externalContact}`
          : normalizePhone(externalContact);
        const state = loadConversationStatesAdmin()[conversationKey] || {};
        if (safeString(state.assignedUserId) !== safeString(req.user.id)) {
          return res.status(403).json({ error: 'Cette conversation n’est pas affectée à votre compte.' });
        }
      }

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              'Aucune instruction à importer.'
          });
      }

      const incoming =
        parseInstructionBlocks(text);

      const instructions =
        loadInstructions();

      const fingerprints =
        new Set(
          instructions.map(
            item =>
              instructionFingerprint(
                item.title,
                item.content
              )
          )
        );

      let imported = 0;
      let duplicates = 0;

      for (const item of incoming) {
        const fingerprint =
          instructionFingerprint(
            item.title,
            item.content
          );

        if (fingerprints.has(fingerprint)) {
          duplicates += 1;
          continue;
        }

        const now =
          new Date().toISOString();

        instructions.push({
          id: crypto.randomUUID(),
          title: item.title,
          content: item.content,
          active: true,
          createdAt: now,
          updatedAt: now
        });

        fingerprints.add(fingerprint);
        imported += 1;
      }

      saveInstructions(instructions);

      return res.json({
        success: true,
        imported,
        duplicates,
        total: instructions.length
      });
    } catch (error) {
      console.error(
        '❌ Import instructions :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d\u2019importer les instructions.'
        });
    }
  }
);

router.post(
  '/api/instructions/import-legacy',
  requireAuth,
  (req, res) => {
    try {
      const legacyText =
        loadLegacyBusinessInfo().trim();

      if (!legacyText) {
        return res
          .status(404)
          .json({
            error:
              'business-info.txt est vide ou introuvable.'
          });
      }

      const incoming =
        parseInstructionBlocks(legacyText);

      const instructions =
        loadInstructions();

      const fingerprints =
        new Set(
          instructions.map(
            item =>
              instructionFingerprint(
                item.title,
                item.content
              )
          )
        );

      let imported = 0;
      let duplicates = 0;

      for (const item of incoming) {
        const fingerprint =
          instructionFingerprint(
            item.title,
            item.content
          );

        if (fingerprints.has(fingerprint)) {
          duplicates += 1;
          continue;
        }

        const now =
          new Date().toISOString();

        instructions.push({
          id: crypto.randomUUID(),
          title: item.title,
          content: item.content,
          active: true,
          source: 'business-info.txt',
          createdAt: now,
          updatedAt: now
        });

        fingerprints.add(fingerprint);
        imported += 1;
      }

      saveInstructions(instructions);

      return res.json({
        success: true,
        imported,
        duplicates,
        total: instructions.length
      });
    } catch (error) {
      console.error(
        '❌ Import business-info.txt :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d\u2019importer business-info.txt.'
        });
    }
  }
);

// ============================================================
// API PARAMÈTRES
// ============================================================

router.get(
  '/api/settings',
  requireAuth,
  (req, res) => {
    return res.json(
      getBotSettings()
    );
  }
);

router.put(
  '/api/settings',
  requireAuth,
  (req, res) => {
    try {
      const saved =
        saveBotSettings(
          req.body || {}
        );

      return res.json({
        success: true,
        settings: saved
      });
    } catch (error) {
      console.error(
        '❌ Sauvegarde paramètres :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de sauvegarder les paramètres.'
        });
    }
  }
);


// ============================================================
// API SAUVEGARDES / RESTAURATION
// ============================================================

router.get(
  '/api/backups',
  requireAuth,
  (req, res) => {
    try {
      return res.json({
        snapshots:
          listFullSnapshots(),
        maxSnapshots:
          MAX_FULL_SNAPSHOTS
      });
    } catch (error) {
      console.error(
        '❌ Liste sauvegardes :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de lire les sauvegardes.'
        });
    }
  }
);

router.get(
  '/api/backups/status',
  requireAuth,
  (req, res) => {
    try {
      const snapshots =
        listFullSnapshots();

      const space = storageSpaceInfo();
      const probe = storageWriteProbe();

      return res.json({
        dataDir:
          DATA_DIR,
        persistentConfigured:
          !samePath(DATA_DIR, APP_DIR),
        writable:
          probe.writable,
        writeErrorCode:
          probe.errorCode || null,
        persistenceStrict:
          PERSISTENCE_STRICT,
        railwayVolumeMountPath:
          process.env.RAILWAY_VOLUME_MOUNT_PATH ||
          null,
        storageMode:
          COMPACT_STORAGE_MODE ? 'compact' : 'standard',
        totalBytes:
          space?.totalBytes ?? null,
        freeBytes:
          space?.freeBytes ?? null,
        usedBytes:
          space?.usedBytes ?? null,
        backupDirectory:
          BACKUPS_DIR,
        snapshotCount:
          snapshots.length,
        lastSnapshot:
          snapshots[0] || null,
        maxSnapshots:
          MAX_FULL_SNAPSHOTS,
        jsonBackupLimit:
          MAX_JSON_BACKUPS_PER_FILE
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            'Impossible de vérifier les sauvegardes.'
        });
    }
  }
);

router.post(
  '/api/backups',
  requireAuth,
  (req, res) => {
    try {
      const snapshot =
        createFullSnapshot(
          safeString(
            req.body?.reason
          ) ||
          'manual'
        );

      return res
        .status(201)
        .json({
          success:
            true,
          snapshot
        });
    } catch (error) {
      console.error(
        '❌ Création sauvegarde :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible de créer la sauvegarde.'
        });
    }
  }
);

router.post(
  '/api/backups/:id/restore',
  requireAuth,
  (req, res) => {
    try {
      const restored =
        restoreFullSnapshot(
          req.params.id
        );

      return res.json({
        success:
          true,
        restored
      });
    } catch (error) {
      console.error(
        '❌ Restauration sauvegarde :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible de restaurer la sauvegarde.'
        });
    }
  }
);

router.get(
  '/api/export-data',
  requireAuth,
  (req, res) => {
    try {
      const data =
        createExternalDataExport();

      const filename =
        `mondeco-data-${timestampId()}.json`;

      res.setHeader(
        'Content-Type',
        'application/json; charset=utf-8'
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );

      return res.send(
        JSON.stringify(
          data,
          null,
          2
        )
      );
    } catch (error) {
      console.error(
        '❌ Export données :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d\u2019exporter les données.'
        });
    }
  }
);


// ============================================================
// API RÉPONSES RAPIDES COMMERCIALES
// ============================================================

router.get(
  '/api/quick-replies',
  requireAuth,
  (req, res) => {
    // V6.33.1 : uniquement les réponses réellement enregistrées dans
    // /data/quick-replies.json. Le catalogue WooCommerce/Produits n'est plus
    // transformé automatiquement en commandes /nom-produit.
    return res.json(
      loadQuickReplies()
        .sort(
          (a, b) =>
            safeString(a.title)
              .localeCompare(
                safeString(b.title),
                'fr'
              )
        )
    );
  }
);

router.post(
  '/api/quick-replies',
  requireAuth,
  (req, res) => {
    const title =
      safeString(req.body?.title);

    const content =
      safeString(req.body?.content);

    const shortcut =
      normalizeQuickReplyShortcut(
        req.body?.shortcut ||
        title
      );

    if (!title || !content) {
      return res
        .status(400)
        .json({
          error:
            'Le titre et la réponse sont obligatoires.'
        });
    }

    const items =
      loadQuickReplies();

    if (
      shortcut &&
      items.some(
        item =>
          item.shortcut === shortcut
      )
    ) {
      return res
        .status(409)
        .json({
          error:
            `Le raccourci /${shortcut} existe déjà.`
        });
    }

    const now =
      new Date().toISOString();

    const item = {
      id: crypto.randomUUID(),
      title,
      shortcut,
      content,
      active: true,
      source: 'manual',
      createdAt: now,
      updatedAt: now
    };

    items.push(item);
    saveQuickReplies(items);

    return res
      .status(201)
      .json(item);
  }
);


// Import massif de réponses manuelles (CSV/TXT analysé côté interface).
router.post(
  '/api/quick-replies/import',
  requireAuth,
  (req, res) => {
    const incoming = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
    if (!incoming.length) {
      return res.status(400).json({ error: 'Aucune réponse à importer.' });
    }

    const items = loadQuickReplies();
    const usedShortcuts = new Set(
      items.map(item => normalizeQuickReplyShortcut(item?.shortcut)).filter(Boolean)
    );
    let imported = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    for (const raw of incoming) {
      const title = safeString(raw?.title);
      const content = safeString(raw?.content);
      const shortcut = normalizeQuickReplyShortcut(raw?.shortcut || title);
      if (!title || !content || !shortcut || usedShortcuts.has(shortcut)) {
        skipped += 1;
        continue;
      }
      items.push({
        id: crypto.randomUUID(),
        title,
        shortcut,
        content,
        active: true,
        source: 'manual-import',
        createdAt: now,
        updatedAt: now
      });
      usedShortcuts.add(shortcut);
      imported += 1;
    }

    if (imported) saveQuickReplies(items);
    return res.json({ success: true, imported, skipped, total: items.length });
  }
);

router.put(
  '/api/quick-replies/:id',
  requireAuth,
  (req, res) => {
    const items =
      loadQuickReplies();

    const index =
      items.findIndex(
        item =>
          item.id === req.params.id
      );

    if (index === -1) {
      return res
        .status(404)
        .json({
          error:
            'Réponse rapide introuvable.'
        });
    }

    const title =
      safeString(
        req.body?.title ??
        items[index].title
      );

    const content =
      safeString(
        req.body?.content ??
        items[index].content
      );

    const shortcut =
      normalizeQuickReplyShortcut(
        req.body?.shortcut ??
        items[index].shortcut
      );

    if (!title || !content) {
      return res
        .status(400)
        .json({
          error:
            'Le titre et la réponse sont obligatoires.'
        });
    }

    if (
      items.some(
        item =>
          item.id !== req.params.id &&
          shortcut &&
          item.shortcut === shortcut
      )
    ) {
      return res
        .status(409)
        .json({
          error:
            `Le raccourci /${shortcut} existe déjà.`
        });
    }

    items[index] = {
      ...items[index],
      title,
      content,
      shortcut,
      active:
        req.body?.active ??
        items[index].active,
      updatedAt:
        new Date().toISOString()
    };

    saveQuickReplies(items);

    return res.json(
      items[index]
    );
  }
);

router.delete(
  '/api/quick-replies/:id',
  requireAuth,
  (req, res) => {
    const items =
      loadQuickReplies();

    const next =
      items.filter(
        item =>
          item.id !== req.params.id
      );

    if (next.length === items.length) {
      return res
        .status(404)
        .json({
          error:
            'Réponse rapide introuvable.'
        });
    }

    saveQuickReplies(next);

    return res.json({
      success: true
    });
  }
);

// ============================================================
// API CORRECTIONS COMMERCIALES
// ============================================================

router.get(
  '/api/commercial-corrections',
  requireAuth,
  (req, res) => {
    const corrections =
      loadCommercialCorrections()
        .sort(
          (a, b) =>
            new Date(b.createdAt || 0) -
            new Date(a.createdAt || 0)
        );

    return res.json(corrections);
  }
);

router.post(
  '/api/commercial-corrections',
  requireAuth,
  (req, res) => {
    try {
      const commercialReply =
        safeString(
          req.body?.commercialReply
        );

      if (!commercialReply) {
        return res
          .status(400)
          .json({
            error:
              'La réponse commerciale est obligatoire.'
          });
      }

      const correction =
        createCommercialCorrectionCandidate({
          phone:
            req.body?.phone,
          question:
            req.body?.question,
          commercialReply,
          source:
            safeString(req.body?.source) ||
            'admin_manual'
        });

      return res
        .status(201)
        .json(correction);
    } catch (error) {
      console.error(
        '❌ Création correction commerciale :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’enregistrer la correction.'
        });
    }
  }
);

router.post(
  '/api/commercial-corrections/manual-knowledge',
  requireAuth,
  (req, res) => {
    try {
      const title =
        safeString(req.body?.title);

      const content =
        safeString(req.body?.content);

      const question =
        safeString(req.body?.question);

      if (!title || !content) {
        return res
          .status(400)
          .json({
            error:
              'Le titre et l’information validée sont obligatoires.'
          });
      }

      const instructions =
        loadInstructions();

      const fingerprint =
        instructionFingerprint(
          title,
          content
        );

      const existing =
        instructions.find(item =>
          instructionFingerprint(
            item.title,
            item.content
          ) === fingerprint
        );

      const now =
        new Date().toISOString();

      let instruction = existing;

      if (!instruction) {
        instruction = {
          id: crypto.randomUUID(),
          title,
          content,
          active: true,
          source:
            'commercial-manual',
          createdAt: now,
          updatedAt: now
        };

        instructions.push(
          instruction
        );

        saveInstructions(
          instructions
        );
      }

      const corrections =
        loadCommercialCorrections();

      const correction = {
        id: crypto.randomUUID(),
        type: 'knowledge',
        status: 'approved',
        phone:
          normalizePhone(req.body?.phone),
        question,
        commercialReply:
          content,
        source:
          'admin_manual_knowledge',
        createdAt: now,
        updatedAt: now,
        reviewedAt: now,
        instructionId:
          instruction.id
      };

      corrections.push(correction);
      saveCommercialCorrections(
        corrections
      );

      return res
        .status(201)
        .json({
          correction,
          instruction,
          duplicate:
            Boolean(existing)
        });
    } catch (error) {
      console.error(
        '❌ Ajout connaissance commerciale :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’ajouter cette information aux connaissances.'
        });
    }
  }
);

router.post(
  '/api/commercial-corrections/:id/approve-instruction',
  requireAuth,
  (req, res) => {
    try {
      const corrections =
        loadCommercialCorrections();

      const correctionIndex =
        corrections.findIndex(
          item =>
            item.id === req.params.id
        );

      if (correctionIndex === -1) {
        return res
          .status(404)
          .json({
            error:
              'Correction introuvable.'
          });
      }

      const correction =
        corrections[correctionIndex];

      const defaultTitle =
        correction.question
          ? `Correction commerciale — ${safeString(correction.question).slice(0, 90)}`
          : 'Information validée par un commercial';

      const title =
        safeString(req.body?.title) ||
        defaultTitle;

      const content =
        safeString(req.body?.content) ||
        safeString(
          correction.commercialReply
        );

      if (!content) {
        return res
          .status(400)
          .json({
            error:
              'L’information à apprendre est vide.'
          });
      }

      const instructions =
        loadInstructions();

      const fingerprint =
        instructionFingerprint(
          title,
          content
        );

      let instruction =
        instructions.find(item =>
          instructionFingerprint(
            item.title,
            item.content
          ) === fingerprint
        );

      const duplicate =
        Boolean(instruction);

      const now =
        new Date().toISOString();

      if (!instruction) {
        instruction = {
          id: crypto.randomUUID(),
          title,
          content,
          active: true,
          source:
            'commercial-correction',
          correctionId:
            correction.id,
          createdAt: now,
          updatedAt: now
        };

        instructions.push(
          instruction
        );

        saveInstructions(
          instructions
        );
      }

      corrections[correctionIndex] = {
        ...correction,
        status: 'approved',
        reviewedAt: now,
        updatedAt: now,
        instructionId:
          instruction.id,
        approvedTitle:
          title,
        approvedContent:
          content
      };

      saveCommercialCorrections(
        corrections
      );

      return res.json({
        correction:
          corrections[correctionIndex],
        instruction,
        duplicate
      });
    } catch (error) {
      console.error(
        '❌ Validation correction commerciale :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de valider cette correction.'
        });
    }
  }
);

router.post(
  '/api/commercial-corrections/:id/ignore',
  requireAuth,
  (req, res) => {
    const updated =
      updateCommercialCorrection(
        req.params.id,
        current => ({
          ...current,
          status: 'ignored',
          reviewedAt:
            new Date().toISOString()
        })
      );

    if (!updated) {
      return res
        .status(404)
        .json({
          error:
            'Correction introuvable.'
        });
    }

    return res.json(updated);
  }
);

router.post(
  '/api/commercial-corrections/product',
  requireAuth,
  (req, res) => {
    try {
      const productId =
        safeString(req.body?.productId);

      const field =
        safeString(req.body?.field);

      let value =
        safeString(req.body?.value);

      if (!productId) {
        return res
          .status(400)
          .json({
            error:
              'Sélectionnez un produit.'
          });
      }

      if (!COMMERCIAL_PRODUCT_FIELDS[field]) {
        return res
          .status(400)
          .json({
            error:
              'Champ produit non autorisé.'
          });
      }

      if (field === 'availability') {
        value =
          normalizeAvailabilityCorrection(
            value
          );

        const allowed =
          new Set([
            'in_stock',
            'on_order',
            'out_of_stock',
            'clearance',
            'unknown'
          ]);

        if (!allowed.has(value)) {
          return res
            .status(400)
            .json({
              error:
                'Disponibilité invalide. Utilisez : En stock, Sur commande, Rupture, Déstockage ou À confirmer.'
            });
        }
      }

      const products =
        loadProducts();

      const index =
        products.findIndex(
          item => item.id === productId
        );

      if (index === -1) {
        return res
          .status(404)
          .json({
            error:
              'Produit introuvable.'
          });
      }

      const product =
        products[index];

      const oldValue =
        safeString(product[field]);

      products[index] = {
        ...product,
        [field]: value,
        updatedAt:
          new Date().toISOString()
      };

      saveProducts(products);

      const now =
        new Date().toISOString();

      const corrections =
        loadCommercialCorrections();

      const correction = {
        id: crypto.randomUUID(),
        type: 'product',
        status: 'approved',
        phone: '',
        question:
          safeString(req.body?.question),
        commercialReply:
          `${COMMERCIAL_PRODUCT_FIELDS[field]} : ${value || '(vide)'}`,
        source:
          'admin_product_correction',
        productId,
        productName:
          safeString(product.name),
        productField:
          field,
        oldValue,
        newValue:
          value,
        note:
          safeString(req.body?.note),
        createdAt: now,
        updatedAt: now,
        reviewedAt: now,
        instructionId: null
      };

      corrections.push(correction);
      saveCommercialCorrections(
        corrections
      );

      return res.json({
        correction,
        product:
          products[index]
      });
    } catch (error) {
      console.error(
        '❌ Correction fiche produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de corriger la fiche produit.'
        });
    }
  }
);

// ============================================================
// DISCUSSION DE TEST
// ============================================================

let chatHandler = null;
let imageChatHandler = null;
let commercialSendHandler = null;
let whatsappCallHandler = null;

function setChatHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error(
      'setChatHandler attend une fonction.'
    );
  }

  chatHandler = fn;
}

function setImageChatHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error(
      'setImageChatHandler attend une fonction.'
    );
  }

  imageChatHandler = fn;
}

function setCommercialSendHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error(
      'setCommercialSendHandler attend une fonction.'
    );
  }

  commercialSendHandler = fn;
}

function setWhatsAppCallHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error(
      'setWhatsAppCallHandler attend une fonction.'
    );
  }

  whatsappCallHandler = fn;
}


// ============================================================
// APPELS WHATSAPP — signalisation WebRTC via Cloud Calling API
// ============================================================

router.post(
  '/api/whatsapp/calls/start',
  requireAuth,
  async (req, res) => {
    try {
      if (!whatsappCallHandler) {
        return res.status(503).json({
          error: 'WhatsApp Calling API n’est pas encore connecté.'
        });
      }

      const contact = safeString(req.body?.contact || req.body?.phone);
      if (!requireCommercialMessageChannelAccess(req, res, 'whatsapp')) return;
      const externalContact = safeString(req.body?.externalContact) || normalizePhone(contact);
      const phone = normalizePhone(externalContact);
      const sdp = safeString(req.body?.sdp);

      if (!phone) {
        return res.status(400).json({ error: 'Numéro WhatsApp client obligatoire.' });
      }

      if (!sdp || !sdp.startsWith('v=0')) {
        return res.status(400).json({ error: 'Session audio WebRTC invalide.' });
      }

      const result = await whatsappCallHandler({
        action: 'start',
        phone,
        contact,
        externalContact,
        sdp,
        actor: {
          id: safeString(req.user?.id),
          name: safeString(req.user?.name),
          email: safeString(req.user?.email),
          role: safeString(req.user?.role)
        }
      });

      return res.json({ success: true, ...(result || {}) });
    } catch (error) {
      console.error('❌ Démarrage appel WhatsApp :', error);
      return res.status(500).json({
        error: error?.message || 'Impossible de démarrer l’appel WhatsApp.'
      });
    }
  }
);

router.get(
  '/api/whatsapp/calls/:callId',
  requireAuth,
  async (req, res) => {
    try {
      if (!whatsappCallHandler) {
        return res.status(503).json({
          error: 'WhatsApp Calling API n’est pas encore connecté.'
        });
      }

      const result = await whatsappCallHandler({
        action: 'status',
        callId: safeString(req.params?.callId),
        actor: {
          id: safeString(req.user?.id),
          role: safeString(req.user?.role)
        }
      });

      return res.json({ success: true, ...(result || {}) });
    } catch (error) {
      return res.status(500).json({
        error: error?.message || 'Impossible de lire l’état de l’appel WhatsApp.'
      });
    }
  }
);

router.post(
  '/api/whatsapp/calls/:callId/terminate',
  requireAuth,
  async (req, res) => {
    try {
      if (!whatsappCallHandler) {
        return res.status(503).json({
          error: 'WhatsApp Calling API n’est pas encore connecté.'
        });
      }

      const result = await whatsappCallHandler({
        action: 'terminate',
        callId: safeString(req.params?.callId),
        actor: {
          id: safeString(req.user?.id),
          role: safeString(req.user?.role)
        }
      });

      return res.json({ success: true, ...(result || {}) });
    } catch (error) {
      return res.status(500).json({
        error: error?.message || 'Impossible de terminer l’appel WhatsApp.'
      });
    }
  }
);

router.post(
  '/api/commercial/send',
  requireAuth,
  async (req, res) => {
    try {
      if (!commercialSendHandler) {
        return res
          .status(503)
          .json({
            error:
              'L’envoi commercial omnicanal n’est pas encore connecté.'
          });
      }

      const contact =
        safeString(
          req.body?.contact ||
          req.body?.phone
        );

      const requestedChannel =
        safeString(
          req.body?.channel
        ).toLowerCase();

      const channel =
        requestedChannel === 'facebook' || contact.startsWith('facebook:')
          ? 'facebook'
          : requestedChannel === 'instagram' || contact.startsWith('instagram:')
            ? 'instagram'
            : 'whatsapp';

      if (!acquireCommercialConversationReply(req, res, contact, channel)) return;

      const externalContact =
        safeString(
          req.body?.externalContact
        ) ||
        (channel === 'instagram'
          ? contact.replace(/^instagram:/, '')
          : channel === 'facebook'
            ? contact.replace(/^facebook:/, '')
            : normalizePhone(contact));

      const phone =
        channel === 'whatsapp'
          ? normalizePhone(externalContact)
          : '';

      const text =
        safeString(req.body?.text);

      const question =
        safeString(req.body?.question);

      if (!externalContact) {
        return res
          .status(400)
          .json({
            error:
              'Contact client obligatoire.'
          });
      }

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              'Réponse commerciale obligatoire.'
          });
      }

      const result =
        await commercialSendHandler({
          phone,
          contact,
          channel,
          externalContact,
          text,
          question,
          actor: {
            id:
              safeString(
                req.user?.id
              ),
            name:
              safeString(
                req.user?.name
              ),
            email:
              safeString(
                req.user?.email
              ),
            role:
              safeString(
                req.user?.role
              )
          }
        });

      // V6.33.1 — une réponse envoyée avec succès remet aussi le petit badge
      // non-lu de la ligne client à zéro, de façon persistante.
      updateConversationStateAdmin(contact, current => ({
        ...current,
        unreadCount: 0,
        lastUnreadMessageId: '',
        lastReadAt: new Date().toISOString()
      }));
      markNotificationsReadForContact(contact, req.user);

      return res.json({
        success: true,
        ...(
          result &&
          typeof result === 'object'
            ? result
            : {}
        )
      });
    } catch (error) {
      console.error(
        '❌ Envoi commercial depuis Admin :',
        error
      );

      const statusCode = Number(error?.statusCode || 500);
      return res
        .status(Number.isFinite(statusCode) ? statusCode : 500)
        .json({
          error:
            error.message ||
            'Impossible d’envoyer le message commercial.',
          errorCode: safeString(error?.code),
          channel: safeString(error?.channel)
        });
    }
  }
);


router.post(
  '/api/commercial/send-media',
  requireAuth,
  uploadCommercialMedia,
  async (req, res) => {
    try {
      if (!commercialSendHandler) {
        return res
          .status(503)
          .json({
            error:
              'L’envoi commercial omnicanal n’est pas encore connecté.'
          });
      }

      const contact =
        safeString(
          req.body?.contact ||
          req.body?.phone
        );

      const requestedChannel =
        safeString(
          req.body?.channel
        ).toLowerCase();

      const channel =
        requestedChannel === 'facebook' || contact.startsWith('facebook:')
          ? 'facebook'
          : requestedChannel === 'instagram' || contact.startsWith('instagram:')
            ? 'instagram'
            : 'whatsapp';

      if (!acquireCommercialConversationReply(req, res, contact, channel)) return;

      const externalContact =
        safeString(
          req.body?.externalContact
        ) ||
        (channel === 'instagram'
          ? contact.replace(/^instagram:/, '')
          : channel === 'facebook'
            ? contact.replace(/^facebook:/, '')
            : normalizePhone(contact));

      if (channel === 'facebook') {
        return res
          .status(400)
          .json({
            error:
              'Facebook Messenger accepte maintenant les réponses commerciales texte dans MONDECO. Les pièces jointes Facebook ne sont pas encore activées dans cette version.'
          });
      }

      if (channel === 'instagram') {
        return res
          .status(400)
          .json({
            error:
              'Pour Instagram, utilisez pour le moment une réponse texte. Les pièces jointes seront ajoutées dans une prochaine version.'
          });
      }

      const phone =
        normalizePhone(externalContact);

      const text =
        safeString(req.body?.text);

      const question =
        safeString(req.body?.question);

      if (!phone) {
        return res
          .status(400)
          .json({
            error:
              'Numéro client obligatoire.'
          });
      }

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              'Ajoutez une photo, un document ou un message vocal.'
          });
      }

      const mediaKind =
        req.file.mimetype.startsWith('image/')
          ? 'image'
          : req.file.mimetype.startsWith('audio/')
            ? 'audio'
            : 'document';

      const result =
        await commercialSendHandler({
          phone,
          contact,
          channel,
          externalContact,
          text,
          question,
          mediaKind,
          actor: {
            id:
              safeString(
                req.user?.id
              ),
            name:
              safeString(
                req.user?.name
              ),
            email:
              safeString(
                req.user?.email
              ),
            role:
              safeString(
                req.user?.role
              )
          },
          file: {
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            originalname: req.file.originalname,
            size: req.file.size
          }
        });

      // V6.33.1 — même acquittement pour les médias WhatsApp.
      updateConversationStateAdmin(contact, current => ({
        ...current,
        unreadCount: 0,
        lastUnreadMessageId: '',
        lastReadAt: new Date().toISOString()
      }));
      markNotificationsReadForContact(contact, req.user);

      return res.json({
        success: true,
        ...(result && typeof result === 'object' ? result : {})
      });
    } catch (error) {
      console.error(
        '❌ Envoi média commercial :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible d’envoyer le fichier au client.'
        });
    }
  }
);

router.post(
  '/api/test-chat',
  requireAuth,
  async (req, res) => {
    try {
      if (!chatHandler) {
        return res
          .status(503)
          .json({
            error:
              'Le bot IA n\u2019est pas encore connecté.'
          });
      }

      const message =
        safeString(req.body?.message);

      if (!message) {
        return res
          .status(400)
          .json({
            error: 'Message vide.'
          });
      }

      const reply =
        await chatHandler(
          'admin-test-session',
          message
        );

      return res.json({ reply });
    } catch (error) {
      console.error(
        '❌ Test chat texte :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Erreur pendant la réponse IA.'
        });
    }
  }
);

router.post(
  '/api/test-chat-image',
  requireAuth,
  uploadTestImage,
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              'Ajoutez une image à analyser.'
          });
      }

      const mode =
        safeString(req.body?.mode) ||
        'analysis';

      const message =
        safeString(req.body?.message) ||
        'Analyse cette image et explique ce que tu vois.';

      if (!imageChatHandler) {
        return res
          .status(503)
          .json({
            error:
              'L\u2019analyse d\u2019image IA n\u2019est pas encore connectée.'
          });
      }

      const reply =
        await imageChatHandler(
          'admin-test-session',
          message,
          {
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            originalname: req.file.originalname,
            size: req.file.size
          },
          mode
        );

      return res.json({
        reply,
        action:
          mode === 'whatsapp'
            ? 'secure_image_simulation'
            : 'vision_analysis'
      });
    } catch (error) {
      console.error(
        '❌ Test chat image :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Erreur pendant l\u2019analyse de l\u2019image.'
        });
    }
  }
);

// ============================================================
// PERSONNALISATION
// ============================================================

let customizationHandler = null;

function setCustomizationHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error(
      'setCustomizationHandler attend une fonction.'
    );
  }

  customizationHandler = fn;
}

function buildCustomizationWarnings(product, request) {
  const warnings = [];

  if (!product) {
    warnings.push(
      'Image libre : identification, prix et faisabilité à confirmer par un commercial.'
    );

    return warnings;
  }

  if (
    request.color &&
    product.customizableColor !== true
  ) {
    warnings.push(
      'Le changement de couleur n\u2019est pas confirmé comme option catalogue.'
    );
  }

  if (
    request.fabric &&
    product.customizableFabric !== true
  ) {
    warnings.push(
      'Le changement de tissu n\u2019est pas confirmé comme option catalogue.'
    );
  }

  if (
    request.dimensions &&
    product.customizableDimensions !== true
  ) {
    warnings.push(
      'Le changement de dimensions doit être validé par un commercial.'
    );
  }

  if (
    request.corner &&
    product.customizableCorner !== true
  ) {
    warnings.push(
      'Le changement de coin/orientation doit être validé par un commercial.'
    );
  }

  return warnings;
}

router.get(
  '/api/customizations',
  requireAuth,
  (req, res) => {
    const items =
      loadCustomizations()
        .sort(
          (a, b) =>
            new Date(b.createdAt || 0) -
            new Date(a.createdAt || 0)
        );

    return res.json(items);
  }
);

router.post(
  '/api/customizations/generate',
  requireAuth,
  uploadCustomizationImage,
  async (req, res) => {
    try {
      if (!customizationHandler) {
        return res
          .status(503)
          .json({
            error:
              'Le moteur de simulation visuelle n\u2019est pas connecté.'
          });
      }

      const products = loadProducts();

      const productId =
        safeString(req.body?.productId);

      const product =
        productId
          ? products.find(
              item => item.id === productId
            )
          : null;

      if (productId && !product) {
        return res
          .status(404)
          .json({
            error:
              'Produit sélectionné introuvable.'
          });
      }

      const request = {
        customerName:
          safeString(req.body?.customerName),

        customerPhone:
          safeString(req.body?.customerPhone),

        color:
          safeString(req.body?.color),

        fabric:
          safeString(req.body?.fabric),

        dimensions:
          safeString(req.body?.dimensions),

        corner:
          safeString(req.body?.corner),

        notes:
          safeString(req.body?.notes)
      };

      const hasModification =
        Boolean(
          request.color ||
          request.fabric ||
          request.dimensions ||
          request.corner ||
          request.notes
        );

      if (!hasModification) {
        return res
          .status(400)
          .json({
            error:
              'Indiquez au moins une modification à simuler.'
          });
      }

      let sourceImage = null;
      let sourceImageUrl = '';

      if (req.file) {
        sourceImage = {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname:
            req.file.originalname ||
            'reference.jpg',
          size: req.file.size
        };
      } else if (product) {
        const localPath =
          getLocalProductImagePath(product);

        if (
          !localPath ||
          !fs.existsSync(localPath)
        ) {
          return res
            .status(400)
            .json({
              error:
                'La photo du produit est introuvable. Ajoutez une image de référence.'
            });
        }

        sourceImage = {
          buffer:
            fs.readFileSync(localPath),

          mimetype:
            mimeTypeFromPath(localPath),

          originalname:
            path.basename(localPath),

          size:
            fs.statSync(localPath).size
        };

        sourceImageUrl =
          safeString(product.image);
      }

      if (!sourceImage) {
        return res
          .status(400)
          .json({
            error:
              'Sélectionnez un produit avec photo ou ajoutez une image de référence.'
          });
      }

      function outputDimension(value, fallback) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
          return fallback;
        }

        return Math.max(
          256,
          Math.min(
            1920,
            Math.round(number)
          )
        );
      }

      const simulation =
        await customizationHandler({
          product,
          request,
          sourceImage,

          outputWidth:
            outputDimension(
              req.body?.outputWidth,
              1024
            ),

          outputHeight:
            outputDimension(
              req.body?.outputHeight,
              768
            )
        });

      if (!simulation?.imageBuffer) {
        throw new Error(
          'Le moteur image n\u2019a retourné aucune simulation.'
        );
      }

      const id =
        crypto.randomUUID();

      const now =
        new Date().toISOString();

      let sourceFilename = '';

      if (req.file) {
        sourceFilename =
          `custom-source-${Date.now()}-${id}` +
          extensionFromMimeType(
            sourceImage.mimetype
          );

        fs.writeFileSync(
          path.join(
            CUSTOMIZATIONS_DIR,
            sourceFilename
          ),
          sourceImage.buffer
        );

        sourceImageUrl =
          `/admin/customizations/${sourceFilename}`;
      }

      const resultFilename =
        `custom-result-${Date.now()}-${id}` +
        extensionFromMimeType(
          simulation.mimeType ||
          'image/jpeg'
        );

      fs.writeFileSync(
        path.join(
          CUSTOMIZATIONS_DIR,
          resultFilename
        ),
        simulation.imageBuffer
      );

      const item = {
        id,

        productId:
          product?.id || '',

        productName:
          safeString(product?.name) ||
          'Image libre',

        customerName:
          request.customerName,

        customerPhone:
          request.customerPhone,

        request,

        warnings:
          buildCustomizationWarnings(
            product,
            request
          ),

        analysis:
          safeString(simulation.analysis),

        sourceImage:
          sourceImageUrl,

        sourceFilename,

        resultImage:
          `/admin/customizations/${resultFilename}`,

        resultFilename,

        status:
          'simulation_generated',

        requiresCommercialValidation:
          true,

        createdAt: now,
        updatedAt: now
      };

      const items = loadCustomizations();
      items.push(item);
      saveCustomizations(items);

      return res
        .status(201)
        .json(item);
    } catch (error) {
      console.error(
        '❌ Personnalisation :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible de générer la simulation.'
        });
    }
  }
);

router.put(
  '/api/customizations/:id/status',
  requireAuth,
  (req, res) => {
    try {
      const allowed =
        new Set([
          'simulation_generated',
          'awaiting_validation',
          'approved',
          'sent_to_client',
          'rejected'
        ]);

      const status =
        safeString(req.body?.status);

      if (!allowed.has(status)) {
        return res
          .status(400)
          .json({
            error:
              'Statut non valide.'
          });
      }

      const items =
        loadCustomizations();

      const index =
        items.findIndex(
          item => item.id === req.params.id
        );

      if (index === -1) {
        return res
          .status(404)
          .json({
            error:
              'Demande introuvable.'
          });
      }

      items[index] = {
        ...items[index],
        status,
        updatedAt:
          new Date().toISOString()
      };

      saveCustomizations(items);

      return res.json(
        items[index]
      );
    } catch (error) {
      console.error(
        '❌ Statut personnalisation :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de modifier le statut.'
        });
    }
  }
);

router.delete(
  '/api/customizations/:id',
  requireAuth,
  (req, res) => {
    try {
      const items =
        loadCustomizations();

      const item =
        items.find(
          entry =>
            entry.id === req.params.id
        );

      if (!item) {
        return res
          .status(404)
          .json({
            error:
              'Demande introuvable.'
          });
      }

      saveCustomizations(
        items.filter(
          entry =>
            entry.id !== req.params.id
        )
      );

      if (item.resultFilename) {
        archiveFileBeforeDelete(
          path.join(
            CUSTOMIZATIONS_DIR,
            path.basename(
              item.resultFilename
            )
          ),
          'customization-images'
        );
      }

      if (item.sourceFilename) {
        archiveFileBeforeDelete(
          path.join(
            CUSTOMIZATIONS_DIR,
            path.basename(
              item.sourceFilename
            )
          ),
          'customization-images'
        );
      }

      return res.json({
        success: true
      });
    } catch (error) {
      console.error(
        '❌ Suppression personnalisation :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer la demande.'
        });
    }
  }
);

// ============================================================
// API CONVERSATIONS WHATSAPP (lecture seule)
// ============================================================

function conversationLogDedupeKey(entry) {
  const messageId =
    safeString(entry?.message_id) ||
    safeString(entry?.meta_message_id);

  if (messageId) {
    return `mid:${messageId}`;
  }

  return [
    'fallback',
    safeString(entry?.contact),
    safeString(entry?.time),
    safeString(entry?.incoming),
    safeString(entry?.reply),
    safeString(entry?.type)
  ].join('|');
}

function conversationEntryMessageIds(entry) {
  return [...new Set([
    safeString(entry?.message_id),
    safeString(entry?.meta_message_id)
  ].filter(Boolean))];
}

function conversationTimeMs(value) {
  const raw = safeString(value);
  if (!raw) return Number.NaN;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    let numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      if (numeric < 1e12) numeric *= 1000;
      return numeric;
    }
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizedConversationTime(entry) {
  const candidates = [
    entry?.meta_created_time,
    entry?.event_time,
    entry?.created_time,
    entry?.time,
    entry?.timestamp
  ];

  for (const candidate of candidates) {
    const ms = conversationTimeMs(candidate);
    if (Number.isFinite(ms)) return ms;
  }

  return 0;
}

function conversationEntryComparator(a, b) {
  const aMs = normalizedConversationTime(a);
  const bMs = normalizedConversationTime(b);
  if (aMs !== bMs) return aMs - bMs;

  // À heure égale : message client avant réponse, puis événements système.
  const rank = entry => {
    if (safeString(entry?.incoming)) return 0;
    if (safeString(entry?.reply)) return 1;
    return 2;
  };
  const rankDiff = rank(a) - rank(b);
  if (rankDiff) return rankDiff;

  return safeString(a?.message_id || a?.meta_message_id)
    .localeCompare(safeString(b?.message_id || b?.meta_message_id));
}

function authoritativeConversationTime(entry) {
  const candidates = [
    safeString(entry?.meta_created_time),
    safeString(entry?.event_time),
    entry?.history_import === true ? safeString(entry?.time) : ''
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (Number.isFinite(conversationTimeMs(candidate))) return candidate;
  }
  return '';
}

function mergeConversationLogEntries(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  // Les champs temps provenant de l'API Meta sont prioritaires sur l'heure
  // locale de traitement d'un ancien webhook.
  const preferredTime =
    safeString(existing?.meta_created_time) ||
    safeString(incoming?.meta_created_time) ||
    safeString(existing?.event_time) ||
    safeString(incoming?.event_time) ||
    authoritativeConversationTime(existing) ||
    authoritativeConversationTime(incoming) ||
    safeString(incoming?.time) ||
    safeString(existing?.time);

  const existingAttachments = Array.isArray(existing?.attachments)
    ? existing.attachments.filter(Boolean)
    : [];
  const incomingAttachments = Array.isArray(incoming?.attachments)
    ? incoming.attachments.filter(Boolean)
    : [];
  const attachmentMap = new Map();
  for (const item of [...existingAttachments, ...incomingAttachments]) {
    const key = [safeString(item?.url), safeString(item?.filename), safeString(item?.metaAttachmentId)].join('|');
    if (!attachmentMap.has(key)) attachmentMap.set(key, item);
  }

  return {
    ...existing,
    ...incoming,
    time: preferredTime || safeString(incoming?.time || existing?.time),
    meta_created_time:
      safeString(existing?.meta_created_time || incoming?.meta_created_time) || undefined,
    event_time:
      safeString(incoming?.event_time || existing?.event_time) || undefined,
    attachments: attachmentMap.size
      ? [...attachmentMap.values()]
      : (incoming?.attachments || existing?.attachments)
  };
}

function normalizeInstagramThreadEntries(rawEntries) {
  const sourceEntries = Array.isArray(rawEntries) ? rawEntries.filter(Boolean) : [];
  if (!sourceEntries.length) return [];

  const isInstagram = sourceEntries.some(entry =>
    safeString(entry?.channel).toLowerCase() === 'instagram' ||
    safeString(entry?.contact).startsWith('instagram:')
  );
  if (!isInstagram) return [...sourceEntries].sort(conversationEntryComparator);

  // Index des heures exactes fournies par Meta pour chaque message_id.
  const exactTimeByMessageId = new Map();
  for (const entry of sourceEntries) {
    const primaryId = safeString(entry?.message_id);
    if (!primaryId) continue;
    const exact =
      safeString(entry?.meta_created_time) ||
      (entry?.history_import === true ? safeString(entry?.time) : '') ||
      safeString(entry?.event_time);
    if (exact && Number.isFinite(conversationTimeMs(exact))) {
      const current = exactTimeByMessageId.get(primaryId);
      if (!current || safeString(entry?.meta_created_time)) {
        exactTimeByMessageId.set(primaryId, exact);
      }
    }
  }

  const linkedOutboundIds = new Set();
  for (const entry of sourceEntries) {
    const inboundId = safeString(entry?.message_id);
    const outboundId = safeString(entry?.meta_message_id);
    if (
      safeString(entry?.incoming) &&
      safeString(entry?.reply) &&
      inboundId && outboundId && inboundId !== outboundId
    ) {
      linkedOutboundIds.add(outboundId);
    }
  }

  const expanded = [];
  for (const entry of sourceEntries) {
    const primaryId = safeString(entry?.message_id);

    // Si l'historique Meta contient séparément une réponse qui est déjà liée
    // à une entrée live (meta_message_id), on garde son heure comme ancre mais
    // on ne l'affiche pas une deuxième fois.
    if (
      entry?.history_import === true &&
      primaryId &&
      linkedOutboundIds.has(primaryId)
    ) {
      continue;
    }

    const inboundId = safeString(entry?.message_id);
    const outboundId = safeString(entry?.meta_message_id);
    const hasCombinedPair =
      safeString(entry?.incoming) &&
      safeString(entry?.reply) &&
      inboundId && outboundId && inboundId !== outboundId;

    if (!hasCombinedPair) {
      const exact = primaryId ? exactTimeByMessageId.get(primaryId) : '';
      expanded.push({
        ...entry,
        time: exact || safeString(entry?.event_time || entry?.meta_created_time || entry?.time)
      });
      continue;
    }

    const inboundTime =
      exactTimeByMessageId.get(inboundId) ||
      safeString(entry?.event_time || entry?.meta_created_time || entry?.time);

    const inboundMs = conversationTimeMs(inboundTime);
    const outboundTime =
      exactTimeByMessageId.get(outboundId) ||
      safeString(entry?.reply_time) ||
      (Number.isFinite(inboundMs)
        ? new Date(inboundMs + 1).toISOString()
        : safeString(entry?.time));

    expanded.push({
      ...entry,
      reply: '',
      reply_sent: false,
      meta_message_id: inboundId,
      linked_reply_message_id: outboundId,
      time: inboundTime,
      direction: 'incoming',
      sender_kind: 'client',
      _thread_split: 'incoming'
    });

    expanded.push({
      ...entry,
      incoming: '',
      message_id: outboundId,
      meta_message_id: outboundId,
      linked_incoming_message_id: inboundId,
      time: outboundTime,
      direction: 'outgoing',
      _thread_split: 'outgoing',
      image_reason: undefined,
      error: undefined
    });
  }

  const deduped = new Map();
  for (const entry of expanded) {
    const key = conversationLogDedupeKey(entry);
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, entry);
      continue;
    }
    // Préférer l'entrée riche/non historique pour l'affichage, tout en
    // conservant l'heure exacte déjà réconciliée.
    const currentScore = (current?.history_import ? 0 : 10) + (safeString(current?.incoming || current?.reply) ? 2 : 0);
    const entryScore = (entry?.history_import ? 0 : 10) + (safeString(entry?.incoming || entry?.reply) ? 2 : 0);
    const winner = entryScore >= currentScore ? entry : current;
    const loser = winner === entry ? current : entry;
    deduped.set(key, mergeConversationLogEntries(loser, winner));
  }

  return [...deduped.values()].sort(conversationEntryComparator);
}

let persistentConversationEventsCache = {
  stamp: 'v6.35-memory-safe',
  entries: []
};

function conversationEventsDirectoryStamp() {
  try {
    if (!fs.existsSync(CONVERSATION_EVENTS_DIR)) return 'missing';
    return fs
      .readdirSync(CONVERSATION_EVENTS_DIR)
      .filter(name => /^conversation-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .map(name => {
        const stat = fs.statSync(path.join(CONVERSATION_EVENTS_DIR, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('|');
  } catch {
    return 'error';
  }
}

function loadPersistentConversationEvents() {
  const cutoffAt = historyImportCutoffIso();
  const entries = [];
  for (const name of conversationEventFilesSince(cutoffAt)) {
    const filePath = path.join(CONVERSATION_EVENTS_DIR, name);
    forEachJsonlRecordSync(filePath, item => {
      const time = safeString(item?.time || item?.event_time || item?.meta_created_time || item?.created_time || item?.timestamp);
      if (!historyTimeIsRecent(time, cutoffAt)) return;
      entries.push(item);
    });
  }
  return entries;
}

function addConversationMessageIdsToSet(entry, target) {
  if (!entry || typeof entry !== 'object' || !target) return;
  for (const id of conversationEntryMessageIds(entry)) {
    if (id) target.add(id);
  }
}

function collectKnownConversationMessageIdsMemorySafe({ includeInstagram = true, includeFacebook = true } = {}) {
  const cutoffAt = historyImportCutoffIso();
  const ids = new Set();
  const add = entry => {
    const time = safeString(entry?.time || entry?.event_time || entry?.meta_created_time || entry?.created_time || entry?.timestamp);
    if (time && !historyTimeIsRecent(time, cutoffAt)) return;
    addConversationMessageIdsToSet(entry, ids);
  };

  if (includeInstagram) forEachJsonArrayObjectSync(INSTAGRAM_HISTORY_PATH, add);
  if (includeFacebook) forEachJsonArrayObjectSync(FACEBOOK_HISTORY_PATH, add);
  for (const name of conversationEventFilesSince(cutoffAt)) {
    forEachJsonlRecordSync(path.join(CONVERSATION_EVENTS_DIR, name), add);
  }
  forEachJsonArrayObjectSync(CONVERSATIONS_LOG_PATH, add);
  return ids;
}

function loadConversationMapFromJsonArrayMemorySafe(filePath) {
  const map = new Map();
  forEachJsonArrayObjectSync(filePath, entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    map.set(conversationLogDedupeKey(entry), entry);
  });
  return map;
}

function writeJsonArrayIterableAtomic(filePath, iterable) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeSync(fd, '[\n');
    let first = true;
    for (const item of iterable) {
      if (!first) fs.writeSync(fd, ',\n');
      fs.writeSync(fd, JSON.stringify(item));
      first = false;
    }
    fs.writeSync(fd, '\n]\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

let combinedConversationLogCache = {
  liveStamp: 'v6.35-memory-safe',
  historyStamp: '',
  facebookHistoryStamp: '',
  persistentStamp: '',
  entries: []
};

function fileChangeStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

// V6.35.0 — fusion mémoire-sûre de l'Inbox.
// On ne charge plus simultanément instagram-history.json, facebook-history.json,
// tous les JSONL puis conversation-log.json dans quatre grands tableaux.
// Chaque source est parcourue séquentiellement et fusionnée directement dans
// une seule Map dédupliquée, limitée à la fenêtre de rétention.
function loadWhatsAppLog() {
  const cutoffAt = historyImportCutoffIso();
  const merged = new Map();
  const mergeIfRecent = entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const time = safeString(entry?.time || entry?.event_time || entry?.meta_created_time || entry?.created_time || entry?.timestamp);
    if (!historyTimeIsRecent(time, cutoffAt)) return;
    const key = conversationLogDedupeKey(entry);
    merged.set(key, mergeConversationLogEntries(merged.get(key), entry));
  };

  // Les fichiers historiques sont des tableaux JSON potentiellement gros :
  // lecture objet par objet, jamais JSON.parse du fichier complet.
  forEachJsonArrayObjectSync(INSTAGRAM_HISTORY_PATH, mergeIfRecent);
  forEachJsonArrayObjectSync(FACEBOOK_HISTORY_PATH, mergeIfRecent);

  // Les événements persistants sont déjà partitionnés par jour.
  for (const name of conversationEventFilesSince(cutoffAt)) {
    forEachJsonlRecordSync(path.join(CONVERSATION_EVENTS_DIR, name), mergeIfRecent);
  }

  // Le cache live est plafonné à 5000 entrées, mais on le parcourt lui aussi
  // en streaming pour éviter un pic inutile au moment où l'Inbox s'ouvre.
  forEachJsonArrayObjectSync(CONVERSATIONS_LOG_PATH, mergeIfRecent);

  const entries = [];
  for (const entry of merged.values()) {
    const clean = applyConversationPurgeTombstones(entry);
    if (clean) entries.push(clean);
  }
  entries.sort(conversationEntryComparator);

  const memory = process.memoryUsage();
  const rssMb = Math.round(Number(memory.rss || 0) / 1024 / 1024);
  if (rssMb > 350) {
    console.warn(`⚠️ Inbox mémoire: RSS ${rssMb} MB | ${entries.length} événement(s) fusionné(s)`);
  }
  return entries;
}

function loadConversationStatesAdmin() {
  try {
    if (!fs.existsSync(CONVERSATION_STATE_PATH_ADMIN)) return {};
    const parsed = JSON.parse(
      fs.readFileSync(CONVERSATION_STATE_PATH_ADMIN, 'utf8') || '{}'
    );
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (error) {
    console.warn('⚠️ Lecture conversation-state.json :', error.message);
    return {};
  }
}


function saveConversationStatesAdmin(states) {
  writeJsonAtomic(
    CONVERSATION_STATE_PATH_ADMIN,
    states &&
    typeof states === 'object' &&
    !Array.isArray(states)
      ? states
      : {}
  );
}

function updateConversationStateAdmin(
  contact,
  updater
) {
  const states =
    loadConversationStatesAdmin();

  const current =
    states[contact] &&
    typeof states[contact] === 'object'
      ? states[contact]
      : {};

  const updated =
    updater({
      ...current
    }) || current;

  states[contact] =
    updated;

  saveConversationStatesAdmin(
    states
  );

  return updated;
}

// ============================================================
// V6.19.6 — NOTIFICATIONS PERSISTANTES
// ============================================================

function notificationUserKey(user) {
  return safeString(user?.id || user?.email || user?.role || 'admin');
}

function loadNotificationsStore() {
  try {
    if (!fs.existsSync(NOTIFICATIONS_PATH)) return { items: [] };
    const parsed = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8') || '{}');
    return {
      items: Array.isArray(parsed?.items) ? parsed.items : []
    };
  } catch (error) {
    console.warn('⚠️ Lecture notifications.json :', error.message);
    return { items: [] };
  }
}

function saveNotificationsStore(store) {
  writeJsonAtomic(NOTIFICATIONS_PATH, {
    items: Array.isArray(store?.items) ? store.items : []
  });
}

function notificationVisibleToUser(item, user, states = {}) {
  if (user?.role !== 'commercial') return true;
  const assignedId = safeString(states[item?.contact]?.assignedUserId);
  return assignedId && assignedId === safeString(user?.id);
}

function markNotificationsReadForContact(contact, user) {
  const key = notificationUserKey(user);
  const store = loadNotificationsStore();
  let changed = false;

  store.items = store.items.map(item => {
    if (safeString(item?.contact) !== safeString(contact)) return item;
    const readBy = Array.isArray(item?.readBy) ? [...item.readBy] : [];
    if (!readBy.includes(key)) {
      readBy.push(key);
      changed = true;
    }
    return { ...item, readBy };
  });

  if (changed) saveNotificationsStore(store);
}

// ============================================================
// V6.19.4 — SYNCHRONISATION HISTORIQUE INSTAGRAM
// ============================================================

let instagramHistorySyncJob = {
  running: false,
  startedAt: '',
  completedAt: '',
  totalConversations: 0,
  processedConversations: 0,
  importedConversations: 0,
  importedMessages: 0,
  skippedMessages: 0,
  errorCount: 0,
  lastError: ''
};

function loadInstagramHistorySyncState() {
  try {
    if (!fs.existsSync(INSTAGRAM_HISTORY_SYNC_STATE_PATH)) {
      return {};
    }

    const parsed = JSON.parse(
      fs.readFileSync(
        INSTAGRAM_HISTORY_SYNC_STATE_PATH,
        'utf8'
      ) || '{}'
    );

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function saveInstagramHistorySyncState(state) {
  writeJsonAtomic(
    INSTAGRAM_HISTORY_SYNC_STATE_PATH,
    state && typeof state === 'object'
      ? state
      : {}
  );
}

async function instagramGraphGet(url) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    throw new Error('INSTAGRAM_ACCESS_TOKEN manquant.');
  }

  const response = await fetch(
    url,
    {
      headers: {
        Authorization:
          `Bearer ${INSTAGRAM_ACCESS_TOKEN}`
      }
    }
  );

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      safeString(data?.error?.message) ||
      `Instagram HTTP ${response.status}`
    );
  }

  return data;
}

async function listAllInstagramConversations(onProgress = null, options = {}) {
  if (!INSTAGRAM_ACCOUNT_ID) {
    throw new Error('INSTAGRAM_ACCOUNT_ID manquant.');
  }

  const cutoffAt = safeString(options?.cutoffAt);
  const cutoffEnabled = Number.isFinite(Date.parse(cutoffAt));
  const conversations = [];
  const seenIds = new Set();
  let olderSkipped = 0;
  let undatedSkipped = 0;
  let cutoffReached = false;

  let nextUrl =
    `https://graph.instagram.com/${META_API_VERSION}/` +
    `${encodeURIComponent(INSTAGRAM_ACCOUNT_ID)}/conversations` +
    `?platform=instagram&fields=id,updated_time&limit=50`;

  let pageCount = 0;
  const seenPageUrls = new Set();

  while (nextUrl) {
    if (seenPageUrls.has(nextUrl)) {
      throw new Error('Pagination Instagram conversations en boucle : Meta a renvoyé deux fois la même page.');
    }
    seenPageUrls.add(nextUrl);

    const data = await instagramGraphGet(nextUrl);
    const pageItems = Array.isArray(data?.data) ? data.data : [];
    let pageDated = 0;
    let pageRecent = 0;
    let pageOlder = 0;

    for (const item of pageItems) {
      const id = safeString(item?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const updatedTime = safeString(item?.updated_time);
      const updatedMs = Date.parse(updatedTime);

      if (cutoffEnabled) {
        if (!Number.isFinite(updatedMs)) {
          undatedSkipped += 1;
          continue;
        }
        pageDated += 1;
        if (!historyTimeIsRecent(updatedTime, cutoffAt)) {
          olderSkipped += 1;
          pageOlder += 1;
          continue;
        }
        pageRecent += 1;
      }

      conversations.push({ id, updatedTime });
    }

    const metaNext = safeString(data?.paging?.next);
    pageCount += 1;

    // Meta renvoie les conversations de la plus récente à la plus ancienne.
    // Dès qu'une page entière datée est hors fenêtre, les pages suivantes le sont aussi.
    if (
      cutoffEnabled &&
      pageItems.length > 0 &&
      pageDated > 0 &&
      pageRecent === 0 &&
      pageOlder === pageDated
    ) {
      cutoffReached = true;
      nextUrl = '';
    } else {
      nextUrl = metaNext;
    }

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          pageCount,
          conversationCount: conversations.length,
          hasMore: Boolean(nextUrl),
          olderSkipped,
          undatedSkipped,
          cutoffReached,
          cutoffAt,
          historyDays: HISTORY_IMPORT_DAYS
        });
      } catch (progressError) {
        console.warn('⚠️ Progression historique Instagram non enregistrée :', progressError.message);
      }
    }
  }

  console.log(
    `📚 Instagram : ${conversations.length} conversation(s) dans les ${HISTORY_IMPORT_DAYS} derniers jours sur ${pageCount} page(s)` +
    `${cutoffReached ? ', arrêt au seuil de rétention.' : ', pagination épuisée.'}`
  );

  return {
    conversations,
    truncated: false,
    pageCount,
    cutoffAt,
    historyDays: HISTORY_IMPORT_DAYS,
    olderSkipped,
    undatedSkipped,
    cutoffReached
  };
}

async function listAllInstagramConversationMessageRefs(conversationId, cutoffAt = '') {
  const encodedId = encodeURIComponent(safeString(conversationId));
  const cutoffEnabled = Number.isFinite(Date.parse(safeString(cutoffAt)));
  let nextUrl =
    `https://graph.instagram.com/${META_API_VERSION}/${encodedId}` +
    `?fields=${encodeURIComponent('messages.limit(100){id,created_time}')}`;

  const refs = [];
  const seenIds = new Set();
  const seenUrls = new Set();

  while (nextUrl) {
    if (seenUrls.has(nextUrl)) {
      throw new Error('Pagination Instagram messages en boucle.');
    }
    seenUrls.add(nextUrl);

    const data = await instagramGraphGet(nextUrl);
    const pageData = Array.isArray(data?.messages?.data)
      ? data.messages.data
      : (Array.isArray(data?.data) ? data.data : []);

    let datedCount = 0;
    let recentCount = 0;
    let olderCount = 0;

    for (const item of pageData) {
      const id = safeString(item?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const createdTime = safeString(item?.created_time);
      const createdMs = Date.parse(createdTime);

      if (cutoffEnabled) {
        if (!Number.isFinite(createdMs)) continue;
        datedCount += 1;
        if (!historyTimeIsRecent(createdTime, cutoffAt)) {
          olderCount += 1;
          continue;
        }
        recentCount += 1;
      }

      refs.push({ id, created_time: createdTime });
    }

    const metaNext = safeString(data?.messages?.paging?.next || data?.paging?.next);
    if (
      cutoffEnabled &&
      pageData.length > 0 &&
      datedCount > 0 &&
      recentCount === 0 &&
      olderCount === datedCount
    ) {
      nextUrl = '';
    } else {
      nextUrl = metaNext;
    }
  }

  return refs.sort((a, b) =>
    new Date(b?.created_time || 0) - new Date(a?.created_time || 0)
  );
}

async function getInstagramConversationRecentMessages(conversationId, cutoffAt = '') {
  const refs = await listAllInstagramConversationMessageRefs(conversationId, cutoffAt);
  const detailedRefs = refs.slice(0, 20);
  const detailsById = new Map();

  // Meta documente que le détail n'est disponible que pour les 20 messages
  // les plus récents. En V6.20.6, seuls les IDs situés dans la fenêtre de
  // fenêtre de rétention configurée sont conservés/importés.
  for (let index = 0; index < detailedRefs.length; index += 5) {
    const batch = detailedRefs.slice(index, index + 5);
    const responses = await Promise.all(
      batch.map(async ref => {
        try {
          const detailUrl =
            `https://graph.instagram.com/${META_API_VERSION}/${encodeURIComponent(ref.id)}` +
            `?fields=${encodeURIComponent('id,created_time,from,to,message')}`;
          return await instagramGraphGet(detailUrl);
        } catch (error) {
          console.warn('⚠️ Détail message Instagram indisponible :', ref.id, error.message);
          return null;
        }
      })
    );

    for (const detail of responses.filter(Boolean)) {
      detailsById.set(safeString(detail?.id), detail);
    }
  }

  return refs.map((ref, index) => {
    const detail = detailsById.get(ref.id);
    if (detail) {
      return { ...ref, ...detail, meta_content_available: true };
    }

    return {
      ...ref,
      meta_content_available: false,
      meta_detail_limit_reason:
        index >= 20
          ? 'Meta limite le détail aux 20 messages les plus récents.'
          : 'Détail non retourné par Meta.'
    };
  });
}

function instagramMessageParticipants(message) {
  const ids = [];

  const fromId =
    safeString(message?.from?.id);

  if (fromId) {
    ids.push(fromId);
  }

  const toData =
    Array.isArray(message?.to?.data)
      ? message.to.data
      : [];

  for (const item of toData) {
    const id = safeString(item?.id);
    if (id) ids.push(id);
  }

  return [...new Set(ids)];
}

function instagramConversationCustomerId(messages) {
  for (const message of messages) {
    const participants =
      instagramMessageParticipants(
        message
      );

    const customer = participants.find(
      id =>
        id &&
        id !== INSTAGRAM_ACCOUNT_ID
    );

    if (customer) {
      return customer;
    }
  }

  return '';
}

function profilePictureExtensionAdmin(contentType) {
  const type = safeString(contentType).toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

async function persistInstagramHistoryProfilePicture(
  remoteUrl,
  customerId
) {
  const url = safeString(remoteUrl);
  const scopedId = safeString(customerId)
    .replace(/[^a-zA-Z0-9_-]/g, '');

  if (!url || !scopedId) return '';

  try {
    const response = await fetch(url);
    if (!response.ok) return '';

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      return '';
    }

    const extension = profilePictureExtensionAdmin(
      response.headers.get('content-type')
    );

    const filename = `instagram-${scopedId}.${extension}`;

    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const candidate = path.join(
        CONVERSATION_PROFILE_DIR,
        `instagram-${scopedId}.${ext}`
      );
      if (ext !== extension && fs.existsSync(candidate)) {
        try { fs.unlinkSync(candidate); } catch {}
      }
    }


const cloudEntry = await storeCloudAssetBuffer({
  buffer,
  mimetype: response.headers.get('content-type') || 'image/jpeg',
  filename,
  kind: 'profile'
});
if (!cloudEntry) {
  fs.writeFileSync(path.join(CONVERSATION_PROFILE_DIR, filename), buffer);
}
return `/admin/conversation-profile/${encodeURIComponent(filename)}`;
  } catch {
    return '';
  }
}

async function getInstagramHistoryProfile(customerId) {
  if (!customerId) return {};

  try {
    const url =
      `https://graph.instagram.com/${META_API_VERSION}/` +
      `${encodeURIComponent(customerId)}` +
      `?fields=name,username,profile_pic`;

    const data =
      await instagramGraphGet(url);

    if (!data || typeof data !== 'object') {
      return {};
    }

    const profilePicture =
      await persistInstagramHistoryProfilePicture(
        data.profile_pic,
        customerId
      );

    return {
      ...data,
      profilePicture
    };
  } catch {
    return {};
  }
}

function minIso(a, b) {
  const aMs = Date.parse(safeString(a));
  const bMs = Date.parse(safeString(b));

  if (!Number.isFinite(aMs)) return safeString(b);
  if (!Number.isFinite(bMs)) return safeString(a);

  return aMs <= bMs
    ? safeString(a)
    : safeString(b);
}

function maxIso(a, b) {
  const aMs = Date.parse(safeString(a));
  const bMs = Date.parse(safeString(b));

  if (!Number.isFinite(aMs)) return safeString(b);
  if (!Number.isFinite(bMs)) return safeString(a);

  return aMs >= bMs
    ? safeString(a)
    : safeString(b);
}

async function runInstagramHistorySync() {
  const startedAt =
    new Date().toISOString();

  const cutoffAt = historyImportCutoffIso(startedAt);

  console.log(`📚 Instagram : import limité aux ${HISTORY_IMPORT_DAYS} derniers jours (depuis ${cutoffAt}).`);

  instagramHistorySyncJob = {
    running: true,
    startedAt,
    completedAt: '',
    totalConversations: 0,
    processedConversations: 0,
    importedConversations: 0,
    importedMessages: 0,
    skippedMessages: 0,
    errorCount: 0,
    lastError: '',
    warning: '',
    truncated: false,
    metaMessageDetailLimit: 20,
    chronologyVersion: 4,
    historyDays: HISTORY_IMPORT_DAYS,
    cutoffAt,
    olderConversationsSkipped: 0,
    cutoffReached: false,
    phase: 'listing',
    listedConversations: 0,
    listPages: 0,
    messageIdsDiscovered: 0,
    contentUnavailableMessages: 0,
    interrupted: false
  };

  saveInstagramHistorySyncState(
    instagramHistorySyncJob
  );

  try {
    const listed =
      await listAllInstagramConversations(progress => {
        instagramHistorySyncJob.phase = 'listing';
        instagramHistorySyncJob.listedConversations = Number(progress?.conversationCount || 0);
        instagramHistorySyncJob.listPages = Number(progress?.pageCount || 0);
        instagramHistorySyncJob.olderConversationsSkipped = Number(progress?.olderSkipped || 0);
        instagramHistorySyncJob.cutoffReached = Boolean(progress?.cutoffReached);
        instagramHistorySyncJob.lastProgressAt = new Date().toISOString();
        saveInstagramHistorySyncState(instagramHistorySyncJob);
      }, { cutoffAt });

    const conversations =
      listed.conversations;

    instagramHistorySyncJob.totalConversations =
      conversations.length;
    instagramHistorySyncJob.listedConversations = conversations.length;
    instagramHistorySyncJob.listPages = Number(listed.pageCount || instagramHistorySyncJob.listPages || 0);
    instagramHistorySyncJob.olderConversationsSkipped = Number(listed.olderSkipped || instagramHistorySyncJob.olderConversationsSkipped || 0);
    instagramHistorySyncJob.cutoffReached = Boolean(listed.cutoffReached);
    instagramHistorySyncJob.phase = 'messages';

    instagramHistorySyncJob.truncated =
      Boolean(listed.truncated);

    if (!conversations.length) {
      instagramHistorySyncJob.warning =
        'Meta a retourné 0 conversation Instagram. Vérifiez que INSTAGRAM_ACCOUNT_ID correspond au compte professionnel, que le token possède instagram_business_manage_messages (Instagram Login) ou instagram_manage_messages avec accès à la Page liée (Facebook Login), et que le niveau d’accès Meta permet les conversations de vrais clients.';
      console.warn('⚠️ Instagram historique :', instagramHistorySyncJob.warning);
    }

    saveInstagramHistorySyncState(instagramHistorySyncJob);

    const live =
      readJsonArray(
        CONVERSATIONS_LOG_PATH,
        'conversation-log.json'
      );

    const historical =
      readJsonArray(
        INSTAGRAM_HISTORY_PATH,
        'instagram-history.json'
      );

    const persistent = loadPersistentConversationEvents();

    const knownMessageIds =
      new Set(
        [...live, ...historical, ...persistent]
          .flatMap(entry => conversationEntryMessageIds(entry))
          .filter(Boolean)
      );

    const historyByKey =
      new Map(
        historical.map(entry => [
          conversationLogDedupeKey(entry),
          entry
        ])
      );

    const states =
      loadConversationStatesAdmin();

    const profileCache = new Map();

    // Cinq conversations en parallèle : assez rapide tout en restant prudent
    // avec les limites de l'API Meta.
    for (
      let index = 0;
      index < conversations.length;
      index += 5
    ) {
      const batch =
        conversations.slice(
          index,
          index + 5
        );

      const results =
        await Promise.all(
          batch.map(async conversation => {
            try {
              const messages =
                await getInstagramConversationRecentMessages(
                  conversation.id,
                  cutoffAt
                );

              instagramHistorySyncJob.messageIdsDiscovered += messages.length;
              instagramHistorySyncJob.contentUnavailableMessages += messages.filter(item => item?.meta_content_available === false).length;

              const customerId =
                instagramConversationCustomerId(
                  messages
                );

              if (!customerId) {
                return {
                  conversation,
                  customerId: '',
                  messages: [],
                  error:
                    'Client Instagram non identifiable.'
                };
              }

              let profile =
                profileCache.get(
                  customerId
                );

              if (!profile) {
                profile =
                  await getInstagramHistoryProfile(
                    customerId
                  );

                profileCache.set(
                  customerId,
                  profile
                );
              }

              return {
                conversation,
                customerId,
                messages,
                profile,
                error: ''
              };
            } catch (error) {
              return {
                conversation,
                customerId: '',
                messages: [],
                profile: {},
                error:
                  error.message
              };
            }
          })
        );

      for (const result of results) {
        instagramHistorySyncJob.processedConversations += 1;

        if (result.error) {
          instagramHistorySyncJob.errorCount += 1;
          instagramHistorySyncJob.lastError =
            result.error;
          continue;
        }

        const customerId =
          result.customerId;

        const contact =
          `instagram:${customerId}`;

        let conversationAdded = false;
        let earliestTime = '';
        let latestInboundTime = '';
        let lastInboundType = '';

        const ordered =
          [...result.messages]
            .sort(
              (a, b) =>
                new Date(a?.created_time || 0) -
                new Date(b?.created_time || 0)
            );

        for (const message of ordered) {
          const messageId =
            safeString(message?.id);

          if (
            messageId &&
            knownMessageIds.has(messageId)
          ) {
            // Même si le message existe déjà dans le live log, conserver
            // l'heure créée par Meta. Cette ancre corrige les anciens
            // événements enregistrés à l'heure de traitement du serveur.
            const anchorKey = `mid:${messageId}`;
            const existingAnchor = historyByKey.get(anchorKey) || {};
            const anchorTime = safeString(message?.created_time);
            if (anchorTime) {
              historyByKey.set(anchorKey, {
                ...existingAnchor,
                message_id: messageId,
                meta_message_id: safeString(existingAnchor?.meta_message_id) || messageId,
                contact,
                external_contact: customerId,
                channel: 'instagram',
                action: safeString(existingAnchor?.action) || 'history_timestamp_anchor',
                source: safeString(existingAnchor?.source) || 'instagram_history_timestamp',
                direction: safeString(existingAnchor?.direction) || 'unknown',
                history_import: true,
                meta_timestamp_anchor: true,
                meta_created_time: anchorTime,
                time: anchorTime
              });
            }
            instagramHistorySyncJob.skippedMessages += 1;
            continue;
          }

          const fromId =
            safeString(message?.from?.id);

          const directionKnown =
            Boolean(fromId);

          const outgoing =
            directionKnown &&
            fromId === INSTAGRAM_ACCOUNT_ID;

          const text =
            safeString(message?.message);

          const time =
            safeString(message?.created_time) ||
            safeString(result.conversation?.updatedTime) ||
            startedAt;

          earliestTime =
            earliestTime
              ? minIso(earliestTime, time)
              : time;

          if (directionKnown && !outgoing) {
            latestInboundTime =
              latestInboundTime
                ? maxIso(latestInboundTime, time)
                : time;

            lastInboundType =
              text
                ? 'text'
                : 'history';
          }

          const entry = {
            message_id:
              messageId || null,
            meta_message_id:
              messageId || null,
            contact,
            external_contact:
              customerId,
            channel:
              'instagram',
            action:
              'history_import',
            source:
              !directionKnown
                ? 'instagram_history_meta_limited'
                : outgoing
                  ? 'commercial_instagram_history'
                  : 'instagram_history_import',
            direction:
              !directionKnown
                ? 'unknown'
                : outgoing
                  ? 'outgoing'
                  : 'incoming',
            history_import:
              true,
            instagram_conversation_id:
              safeString(result.conversation?.id),
            meta_content_available:
              message?.meta_content_available !== false,
            meta_detail_limit_reason:
              safeString(message?.meta_detail_limit_reason),
            meta_created_time: time,
            time
          };

          if (!directionKnown) {
            // Meta permet de conserver l'ID/date des anciens messages mais
            // ne fournit plus le détail au-delà de sa fenêtre documentée.
            // Ne jamais inventer ici s'il s'agissait d'un entrant ou sortant.
            entry.type = 'history';
            entry.message_text = text || undefined;
          } else if (outgoing) {
            entry.reply = text;
            entry.reply_sent = true;
            entry.commercial_user_name =
              'Équipe MONDECO';
            entry.commercial_user_role =
              'commercial';
          } else {
            entry.incoming = text;
            entry.reply_sent = false;
            entry.type =
              text
                ? 'text'
                : 'history';
          }

          historyByKey.set(
            conversationLogDedupeKey(entry),
            entry
          );

          if (messageId) {
            knownMessageIds.add(
              messageId
            );
          }

          conversationAdded = true;
          instagramHistorySyncJob.importedMessages += 1;
        }

        // Même si les messages sont déjà présents, on enrichit le profil et
        // marque la discussion comme connue de la synchronisation historique.
        const current =
          states[contact] &&
          typeof states[contact] === 'object'
            ? states[contact]
            : {};

        const profileName =
          safeString(
            result.profile?.name ||
            result.profile?.username ||
            current.profileName
          );

        const username =
          safeString(
            result.profile?.username ||
            current.instagramUsername
          );

        states[contact] = {
          ...current,
          channel:
            'instagram',
          externalContact:
            customerId,
          profileName,
          instagramUsername:
            username,
          profilePicture:
            safeString(
              result.profile?.profilePicture ||
              current.profilePicture
            ),
          profileUpdatedAt:
            result.profile && Object.keys(result.profile).length
              ? startedAt
              : safeString(current.profileUpdatedAt),
          firstSeenAt:
            current.firstSeenAt
              ? (
                  earliestTime
                    ? minIso(current.firstSeenAt, earliestTime)
                    : current.firstSeenAt
                )
              : (
                  earliestTime ||
                  safeString(result.conversation?.updatedTime) ||
                  startedAt
                ),
          lastCustomerAt:
            latestInboundTime
              ? maxIso(
                  current.lastCustomerAt,
                  latestInboundTime
                )
              : safeString(current.lastCustomerAt),
          lastInboundType:
            lastInboundType ||
            safeString(current.lastInboundType),
          unreadCount:
            Number(current.unreadCount || 0),
          instagramHistoryImported:
            true,
          instagramHistoryConversationId:
            safeString(result.conversation?.id),
          instagramHistoryUpdatedTime:
            safeString(result.conversation?.updatedTime),
          instagramHistoryImportedAt:
            startedAt
        };

        if (conversationAdded) {
          instagramHistorySyncJob.importedConversations += 1;
        }
      }

      // Sauvegarde progressive par blocs de 25 discussions (et à la fin).
      // Cela protège contre un redémarrage Railway sans réécrire un gros JSON
      // après chaque conversation.
      const shouldCheckpoint =
        instagramHistorySyncJob.processedConversations % 25 === 0 ||
        instagramHistorySyncJob.processedConversations >= conversations.length;

      if (shouldCheckpoint) {
        const historyList =
          [...historyByKey.values()]
            .sort(
              (a, b) =>
                new Date(a?.time || 0) -
                new Date(b?.time || 0)
            );

        writeJsonAtomic(
          INSTAGRAM_HISTORY_PATH,
          historyList
        );

        saveConversationStatesAdmin(
          states
        );
      }

      saveInstagramHistorySyncState({
        ...instagramHistorySyncJob,
        lastProgressAt:
          new Date().toISOString()
      });
    }

    instagramHistorySyncJob.running = false;
    instagramHistorySyncJob.phase = 'completed';
    instagramHistorySyncJob.completedAt =
      new Date().toISOString();

    saveInstagramHistorySyncState(
      instagramHistorySyncJob
    );
  } catch (error) {
    instagramHistorySyncJob.running = false;
    instagramHistorySyncJob.phase = 'error';
    instagramHistorySyncJob.completedAt =
      new Date().toISOString();
    instagramHistorySyncJob.errorCount += 1;
    instagramHistorySyncJob.lastError =
      error.message;

    saveInstagramHistorySyncState(
      instagramHistorySyncJob
    );

    console.error(
      '❌ Synchronisation historique Instagram :',
      error
    );
  }
}

router.get(
  '/api/instagram-history/status',
  requireAuth,
  (req, res) => {
    try {
      const persisted = loadInstagramHistorySyncState();

      // GET = lecture seule. Après un redémarrage Railway, on présente
      // l'ancien running=true comme interrompu sans réécrire /data.
      const effectivePersisted =
        !instagramHistorySyncJob.running && persisted?.running === true
          ? {
              ...persisted,
              running: false,
              interrupted: true,
              phase: 'interrupted',
              interruptedAt: safeString(persisted?.interruptedAt) || new Date().toISOString(),
              lastError: safeString(persisted?.lastError) || 'Synchronisation interrompue par un redémarrage du service Railway.'
            }
          : persisted;

      return res.json({
        configured:
          Boolean(
            INSTAGRAM_ACCESS_TOKEN &&
            INSTAGRAM_ACCOUNT_ID
          ),
        ...effectivePersisted,
        ...(instagramHistorySyncJob.running
          ? instagramHistorySyncJob
          : {})
      });
    } catch (error) {
      console.error('❌ Statut historique Instagram :', error);
      return res.status(500).json({
        error: 'Impossible de lire l’état Instagram. Consultez les logs Railway.'
      });
    }
  }
);

router.post(
  '/api/instagram-history/sync',
  requireAdminOrCommercialManager,
  (req, res) => {
    if (
      !INSTAGRAM_ACCESS_TOKEN ||
      !INSTAGRAM_ACCOUNT_ID
    ) {
      return res
        .status(400)
        .json({
          error:
            'Instagram n’est pas complètement configuré dans Railway.'
        });
    }

    if (instagramHistorySyncJob.running) {
      return res
        .status(202)
        .json({
          success: true,
          alreadyRunning: true,
          job: instagramHistorySyncJob
        });
    }

    // Travail en arrière-plan : la requête HTTP répond immédiatement, puis
    // l'interface suit la progression avec /status.
    setImmediate(() => {
      runInstagramHistorySync()
        .catch(error => {
          console.error(
            '❌ Job historique Instagram :',
            error
          );
        });
    });

    return res
      .status(202)
      .json({
        success: true,
        started: true
      });
  }
);

// ============================================================
// V6.20.6 — SYNCHRONISATION HISTORIQUE FACEBOOK MESSENGER
// ============================================================

let facebookHistorySyncJob = {
  running: false,
  startedAt: '',
  completedAt: '',
  totalConversations: 0,
  processedConversations: 0,
  importedConversations: 0,
  importedMessages: 0,
  skippedMessages: 0,
  messageIdsDiscovered: 0,
  contentUnavailableMessages: 0,
  errorCount: 0,
  lastError: ''
};

function loadFacebookHistorySyncState() {
  try {
    if (!fs.existsSync(FACEBOOK_HISTORY_SYNC_STATE_PATH)) return {};
    const parsed = JSON.parse(
      fs.readFileSync(FACEBOOK_HISTORY_SYNC_STATE_PATH, 'utf8') || '{}'
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function saveFacebookHistorySyncState(state) {
  writeJsonAtomic(
    FACEBOOK_HISTORY_SYNC_STATE_PATH,
    state && typeof state === 'object' ? state : {}
  );
}

// V6.35.1/V6.35.2 — Résilience réseau Graph API, partagée par toutes les
// fonctions d'appel Meta (Messenger, Comments, Instagram).
// "fetch failed" (TypeError Node/undici) est une erreur RÉSEAU transitoire
// (DNS, TLS, coupure, timeout) : ni un token invalide ni une erreur Meta.
// On la distingue clairement d'une vraie erreur Meta (4xx/5xx avec payload
// JSON error.message) pour ne jamais ré-essayer inutilement une requête que
// Meta a explicitement refusée (ex: token expiré, permission manquante).
const GRAPH_REQUEST_TIMEOUT_MS = 20000;
const GRAPH_REQUEST_MAX_ATTEMPTS = 3; // 1 essai initial + 2 retries
const GRAPH_REQUEST_RETRY_BASE_DELAY_MS = 600;

function isTransientGraphNetworkError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true; // timeout local
  // undici/Node encapsule les erreurs réseau (DNS, connexion refusée, TLS,
  // reset) dans une TypeError "fetch failed" avec parfois error.cause.
  if (error instanceof TypeError && /fetch failed/i.test(safeString(error.message))) return true;
  const code = safeString(error?.cause?.code || error?.code);
  if (['ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET'].includes(code)) return true;
  return false;
}

function isRetryableMetaHttpStatus(status) {
  // Erreurs serveur Meta (temporaires) : on retente. Les 4xx (token,
  // permissions, requête invalide) ne sont volontairement PAS retentées.
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// V6.35.2 — facebookGraphGet est la fonction RÉELLEMENT utilisée par la
// récupération des conversations/messages Facebook Messenger (identité
// client, statut répondu/à répondre, rattrapage temps réel). Elle doit avoir
// la même résilience réseau que graphJsonRequest (timeout + retry ciblé sur
// erreurs transitoires uniquement), sinon un simple incident réseau bloque
// silencieusement la mise à jour du nom/photo ET du statut répondu pour la
// conversation concernée jusqu'au prochain cycle.
async function facebookGraphGet(url) {
  if (!FACEBOOK_MESSENGER_TOKEN) {
    throw new Error('FACEBOOK_MESSENGER_TOKEN manquant.');
  }

  let lastNetworkError;
  for (let attempt = 1; attempt <= GRAPH_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${FACEBOOK_MESSENGER_TOKEN}` },
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      const transient = isTransientGraphNetworkError(error);
      if (transient && attempt < GRAPH_REQUEST_MAX_ATTEMPTS) {
        lastNetworkError = error;
        await sleep(GRAPH_REQUEST_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      if (transient) {
        const timeoutError = new Error(
          `Facebook Messenger injoignable après ${GRAPH_REQUEST_MAX_ATTEMPTS} tentatives (réseau) : ${error.message}`
        );
        timeoutError.transientNetwork = true;
        throw timeoutError;
      }
      throw error;
    }
    clearTimeout(timer);

    let data = {};
    try { data = await response.json(); } catch { data = {}; }

    if (!response.ok) {
      const metaCode = Number(data?.error?.code || 0);
      if (metaCode === 190) {
        const error = new Error(
          'Connexion Facebook Messenger expirée : remplacez FACEBOOK_MESSENGER_TOKEN dans Railway par le token Messenger valide.'
        );
        error.code = 'FACEBOOK_TOKEN_EXPIRED';
        error.statusCode = 503;
        throw error;
      }
      if (attempt < GRAPH_REQUEST_MAX_ATTEMPTS && isRetryableMetaHttpStatus(response.status)) {
        lastNetworkError = new Error(safeString(data?.error?.message) || `Facebook HTTP ${response.status}`);
        await sleep(GRAPH_REQUEST_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw new Error(
        safeString(data?.error?.message) ||
        `Facebook HTTP ${response.status}`
      );
    }

    return data;
  }
  throw lastNetworkError || new Error('Facebook Messenger : requête impossible.');
}

async function listAllFacebookConversations(onProgress = null, options = {}) {
  if (!FACEBOOK_PAGE_ID) {
    throw new Error('FACEBOOK_PAGE_ID manquant.');
  }

  const cutoffAt = safeString(options?.cutoffAt);
  const cutoffEnabled = Number.isFinite(Date.parse(cutoffAt));
  const conversations = [];
  const seenIds = new Set();
  const seenUrls = new Set();
  let pageCount = 0;
  let olderSkipped = 0;
  let undatedSkipped = 0;
  let cutoffReached = false;
  let nextUrl =
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(FACEBOOK_PAGE_ID)}/conversations` +
    `?fields=${encodeURIComponent('id,link,updated_time,participants{id,name}')}&limit=50`;

  while (nextUrl) {
    if (seenUrls.has(nextUrl)) {
      throw new Error('Pagination Facebook conversations en boucle.');
    }
    seenUrls.add(nextUrl);

    const data = await facebookGraphGet(nextUrl);
    const pageItems = Array.isArray(data?.data) ? data.data : [];
    let pageDated = 0;
    let pageRecent = 0;
    let pageOlder = 0;

    for (const item of pageItems) {
      const id = safeString(item?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const updatedTime = safeString(item?.updated_time);
      const updatedMs = Date.parse(updatedTime);

      if (cutoffEnabled) {
        if (!Number.isFinite(updatedMs)) {
          undatedSkipped += 1;
          continue;
        }
        pageDated += 1;
        if (!historyTimeIsRecent(updatedTime, cutoffAt)) {
          olderSkipped += 1;
          pageOlder += 1;
          continue;
        }
        pageRecent += 1;
      }

      conversations.push({
        id,
        link: safeString(item?.link),
        updatedTime,
        participants: item?.participants && typeof item.participants === 'object' ? item.participants : undefined
      });
    }

    const metaNext = safeString(data?.paging?.next);
    pageCount += 1;

    if (
      cutoffEnabled &&
      pageItems.length > 0 &&
      pageDated > 0 &&
      pageRecent === 0 &&
      pageOlder === pageDated
    ) {
      cutoffReached = true;
      nextUrl = '';
    } else {
      nextUrl = metaNext;
    }

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          pageCount,
          conversationCount: conversations.length,
          hasMore: Boolean(nextUrl),
          olderSkipped,
          undatedSkipped,
          cutoffReached,
          cutoffAt,
          historyDays: HISTORY_IMPORT_DAYS
        });
      } catch (progressError) {
        console.warn('⚠️ Progression historique Facebook non enregistrée :', progressError.message);
      }
    }
  }

  console.log(
    `📘 Facebook : ${conversations.length} conversation(s) dans les ${HISTORY_IMPORT_DAYS} derniers jours sur ${pageCount} page(s)` +
    `${cutoffReached ? ', arrêt au seuil de rétention.' : ', pagination épuisée.'}`
  );
  return {
    conversations,
    pageCount,
    truncated: false,
    cutoffAt,
    historyDays: HISTORY_IMPORT_DAYS,
    olderSkipped,
    undatedSkipped,
    cutoffReached
  };
}

async function listAllFacebookConversationMessageRefs(conversationId, cutoffAt = '') {
  const encodedId = encodeURIComponent(safeString(conversationId));
  const cutoffEnabled = Number.isFinite(Date.parse(safeString(cutoffAt)));
  const fieldSets = [
    'messages.limit(100){id,created_time,from,to,message,reply_to,attachments}',
    'messages.limit(100){id,created_time,from,to,message,reply_to}',
    'messages.limit(100){id,created_time}'
  ];

  let firstData = null;
  let selectedFields = '';
  let lastError = null;

  for (const fields of fieldSets) {
    try {
      firstData = await facebookGraphGet(
        `https://graph.facebook.com/${META_API_VERSION}/${encodedId}` +
        `?fields=${encodeURIComponent(fields)}`
      );
      selectedFields = fields;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!firstData) {
    throw lastError || new Error('Impossible de lire les messages Facebook.');
  }

  const refs = [];
  const seenIds = new Set();
  const seenUrls = new Set();
  let data = firstData;
  while (data) {
    const pageData = Array.isArray(data?.messages?.data)
      ? data.messages.data
      : (Array.isArray(data?.data) ? data.data : []);

    let datedCount = 0;
    let recentCount = 0;
    let olderCount = 0;

    for (const item of pageData) {
      const id = safeString(item?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const createdTime = safeString(item?.created_time);
      const createdMs = Date.parse(createdTime);

      if (cutoffEnabled) {
        if (!Number.isFinite(createdMs)) continue;
        datedCount += 1;
        if (!historyTimeIsRecent(createdTime, cutoffAt)) {
          olderCount += 1;
          continue;
        }
        recentCount += 1;
      }

      const hasInlineDetail = Boolean(
        item?.from ||
        item?.to ||
        Object.prototype.hasOwnProperty.call(item || {}, 'message') ||
        item?.reply_to ||
        item?.attachments
      );
      refs.push({
        ...item,
        id,
        created_time: createdTime,
        _facebook_inline_detail: hasInlineDetail
      });
    }

    const nextUrl = safeString(data?.messages?.paging?.next || data?.paging?.next);
    if (
      cutoffEnabled &&
      pageData.length > 0 &&
      datedCount > 0 &&
      recentCount === 0 &&
      olderCount === datedCount
    ) {
      break;
    }
    if (!nextUrl) break;
    if (seenUrls.has(nextUrl)) {
      throw new Error('Pagination Facebook messages en boucle.');
    }
    seenUrls.add(nextUrl);
    data = await facebookGraphGet(nextUrl);
  }

  console.log(
    `📘 Facebook conversation ${safeString(conversationId)} : ${refs.length} message(s) des ${HISTORY_IMPORT_DAYS} derniers jours` +
    `${selectedFields.includes('from,to,message') ? ' avec détails groupés' : ' (IDs/dates, détails à enrichir)'}.`
  );

  return refs.sort((a, b) => {
    const aMs = conversationTimeMs(a?.created_time);
    const bMs = conversationTimeMs(b?.created_time);
    return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
  });
}

async function getFacebookMessageDetail(ref) {
  const base =
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(ref.id)}`;

  // Les champs textuels/direction sont les plus importants. On tente aussi
  // attachments ; si une version Graph refuse ce champ, on retente sans lui.
  const fieldSets = [
    'id,created_time,from,to,message,reply_to,attachments',
    'id,created_time,from,to,message,reply_to'
  ];

  let lastError = null;
  for (const fields of fieldSets) {
    try {
      const detail = await facebookGraphGet(
        `${base}?fields=${encodeURIComponent(fields)}`
      );
      return {
        ...ref,
        ...detail,
        meta_content_available: true
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ...ref,
    meta_content_available: false,
    meta_detail_limit_reason: safeString(lastError?.message || 'Détail non retourné par Meta.')
  };
}

async function getAllFacebookConversationMessages(conversationId, cutoffAt = '') {
  const refs = await listAllFacebookConversationMessageRefs(conversationId, cutoffAt);
  const messages = [];

  // V6.20.6 : aucune pagination de messages au-delà de la fenêtre de rétention de 15 jours.
  // Les messages déjà détaillés sont utilisés directement ; les autres sont enrichis.
  for (let index = 0; index < refs.length; index += 8) {
    const batch = refs.slice(index, index + 8);
    const details = await Promise.all(
      batch.map(ref =>
        ref?._facebook_inline_detail
          ? Promise.resolve({ ...ref, meta_content_available: true })
          : getFacebookMessageDetail(ref)
      )
    );
    messages.push(...details);
  }

  return messages;
}


function facebookHistoryAttachmentList(message) {
  const value=message?.attachments;
  if(Array.isArray(value)) return value.filter(Boolean);
  if(Array.isArray(value?.data)) return value.data.filter(Boolean);
  return [];
}

function facebookHistoryAttachmentUrl(item) {
  return safeString(
    item?.file_url ||
    item?.url ||
    item?.image_data?.url ||
    item?.video_data?.url ||
    item?.audio_data?.url ||
    item?.payload?.url
  );
}

function facebookHistoryMediaType(item, mimetype='') {
  const mime=safeString(mimetype || item?.mime_type).toLowerCase();
  const raw=safeString(item?.type).toLowerCase();
  if(mime.startsWith('image/') || raw==='image') return 'image';
  if(mime.startsWith('video/') || raw==='video') return 'video';
  if(mime.startsWith('audio/') || raw==='audio') return 'audio';
  return 'file';
}

function facebookHistoryMediaExtension(mimetype, type='file') {
  const mime=safeString(mimetype).toLowerCase().split(';')[0];
  const map={
    'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
    'video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm',
    'audio/mpeg':'mp3','audio/mp4':'m4a','audio/ogg':'ogg','audio/wav':'wav','audio/x-wav':'wav','audio/webm':'webm',
    'application/pdf':'pdf','text/plain':'txt','application/msword':'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
    'application/vnd.ms-excel':'xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx'
  };
  if(map[mime]) return map[mime];
  if(type==='image') return 'jpg';
  if(type==='video') return 'mp4';
  if(type==='audio') return 'mp3';
  return 'bin';
}

function assertSafeFacebookHistoryMedia(buffer, mimetype='') {
  if(!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Média Facebook vide.');
  if(buffer.length > 20 * 1024 * 1024) throw new Error('Média Facebook trop volumineux (maximum 20 Mo).');
  const mime=safeString(mimetype).toLowerCase().split(';')[0];
  const first=buffer.subarray(0,32);
  const ascii=first.toString('utf8').trimStart().toLowerCase();
  if(mime==='text/html'||mime==='application/xhtml+xml'||mime.includes('javascript')||mime.includes('x-sh')||mime.includes('x-executable')||ascii.startsWith('<!doctype html')||ascii.startsWith('<html')||ascii.startsWith('<script')||first.subarray(0,2).toString('ascii')==='MZ'||first.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))||first.subarray(0,2).toString('ascii')==='#!'){
    throw new Error('Fichier Facebook potentiellement exécutable refusé.');
  }
  if((mime==='image/jpeg'||mime==='image/jpg') && !(buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)) throw new Error('JPEG Facebook invalide.');
  if(mime==='image/png' && !buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) throw new Error('PNG Facebook invalide.');
  if(mime==='image/gif' && !['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString('ascii'))) throw new Error('GIF Facebook invalide.');
  if(mime==='image/webp' && !(buffer.subarray(0,4).toString('ascii')==='RIFF'&&buffer.subarray(8,12).toString('ascii')==='WEBP')) throw new Error('WEBP Facebook invalide.');
  if(mime==='application/pdf' && buffer.subarray(0,5).toString('ascii')!=='%PDF-') throw new Error('PDF Facebook invalide.');
}

// V6.35.9 — Téléchargement de pièce jointe (GET, donc rejouable sans
// risque, contrairement à un envoi) avec timeout + retry sur incident
// réseau transitoire uniquement.
async function fetchFacebookAttachmentWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= GRAPH_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error;
      const transient = isTransientGraphNetworkError(error);
      if (transient && attempt < GRAPH_REQUEST_MAX_ATTEMPTS) {
        await sleep(GRAPH_REQUEST_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Téléchargement pièce jointe Facebook impossible.');
}

async function persistFacebookHistoryAttachments(message) {
  const items=facebookHistoryAttachmentList(message);
  const messageId=safeString(message?.id).replace(/[^a-zA-Z0-9_-]/g,'').slice(-70) || crypto.randomUUID();
  const stored=[];
  for(let index=0; index<items.length; index+=1){
    const item=items[index];
    const remoteUrl=facebookHistoryAttachmentUrl(item);
    if(!remoteUrl) continue;
    try{
      // V6.35.9 — Même protection réseau (timeout + retry) que les autres
      // appels Meta : le téléchargement d'une pièce jointe historique
      // (photo/vidéo) subissait le même "fetch failed" non protégé.
      let response = await fetchFacebookAttachmentWithRetry(remoteUrl, {
        headers:{Authorization:`Bearer ${FACEBOOK_MESSENGER_TOKEN}`}
      });
      if(!response.ok) response = await fetchFacebookAttachmentWithRetry(remoteUrl);
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer=Buffer.from(await response.arrayBuffer());
      const mimetype=safeString(item?.mime_type || response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      assertSafeFacebookHistoryMedia(buffer,mimetype);
      const type=facebookHistoryMediaType(item,mimetype);
      const extension=facebookHistoryMediaExtension(mimetype,type);
      const filename=`facebook-history-${messageId}-${index}.${extension}`;
      const cloudEntry = await storeCloudAssetBuffer({ buffer, mimetype, filename, kind: 'media' });
      const filePath=path.join(CONVERSATION_MEDIA_DIR,filename);
      if(!cloudEntry && !fs.existsSync(filePath)) fs.writeFileSync(filePath,buffer);
      stored.push({
        type,
        sourceType:safeString(item?.type)||type,
        name:safeString(item?.name)||`${type==='image'?'Photo':type==='video'?'Vidéo':type==='audio'?'Audio':'Fichier'} Facebook`,
        mimetype,
        size:buffer.length,
        url:`/admin/conversation-media/${encodeURIComponent(filename)}`,
        filename,
        cloudStored:Boolean(cloudEntry),
        metaAttachmentId:safeString(item?.id)
      });
    }catch(error){
      console.warn('⚠️ Média historique Facebook non sauvegardé :',safeString(message?.id),error.message);
    }
  }
  return stored;
}

function facebookMessageParticipants(message) {
  const ids = [];
  const fromId = safeString(message?.from?.id);
  if (fromId) ids.push(fromId);

  const toData = Array.isArray(message?.to?.data)
    ? message.to.data
    : [];
  for (const item of toData) {
    const id = safeString(item?.id);
    if (id) ids.push(id);
  }

  return [...new Set(ids)];
}

function facebookConversationParticipantRows(conversation = {}) {
  const participants = conversation?.participants;
  if (Array.isArray(participants)) return participants.filter(Boolean);
  if (Array.isArray(participants?.data)) return participants.data.filter(Boolean);
  return [];
}

function facebookConversationCustomerIdentity(conversation = {}, messages = []) {
  // La Conversation API expose directement participants.id + participants.name
  // pour les conversations de Pages. C'est plus fiable que d'afficher le PSID.
  for (const participant of facebookConversationParticipantRows(conversation)) {
    const id = safeString(participant?.id);
    if (!id || id === safeString(FACEBOOK_PAGE_ID)) continue;
    return { id, name:safeString(participant?.name) };
  }

  // Fallback : le champ from des messages contient souvent aussi le nom.
  for (const message of Array.isArray(messages) ? messages : []) {
    const fromId = safeString(message?.from?.id);
    if (fromId && fromId !== safeString(FACEBOOK_PAGE_ID)) {
      return { id:fromId, name:safeString(message?.from?.name) };
    }
    const toData = Array.isArray(message?.to?.data) ? message.to.data : [];
    for (const participant of toData) {
      const id = safeString(participant?.id);
      if (id && id !== safeString(FACEBOOK_PAGE_ID)) {
        return { id, name:safeString(participant?.name) };
      }
    }
  }
  return { id:'', name:'' };
}

function facebookConversationCustomerId(messages, conversation = {}) {
  return facebookConversationCustomerIdentity(conversation, messages).id;
}

async function persistFacebookHistoryProfilePicture(remoteUrl, customerId) {
  const url = safeString(remoteUrl);
  const scopedId = safeString(customerId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!url || !scopedId) return '';

  try {
    const response = await fetch(url);
    if (!response.ok) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return '';

    const extension = profilePictureExtensionAdmin(
      response.headers.get('content-type')
    );
    const filename = `facebook-${scopedId}.${extension}`;

    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const candidate = path.join(
        CONVERSATION_PROFILE_DIR,
        `facebook-${scopedId}.${ext}`
      );
      if (ext !== extension && fs.existsSync(candidate)) {
        try { fs.unlinkSync(candidate); } catch {}
      }
    }

    const cloudEntry = await storeCloudAssetBuffer({
      buffer,
      mimetype: response.headers.get('content-type') || 'image/jpeg',
      filename,
      kind: 'profile'
    });
    if (!cloudEntry) fs.writeFileSync(path.join(CONVERSATION_PROFILE_DIR, filename), buffer);
    return `/admin/conversation-profile/${encodeURIComponent(filename)}`;
  } catch {
    return '';
  }
}

async function getFacebookHistoryProfile(customerId) {
  if (!customerId) return {};

  const fieldSets = [
    'first_name,last_name,name,profile_pic',
    'first_name,last_name,profile_pic'
  ];

  let best = {};
  let profileFetchError = '';
  for (const fields of fieldSets) {
    try {
      const url =
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(customerId)}` +
        `?fields=${encodeURIComponent(fields)}`;
      const data = await facebookGraphGet(url);
      if (!data || typeof data !== 'object') continue;

      const name = safeString(
        data?.name ||
        [safeString(data?.first_name), safeString(data?.last_name)].filter(Boolean).join(' ')
      );
      best = { ...best, ...data, name: name || safeString(best?.name) };
      if (name && safeString(data?.profile_pic)) break;
    } catch (error) {
      // V6.35.2 : on garde la dernière erreur pour la logger si AUCUN des
      // deux jeux de champs n'a réussi (sinon on masquerait un simple champ
      // en trop refusé par une ancienne version de l'API).
      profileFetchError = error.message;
    }
  }
  if (!safeString(best?.name) && profileFetchError) {
    console.warn(`⚠️ User Profile API Facebook ${safeString(customerId)} :`, profileFetchError);
  }

  // V6.35 : la User Profile API peut ne pas renvoyer profile_pic dans tous
  // les contextes. Le /picture edge est tenté comme filet de sécurité.
  let remotePicture = safeString(best?.profile_pic);
  if (!remotePicture) {
    try {
      const pictureData = await facebookGraphGet(
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(customerId)}/picture` +
        `?redirect=0&type=normal`
      );
      if (pictureData?.data?.is_silhouette !== true) {
        remotePicture = safeString(pictureData?.data?.url);
      }
    } catch (error) {
      console.warn(`⚠️ Photo profil Facebook ${safeString(customerId)} :`, error.message);
    }
  }

  const profilePicture = remotePicture
    ? await persistFacebookHistoryProfilePicture(remotePicture, customerId)
    : '';

  return {
    ...best,
    profilePicture
  };
}

async function validateFacebookHistoryConfiguration() {
  if (!FACEBOOK_PAGE_ID || !FACEBOOK_MESSENGER_TOKEN) {
    throw new Error('FACEBOOK_PAGE_ID ou FACEBOOK_MESSENGER_TOKEN manquant.');
  }

  const tokenOwner = await facebookGraphGet(
    `https://graph.facebook.com/${META_API_VERSION}/me?fields=${encodeURIComponent('id,name')}`
  );

  const tokenOwnerId = safeString(tokenOwner?.id);
  if (tokenOwnerId && tokenOwnerId !== safeString(FACEBOOK_PAGE_ID)) {
    throw new Error(
      `FACEBOOK_MESSENGER_TOKEN appartient à l’ID ${tokenOwnerId}, mais FACEBOOK_PAGE_ID vaut ${FACEBOOK_PAGE_ID}. Utilisez le Page Access Token Messenger correspondant à cette Page.`
    );
  }

  const page = await facebookGraphGet(
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(FACEBOOK_PAGE_ID)}` +
    `?fields=${encodeURIComponent('id,name')}`
  );

  const returnedId = safeString(page?.id || tokenOwnerId);
  return {
    pageId: returnedId || safeString(FACEBOOK_PAGE_ID),
    pageName: safeString(page?.name || tokenOwner?.name)
  };
}

async function runFacebookHistorySync() {
  const startedAt = new Date().toISOString();
  const cutoffAt = historyImportCutoffIso(startedAt);

  facebookHistorySyncJob = {
    running: true,
    startedAt,
    completedAt: '',
    totalConversations: 0,
    processedConversations: 0,
    importedConversations: 0,
    importedMessages: 0,
    skippedMessages: 0,
    messageIdsDiscovered: 0,
    contentUnavailableMessages: 0,
    errorCount: 0,
    lastError: '',
    warning: '',
    pageTokenValidated: false,
    pageName: '',
    tokenPageId: '',
    syncVersion: 4,
    historyDays: HISTORY_IMPORT_DAYS,
    cutoffAt,
    olderConversationsSkipped: 0,
    cutoffReached: false,
    phase: 'validating',
    listedConversations: 0,
    listPages: 0,
    interrupted: false,
    truncated: false
  };
  saveFacebookHistorySyncState(facebookHistorySyncJob);

  try {
    const validation = await validateFacebookHistoryConfiguration();
    facebookHistorySyncJob.pageTokenValidated = true;
    facebookHistorySyncJob.pageName = safeString(validation?.pageName);
    facebookHistorySyncJob.tokenPageId = safeString(validation?.pageId);
    facebookHistorySyncJob.phase = 'listing';
    saveFacebookHistorySyncState(facebookHistorySyncJob);

    const listed = await listAllFacebookConversations(progress => {
      facebookHistorySyncJob.phase = 'listing';
      facebookHistorySyncJob.listedConversations = Number(progress?.conversationCount || 0);
      facebookHistorySyncJob.listPages = Number(progress?.pageCount || 0);
      facebookHistorySyncJob.olderConversationsSkipped = Number(progress?.olderSkipped || 0);
      facebookHistorySyncJob.cutoffReached = Boolean(progress?.cutoffReached);
      facebookHistorySyncJob.lastProgressAt = new Date().toISOString();
      saveFacebookHistorySyncState(facebookHistorySyncJob);
    }, { cutoffAt });
    const conversations = listed.conversations;
    facebookHistorySyncJob.totalConversations = conversations.length;
    facebookHistorySyncJob.listedConversations = conversations.length;
    facebookHistorySyncJob.listPages = Number(listed.pageCount || facebookHistorySyncJob.listPages || 0);
    facebookHistorySyncJob.olderConversationsSkipped = Number(listed.olderSkipped || facebookHistorySyncJob.olderConversationsSkipped || 0);
    facebookHistorySyncJob.cutoffReached = Boolean(listed.cutoffReached);
    facebookHistorySyncJob.phase = 'messages';
    saveFacebookHistorySyncState(facebookHistorySyncJob);

    if (!conversations.length) {
      facebookHistorySyncJob.warning =
        'Meta a retourné 0 conversation Messenger. Vérifiez que le token est bien un Page Access Token de cette Page, que pages_messaging/pages_read_engagement/pages_manage_metadata sont accordées et, pour les vrais clients, que l’accès avancé requis est approuvé.';
      console.warn('⚠️ Facebook historique :', facebookHistorySyncJob.warning);
    }

    // V6.35 : ne plus créer 3 gros tableaux simultanés pendant l'import.
    const knownMessageIds = collectKnownConversationMessageIdsMemorySafe({ includeInstagram:false });
    const historyByKey = loadConversationMapFromJsonArrayMemorySafe(FACEBOOK_HISTORY_PATH);
    const liveByKey = loadConversationMapFromJsonArrayMemorySafe(CONVERSATIONS_LOG_PATH);

    const states = loadConversationStatesAdmin();

    for (let start = 0; start < conversations.length; start += 2) {
      const batch = conversations.slice(start, start + 2);
      const results = await Promise.all(
        batch.map(async conversation => {
          try {
            const messages = await getAllFacebookConversationMessages(conversation.id, cutoffAt);
            const identity = facebookConversationCustomerIdentity(conversation, messages);
            const customerId = identity.id;
            if (!customerId) {
              return { conversation, messages, error: 'Client Facebook non identifiable.' };
            }
            const profile = await getFacebookHistoryProfile(customerId);
            if (!safeString(profile?.name) && safeString(identity.name)) profile.name = safeString(identity.name);
            return { conversation, messages, customerId, profile, participantName:safeString(identity.name) };
          } catch (error) {
            return { conversation, messages: [], error: error.message };
          }
        })
      );

      for (const result of results) {
        facebookHistorySyncJob.processedConversations += 1;

        if (result.error) {
          facebookHistorySyncJob.errorCount += 1;
          facebookHistorySyncJob.lastError = result.error;
          continue;
        }

        const customerId = result.customerId;
        const contact = `facebook:${customerId}`;
        const ordered = [...result.messages].sort(
          (a, b) => new Date(a?.created_time || 0) - new Date(b?.created_time || 0)
        );

        facebookHistorySyncJob.messageIdsDiscovered += ordered.length;
        let conversationAdded = false;
        let earliestTime = '';
        let latestInboundTime = '';
        let lastInboundType = '';

        for (const message of ordered) {
          const messageId = safeString(message?.id);
          if (messageId && knownMessageIds.has(messageId)) {
            facebookHistorySyncJob.skippedMessages += 1;
            continue;
          }

          const fromId = safeString(message?.from?.id);
          const directionKnown = Boolean(fromId);
          const outgoing = directionKnown && fromId === FACEBOOK_PAGE_ID;
          const text = safeString(message?.message);
          const time =
            safeString(message?.created_time) ||
            safeString(result.conversation?.updatedTime) ||
            startedAt;

          const storedAttachments = message?.meta_content_available === false
            ? []
            : await persistFacebookHistoryAttachments(message);

          earliestTime = earliestTime ? minIso(earliestTime, time) : time;
          if (directionKnown && !outgoing) {
            latestInboundTime = latestInboundTime
              ? maxIso(latestInboundTime, time)
              : time;
            lastInboundType = text ? 'text' : (storedAttachments[0]?.type || 'history');
          }

          const entry = {
            message_id: messageId || null,
            meta_message_id: messageId || null,
            contact,
            external_contact: customerId,
            channel: 'facebook',
            action: 'history_import',
            source: !directionKnown
              ? 'facebook_history_meta_limited'
              : outgoing
                ? 'facebook_meta_history'
                : 'facebook_history_import',
            direction: !directionKnown
              ? 'unknown'
              : outgoing
                ? 'outgoing'
                : 'incoming',
            sender_kind: !directionKnown ? 'system' : (outgoing ? 'meta' : 'client'),
            history_import: true,
            facebook_conversation_id: safeString(result.conversation?.id),
            facebook_conversation_link: safeString(result.conversation?.link),
            meta_content_available: message?.meta_content_available !== false,
            meta_detail_limit_reason: safeString(message?.meta_detail_limit_reason),
            reply_to: message?.reply_to || undefined,
            attachments: storedAttachments,
            attachment_direction: directionKnown ? (outgoing ? 'outgoing' : 'incoming') : 'unknown',
            raw_attachments: message?.attachments || undefined,
            meta_created_time: time,
            time
          };

          if (message?.meta_content_available === false) {
            facebookHistorySyncJob.contentUnavailableMessages += 1;
          }

          if (!directionKnown) {
            entry.type = 'history';
            entry.message_text = text || undefined;
          } else if (outgoing) {
            entry.reply = text;
            entry.reply_sent = true;
            entry.facebook_response_owner = 'meta_or_business_suite';
          } else {
            entry.incoming = text;
            entry.reply_sent = false;
            entry.type = text ? 'text' : (storedAttachments[0]?.type || 'history');
          }

          historyByKey.set(conversationLogDedupeKey(entry), entry);
          if (messageId) knownMessageIds.add(messageId);
          conversationAdded = true;
          facebookHistorySyncJob.importedMessages += 1;
        }

        const current = states[contact] && typeof states[contact] === 'object'
          ? states[contact]
          : {};

        states[contact] = {
          ...current,
          channel: 'facebook',
          externalContact: customerId,
          facebookPsid: customerId,
          facebookPageId: FACEBOOK_PAGE_ID,
          profileName: safeString(result.profile?.name || current.profileName),
          profilePicture: safeString(result.profile?.profilePicture || current.profilePicture),
          profileUpdatedAt:
            result.profile && Object.keys(result.profile).length
              ? startedAt
              : safeString(current.profileUpdatedAt),
          firstSeenAt: current.firstSeenAt
            ? (earliestTime ? minIso(current.firstSeenAt, earliestTime) : current.firstSeenAt)
            : (earliestTime || safeString(result.conversation?.updatedTime) || startedAt),
          lastCustomerAt: latestInboundTime
            ? maxIso(current.lastCustomerAt, latestInboundTime)
            : safeString(current.lastCustomerAt),
          lastInboundType: lastInboundType || safeString(current.lastInboundType),
          unreadCount: Number(current.unreadCount || 0),
          facebookResponseMode: 'meta_business_ai',
          mondecoAiEnabled: false,
          aiModePreference: 'meta',
          aiModeChoicePending: false,
          facebookHistoryImported: true,
          facebookHistoryConversationId: safeString(result.conversation?.id),
          facebookConversationLink: safeString(result.conversation?.link),
          facebookHistoryUpdatedTime: safeString(result.conversation?.updatedTime),
          facebookHistoryImportedAt: startedAt
        };

        if (conversationAdded) facebookHistorySyncJob.importedConversations += 1;
      }

      const shouldCheckpoint =
        facebookHistorySyncJob.processedConversations % 20 === 0 ||
        facebookHistorySyncJob.processedConversations >= conversations.length;

      if (shouldCheckpoint) {
        // Écriture progressive : pas de [...map.values()] + JSON.stringify géant.
        writeJsonArrayIterableAtomic(FACEBOOK_HISTORY_PATH, historyByKey.values());
        saveConversationStatesAdmin(states);
      }

      saveFacebookHistorySyncState({
        ...facebookHistorySyncJob,
        lastProgressAt: new Date().toISOString()
      });
    }

    facebookHistorySyncJob.running = false;
    facebookHistorySyncJob.phase = 'completed';
    facebookHistorySyncJob.completedAt = new Date().toISOString();
    saveFacebookHistorySyncState(facebookHistorySyncJob);
  } catch (error) {
    facebookHistorySyncJob.running = false;
    facebookHistorySyncJob.phase = 'error';
    facebookHistorySyncJob.completedAt = new Date().toISOString();
    facebookHistorySyncJob.errorCount += 1;
    facebookHistorySyncJob.lastError = error.message;
    saveFacebookHistorySyncState(facebookHistorySyncJob);
    console.error('❌ Synchronisation historique Facebook :', error);
  }
}


// ============================================================
// V6.29.1 — FACEBOOK MESSENGER TEMPS RÉEL + FILET DE SÉCURITÉ
// ============================================================
// Le webhook reste la voie principale. Cette synchronisation incrémentale
// récupère uniquement les conversations récentes si Meta ne livre pas un
// webhook ou si l'abonnement de Page a été momentanément interrompu.

let facebookRealtimeSyncJob = {
  running: false,
  lastRunAt: '',
  lastCompletedAt: '',
  importedMessages: 0,
  importedInbound: 0,
  importedOutbound: 0,
  conversationsScanned: 0,
  conversationPagesScanned: 0,
  latestGraphConversationAt: '',
  recoveryCutoffAt: '',
  webhookFields: [],
  webhookMessagesSubscribed: null,
  webhookCheckAt: '',
  webhookRepairAttemptedAt: '',
  webhookRepairSuccess: null,
  lastError: ''
};

// V6.33.1 — récupération sûre après une panne de webhook/token.
// Le premier rattrapage regarde jusqu'à 48 h en arrière ; ensuite on repart
// du dernier succès avec 15 minutes de chevauchement. Cela récupère les
// messages manqués sans rescanner 15 jours à chaque minute.
const FACEBOOK_REALTIME_LOOKBACK_MINUTES = Math.max(
  60,
  Math.min(7 * 24 * 60, Number(process.env.FACEBOOK_REALTIME_LOOKBACK_MINUTES || 2880) || 2880)
);
const FACEBOOK_REALTIME_OVERLAP_MINUTES = Math.max(
  5,
  Math.min(120, Number(process.env.FACEBOOK_REALTIME_OVERLAP_MINUTES || 15) || 15)
);
const FACEBOOK_REALTIME_MAX_CONVERSATION_PAGES = Math.max(
  3,
  Math.min(40, Number(process.env.FACEBOOK_REALTIME_MAX_CONVERSATION_PAGES || 20) || 20)
);
const FACEBOOK_REALTIME_POLL_MS = Math.max(
  30000,
  Math.min(10 * 60 * 1000, Number(process.env.FACEBOOK_REALTIME_POLL_MS || 60000) || 60000)
);
const FACEBOOK_REALTIME_MIN_GAP_MS = 25000;

function loadFacebookRealtimeSyncState() {
  try {
    if (!fs.existsSync(FACEBOOK_REALTIME_SYNC_STATE_PATH)) return {};
    const parsed = JSON.parse(
      fs.readFileSync(FACEBOOK_REALTIME_SYNC_STATE_PATH, 'utf8') || '{}'
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function saveFacebookRealtimeSyncState(extra = {}) {
  const merged = {
    ...loadFacebookRealtimeSyncState(),
    ...facebookRealtimeSyncJob,
    ...(extra && typeof extra === 'object' ? extra : {})
  };
  writeJsonAtomic(FACEBOOK_REALTIME_SYNC_STATE_PATH, merged);
}

function facebookRecoveredPreview(entry) {
  const text = safeString(entry?.incoming || entry?.reply);
  if (text) return text.slice(0, 220);
  const attachments = Array.isArray(entry?.attachments) ? entry.attachments : [];
  const type = safeString(attachments?.[0]?.type || entry?.type).toLowerCase();
  if (type === 'image') return '📷 Photo envoyée';
  if (type === 'audio') return '🎤 Message vocal';
  if (type === 'video') return '🎬 Vidéo';
  if (type === 'file' || type === 'document') return '📎 Fichier';
  return 'Nouveau message Facebook';
}

function registerRecoveredFacebookNotification(entry, state = {}) {
  if (safeString(entry?.direction) !== 'incoming') return;
  const id = safeString(entry?.message_id || entry?.meta_message_id);
  const contact = safeString(entry?.contact);
  if (!id || !contact) return;

  try {
    const store = loadNotificationsStore();
    if (store.items.some(item => safeString(item?.id) === id)) return;
    const attachments = Array.isArray(entry?.attachments) ? entry.attachments : [];
    store.items.push({
      id,
      messageId: id,
      contact,
      channel: 'facebook',
      externalContact: safeString(entry?.external_contact || state?.externalContact),
      username: '',
      profileName: safeString(state?.profileName),
      profilePicture: safeString(state?.profilePicture),
      preview: facebookRecoveredPreview(entry),
      type: safeString(entry?.type || 'text'),
      urgent: false,
      action: 'facebook_inbound_recovered',
      assignedTo: safeString(state?.assignedTo),
      createdAt: safeString(entry?.time) || new Date().toISOString(),
      readBy: [],
      attachmentPreview:
        safeString(attachments?.[0]?.type) === 'image'
          ? safeString(attachments?.[0]?.url)
          : ''
    });
    // Garde-fou stockage : conserver au maximum les 5000 notifications les plus récentes.
    if (store.items.length > 5000) {
      store.items = store.items
        .sort((a, b) => new Date(a?.createdAt || 0) - new Date(b?.createdAt || 0))
        .slice(-5000);
    }
    saveNotificationsStore(store);
  } catch (error) {
    console.warn('⚠️ Notification Facebook récupérée non enregistrée :', error.message);
  }
}

async function facebookRealtimeWebhookStatus({ tryRepair = false } = {}) {
  const result = {
    fields: [],
    messagesSubscribed: null,
    checkedAt: new Date().toISOString(),
    repairAttempted: false,
    repairSuccess: null,
    error: ''
  };

  if (!FACEBOOK_PAGE_ID || !FACEBOOK_MESSENGER_TOKEN) {
    result.error = 'FACEBOOK_PAGE_ID ou FACEBOOK_MESSENGER_TOKEN manquant.';
    return result;
  }

  const endpoint =
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(FACEBOOK_PAGE_ID)}/subscribed_apps`;

  const readFields = async () => {
    const data = await facebookGraphGet(endpoint);
    return Array.isArray(data?.data)
      ? [...new Set(
          data.data.flatMap(item =>
            Array.isArray(item?.subscribed_fields) ? item.subscribed_fields : []
          ).map(safeString).filter(Boolean)
        )]
      : [];
  };

  const subscribeFields = async fields => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FACEBOOK_MESSENGER_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ subscribed_fields: fields.join(',') }).toString()
    });
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok || body?.success === false) {
      throw new Error(
        safeString(body?.error?.message) || `Facebook HTTP ${response.status}`
      );
    }
    return body;
  };

  try {
    result.fields = await readFields();
    result.messagesSubscribed = result.fields.includes('messages');

    // V6.33.1 : réparer d'abord UNIQUEMENT le champ indispensable `messages`.
    // Avant, on tentait en une seule requête messages + feed + plusieurs champs
    // optionnels. Un seul champ refusé par les permissions pouvait faire échouer
    // toute la souscription Messenger.
    if (tryRepair && !result.messagesSubscribed) {
      result.repairAttempted = true;
      try {
        await subscribeFields(['messages']);
        result.fields = await readFields();
        result.messagesSubscribed = result.fields.includes('messages');
        result.repairSuccess = result.messagesSubscribed;

        // Une fois `messages` garanti, les champs secondaires sont ajoutés un par
        // un. Leur échec ne doit jamais retirer/casser la réception des messages.
        const optionalFields = [
          'message_echoes',
          'message_edits',
          'message_deliveries',
          'message_reads',
          'message_reactions',
          'messaging_postbacks',
          'messaging_referrals'
        ];
        for (const field of optionalFields) {
          if (result.fields.includes(field)) continue;
          try {
            await subscribeFields([field]);
          } catch (optionalError) {
            console.debug(`Facebook webhook optionnel ${field}:`, optionalError.message);
          }
        }
        result.fields = await readFields();
      } catch (error) {
        result.repairSuccess = false;
        result.error = `Réabonnement webhook messages : ${error.message}`;
      }
    }
  } catch (error) {
    result.error = `Lecture abonnement webhook : ${error.message}`;
  }

  return result;
}

async function listRecentFacebookConversations(cutoffAt) {
  const recent = [];
  const seen = new Set();
  let nextUrl =
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(FACEBOOK_PAGE_ID)}/conversations` +
    `?platform=messenger&fields=${encodeURIComponent('id,link,updated_time,participants{id,name}')}&limit=50`;
  let pageCount = 0;
  let latestUpdatedTime = '';

  while (nextUrl && pageCount < FACEBOOK_REALTIME_MAX_CONVERSATION_PAGES) {
    const data = await facebookGraphGet(nextUrl);
    const rows = Array.isArray(data?.data) ? data.data : [];
    let recentOnPage = 0;
    let datedOnPage = 0;
    let olderOnPage = 0;

    for (const row of rows) {
      const id = safeString(row?.id);
      const updated = safeString(row?.updated_time);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (Number.isFinite(Date.parse(updated))) {
        datedOnPage += 1;
        if (!latestUpdatedTime || Date.parse(updated) > Date.parse(latestUpdatedTime)) {
          latestUpdatedTime = updated;
        }
      }
      if (!historyTimeIsRecent(updated, cutoffAt)) {
        olderOnPage += 1;
        continue;
      }
      recentOnPage += 1;
      recent.push({
        id,
        link: safeString(row?.link),
        updatedTime: updated,
        participants: row?.participants && typeof row.participants === 'object' ? row.participants : undefined
      });
    }

    pageCount += 1;
    // Arrêt seulement lorsqu'une page datée entière est plus ancienne que le
    // cutoff. Cela évite l'ancien plafond de 75 conversations qui pouvait
    // manquer des messages dans une Inbox MONDECO très active.
    if (
      rows.length > 0 &&
      datedOnPage > 0 &&
      recentOnPage === 0 &&
      olderOnPage === datedOnPage
    ) {
      break;
    }
    nextUrl = safeString(data?.paging?.next);
  }

  return { conversations: recent, pageCount, latestUpdatedTime };
}

async function runFacebookRealtimeRecovery({ force = false } = {}) {
  if (!FACEBOOK_PAGE_ID || !FACEBOOK_MESSENGER_TOKEN) {
    return { configured: false, skipped: true };
  }
  if (facebookRealtimeSyncJob.running) {
    return { configured: true, skipped: true, reason: 'realtime_sync_running' };
  }
  // V6.33.1 : le rattrapage des nouveaux messages est prioritaire.
  // L'ancien code le bloquait pendant toute la synchronisation historique
  // Facebook, qui peut durer longtemps avec plusieurs milliers de conversations.
  // L'historique n'est désormais plus lancé automatiquement côté interface.
  if (facebookHistorySyncJob.running) {
    console.warn('⚡ Facebook temps réel prioritaire : historique en cours, rattrapage lancé quand même.');
  }

  const persisted = loadFacebookRealtimeSyncState();
  const lastMs = Date.parse(
    safeString(
      facebookRealtimeSyncJob.lastCompletedAt ||
      persisted?.lastCompletedAt
    )
  );
  if (
    !force &&
    Number.isFinite(lastMs) &&
    Date.now() - lastMs < FACEBOOK_REALTIME_MIN_GAP_MS
  ) {
    return { configured: true, skipped: true, reason: 'cooldown' };
  }

  const startedAt = new Date().toISOString();
  const previousSuccessfulMs = Date.parse(safeString(persisted?.lastSuccessfulAt));
  const fallbackCutoffMs = Date.now() - FACEBOOK_REALTIME_LOOKBACK_MINUTES * 60 * 1000;
  const incrementalCutoffMs = Number.isFinite(previousSuccessfulMs)
    ? previousSuccessfulMs - FACEBOOK_REALTIME_OVERLAP_MINUTES * 60 * 1000
    : fallbackCutoffMs;
  const cutoffAt = new Date(Math.max(fallbackCutoffMs, incrementalCutoffMs)).toISOString();

  facebookRealtimeSyncJob = {
    ...facebookRealtimeSyncJob,
    running: true,
    lastRunAt: startedAt,
    importedMessages: 0,
    importedInbound: 0,
    importedOutbound: 0,
    conversationsScanned: 0,
    lastError: ''
  };
  saveFacebookRealtimeSyncState();

  try {
    // Contrôle du webhook au maximum une fois par heure.
    const previousCheckMs = Date.parse(
      safeString(persisted?.webhookCheckAt || facebookRealtimeSyncJob.webhookCheckAt)
    );
    if (!Number.isFinite(previousCheckMs) || Date.now() - previousCheckMs > 60 * 60 * 1000) {
      const webhook = await facebookRealtimeWebhookStatus({ tryRepair: true });
      facebookRealtimeSyncJob.webhookFields = webhook.fields;
      facebookRealtimeSyncJob.webhookMessagesSubscribed = webhook.messagesSubscribed;
      facebookRealtimeSyncJob.webhookCheckAt = webhook.checkedAt;
      if (webhook.repairAttempted) {
        facebookRealtimeSyncJob.webhookRepairAttemptedAt = webhook.checkedAt;
        facebookRealtimeSyncJob.webhookRepairSuccess = webhook.repairSuccess;
      }
      if (webhook.error) {
        console.warn('⚠️ Facebook webhook temps réel :', webhook.error);
      }
    }

    const recentResult = await listRecentFacebookConversations(cutoffAt);
    const conversations = recentResult.conversations;
    facebookRealtimeSyncJob.conversationsScanned = conversations.length;
    facebookRealtimeSyncJob.conversationPagesScanned = recentResult.pageCount;
    facebookRealtimeSyncJob.latestGraphConversationAt = recentResult.latestUpdatedTime;
    facebookRealtimeSyncJob.recoveryCutoffAt = cutoffAt;

    if (!conversations.length) {
      facebookRealtimeSyncJob.running = false;
      facebookRealtimeSyncJob.lastCompletedAt = new Date().toISOString();
      facebookRealtimeSyncJob.lastSuccessfulAt = facebookRealtimeSyncJob.lastCompletedAt;
      saveFacebookRealtimeSyncState();
      return {
        configured: true,
        importedMessages: 0,
        conversationsScanned: 0,
        conversationPagesScanned: recentResult.pageCount,
        latestGraphConversationAt: recentResult.latestUpdatedTime,
        webhookMessagesSubscribed: facebookRealtimeSyncJob.webhookMessagesSubscribed
      };
    }

    const realtimeWriteToLive = facebookHistorySyncJob.running === true;
    const knownMessageIds = collectKnownConversationMessageIdsMemorySafe({ includeInstagram:false });
    const historyByKey = realtimeWriteToLive
      ? new Map()
      : loadConversationMapFromJsonArrayMemorySafe(FACEBOOK_HISTORY_PATH);
    const liveByKey = realtimeWriteToLive
      ? loadConversationMapFromJsonArrayMemorySafe(CONVERSATIONS_LOG_PATH)
      : new Map();

    const states = loadConversationStatesAdmin();
    let changed = false;

    for (const conversation of conversations) {
      let messages = [];
      try {
        messages = await getAllFacebookConversationMessages(conversation.id, cutoffAt);
      } catch (error) {
        console.warn(
          `⚠️ Récupération Facebook récente ${safeString(conversation.id)} :`,
          error.message
        );
        continue;
      }

      const identity = facebookConversationCustomerIdentity(conversation, messages);
      const customerId = identity.id;
      if (!customerId) continue;
      const contact = `facebook:${customerId}`;
      let state = states[contact] && typeof states[contact] === 'object'
        ? { ...states[contact] }
        : {};

      let profile = {};
      if (!safeString(state?.profileName) || !safeString(state?.profilePicture)) {
        try {
          profile = await getFacebookHistoryProfile(customerId);
        } catch (error) {
          // V6.35.2 : cette erreur était auparavant totalement silencieuse,
          // ce qui rendait impossible le diagnostic d'un nom/photo qui ne
          // s'affiche jamais (ex: permission Meta manquante, PSID expiré).
          console.warn(`⚠️ Profil Facebook ${safeString(customerId)} :`, error.message);
        }
      }
      if (!safeString(profile?.name) && safeString(identity.name)) {
        profile.name = safeString(identity.name);
      }
      const profileChanged = Boolean(
        (safeString(profile?.name) && safeString(profile?.name) !== safeString(state?.profileName)) ||
        (safeString(profile?.profilePicture) && safeString(profile?.profilePicture) !== safeString(state?.profilePicture))
      );

      let newInbound = 0;
      let conversationChanged = false;
      const notifyEntries = [];
      let latestInbound = safeString(state?.lastCustomerAt);
      let latestBusiness = safeString(state?.lastBusinessAt);
      let earliest = safeString(state?.firstSeenAt);

      const ordered = [...messages].sort(
        (a, b) => conversationTimeMs(a?.created_time) - conversationTimeMs(b?.created_time)
      );

      for (const message of ordered) {
        const messageId = safeString(message?.id);
        if (!messageId || knownMessageIds.has(messageId)) continue;

        const fromId = safeString(message?.from?.id);
        if (!fromId) continue;
        const outgoing = fromId === FACEBOOK_PAGE_ID;
        const textValue = safeString(message?.message);
        const time =
          safeString(message?.created_time) ||
          safeString(conversation?.updatedTime) ||
          startedAt;
        const storedAttachments = message?.meta_content_available === false
          ? []
          : await persistFacebookHistoryAttachments(message);

        const entry = {
          message_id: messageId,
          meta_message_id: messageId,
          contact,
          external_contact: customerId,
          channel: 'facebook',
          action: outgoing
            ? 'facebook_outbound_recovered'
            : 'facebook_inbound_recovered',
          source: 'facebook_recent_recovery',
          direction: outgoing ? 'outgoing' : 'incoming',
          sender_kind: outgoing ? 'meta' : 'client',
          history_import: false,
          recovered_sync: true,
          facebook_conversation_id: safeString(conversation?.id),
          facebook_conversation_link: safeString(conversation?.link),
          meta_content_available: message?.meta_content_available !== false,
          meta_detail_limit_reason: safeString(message?.meta_detail_limit_reason),
          reply_to: message?.reply_to || undefined,
          attachments: storedAttachments,
          attachment_direction: outgoing ? 'outgoing' : 'incoming',
          raw_attachments: message?.attachments || undefined,
          meta_created_time: time,
          time
        };

        if (outgoing) {
          entry.reply = textValue;
          entry.reply_sent = true;
          entry.facebook_response_owner = 'meta_or_business_suite';
          latestBusiness = latestBusiness ? maxIso(latestBusiness, time) : time;
          facebookRealtimeSyncJob.importedOutbound += 1;
        } else {
          entry.incoming = textValue;
          entry.reply_sent = false;
          entry.type = textValue ? 'text' : (storedAttachments?.[0]?.type || 'message');
          latestInbound = latestInbound ? maxIso(latestInbound, time) : time;
          newInbound += 1;
          facebookRealtimeSyncJob.importedInbound += 1;
        }

        earliest = earliest ? minIso(earliest, time) : time;
        if (realtimeWriteToLive) {
          liveByKey.set(conversationLogDedupeKey(entry), entry);
        } else {
          historyByKey.set(conversationLogDedupeKey(entry), entry);
        }
        knownMessageIds.add(messageId);
        facebookRealtimeSyncJob.importedMessages += 1;
        changed = true;
        conversationChanged = true;

        if (!outgoing) {
          notifyEntries.push(entry);
        }
      }

      // Même sans nouveau message, réparer les anciens Facebook affichés
      // seulement avec leur PSID lorsque Meta donne désormais le nom/photo.
      if (!conversationChanged && !profileChanged) continue;

      state = {
        ...state,
        channel: 'facebook',
        externalContact: customerId,
        facebookPsid: customerId,
        facebookPageId: FACEBOOK_PAGE_ID,
        profileName: safeString(profile?.name || state?.profileName),
        profilePicture: safeString(profile?.profilePicture || state?.profilePicture),
        profileUpdatedAt:
          profile && Object.keys(profile).length
            ? startedAt
            : safeString(state?.profileUpdatedAt),
        firstSeenAt: earliest || safeString(state?.firstSeenAt) || startedAt,
        lastCustomerAt: latestInbound || safeString(state?.lastCustomerAt),
        lastBusinessAt: latestBusiness || safeString(state?.lastBusinessAt),
        unreadCount: Number(state?.unreadCount || 0) + newInbound,
        facebookResponseMode: 'commercial_enabled',
        mondecoAiEnabled: false,
        aiModePreference: 'meta',
        aiModeChoicePending: false,
        facebookHistoryImported: true,
        facebookHistoryConversationId: safeString(conversation?.id),
        facebookConversationLink: safeString(conversation?.link),
        facebookHistoryUpdatedTime: safeString(conversation?.updatedTime),
        facebookRealtimeRecoveredAt: startedAt
      };
      states[contact] = state;
      if (profileChanged) changed = true;

      for (const entry of notifyEntries) {
        registerRecoveredFacebookNotification(entry, state);
      }
    }

    if (changed) {
      if (realtimeWriteToLive) {
        const liveList = [...liveByKey.values()]
          .sort((a, b) => new Date(a?.time || 0) - new Date(b?.time || 0));
        writeJsonAtomic(CONVERSATIONS_LOG_PATH, liveList);
      } else if (facebookRealtimeSyncJob.importedMessages > 0) {
        writeJsonArrayIterableAtomic(FACEBOOK_HISTORY_PATH, historyByKey.values());
      }
      // Recharger l'état courant avant de sauvegarder afin de ne pas écraser
      // une affectation/favori effectuée pendant le rattrapage.
      const freshestStates = loadConversationStatesAdmin();
      for (const [contact, state] of Object.entries(states)) {
        const freshest = freshestStates[contact] || {};
        const merged = { ...freshest, ...state };

        // V6.33.1 — le rattrapage Facebook peut finir après qu'un commercial
        // a lu/répondu. Préserver les horodatages les plus récents empêche
        // l'ancien unreadCount de revenir à 1.
        merged.lastCustomerAt = maxIso(freshest.lastCustomerAt, state.lastCustomerAt);
        merged.lastReadAt = maxIso(freshest.lastReadAt, state.lastReadAt);
        merged.lastAnsweredAt = maxIso(freshest.lastAnsweredAt, state.lastAnsweredAt);
        merged.lastAnsweredCustomerAt = maxIso(
          freshest.lastAnsweredCustomerAt,
          state.lastAnsweredCustomerAt
        );
        merged.lastHumanAt = maxIso(freshest.lastHumanAt, state.lastHumanAt);

        const lastCustomerMs = Date.parse(safeString(merged.lastCustomerAt));
        const lastReadMs = Date.parse(safeString(merged.lastReadAt));
        const lastAnsweredMs = Date.parse(safeString(merged.lastAnsweredAt));
        const acknowledgedMs = Math.max(
          Number.isFinite(lastReadMs) ? lastReadMs : 0,
          Number.isFinite(lastAnsweredMs) ? lastAnsweredMs : 0
        );

        if (Number.isFinite(lastCustomerMs) && acknowledgedMs >= lastCustomerMs) {
          merged.unreadCount = 0;
          merged.lastUnreadMessageId = '';
        } else {
          merged.unreadCount = Math.max(
            Number(freshest.unreadCount || 0),
            Number(state.unreadCount || 0)
          );
        }

        freshestStates[contact] = merged;
      }
      saveConversationStatesAdmin(freshestStates);
      // Forcer la reconstruction du cache combiné au prochain appel Inbox.
      combinedConversationLogCache = {
        liveStamp: '',
        historyStamp: '',
        facebookHistoryStamp: '',
        persistentStamp: '',
        entries: []
      };
    }

    facebookRealtimeSyncJob.running = false;
    facebookRealtimeSyncJob.lastCompletedAt = new Date().toISOString();
    facebookRealtimeSyncJob.lastSuccessfulAt = facebookRealtimeSyncJob.lastCompletedAt;
    saveFacebookRealtimeSyncState();

    if (facebookRealtimeSyncJob.importedMessages > 0) {
      console.log(
        `🔵 Facebook récupération temps réel : ${facebookRealtimeSyncJob.importedMessages} nouveau(x) message(s), ` +
        `${facebookRealtimeSyncJob.importedInbound} entrant(s).`
      );
    }

    return {
      configured: true,
      importedMessages: facebookRealtimeSyncJob.importedMessages,
      importedInbound: facebookRealtimeSyncJob.importedInbound,
      conversationsScanned: facebookRealtimeSyncJob.conversationsScanned,
      conversationPagesScanned: Number(facebookRealtimeSyncJob.conversationPagesScanned || 0),
      latestGraphConversationAt: safeString(facebookRealtimeSyncJob.latestGraphConversationAt),
      recoveryCutoffAt: safeString(facebookRealtimeSyncJob.recoveryCutoffAt),
      webhookMessagesSubscribed: facebookRealtimeSyncJob.webhookMessagesSubscribed
    };
  } catch (error) {
    facebookRealtimeSyncJob.running = false;
    facebookRealtimeSyncJob.lastCompletedAt = new Date().toISOString();
    facebookRealtimeSyncJob.lastError = error.message;
    saveFacebookRealtimeSyncState();
    console.error('❌ Facebook récupération temps réel :', error);
    return {
      configured: true,
      error: error.message,
      importedMessages: 0
    };
  }
}

router.get('/api/facebook-realtime/status', requireAuth, (req, res) => {
  const saved = loadFacebookRealtimeSyncState();
  return res.json({
    configured: Boolean(FACEBOOK_PAGE_ID && FACEBOOK_MESSENGER_TOKEN),
    pollSeconds: Math.round(FACEBOOK_REALTIME_POLL_MS / 1000),
    lookbackMinutes: FACEBOOK_REALTIME_LOOKBACK_MINUTES,
    overlapMinutes: FACEBOOK_REALTIME_OVERLAP_MINUTES,
    maxConversationPages: FACEBOOK_REALTIME_MAX_CONVERSATION_PAGES,
    ...saved,
    ...(facebookRealtimeSyncJob.running ? facebookRealtimeSyncJob : {})
  });
});

router.post('/api/facebook-realtime/sync', requireAuth, async (req, res) => {
  const result = await runFacebookRealtimeRecovery({ force: req.query?.force === '1' });
  return res.status(result?.error ? 502 : 200).json(result);
});

// Le serveur Railway effectue aussi le rattrapage même si aucun navigateur
// n'est ouvert. Le timer est "unref" pour ne pas empêcher l'arrêt propre Node.
if (FACEBOOK_PAGE_ID && FACEBOOK_MESSENGER_TOKEN) {
  const initialFacebookRealtimeTimer = setTimeout(() => {
    runFacebookRealtimeRecovery({ force: true }).catch(() => {});
  }, 12000);
  if (typeof initialFacebookRealtimeTimer.unref === 'function') {
    initialFacebookRealtimeTimer.unref();
  }

  const facebookRealtimeTimer = setInterval(() => {
    runFacebookRealtimeRecovery().catch(() => {});
  }, FACEBOOK_REALTIME_POLL_MS);
  if (typeof facebookRealtimeTimer.unref === 'function') {
    facebookRealtimeTimer.unref();
  }
}

router.get('/api/facebook-history/status', requireAuth, (req, res) => {
  try {
    const persisted = loadFacebookHistorySyncState();

    // GET = lecture seule : aucune écriture concurrente dans le fichier
    // d'état pendant le polling du navigateur.
    const effectivePersisted =
      !facebookHistorySyncJob.running && persisted?.running === true
        ? {
            ...persisted,
            running: false,
            interrupted: true,
            phase: 'interrupted',
            interruptedAt: safeString(persisted?.interruptedAt) || new Date().toISOString(),
            lastError: safeString(persisted?.lastError) || 'Synchronisation interrompue par un redémarrage du service Railway.'
          }
        : persisted;

    return res.json({
      configured: Boolean(FACEBOOK_PAGE_ID && FACEBOOK_MESSENGER_TOKEN),
      ...effectivePersisted,
      ...(facebookHistorySyncJob.running ? facebookHistorySyncJob : {})
    });
  } catch (error) {
    console.error('❌ Statut historique Facebook :', error);
    return res.status(500).json({
      error: 'Impossible de lire l’état Facebook. Consultez les logs Railway.'
    });
  }
});

router.post(
  '/api/facebook-history/sync',
  requireAdminOrCommercialManager,
  (req, res) => {
    if (!FACEBOOK_PAGE_ID || !FACEBOOK_MESSENGER_TOKEN) {
      return res.status(400).json({
        error: 'Facebook Messenger n’est pas complètement configuré dans Railway.'
      });
    }

    if (facebookHistorySyncJob.running) {
      return res.status(202).json({
        success: true,
        alreadyRunning: true,
        job: facebookHistorySyncJob
      });
    }

    setImmediate(() => {
      runFacebookHistorySync().catch(error => {
        console.error('❌ Job historique Facebook :', error);
      });
    });

    return res.status(202).json({ success: true, started: true });
  }
);


// ============================================================
// V6.26 — CENTRE DE COMMENTAIRES FACEBOOK + INSTAGRAM
// ============================================================


// V6.33.1 — diagnostic sans exposer les secrets.
router.get('/api/facebook-token-status', requireAuth, (req, res) => {
  res.json({
    ok: true,
    pageId: safeString(FACEBOOK_PAGE_ID),
    messengerConfigured: Boolean(FACEBOOK_PAGE_ID && FACEBOOK_MESSENGER_TOKEN),
    commentsConfigured: Boolean(FACEBOOK_PAGE_ID && FACEBOOK_COMMENTS_TOKEN),
    legacyFallbackConfigured: Boolean(FACEBOOK_LEGACY_PAGE_TOKEN),
    separatedTokens: Boolean(FACEBOOK_MESSENGER_TOKEN && FACEBOOK_COMMENTS_TOKEN && FACEBOOK_MESSENGER_TOKEN !== FACEBOOK_COMMENTS_TOKEN),
    commentsPageTokenAutoResolve: true
  });
});

async function graphJsonRequest(url, token, options = {}) {
  if (!token) throw new Error('Token Meta manquant.');
  const method = safeString(options?.method || 'GET').toUpperCase();
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (options?.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options?.form && typeof options.form === 'object') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }

  let lastError;
  for (let attempt = 1; attempt <= GRAPH_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      let data = {};
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok) {
        const message = safeString(data?.error?.message) || `Meta HTTP ${response.status}`;
        const error = new Error(message);
        error.metaCode = data?.error?.code;
        error.metaSubcode = data?.error?.error_subcode;
        error.httpStatus = response.status;
        if (attempt < GRAPH_REQUEST_MAX_ATTEMPTS && isRetryableMetaHttpStatus(response.status)) {
          lastError = error;
          await sleep(GRAPH_REQUEST_RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
      return data;
    } catch (error) {
      const transient = isTransientGraphNetworkError(error);
      if (transient && attempt < GRAPH_REQUEST_MAX_ATTEMPTS) {
        lastError = error;
        await sleep(GRAPH_REQUEST_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      if (transient) {
        const timeoutError = new Error(
          `Meta Graph API injoignable après ${GRAPH_REQUEST_MAX_ATTEMPTS} tentatives (réseau) : ${error.message}`
        );
        timeoutError.transientNetwork = true;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Requête Meta Graph API impossible.');
}

// V6.33.1 — Publications/commentaires Facebook doivent TOUJOURS être exécutés
// au nom de la Page. Si FACEBOOK_COMMENTS_TOKEN contient accidentellement un
// User Access Token, MONDECO tente de dériver le Page Access Token de
// FACEBOOK_PAGE_ID avant toute lecture/modération. Aucun token dérivé n'est
// écrit sur disque ni exposé dans les logs.
let facebookCommentsPageTokenCache = {
  sourceToken:'',
  pageToken:'',
  pageId:'',
  pageName:'',
  checkedAt:0,
  derived:false
};

function clearFacebookCommentsPageTokenCache(){
  facebookCommentsPageTokenCache = {
    sourceToken:'', pageToken:'', pageId:'', pageName:'', checkedAt:0, derived:false
  };
}

async function resolveFacebookCommentsPageToken({ force = false } = {}) {
  if (!FACEBOOK_COMMENTS_TOKEN) {
    throw new Error('FACEBOOK_COMMENTS_TOKEN manquant dans Railway.');
  }
  if (!FACEBOOK_PAGE_ID) {
    throw new Error('FACEBOOK_PAGE_ID manquant dans Railway.');
  }

  const now = Date.now();
  const cached = facebookCommentsPageTokenCache;
  if (
    !force &&
    cached.pageToken &&
    cached.sourceToken === FACEBOOK_COMMENTS_TOKEN &&
    cached.pageId === FACEBOOK_PAGE_ID &&
    now - Number(cached.checkedAt || 0) < 5 * 60 * 1000
  ) {
    return cached.pageToken;
  }

  const meUrl = `https://graph.facebook.com/${META_API_VERSION}/me?fields=${encodeURIComponent('id,name')}`;
  const me = await graphJsonRequest(meUrl, FACEBOOK_COMMENTS_TOKEN);
  const ownerId = safeString(me?.id);

  // Cas idéal : Railway contient déjà le Page Access Token de Mondeco.tn.
  if (ownerId === safeString(FACEBOOK_PAGE_ID)) {
    facebookCommentsPageTokenCache = {
      sourceToken:FACEBOOK_COMMENTS_TOKEN,
      pageToken:FACEBOOK_COMMENTS_TOKEN,
      pageId:ownerId,
      pageName:safeString(me?.name),
      checkedAt:now,
      derived:false
    };
    return FACEBOOK_COMMENTS_TOKEN;
  }

  // Cas fréquent après régénération dans Graph API Explorer : un User Token a
  // été collé dans Railway. On demande alors explicitement le token de la Page.
  const pageUrl =
    `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(FACEBOOK_PAGE_ID)}` +
    `?fields=${encodeURIComponent('id,name,access_token')}`;
  let page;
  try {
    page = await graphJsonRequest(pageUrl, FACEBOOK_COMMENTS_TOKEN);
  } catch (error) {
    const e = new Error(
      `FACEBOOK_COMMENTS_TOKEN appartient à l'utilisateur ${safeString(me?.name || ownerId || 'inconnu')} et MONDECO ne peut pas obtenir le Page Access Token de Mondeco.tn. ` +
      `Générez un Page Access Token avec pages_read_engagement, pages_read_user_content et pages_manage_engagement.`
    );
    e.metaCode = error?.metaCode;
    throw e;
  }

  const derivedToken = safeString(page?.access_token);
  if (!derivedToken) {
    throw new Error(
      `FACEBOOK_COMMENTS_TOKEN est un User Access Token (${safeString(me?.name || ownerId)}). ` +
      `Meta n'a pas retourné le Page Access Token de Mondeco.tn. Remplacez FACEBOOK_COMMENTS_TOKEN par le access_token de la Page ${FACEBOOK_PAGE_ID}.`
    );
  }

  const verify = await graphJsonRequest(meUrl, derivedToken);
  if (safeString(verify?.id) !== safeString(FACEBOOK_PAGE_ID)) {
    throw new Error(
      `Le Page Access Token dérivé appartient à ${safeString(verify?.name || verify?.id)}, pas à la Page ${FACEBOOK_PAGE_ID}.`
    );
  }

  facebookCommentsPageTokenCache = {
    sourceToken:FACEBOOK_COMMENTS_TOKEN,
    pageToken:derivedToken,
    pageId:safeString(verify?.id),
    pageName:safeString(verify?.name),
    checkedAt:now,
    derived:true
  };
  return derivedToken;
}

async function facebookGraphRequestPath(pathname, options = {}) {
  const cleanPath = String(pathname || '').replace(/^\//,'');
  const url = `https://graph.facebook.com/${META_API_VERSION}/${cleanPath}`;
  let token = await resolveFacebookCommentsPageToken();
  try {
    return await graphJsonRequest(url, token, options);
  } catch (error) {
    // Si Meta invalide le token dérivé/ancien, on le résout une seule fois de
    // plus afin qu'un renouvellement côté Meta soit pris en compte proprement.
    if (Number(error?.metaCode || 0) === 190) {
      clearFacebookCommentsPageTokenCache();
      token = await resolveFacebookCommentsPageToken({ force:true });
      return await graphJsonRequest(url, token, options);
    }
    if (/publish_actions/i.test(safeString(error?.message))) {
      throw new Error(
        `Meta refuse la réponse car le token actif n'agit pas au nom de la Page. ` +
        `Vérifiez FACEBOOK_COMMENTS_TOKEN : /me doit retourner Mondeco.tn (${FACEBOOK_PAGE_ID}) et le token doit avoir pages_manage_engagement.`
      );
    }
    throw error;
  }
}

async function instagramGraphRequestPath(pathname, options = {}) {
  const cleanPath = String(pathname || '').replace(/^\//,'');
  const hosts = [
    `https://graph.instagram.com/${META_API_VERSION}/${cleanPath}`,
    `https://graph.facebook.com/${META_API_VERSION}/${cleanPath}`
  ];
  const errors = [];
  for (const url of hosts) {
    try {
      return await graphJsonRequest(url, INSTAGRAM_ACCESS_TOKEN, options);
    } catch (error) {
      errors.push(`${url.includes('graph.instagram.com') ? 'Instagram Login' : 'Facebook Login'}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'Instagram Graph API inaccessible.');
}

async function collectPagedMeta(firstUrl, token, { maxItems = 20000, cutoffAt = '' } = {}) {
  const items = [];
  const seen = new Set();
  let nextUrl = firstUrl;
  while (nextUrl && items.length < maxItems) {
    if (seen.has(nextUrl)) break;
    seen.add(nextUrl);
    const data = await graphJsonRequest(nextUrl, token);
    const page = Array.isArray(data?.data) ? data.data : [];
    items.push(...page);
    if (cutoffAt && page.length) {
      const times = page.map(item => Date.parse(safeString(item?.created_time || item?.timestamp))).filter(Number.isFinite);
      if (times.length && Math.max(...times) < Date.parse(cutoffAt)) break;
    }
    nextUrl = safeString(data?.paging?.next);
  }
  return items.slice(0, maxItems);
}

async function hydrateFacebookPost(postId) {
  if (!postId || !FACEBOOK_COMMENTS_TOKEN) return null;
  try {
    const fields = 'id,message,created_time,permalink_url,full_picture';
    const data = await facebookGraphRequestPath(`${encodeURIComponent(postId)}?fields=${encodeURIComponent(fields)}`);
    const post = normalizeFacebookPost(data);
    if (post) upsertSocialPosts([post]);
    return post;
  } catch (error) {
    console.warn('⚠️ Publication Facebook non hydratée :', error.message);
    return null;
  }
}

async function hydrateFacebookComment(commentId, postId = '') {
  if (!commentId || !FACEBOOK_COMMENTS_TOKEN) return null;
  try {
    const fields = 'id,message,created_time,from{id,name,picture},parent{id},permalink_url,is_hidden,can_hide,can_remove,can_reply_privately,comment_count,attachment';
    const data = await facebookGraphRequestPath(`${encodeURIComponent(commentId)}?fields=${encodeURIComponent(fields)}`);
    const comment = normalizeFacebookComment(data, postId);
    if (comment) upsertSocialComments([comment]);
    return comment;
  } catch (error) {
    console.warn('⚠️ Commentaire Facebook non hydraté :', error.message);
    return null;
  }
}

async function hydrateInstagramPost(mediaId) {
  if (!mediaId || !INSTAGRAM_ACCESS_TOKEN) return null;
  try {
    const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
    const data = await instagramGraphRequestPath(`${encodeURIComponent(mediaId)}?fields=${encodeURIComponent(fields)}`);
    const post = normalizeInstagramPost(data);
    if (post) upsertSocialPosts([post]);
    return post;
  } catch (error) {
    console.warn('⚠️ Publication Instagram non hydratée :', error.message);
    return null;
  }
}

async function hydrateInstagramComment(commentId, mediaId = '') {
  if (!commentId || !INSTAGRAM_ACCESS_TOKEN) return null;
  try {
    const fields = 'id,text,timestamp,username,from,hidden,like_count,parent_id,media';
    const data = await instagramGraphRequestPath(`${encodeURIComponent(commentId)}?fields=${encodeURIComponent(fields)}`);
    const resolvedMediaId = safeString(mediaId || data?.media?.id);
    const comment = normalizeInstagramComment(data, resolvedMediaId);
    if (comment) upsertSocialComments([comment]);
    return comment;
  } catch (error) {
    console.warn('⚠️ Commentaire Instagram non hydraté :', error.message);
    return null;
  }
}

async function processFacebookCommentWebhookChange(entry, change) {
  if (safeString(change?.field) !== 'feed') return false;
  const value = change?.value && typeof change.value === 'object' ? change.value : {};
  if (safeString(value?.item) !== 'comment') return false;
  const commentId = safeString(value?.comment_id || value?.id);
  const postId = safeString(value?.post_id);
  if (!commentId) return false;
  const verb = safeString(value?.verb).toLowerCase();
  const current = loadSocialComments().find(item => safeString(item?.key) === socialKey('facebook', commentId)) || {};
  const record = normalizeFacebookComment({
    ...value,
    id: commentId,
    is_hidden: verb === 'hide' ? true : verb === 'unhide' ? false : current?.isHidden
  }, postId) || {};
  record.source = 'webhook';
  record.direction = safeString(record.authorId) === FACEBOOK_PAGE_ID ? 'outgoing' : 'incoming';
  record.webhookVerb = verb;
  record.deleted = ['remove','delete'].includes(verb);
  if (['hide','unhide'].includes(verb)) record.isHidden = verb === 'hide';
  const shouldResetRead = ['add','edit','edited','update'].includes(verb) || !safeString(current?.key);
  upsertSocialComments([{ ...current, ...record, readBy: shouldResetRead ? [] : (Array.isArray(current?.readBy) ? current.readBy : []) }]);
  if (postId) {
    const existingPost = loadSocialPosts().find(post => post.key === socialKey('facebook', postId));
    if (!existingPost) upsertSocialPosts([{
      key: socialKey('facebook', postId), channel:'facebook', postId, mediaId:'', caption:'', createdAt:'',
      updatedAt:new Date().toISOString(), lastCommentAt:record.createdAt || new Date().toISOString(), source:'webhook'
    }]);
  }
  // Hydratation hors chemin critique : ajoute le visuel, le lien, les droits de modération.
  Promise.allSettled([
    hydrateFacebookComment(commentId, postId),
    postId ? hydrateFacebookPost(postId) : Promise.resolve(null)
  ]).catch(()=>{});
  return true;
}

async function processInstagramCommentWebhookChange(entry, change) {
  const field = safeString(change?.field);
  if (!['comments','live_comments'].includes(field)) return false;
  const value = change?.value && typeof change.value === 'object' ? change.value : {};
  const commentId = safeString(value?.id || value?.comment_id);
  const mediaId = safeString(value?.media?.id || value?.media_id);
  if (!commentId) return false;
  const record = normalizeInstagramComment({
    ...value,
    id: commentId,
    text: safeString(value?.text || value?.message),
    timestamp: safeString(value?.timestamp)
  }, mediaId) || {};
  record.source = 'webhook';
  record.direction = safeString(record.authorId) === INSTAGRAM_ACCOUNT_ID ? 'outgoing' : 'incoming';
  record.liveComment = field === 'live_comments';
  record.readBy = [];
  upsertSocialComments([record]);
  if (mediaId) {
    const existingPost = loadSocialPosts().find(post => post.key === socialKey('instagram', mediaId));
    if (!existingPost) upsertSocialPosts([{
      key:socialKey('instagram',mediaId), channel:'instagram', postId:mediaId, mediaId,
      caption:'', createdAt:'', updatedAt:new Date().toISOString(), lastCommentAt:record.createdAt, source:'webhook'
    }]);
  }
  Promise.allSettled([
    hydrateInstagramComment(commentId, mediaId),
    mediaId ? hydrateInstagramPost(mediaId) : Promise.resolve(null)
  ]).catch(()=>{});
  return true;
}

async function processSocialCommentWebhookEntry(channel, entry) {
  const changes = Array.isArray(entry?.changes) ? entry.changes : [];
  let handled = 0;
  for (const change of changes) {
    try {
      const ok = channel === 'facebook'
        ? await processFacebookCommentWebhookChange(entry, change)
        : channel === 'instagram'
          ? await processInstagramCommentWebhookChange(entry, change)
          : false;
      if (ok) handled += 1;
    } catch (error) {
      console.error(`❌ Webhook commentaire ${channel} :`, error.message);
    }
  }
  return handled;
}

let socialCommentsSyncJob = {
  running:false, startedAt:'', completedAt:'', facebookPosts:0, facebookComments:0,
  instagramPosts:0, instagramComments:0, errors:[]
};

function loadSocialCommentsSyncState() {
  try {
    if (!fs.existsSync(SOCIAL_COMMENTS_SYNC_STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(SOCIAL_COMMENTS_SYNC_STATE_PATH,'utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function saveSocialCommentsSyncState(state) {
  writeJsonAtomic(SOCIAL_COMMENTS_SYNC_STATE_PATH, state && typeof state === 'object' ? state : {});
}

async function syncFacebookComments90Days() {
  if (!FACEBOOK_PAGE_ID || !FACEBOOK_COMMENTS_TOKEN) {
    throw new Error('Facebook Page ID / Page Access Token manquant.');
  }

  const cutoffAt = historyImportCutoffIso();
  const rawPostMap = new Map();
  const localErrors = [];
  const stats = {
    postsScanned: 0,
    postsWithComments: 0,
    rawComments: 0,
    importedComments: 0,
    commentRequests: 0,
    exactApiMode: true
  };

  // V6.27.5 — le token Railway doit être le Page Access Token lui-même.
  // C'est le même test que celui validé manuellement dans Graph API Explorer.
  try {
    const me = await facebookGraphRequestPath(`me?fields=${encodeURIComponent('id,name')}`);
    const tokenPageId = safeString(me?.id);
    if (!tokenPageId) {
      throw new Error('Meta ne retourne aucun identifiant pour le token configuré.');
    }
    if (tokenPageId !== safeString(FACEBOOK_PAGE_ID)) {
      throw new Error(
        `Le token appartient à ${safeString(me?.name || tokenPageId)} (${tokenPageId}), ` +
        `pas à la Page configurée ${FACEBOOK_PAGE_ID}.`
      );
    }
  } catch (error) {
    throw new Error(`Page Access Token Facebook invalide dans Railway : ${error.message}`);
  }

  // V6.27.5 — /feed est interrogé en premier avec EXACTEMENT les champs
  // validés dans Graph API Explorer. Les champs riches sont hydratés ensuite.
  const minimalPostFields = 'id,message,created_time,permalink_url';
  for (const edge of ['feed', 'posts']) {
    const first =
      `https://graph.facebook.com/${META_API_VERSION}/` +
      `${encodeURIComponent(FACEBOOK_PAGE_ID)}/${edge}` +
      `?fields=${encodeURIComponent(minimalPostFields)}&limit=50`;
    try {
      const rows = await collectPagedMeta(first, FACEBOOK_COMMENTS_TOKEN, {
        maxItems: 1500,
        cutoffAt
      });
      for (const row of rows) {
        const id = safeString(row?.id);
        if (id) rawPostMap.set(id, row);
      }
    } catch (error) {
      localErrors.push(`Facebook ${edge}: ${error.message}`);
    }
  }

  const rawPosts = [...rawPostMap.values()];
  if (!rawPosts.length && localErrors.length) {
    throw new Error(localErrors.slice(-2).join(' | '));
  }

  const posts = rawPosts
    .map(normalizeFacebookPost)
    .filter(Boolean)
    .filter(post => !post.createdAt || historyTimeIsRecent(post.createdAt, cutoffAt));

  stats.postsScanned = posts.length;

  const commentsById = new Map();
  const minimalCommentFields = 'id,message,from,created_time,is_hidden';
  const richCommentFields =
    'id,message,created_time,from{id,name,picture},parent{id},permalink_url,' +
    'is_hidden,can_hide,can_remove,can_reply_privately,comment_count,attachment';

  for (const post of posts) {
    const postId = safeString(post?.postId);
    if (!postId) continue;

    // 1) Requête de vérité : exactement celle qui a fonctionné manuellement.
    // Aucun filter=stream / order=chronological ici : ces paramètres pouvaient
    // produire data:[] sans erreur sur certaines publications / versions Graph.
    const minimalUrl =
      `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(postId)}/comments` +
      `?fields=${encodeURIComponent(minimalCommentFields)}&limit=100`;

    let minimalRows = [];
    stats.commentRequests += 1;
    try {
      // Pas de cutoff dans la pagination des commentaires : l'ordre de Meta
      // n'est pas garanti comme strictement antéchronologique. On filtre localement après.
      minimalRows = await collectPagedMeta(minimalUrl, FACEBOOK_COMMENTS_TOKEN, {
        maxItems: 5000,
        cutoffAt: ''
      });
    } catch (error) {
      localErrors.push(`Facebook commentaires ${postId}: ${error.message}`);
      continue;
    }

    if (minimalRows.length) stats.postsWithComments += 1;
    stats.rawComments += minimalRows.length;

    for (const raw of minimalRows) {
      const id = safeString(raw?.id);
      if (id) commentsById.set(id, { ...raw, __mondecoPostId: postId });
    }

    // 2) Enrichissement facultatif. Une erreur OU une réponse vide n'efface
    // jamais les commentaires déjà récupérés par la requête minimale.
    if (minimalRows.length) {
      const richUrl =
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(postId)}/comments` +
        `?fields=${encodeURIComponent(richCommentFields)}&limit=100`;
      try {
        const richRows = await collectPagedMeta(richUrl, FACEBOOK_COMMENTS_TOKEN, {
          maxItems: 5000,
          cutoffAt: ''
        });
        for (const raw of richRows) {
          const id = safeString(raw?.id);
          if (!id) continue;
          commentsById.set(id, {
            ...(commentsById.get(id) || {}),
            ...raw,
            __mondecoPostId: postId
          });
        }
      } catch (error) {
        // Non bloquant : les données minimales sont déjà exploitables.
        localErrors.push(`Facebook enrichissement ${postId}: ${error.message}`);
      }
    }

    // 3) Réponses aux commentaires : on tente l'edge /comments de chaque
    // commentaire de premier niveau afin de reconstruire le fil complet.
    for (const top of minimalRows) {
      const topId = safeString(top?.id);
      if (!topId) continue;
      const repliesUrl =
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(topId)}/comments` +
        `?fields=${encodeURIComponent(minimalCommentFields)}&limit=100`;
      try {
        const replies = await collectPagedMeta(repliesUrl, FACEBOOK_COMMENTS_TOKEN, {
          maxItems: 3000,
          cutoffAt: ''
        });
        stats.rawComments += replies.length;
        for (const reply of replies) {
          const id = safeString(reply?.id);
          if (!id) continue;
          commentsById.set(id, {
            ...reply,
            parent: reply?.parent || { id: topId },
            __mondecoPostId: postId
          });
        }
      } catch (error) {
        // Certaines versions/objets n'exposent pas cet edge pour toutes les réponses.
        // On conserve le commentaire parent et on n'échoue pas l'import global.
      }
    }
  }

  const comments = [];
  for (const raw of commentsById.values()) {
    // L'ID Facebook d'un commentaire contient souvent l'ID du post en préfixe,
    // mais on cherche d'abord le post parent déjà connu pour éviter toute supposition.
    let postId = safeString(raw?.post_id);
    if (!postId) {
      const parentId = safeString(raw?.parent?.id);
      if (parentId) {
        const parentRecord = commentsById.get(parentId);
        postId = safeString(parentRecord?.post_id);
      }
    }
    if (!postId) {
      // Retrouve le post en testant l'appartenance aux commentaires déjà collectés.
      // Pour les commentaires de premier niveau, on a mémorisé ce lien ci-dessous.
      postId = safeString(raw?.__mondecoPostId);
    }
    const normalized = normalizeFacebookComment(raw, postId);
    if (normalized && historyTimeIsRecent(normalized.createdAt, cutoffAt)) {
      comments.push(normalized);
    }
  }

  // Le bloc ci-dessus reçoit les liens post/commentaire via __mondecoPostId.
  // Compatibilité avec les entrées créées avant V6.27.5 : si un commentaire
  // n'a pas de postId, on le rattache via un second passage par publication.
  if (comments.some(item => !safeString(item?.postId))) {
    const topToPost = new Map();
    for (const post of posts) {
      const postId = safeString(post?.postId);
      if (!postId) continue;
      // Aucune nouvelle requête : les IDs composites de Page Post permettent
      // seulement un fallback d'affichage, jamais une suppression de donnée.
      for (const [commentId, raw] of commentsById.entries()) {
        if (safeString(raw?.__mondecoPostId) === postId) topToPost.set(commentId, postId);
      }
    }
    for (const item of comments) {
      if (!safeString(item?.postId)) {
        item.postId = safeString(topToPost.get(item.commentId));
      }
    }
  }

  stats.importedComments = comments.length;

  upsertSocialPosts(posts);
  upsertSocialComments(comments);

  if (localErrors.length) {
    socialCommentsSyncJob.errors.push(...localErrors.slice(-20));
  }

  socialCommentsSyncJob.facebookPostsScanned = stats.postsScanned;
  socialCommentsSyncJob.facebookPostsWithComments = stats.postsWithComments;
  socialCommentsSyncJob.facebookRawComments = stats.rawComments;
  socialCommentsSyncJob.facebookCommentRequests = stats.commentRequests;
  socialCommentsSyncJob.facebookExactApiMode = true;

  return {
    posts: posts.length,
    comments: comments.length,
    errors: localErrors.length,
    ...stats
  };
}

async function syncInstagramComments90Days() {
  if (!INSTAGRAM_ACCOUNT_ID || !INSTAGRAM_ACCESS_TOKEN) throw new Error('Instagram Account ID / Access Token manquant.');
  const cutoffAt = historyImportCutoffIso();
  const mediaFields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const mediaPage = await instagramGraphRequestPath(`${encodeURIComponent(INSTAGRAM_ACCOUNT_ID)}/media?fields=${encodeURIComponent(mediaFields)}&limit=50`);
  const rawMedia = Array.isArray(mediaPage?.data) ? [...mediaPage.data] : [];
  let nextMedia = safeString(mediaPage?.paging?.next);
  while (nextMedia && rawMedia.length < 1000) {
    const page = await graphJsonRequest(nextMedia, INSTAGRAM_ACCESS_TOKEN);
    rawMedia.push(...(Array.isArray(page?.data) ? page.data : []));
    const times = (Array.isArray(page?.data) ? page.data : []).map(item => Date.parse(safeString(item?.timestamp))).filter(Number.isFinite);
    if (times.length && Math.max(...times) < Date.parse(cutoffAt)) break;
    nextMedia = safeString(page?.paging?.next);
  }
  const posts = rawMedia.slice(0,1000).map(normalizeInstagramPost).filter(Boolean).filter(post => !post.createdAt || historyTimeIsRecent(post.createdAt, cutoffAt));
  const comments = [];
  for (const post of posts) {
    const replyFields = 'id,text,timestamp,username,from,hidden,like_count,parent_id';
    const commentFields = `${replyFields},replies.limit(100){${replyFields}}`;
    try {
      const firstComments = await instagramGraphRequestPath(`${encodeURIComponent(post.mediaId)}/comments?fields=${encodeURIComponent(commentFields)}&limit=100`);
      const top = Array.isArray(firstComments?.data) ? [...firstComments.data] : [];
      let nextTop = safeString(firstComments?.paging?.next);
      while (nextTop && top.length < 5000) {
        const page = await graphJsonRequest(nextTop, INSTAGRAM_ACCESS_TOKEN);
        top.push(...(Array.isArray(page?.data) ? page.data : []));
        nextTop = safeString(page?.paging?.next);
      }
      for (const raw of top) {
        const normalized = normalizeInstagramComment(raw, post.mediaId);
        if (normalized && historyTimeIsRecent(normalized.createdAt, cutoffAt)) comments.push(normalized);

        const firstReplies = Array.isArray(raw?.replies?.data) ? raw.replies.data : [];
        for (const reply of firstReplies) {
          const normalizedReply = normalizeInstagramComment(reply, post.mediaId, safeString(raw?.id));
          if (normalizedReply && historyTimeIsRecent(normalizedReply.createdAt, cutoffAt)) comments.push(normalizedReply);
        }

        // Si un fil dépasse les 100 premières réponses, Meta fournit paging.next.
        const nextReplies = safeString(raw?.replies?.paging?.next);
        if (nextReplies) {
          try {
            const extraReplies = await collectPagedMeta(nextReplies, INSTAGRAM_ACCESS_TOKEN, { maxItems:3000, cutoffAt });
            for (const reply of extraReplies) {
              const normalizedReply = normalizeInstagramComment(reply, post.mediaId, safeString(raw?.id));
              if (normalizedReply && historyTimeIsRecent(normalizedReply.createdAt, cutoffAt)) comments.push(normalizedReply);
            }
          } catch (error) {
            socialCommentsSyncJob.errors.push(`Instagram réponses ${safeString(raw?.id)}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      socialCommentsSyncJob.errors.push(`Instagram ${post.mediaId}: ${error.message}`);
    }
  }
  upsertSocialPosts(posts);
  upsertSocialComments(comments);
  return { posts:posts.length, comments:comments.length };
}

async function runSocialCommentsSync(channel = 'all') {
  if (socialCommentsSyncJob.running) return;
  const requestedChannel = ['facebook','instagram'].includes(safeString(channel)) ? safeString(channel) : 'all';
  const previous = loadSocialCommentsSyncState();
  socialCommentsSyncJob = {
    running:true, startedAt:new Date().toISOString(), completedAt:'', requestedChannel,
    facebookPosts: requestedChannel === 'instagram' ? Number(previous?.facebookPosts || 0) : 0,
    facebookComments: requestedChannel === 'instagram' ? Number(previous?.facebookComments || 0) : 0,
    instagramPosts: requestedChannel === 'facebook' ? Number(previous?.instagramPosts || 0) : 0,
    instagramComments: requestedChannel === 'facebook' ? Number(previous?.instagramComments || 0) : 0,
    errors:[]
  };
  try {
    if (requestedChannel === 'all' || requestedChannel === 'facebook') {
      try {
        const fb = await syncFacebookComments90Days();
        socialCommentsSyncJob.facebookPosts = fb.posts;
        socialCommentsSyncJob.facebookComments = fb.comments;
      } catch (error) {
        socialCommentsSyncJob.errors.push(`Facebook: ${error.message}`);
      }
    }
    if (requestedChannel === 'all' || requestedChannel === 'instagram') {
      try {
        const ig = await syncInstagramComments90Days();
        socialCommentsSyncJob.instagramPosts = ig.posts;
        socialCommentsSyncJob.instagramComments = ig.comments;
      } catch (error) {
        socialCommentsSyncJob.errors.push(`Instagram: ${error.message}`);
      }
    }
  } finally {
    socialCommentsSyncJob.running = false;
    socialCommentsSyncJob.completedAt = new Date().toISOString();
    socialCommentsSyncJob.errors = (Array.isArray(socialCommentsSyncJob.errors) ? socialCommentsSyncJob.errors : []).slice(-50);
    saveSocialCommentsSyncState(socialCommentsSyncJob);
  }
}



async function refreshFacebookSocialThread(postId) {
  if (!postId || !FACEBOOK_COMMENTS_TOKEN) return;
  await hydrateFacebookPost(postId);
  const cutoffAt = historyImportCutoffIso();
  const minimalFields = 'id,message,from,created_time,is_hidden';
  const richFields = 'id,message,created_time,from{id,name,picture},parent{id},permalink_url,is_hidden,can_hide,can_remove,can_reply_privately,comment_count,attachment';
  const minimalUrl = `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(postId)}/comments?fields=${encodeURIComponent(minimalFields)}&limit=100`;
  const top = await collectPagedMeta(minimalUrl, FACEBOOK_COMMENTS_TOKEN, { maxItems:10000, cutoffAt:'' });
  const byId = new Map();
  for (const raw of top) {
    const id=safeString(raw?.id); if(id) byId.set(id,{...raw,__mondecoPostId:postId});
  }
  if (top.length) {
    try {
      const richUrl=`https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(postId)}/comments?fields=${encodeURIComponent(richFields)}&limit=100`;
      const rich=await collectPagedMeta(richUrl,FACEBOOK_COMMENTS_TOKEN,{maxItems:10000,cutoffAt:''});
      for(const raw of rich){const id=safeString(raw?.id);if(id)byId.set(id,{...(byId.get(id)||{}),...raw,__mondecoPostId:postId});}
    } catch {}
  }
  for (const raw of top) {
    const topId=safeString(raw?.id); if(!topId) continue;
    try {
      const repliesUrl=`https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(topId)}/comments?fields=${encodeURIComponent(minimalFields)}&limit=100`;
      const replies=await collectPagedMeta(repliesUrl,FACEBOOK_COMMENTS_TOKEN,{maxItems:5000,cutoffAt:''});
      for(const reply of replies){const id=safeString(reply?.id);if(id)byId.set(id,{...reply,parent:reply?.parent||{id:topId},__mondecoPostId:postId});}
    } catch {}
  }
  let comments=[...byId.values()].map(raw=>normalizeFacebookComment(raw,postId)).filter(Boolean).filter(item=>historyTimeIsRecent(item.createdAt,cutoffAt));
  comments=await enrichSocialCommentProfiles(comments,40);
  upsertSocialComments(comments);
  const posts = loadSocialPosts();
  const index = posts.findIndex(post => post.key === socialKey('facebook', postId));
  if (index >= 0) {
    posts[index] = { ...posts[index], lastThreadSyncAt:new Date().toISOString() };
    saveSocialPosts(posts);
  }
}

async function refreshInstagramSocialThread(mediaId) {
  if (!mediaId || !INSTAGRAM_ACCESS_TOKEN) return;
  await hydrateInstagramPost(mediaId);
  const cutoffAt = historyImportCutoffIso();
  const replyFields = 'id,text,timestamp,username,from,hidden,like_count,parent_id';
  const commentFields = `${replyFields},replies.limit(100){${replyFields}}`;
  const url = `https://graph.instagram.com/${META_API_VERSION}/${encodeURIComponent(mediaId)}/comments?fields=${encodeURIComponent(commentFields)}&limit=100`;
  const top = await collectPagedMeta(url, INSTAGRAM_ACCESS_TOKEN, { maxItems:10000, cutoffAt });
  const comments = [];
  for (const raw of top) {
    const normalized = normalizeInstagramComment(raw, mediaId);
    if (normalized && historyTimeIsRecent(normalized.createdAt, cutoffAt)) comments.push(normalized);
    for (const reply of Array.isArray(raw?.replies?.data) ? raw.replies.data : []) {
      const normalizedReply = normalizeInstagramComment(reply, mediaId, safeString(raw?.id));
      if (normalizedReply && historyTimeIsRecent(normalizedReply.createdAt, cutoffAt)) comments.push(normalizedReply);
    }
    const nextReplies = safeString(raw?.replies?.paging?.next);
    if (nextReplies) {
      try {
        const extra = await collectPagedMeta(nextReplies, INSTAGRAM_ACCESS_TOKEN, { maxItems:5000, cutoffAt });
        for (const reply of extra) {
          const normalizedReply = normalizeInstagramComment(reply, mediaId, safeString(raw?.id));
          if (normalizedReply && historyTimeIsRecent(normalizedReply.createdAt, cutoffAt)) comments.push(normalizedReply);
        }
      } catch (error) {
        console.warn('⚠️ Réponses Instagram partielles :', error.message);
      }
    }
  }
  const enrichedComments = await enrichSocialCommentProfiles(comments, 40);
  upsertSocialComments(enrichedComments);
  const posts = loadSocialPosts();
  const index = posts.findIndex(post => post.key === socialKey('instagram', mediaId));
  if (index >= 0) {
    posts[index] = { ...posts[index], lastThreadSyncAt:new Date().toISOString() };
    saveSocialPosts(posts);
  }
}

async function refreshSocialThreadIfNeeded(comment, force = false) {
  const channel = safeString(comment?.channel);
  const postId = safeString(comment?.postId || comment?.mediaId);
  if (!channel || !postId) return '';
  const post = loadSocialPosts().find(item => item.key === socialKey(channel, postId));
  const lastMs = Date.parse(safeString(post?.lastThreadSyncAt));
  if (!force && Number.isFinite(lastMs) && Date.now() - lastMs < 30_000) return '';
  try {
    if (channel === 'facebook') await refreshFacebookSocialThread(postId);
    else if (channel === 'instagram') await refreshInstagramSocialThread(postId);
    return '';
  } catch (error) {
    return safeString(error?.message) || 'Synchronisation du fil impossible.';
  }
}

function socialOutgoingReplyIndex(items = []) {
  const byParent = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.deleted || safeString(item?.direction) !== 'outgoing') continue;
    const parentId = safeString(item?.parentId);
    if (!parentId) continue;
    const ms = Date.parse(safeString(item?.createdAt || item?.updatedAt)) || 0;
    if (ms > (byParent.get(parentId) || 0)) byParent.set(parentId, ms);
  }
  return byParent;
}

// V6.33.1 — les commentaires sont comptés par FIL de discussion, pas par
// chaque ligne historique. Si MONDECO répond après le dernier commentaire
// client du fil, tout le fil est traité. Cela correspond au travail réel du
// commercial et empêche 4 réponses/client dans un même fil de compter 4 fois.
function socialCommentThreadIndex(items = []) {
  const active = (Array.isArray(items) ? items : []).filter(item => item && !item.deleted);
  const byIdentity = new Map();
  for (const item of active) {
    const identity = `${safeString(item?.channel)}|${safeString(item?.postId)}|${safeString(item?.commentId)}`;
    if (safeString(item?.commentId)) byIdentity.set(identity, item);
  }

  const rootCache = new Map();
  function rootIdentity(item) {
    const own = `${safeString(item?.channel)}|${safeString(item?.postId)}|${safeString(item?.commentId)}`;
    if (rootCache.has(own)) return rootCache.get(own);
    let current = item;
    const seen = new Set();
    for (let depth = 0; depth < 25; depth += 1) {
      const parentId = safeString(current?.parentId);
      if (!parentId) break;
      const parentIdentity = `${safeString(current?.channel)}|${safeString(current?.postId)}|${parentId}`;
      if (seen.has(parentIdentity)) break;
      seen.add(parentIdentity);
      const parent = byIdentity.get(parentIdentity);
      if (!parent) break;
      current = parent;
    }
    const root = `${safeString(current?.channel)}|${safeString(current?.postId)}|${safeString(current?.commentId)}`;
    rootCache.set(own, root);
    return root;
  }

  const threads = new Map();
  for (const item of active) {
    const root = rootIdentity(item);
    if (!root) continue;
    const thread = threads.get(root) || {
      root,
      channel:safeString(item?.channel),
      postId:safeString(item?.postId),
      items:[],
      latestIncomingMs:0,
      latestIncomingItem:null,
      latestOutgoingMs:0,
      latestAckMs:0
    };
    thread.items.push(item);
    const createdMs = Date.parse(safeString(item?.createdAt || item?.updatedAt)) || 0;
    if (safeString(item?.direction) === 'outgoing') {
      if (createdMs >= thread.latestOutgoingMs) thread.latestOutgoingMs = createdMs;
    } else {
      if (createdMs >= thread.latestIncomingMs) {
        thread.latestIncomingMs = createdMs;
        thread.latestIncomingItem = item;
      }
      for (const field of ['lastReplyAt','privateReplySentAt','answeredAt']) {
        const ackMs = Date.parse(safeString(item?.[field])) || 0;
        if (ackMs > thread.latestAckMs) thread.latestAckMs = ackMs;
      }
    }
    threads.set(root, thread);
  }

  const pendingByKey = new Map();
  const threadByKey = new Map();
  for (const thread of threads.values()) {
    const latestResponseMs = Math.max(thread.latestOutgoingMs, thread.latestAckMs);
    thread.pending = thread.latestIncomingMs > 0 && thread.latestIncomingMs > latestResponseMs;
    thread.latestResponseMs = latestResponseMs;
    const actionableKey = thread.pending ? safeString(thread.latestIncomingItem?.key) : '';
    thread.actionableKey = actionableKey;
    for (const item of thread.items) {
      const key = safeString(item?.key);
      if (!key) continue;
      threadByKey.set(key, thread);
      pendingByKey.set(key, Boolean(actionableKey && key === actionableKey));
    }
  }

  return { threads, pendingByKey, threadByKey };
}

function socialCommentNeedsReply(item, index = null) {
  if (!item || item.deleted || safeString(item?.direction) === 'outgoing') return false;
  if (index?.pendingByKey instanceof Map) {
    return index.pendingByKey.get(safeString(item?.key)) === true;
  }
  // Compatibilité des anciens appels : calcule sur ce seul commentaire.
  const createdMs = Date.parse(safeString(item?.createdAt)) || 0;
  const publicReplyMs = Date.parse(safeString(item?.lastReplyAt)) || 0;
  const privateReplyMs = Date.parse(safeString(item?.privateReplySentAt)) || 0;
  const answeredMs = Date.parse(safeString(item?.answeredAt)) || 0;
  const childReplyMs = index instanceof Map
    ? Number(index.get(safeString(item?.commentId)) || 0)
    : 0;
  return createdMs > Math.max(publicReplyMs, privateReplyMs, answeredMs, childReplyMs);
}

function socialCommentCounts(items, user) {
  const allItems = Array.isArray(items) ? items : [];
  const active = allItems.filter(item => !item.deleted && safeString(item?.direction) !== 'outgoing');
  const threadIndex = socialCommentThreadIndex(allItems);
  const pendingThreads = [...threadIndex.threads.values()].filter(thread => thread.pending === true);
  return {
    all: active.length,
    facebook: active.filter(item => item.channel === 'facebook').length,
    instagram: active.filter(item => item.channel === 'instagram').length,
    unread: active.filter(item => !socialCommentReadByUser(item,user)).length,
    pendingReply: pendingThreads.length,
    pendingFacebook: pendingThreads.filter(thread => thread.channel === 'facebook').length,
    pendingInstagram: pendingThreads.filter(thread => thread.channel === 'instagram').length,
    hidden: active.filter(item => item.isHidden === true).length,
    privateReply: active.filter(item => Boolean(item.privateReplySentAt)).length,
    answered: pendingThreads.length <= threadIndex.threads.size
      ? [...threadIndex.threads.values()].filter(thread => thread.pending !== true).length
      : 0
  };
}

router.get('/api/social-comments/status', requireAuth, (req,res) => {
  const saved = loadSocialCommentsSyncState();
  const current = socialCommentsSyncJob.startedAt ? socialCommentsSyncJob : { ...saved, running:false };
  let scopedComments = loadSocialComments();
  const channelScope = plannedChannelSetForUser(req.user);
  if (channelScope) scopedComments = scopedComments.filter(item => channelScopeAllowsComment(channelScope, item?.channel));
  const counts = socialCommentCounts(scopedComments, req.user);
  const canFacebookComments = channelScopeAllowsComment(channelScope, 'facebook');
  const canInstagramComments = channelScopeAllowsComment(channelScope, 'instagram');
  return res.json({
    ...current,
    counts,
    access:{
      instagramComments:canInstagramComments,
      facebookComments:canFacebookComments
    },
    facebookConfigured:Boolean(FACEBOOK_PAGE_ID && FACEBOOK_COMMENTS_TOKEN),
    instagramConfigured:Boolean(INSTAGRAM_ACCOUNT_ID && INSTAGRAM_ACCESS_TOKEN),
    historyDays:HISTORY_IMPORT_DAYS,
    hasData:Number(counts?.all || 0) > 0,
    needsInitialSync:!current?.running && Number(counts?.all || 0) === 0 && (canFacebookComments || canInstagramComments),
    needsFacebookSync:canFacebookComments && !current?.running && Boolean(FACEBOOK_PAGE_ID && FACEBOOK_COMMENTS_TOKEN) && Number(counts?.facebook || 0) === 0,
    needsInstagramSync:canInstagramComments && !current?.running && Boolean(INSTAGRAM_ACCOUNT_ID && INSTAGRAM_ACCESS_TOKEN) && Number(counts?.instagram || 0) === 0,
    lastErrors:Array.isArray(current?.errors) ? current.errors.slice(-10) : []
  });
});

async function diagnoseFacebookCommentsAccess() {
  const result = {
    channel:'facebook', configured:Boolean(FACEBOOK_PAGE_ID && FACEBOOK_COMMENTS_TOKEN),
    page:false, posts:false, comments:false, feed:false, samplePostId:'', error:''
  };
  if (!result.configured) {
    result.error = 'FACEBOOK_PAGE_ID ou FACEBOOK_COMMENTS_TOKEN manquant.';
    return result;
  }
  try {
    const page = await facebookGraphRequestPath(`${encodeURIComponent(FACEBOOK_PAGE_ID)}?fields=${encodeURIComponent('id,name')}`);
    result.page = Boolean(page?.id);
    result.pageId = safeString(page?.id);
    result.pageName = safeString(page?.name);
    result.tokenMatchesPage = safeString(page?.id) === safeString(FACEBOOK_PAGE_ID);
  } catch (error) {
    result.error = `Accès Page Facebook refusé : ${error.message}`;
    return result;
  }
  let sample = null;
  try {
    const posts = await facebookGraphRequestPath(`${encodeURIComponent(FACEBOOK_PAGE_ID)}/posts?fields=${encodeURIComponent('id,created_time')}&limit=1`);
    sample = Array.isArray(posts?.data) ? posts.data[0] : null;
    result.posts = true;
  } catch (error) {
    result.postsError = safeString(error.message);
  }
  try {
    const feed = await facebookGraphRequestPath(`${encodeURIComponent(FACEBOOK_PAGE_ID)}/feed?fields=${encodeURIComponent('id,created_time')}&limit=1`);
    if (!sample) sample = Array.isArray(feed?.data) ? feed.data[0] : null;
    result.feed = true;
  } catch (error) {
    result.feedError = safeString(error.message);
  }
  result.samplePostId = safeString(sample?.id);
  if (result.samplePostId) {
    try {
      await facebookGraphRequestPath(`${encodeURIComponent(result.samplePostId)}/comments?fields=${encodeURIComponent('id,message,created_time,is_hidden')}&limit=1`);
      result.comments = true;
    } catch (error) {
      result.commentsError = safeString(error.message);
    }
  } else if (result.posts || result.feed) {
    result.comments = true;
  }
  try {
    const subscribed = await facebookGraphRequestPath(`${encodeURIComponent(FACEBOOK_PAGE_ID)}/subscribed_apps`);
    result.webhookSubscription = Array.isArray(subscribed?.data) ? subscribed.data.length > 0 : null;
    result.webhookFields = Array.isArray(subscribed?.data)
      ? [...new Set(subscribed.data.flatMap(item => Array.isArray(item?.subscribed_fields) ? item.subscribed_fields : []))]
      : [];
  } catch (error) {
    result.webhookError = safeString(error.message);
  }
  return result;
}

async function diagnoseInstagramCommentsAccess() {
  const result = {
    channel:'instagram', configured:Boolean(INSTAGRAM_ACCOUNT_ID && INSTAGRAM_ACCESS_TOKEN),
    account:false, media:false, comments:false, sampleMediaId:'', error:''
  };
  if (!result.configured) {
    result.error = 'INSTAGRAM_ACCOUNT_ID ou INSTAGRAM_ACCESS_TOKEN manquant.';
    return result;
  }
  try {
    const account = await instagramGraphRequestPath(`${encodeURIComponent(INSTAGRAM_ACCOUNT_ID)}?fields=${encodeURIComponent('id,username')}`);
    result.account = Boolean(account?.id);
    result.username = safeString(account?.username);
  } catch (error) {
    result.error = `Accès compte Instagram refusé : ${error.message}`;
    return result;
  }
  try {
    const media = await instagramGraphRequestPath(`${encodeURIComponent(INSTAGRAM_ACCOUNT_ID)}/media?fields=${encodeURIComponent('id,timestamp')}&limit=1`);
    const firstMedia = Array.isArray(media?.data) ? media.data[0] : null;
    result.media = true;
    result.sampleMediaId = safeString(firstMedia?.id);
    if (result.sampleMediaId) {
      try {
        await instagramGraphRequestPath(`${encodeURIComponent(result.sampleMediaId)}/comments?fields=${encodeURIComponent('id,text,timestamp,hidden')}&limit=1`);
        result.comments = true;
      } catch (error) {
        result.commentsError = safeString(error.message);
      }
    } else {
      result.comments = true;
    }
  } catch (error) {
    result.mediaError = safeString(error.message);
  }
  try {
    const subscribed = await instagramGraphRequestPath(`${encodeURIComponent(INSTAGRAM_ACCOUNT_ID)}/subscribed_apps`);
    result.webhookSubscription = Array.isArray(subscribed?.data) ? subscribed.data.length > 0 : null;
    result.webhookFields = Array.isArray(subscribed?.data)
      ? [...new Set(subscribed.data.flatMap(item => Array.isArray(item?.subscribed_fields) ? item.subscribed_fields : []))]
      : [];
  } catch (error) {
    result.webhookError = safeString(error.message);
  }
  return result;
}

router.get('/api/social-comments/diagnostic', requireAdminOrCommercialManager, async (req,res) => {
  try {
    const [facebook, instagram] = await Promise.all([
      diagnoseFacebookCommentsAccess(),
      diagnoseInstagramCommentsAccess()
    ]);
    const issues = [];
    if (!facebook.configured) issues.push('Facebook : configuration manquante.');
    else {
      if (!facebook.page) issues.push('Facebook : le Page Access Token ne permet pas de lire la Page.');
      if (!facebook.posts && !facebook.feed) issues.push(`Facebook : lecture des publications refusée — ${facebook.postsError || facebook.feedError || 'permissions insuffisantes'}.`);
      if (!facebook.comments) issues.push(`Facebook : lecture des commentaires refusée — ${facebook.commentsError || 'permissions insuffisantes'}. Vérifiez pages_read_engagement, pages_read_user_content et la tâche MODERATE sur la Page.`);
      if (facebook.webhookSubscription === false) issues.push('Facebook : aucune souscription webhook Page détectée. Le champ feed doit être abonné pour recevoir les nouveaux commentaires en temps réel.');
      if (Array.isArray(facebook.webhookFields) && facebook.webhookFields.length && !facebook.webhookFields.includes('feed')) issues.push('Facebook : le webhook de la Page n’est pas abonné au champ feed.');
    }
    if (!instagram.configured) issues.push('Instagram : configuration manquante.');
    else {
      if (!instagram.account) issues.push('Instagram : le token ne permet pas de lire le compte professionnel.');
      if (!instagram.media) issues.push(`Instagram : lecture des médias refusée — ${instagram.mediaError || 'permissions insuffisantes'}.`);
      if (!instagram.comments) issues.push(`Instagram : lecture des commentaires refusée — ${instagram.commentsError || 'permissions insuffisantes'}. Vérifiez instagram_business_manage_comments (Instagram Login) ou instagram_manage_comments (Facebook Login).`);
      if (instagram.webhookSubscription === false) issues.push('Instagram : aucune souscription webhook détectée pour ce compte.');
      if (Array.isArray(instagram.webhookFields) && instagram.webhookFields.length && !instagram.webhookFields.includes('comments')) issues.push('Instagram : le webhook du compte n’est pas abonné au champ comments.');
    }
    return res.json({ success:true, facebook, instagram, issues, checkedAt:new Date().toISOString() });
  } catch (error) {
    console.error('❌ Diagnostic commentaires Meta :', error);
    return res.status(500).json({ error:error.message || 'Diagnostic Meta impossible.' });
  }
});

router.post('/api/social-comments/sync', requireAdminOrCommercialManager, (req,res) => {
  if (socialCommentsSyncJob.running) return res.status(202).json({ success:true, alreadyRunning:true, ...socialCommentsSyncJob });
  const requested = safeString(req?.query?.channel || req?.body?.channel).toLowerCase();
  const channel = ['facebook','instagram'].includes(requested) ? requested : 'all';
  runSocialCommentsSync(channel).catch(error => console.error('❌ Sync commentaires :', error));
  return res.status(202).json({ success:true, started:true, channel });
});

router.post('/api/social-comments/reconcile-pending', requireAdminOrCommercialManager, async (req,res) => {
  try {
    const before = loadSocialComments();
    const index = socialCommentThreadIndex(before);
    const limit = Math.max(1, Math.min(12, Number(req.body?.limit || 8) || 8));
    const pending = [...index.threads.values()]
      .filter(thread => thread.pending === true && thread.latestIncomingItem)
      .sort((a,b) => Number(a.latestIncomingMs||0) - Number(b.latestIncomingMs||0));
    const unique = [];
    const seen = new Set();
    for (const thread of pending) {
      const item = thread.latestIncomingItem;
      const identity = `${safeString(item?.channel)}|${safeString(item?.postId || item?.mediaId)}`;
      if (!safeString(item?.postId || item?.mediaId) || seen.has(identity)) continue;
      seen.add(identity);
      unique.push(item);
      if (unique.length >= limit) break;
    }
    const errors = [];
    for (const item of unique) {
      const error = await refreshSocialThreadIfNeeded(item, true);
      if (error) errors.push(`${safeString(item?.channel)}:${safeString(item?.postId)} — ${error}`);
    }
    const after = loadSocialComments();
    const counts = socialCommentCounts(after, req.user);
    return res.json({ success:true, checkedThreads:unique.length, pendingBefore:pending.length, pendingAfter:Number(counts.pendingReply||0), counts, errors:errors.slice(-5) });
  } catch (error) {
    console.warn('⚠️ Réconciliation commentaires à répondre :', error.message);
    return res.status(500).json({ error:'Impossible de vérifier les commentaires à répondre.' });
  }
});

router.get('/api/social-comments', requireAuth, (req,res) => {
  try {
    const posts = loadSocialPosts();
    const postMap = new Map(posts.map(post => [safeString(post?.key), post]));
    let allComments = loadSocialComments();
    const channelScope = plannedChannelSetForUser(req.user);
    if (channelScope) allComments = allComments.filter(item => channelScopeAllowsComment(channelScope, item?.channel));
    const threadIndex = socialCommentThreadIndex(allComments);
    let comments = allComments.filter(item => !item.deleted && safeString(item?.direction) !== 'outgoing');
    const channel = safeString(req.query?.channel).toLowerCase();
    const filter = safeString(req.query?.filter || 'all').toLowerCase();
    const q = safeString(req.query?.q).toLowerCase();
    if (['facebook','instagram'].includes(channel)) comments = comments.filter(item => item.channel === channel);
    if (filter === 'unread') comments = comments.filter(item => !socialCommentReadByUser(item,req.user));
    if (filter === 'pending') comments = comments.filter(item => socialCommentNeedsReply(item, threadIndex));
    if (filter === 'answered') comments = comments.filter(item => !socialCommentNeedsReply(item, threadIndex));
    if (filter === 'hidden') comments = comments.filter(item => item.isHidden === true);
    if (filter === 'private') comments = comments.filter(item => Boolean(item.privateReplySentAt));
    if (q) {
      comments = comments.filter(item => {
        const post = postMap.get(socialKey(item.channel, item.postId)) || {};
        return [item.text,item.authorName,item.authorUsername,item.commentId,post.caption,post.postId]
          .map(value => safeString(value).toLowerCase()).join(' ').includes(q);
      });
    }
    comments.sort((a,b) => (Date.parse(b.createdAt)||0) - (Date.parse(a.createdAt)||0));
    const counts = socialCommentCounts(allComments, req.user);
    const limit = Math.max(20, Math.min(200, Number(req.query?.limit || 100) || 100));
    const offset = Math.max(0, Number(req.query?.offset || 0) || 0);
    const items = comments.slice(offset, offset + limit).map(comment => ({
      ...comment,
      read: socialCommentReadByUser(comment,req.user),
      pendingReply: socialCommentNeedsReply(comment, threadIndex),
      post: postMap.get(socialKey(comment.channel, comment.postId)) || null
    }));
    return res.json({ items, total:comments.length, counts, offset, limit, hasMore:offset+limit<comments.length });
  } catch (error) {
    console.error('❌ Liste commentaires :', error);
    return res.status(500).json({ error:'Impossible de lire les commentaires.' });
  }
});

router.post('/api/social-comments/avatars/refresh', requireAuth, async (req,res) => {
  try {
    const requestedKeys = Array.isArray(req.body?.keys) ? req.body.keys.map(safeString).filter(Boolean).slice(0,60) : [];
    const channel = safeString(req.body?.channel).toLowerCase();
    let comments = loadSocialComments();
    let targets = comments.filter(item => !item.deleted && item.direction !== 'outgoing');
    if (requestedKeys.length) {
      const wanted = new Set(requestedKeys);
      targets = targets.filter(item => wanted.has(safeString(item.key)));
    }
    if (['facebook','instagram'].includes(channel)) targets = targets.filter(item => item.channel === channel);
    const avatarScope = plannedChannelSetForUser(req.user);
    if (avatarScope) targets = targets.filter(item => channelScopeAllowsComment(avatarScope, item.channel));
    targets = targets.slice(0,60);
    const enriched = await enrichSocialCommentProfiles(targets, 40);
    const map = new Map(enriched.map(item => [safeString(item.key), item]));
    comments = comments.map(item => map.has(safeString(item.key)) ? { ...item, ...map.get(safeString(item.key)) } : item);
    saveSocialComments(comments);
    return res.json({ success:true, updated:enriched.filter(item=>safeString(item.authorAvatar)).length, items:enriched.map(item=>({key:item.key,authorAvatar:safeString(item.authorAvatar),authorName:safeString(item.authorName),authorUsername:safeString(item.authorUsername)})) });
  } catch (error) {
    console.warn('⚠️ Photos profils commentaires :', error.message);
    return res.status(500).json({ error:'Impossible de mettre à jour les photos de profil.' });
  }
});

router.get('/api/social-comments/:key', requireAuth, async (req,res) => {
  const key = safeString(req.params.key);
  let comments = loadSocialComments();
  let selected = comments.find(item => safeString(item?.key) === key);
  if (!selected) return res.status(404).json({ error:'Commentaire introuvable.' });
  if (!requireCommercialCommentChannelAccess(req, res, selected.channel)) return;

  // Quand le commercial ouvre un commentaire, on tente de recharger la
  // publication et son fil complet depuis Meta. Une erreur Meta n'empêche pas
  // l'ouverture : le cache local reste disponible.
  const refreshError = await refreshSocialThreadIfNeeded(selected, String(req.query?.refresh || '') === '1');
  comments = loadSocialComments();
  selected = comments.find(item => safeString(item?.key) === key) || selected;
  const postKey = socialKey(selected.channel, selected.postId);
  const post = loadSocialPosts().find(item => safeString(item?.key) === postKey) || null;
  let thread = comments
    .filter(item => !item.deleted && item.channel === selected.channel && safeString(item.postId) === safeString(selected.postId))
    .sort((a,b) => (Date.parse(a.createdAt)||0) - (Date.parse(b.createdAt)||0));
  try {
    const enriched = await enrichSocialCommentProfiles(thread, 30);
    const map = new Map(enriched.map(item => [safeString(item.key), item]));
    comments = comments.map(item => map.has(safeString(item.key)) ? { ...item, ...map.get(safeString(item.key)) } : item);
    saveSocialComments(comments);
    thread = enriched;
    selected = comments.find(item => safeString(item?.key) === key) || selected;
  } catch {}
  const read = markSocialCommentRead(key, req.user) || selected;
  if (safeString(req.user?.role) === 'commercial') {
    appendTeamActivity({
      type:'comment_open', userId:safeString(req.user.id), userName:safeString(req.user.name || req.user.email),
      channel:safeString(selected.channel), commentKey:key, commentId:safeString(selected.commentId), authorId:safeString(selected.authorId)
    });
  }
  return res.json({
    comment:{...read,read:true},
    post,
    thread:thread.map(item=>({...item,read:socialCommentReadByUser(item,req.user)})),
    refreshError
  });
});

router.post('/api/social-comments/:key/read', requireAuth, (req,res) => {
  const key = safeString(req.params.key);
  const target = loadSocialComments().find(item => safeString(item?.key) === key);
  if (!target) return res.status(404).json({ error:'Commentaire introuvable.' });
  if (!requireCommercialCommentChannelAccess(req, res, target.channel)) return;
  const updated = markSocialCommentRead(key, req.user);
  return res.json({ success:true });
});

router.post('/api/social-comments/:key/reply', requireAuth, async (req,res) => {
  try {
    const key = safeString(req.params.key);
    const text = safeString(req.body?.message).trim();
    if (!text) return res.status(400).json({ error:'Réponse vide.' });
    const comments = loadSocialComments();
    const index = comments.findIndex(item => safeString(item?.key) === key);
    if (index < 0) return res.status(404).json({ error:'Commentaire introuvable.' });
    const target = comments[index];
    if (!requireCommercialCommentChannelAccess(req, res, target.channel)) return;
    let data;
    if (target.channel === 'facebook') {
      data = await facebookGraphRequestPath(`${encodeURIComponent(target.commentId)}/comments`, { method:'POST', form:{ message:text } });
    } else if (target.channel === 'instagram') {
      data = await instagramGraphRequestPath(`${encodeURIComponent(target.commentId)}/replies`, { method:'POST', form:{ message:text } });
    } else return res.status(400).json({ error:'Canal non pris en charge.' });
    const now = new Date().toISOString();
    comments[index] = { ...target, lastReply:text, lastReplyAt:now, answeredAt:now, lastReplyBy:safeString(req.user?.name || req.user?.email), lastReplyByUserId:safeString(req.user?.id), lastReplyByEmail:safeString(req.user?.email) };
    saveSocialComments(comments);
    appendTeamActivity({
      type:'comment_reply', userId:safeString(req.user?.id), userName:safeString(req.user?.name || req.user?.email),
      channel:safeString(target.channel), commentKey:key, commentId:safeString(target.commentId), authorId:safeString(target.authorId), text
    });
    // Ajoute immédiatement la réponse dans le fil local, même avant le webhook d'écho Meta.
    const replyId = safeString(data?.id);
    if (replyId) upsertSocialComments([{
      key:socialKey(target.channel,replyId), channel:target.channel, commentId:replyId,
      postId:target.postId, mediaId:target.mediaId, parentId:target.commentId, text,
      authorId: target.channel === 'facebook' ? FACEBOOK_PAGE_ID : INSTAGRAM_ACCOUNT_ID,
      authorName:'MONDECO', authorUsername:'mondeco', createdAt:now, updatedAt:now,
      isHidden:false, canHide:true, canRemove:true, canReply:true, canReplyPrivately:false,
      replyCount:0, deleted:false, source:'mondeco_reply', direction:'outgoing', readBy:[]
    }]);
    return res.json({ success:true, id:replyId || null });
  } catch (error) {
    console.error('❌ Réponse commentaire :', error);
    return res.status(502).json({ error:`Meta : ${error.message}` });
  }
});

router.post('/api/social-comments/:key/hide', requireAuth, async (req,res) => {
  try {
    const key = safeString(req.params.key);
    const hidden = req.body?.hidden === true;
    const comments = loadSocialComments();
    const index = comments.findIndex(item => safeString(item?.key) === key);
    if (index < 0) return res.status(404).json({ error:'Commentaire introuvable.' });
    const target = comments[index];
    if (!requireCommercialCommentChannelAccess(req, res, target.channel)) return;
    if (target.canHide === false) return res.status(403).json({ error:'Meta indique que ce commentaire ne peut pas être masqué/démasqué par ce compte.' });
    if (target.channel === 'facebook') {
      await facebookGraphRequestPath(`${encodeURIComponent(target.commentId)}`, { method:'POST', form:{ is_hidden:hidden ? 'true':'false' } });
    } else if (target.channel === 'instagram') {
      await instagramGraphRequestPath(`${encodeURIComponent(target.commentId)}`, { method:'POST', form:{ hide:hidden ? 'true':'false' } });
    } else return res.status(400).json({ error:'Canal non pris en charge.' });
    comments[index] = { ...target, isHidden:hidden, updatedAt:new Date().toISOString() };
    saveSocialComments(comments);
    return res.json({ success:true, hidden });
  } catch (error) {
    return res.status(502).json({ error:`Meta : ${error.message}` });
  }
});

router.delete('/api/social-comments/:key', requireAdmin, async (req,res) => {
  try {
    const key = safeString(req.params.key);
    const comments = loadSocialComments();
    const index = comments.findIndex(item => safeString(item?.key) === key);
    if (index < 0) return res.status(404).json({ error:'Commentaire introuvable.' });
    const target = comments[index];
    if (target.canRemove === false) return res.status(403).json({ error:'Meta indique que ce commentaire ne peut pas être supprimé par ce compte.' });

    // Suppression publique réelle d'abord. Si Meta refuse, MONDECO ne fait pas
    // croire que le commentaire a disparu alors qu'il est encore public.
    if (target.channel === 'facebook') {
      await facebookGraphRequestPath(`${encodeURIComponent(target.commentId)}`, { method:'DELETE' });
    } else if (target.channel === 'instagram') {
      await instagramGraphRequestPath(`${encodeURIComponent(target.commentId)}`, { method:'DELETE' });
    } else return res.status(400).json({ error:'Canal non pris en charge.' });

    // Supprime physiquement le commentaire ET ses réponses locales descendantes.
    const removedIds = new Set([safeString(target.commentId)]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of comments) {
        if (safeString(item?.channel) !== safeString(target.channel) || safeString(item?.postId) !== safeString(target.postId)) continue;
        const parentId = safeString(item?.parentId);
        const id = safeString(item?.commentId);
        if (id && parentId && removedIds.has(parentId) && !removedIds.has(id)) { removedIds.add(id); grew = true; }
      }
    }
    const removed = comments.filter(item => removedIds.has(safeString(item?.commentId)) && safeString(item?.channel) === safeString(target.channel));
    rememberPurgedHashes(removed.map(socialCommentPurgeHash));
    saveSocialComments(comments.filter(item => !removedIds.has(safeString(item?.commentId)) || safeString(item?.channel) !== safeString(target.channel)));
    return res.json({ success:true, permanentlyDeleted:true, removedLocal:removed.length, remoteDeleted:true });
  } catch (error) {
    return res.status(502).json({ error:`Meta : ${error.message}` });
  }
});


router.post('/api/social-comments/:key/private-reply', requireAuth, async (req,res) => {
  try {
    const key = safeString(req.params.key);
    const text = safeString(req.body?.message).trim();
    if (!text) return res.status(400).json({ error:'Message privé vide.' });
    const comments = loadSocialComments();
    const index = comments.findIndex(item => safeString(item?.key) === key);
    if (index < 0) return res.status(404).json({ error:'Commentaire introuvable.' });
    const target = comments[index];
    if (!requireCommercialCommentChannelAccess(req, res, target.channel)) return;
    if (target.canReplyPrivately === false) return res.status(403).json({ error:'Meta n’autorise pas de réponse privée pour ce commentaire.' });
    let data;
    if (target.channel === 'facebook') {
      if (!FACEBOOK_PAGE_ID) throw new Error('FACEBOOK_PAGE_ID manquant.');
      if (!FACEBOOK_MESSENGER_TOKEN) throw new Error('FACEBOOK_MESSENGER_TOKEN manquant.');
      data = await graphJsonRequest(
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(FACEBOOK_PAGE_ID)}/messages`,
        FACEBOOK_MESSENGER_TOKEN,
        { method:'POST', json:{ recipient:{ comment_id:target.commentId }, message:{ text } } }
      );
    } else if (target.channel === 'instagram') {
      if (!INSTAGRAM_ACCOUNT_ID) throw new Error('INSTAGRAM_ACCOUNT_ID manquant.');
      data = await instagramGraphRequestPath(`${encodeURIComponent(INSTAGRAM_ACCOUNT_ID)}/messages`, {
        method:'POST', json:{ recipient:{ comment_id:target.commentId }, message:{ text } }
      });
    } else return res.status(400).json({ error:'Canal non pris en charge.' });
    const now = new Date().toISOString();
    const recipientId = safeString(data?.recipient_id);
    comments[index] = {
      ...target, privateReplySentAt:now, answeredAt:now, privateReplyMessage:text,
      privateReplyBy:safeString(req.user?.name || req.user?.email),
      privateReplyByUserId:safeString(req.user?.id),
      privateReplyByEmail:safeString(req.user?.email),
      privateRecipientId:recipientId
    };
    saveSocialComments(comments);
    appendTeamActivity({
      type:'comment_private_reply', userId:safeString(req.user?.id), userName:safeString(req.user?.name || req.user?.email),
      channel:safeString(target.channel), commentKey:key, commentId:safeString(target.commentId), authorId:safeString(target.authorId), text
    });

    // Relie la future conversation privée à la publication/commentaire source.
    // Ainsi, si le client répond au message privé, le commercial retrouve le
    // contexte produit/publication directement dans Messages.
    if (recipientId) {
      const contact = `${target.channel}:${recipientId}`;
      const post = loadSocialPosts().find(item => item.key === socialKey(target.channel, target.postId)) || {};
      updateConversationStateAdmin(contact, state => ({
        ...state,
        channel:target.channel,
        externalContact:recipientId,
        ...(target.channel === 'facebook' ? { facebookPsid:recipientId } : {}),
        ...(target.channel === 'instagram' ? { instagramUsername:safeString(target.authorUsername) } : {}),
        sourceContext:{
          type:'comment_private_reply',
          label:`Commentaire ${target.channel === 'instagram' ? 'Instagram' : 'Facebook'}`,
          id:safeString(target.postId),
          commentId:safeString(target.commentId),
          caption:safeString(post?.caption),
          url:safeString(post?.permalink || post?.sourceUrl),
          mediaUrl:safeString(post?.thumbnailUrl || post?.mediaUrl),
          customerComment:safeString(target.text)
        },
        lastSocialCommentKey:key,
        lastSocialCommentAt:safeString(target.createdAt),
        updatedAt:now
      }));
    }

    return res.json({ success:true, recipientId, messageId:safeString(data?.message_id) });
  } catch (error) {
    return res.status(502).json({ error:`Meta : ${error.message}` });
  }
});

function conversationEntryPreview(entry) {
  const attachments = Array.isArray(entry?.attachments) ? entry.attachments.filter(Boolean) : [];
  const source = safeString(entry?.source);
  const commercialName = safeString(entry?.commercial_user_name || entry?.actor_name);

  if (entry?.reply_sent && safeString(entry?.reply)) {
    if (safeString(entry?.channel) === 'facebook' || source.startsWith('facebook_meta')) {
      return `🔵 Facebook / Meta : ${safeString(entry.reply)}`.slice(0, 220);
    }
    if (source.startsWith('commercial')) {
      return `${commercialName ? `👤 ${commercialName} : ` : '👤 Équipe MONDECO : '}${safeString(entry.reply)}`.slice(0, 220);
    }
    if (safeString(entry?.action) === 'ai_reply') {
      return `🤖 ${safeString(entry.reply)}`.slice(0, 220);
    }
  }

  if (safeString(entry?.incoming)) return safeString(entry.incoming).slice(0, 220);

  if (attachments.length > 1 && attachments.every(item => safeString(item?.type) === 'image')) {
    return `📷 ${attachments.length} photos`;
  }

  const type = safeString(attachments[0]?.type || entry?.attachment_type || entry?.type).toLowerCase();
  if (type === 'image') return '📷 Photo envoyée';
  if (type === 'audio') return '🎤 Message vocal';
  if (type === 'video') return '🎬 Vidéo';
  if (type === 'file' || type === 'document') return '📎 Fichier';

  return 'Nouvelle conversation';
}

function conversationEntryNeedsDirection(entry) {
  const direction = safeString(entry?.direction || entry?.attachment_direction).toLowerCase();
  const senderKind = safeString(entry?.sender_kind).toLowerCase();
  const source = safeString(entry?.source).toLowerCase();
  const action = safeString(entry?.action).toLowerCase();
  const incoming = Boolean(safeString(entry?.incoming));
  const reply = Boolean(safeString(entry?.reply));
  const inbound = direction === 'incoming' || senderKind === 'client' || incoming;
  const outbound = direction === 'outgoing' || entry?.reply_sent === true ||
    source.startsWith('commercial') || action === 'ai_reply' || action === 'commercial_reply' ||
    senderKind === 'human' || senderKind === 'meta' || (!inbound && reply);
  return { inbound, outbound };
}

// V6.33.1 — une seule source de vérité pour tous les compteurs Messages.
// On privilégie l'ordre réel des événements du journal. Un ancien lastCustomerAt
// importé ne doit plus remettre une discussion en rouge si le dernier échange
// visible est déjà une réponse MONDECO / Meta / IA.
function conversationDirectionalEvidence(entries = [], state = {}) {
  let latestInboundMs = 0;
  let latestInboundIso = '';
  let latestOutboundMs = 0;
  let latestOutboundIso = '';
  let latestHumanMs = 0;
  let latestHumanIso = '';

  const ordered = [...(Array.isArray(entries) ? entries : [])].sort(conversationEntryComparator);
  for (const entry of ordered) {
    let ms = normalizedConversationTime(entry);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const flags = conversationEntryNeedsDirection(entry);
    if (flags.inbound && ms >= latestInboundMs) {
      latestInboundMs = ms;
      latestInboundIso = safeString(entry?.meta_created_time || entry?.event_time || entry?.created_time || entry?.time || entry?.timestamp);
    }
    if (flags.outbound) {
      // Certains anciens événements WhatsApp contiennent le message client ET
      // la réponse dans la même entrée / même seconde. Dans ce cas la réponse
      // est nécessairement postérieure au message qui l'a déclenchée.
      const outboundMs = flags.inbound ? ms + 1 : ms;
      if (outboundMs >= latestOutboundMs) {
        latestOutboundMs = outboundMs;
        const rawOutboundIso = safeString(entry?.reply_time || entry?.meta_created_time || entry?.event_time || entry?.created_time || entry?.time || entry?.timestamp);
        latestOutboundIso = flags.inbound && !safeString(entry?.reply_time)
          ? new Date(outboundMs).toISOString()
          : rawOutboundIso;
      }
      if (conversationEntryIsBusinessReply(entry) && outboundMs >= latestHumanMs) {
        latestHumanMs = outboundMs;
        latestHumanIso = latestOutboundIso;
      }
    }
  }

  const stateInboundMs = conversationTimeMs(state?.lastCustomerAt);
  const stateHumanMs = conversationTimeMs(state?.lastHumanAt);
  const stateBotMs = conversationTimeMs(state?.lastBotAt);
  const stateAnsweredMs = conversationTimeMs(state?.lastAnsweredAt);
  const stateBusinessMs = conversationTimeMs(state?.lastBusinessAt);
  const answeredCustomerMs = conversationTimeMs(state?.lastAnsweredCustomerAt);
  const stateResponseMs = Math.max(
    Number.isFinite(stateHumanMs) ? stateHumanMs : 0,
    Number.isFinite(stateBotMs) ? stateBotMs : 0,
    Number.isFinite(stateAnsweredMs) ? stateAnsweredMs : 0,
    Number.isFinite(stateBusinessMs) ? stateBusinessMs : 0
  );

  // Un lastCustomerAt plus récent que tout le journal n'est accepté comme
  // nouveau message que s'il n'est pas déjà acquitté par un marqueur de réponse.
  let effectiveInboundMs = latestInboundMs;
  let effectiveInboundIso = latestInboundIso;
  if (Number.isFinite(stateInboundMs) && stateInboundMs > effectiveInboundMs) {
    const stateAlreadyAnswered =
      stateResponseMs >= stateInboundMs ||
      (Number.isFinite(answeredCustomerMs) && answeredCustomerMs >= stateInboundMs);
    if (!stateAlreadyAnswered) {
      effectiveInboundMs = stateInboundMs;
      effectiveInboundIso = safeString(state?.lastCustomerAt);
    }
  }

  const effectiveOutboundMs = Math.max(latestOutboundMs, stateResponseMs);
  const hasInbound = effectiveInboundMs > 0;
  const answered = hasInbound && effectiveOutboundMs >= effectiveInboundMs;
  const pending = hasInbound && !answered;

  return {
    pending,
    answered,
    latestInboundMs: effectiveInboundMs,
    latestInboundIso: effectiveInboundIso,
    latestOutboundMs: effectiveOutboundMs,
    latestOutboundIso: latestOutboundIso || safeString(state?.lastAnsweredAt || state?.lastBusinessAt || state?.lastHumanAt || state?.lastBotAt),
    latestHumanMs: Math.max(latestHumanMs, Number.isFinite(stateHumanMs) ? stateHumanMs : 0),
    latestHumanIso: latestHumanIso || safeString(state?.lastHumanAt),
    answeredCustomerMs: Number.isFinite(answeredCustomerMs) ? answeredCustomerMs : 0
  };
}

function conversationNeedsReplyFromEntries(entries = [], state = {}) {
  if (state?.resolved === true) return false;
  return conversationDirectionalEvidence(entries, state).pending;
}

function conversationEntryIsBusinessReply(entry) {
  const flags = conversationEntryNeedsDirection(entry);
  if (!flags.outbound) return false;
  const source = safeString(entry?.source).toLowerCase();
  const action = safeString(entry?.action).toLowerCase();
  const senderKind = safeString(entry?.sender_kind).toLowerCase();
  return Boolean(
    source.startsWith('commercial') ||
    action === 'commercial_reply' ||
    senderKind === 'human' ||
    senderKind === 'meta' ||
    safeString(entry?.commercial_user_id) ||
    safeString(entry?.commercial_user_name) ||
    safeString(entry?.facebook_response_owner)
  );
}

let lastAnsweredConversationReconcileAt = 0;

// V6.33.1 — auto-réparation des anciennes discussions déjà traitées.
// Une réponse commerciale peut avoir été synchronisée depuis WhatsApp Business,
// Instagram ou Meta après que l'état local unread/SLA a été écrit. L'historique
// réel est la source de vérité : si une réponse business est postérieure au
// dernier message client, la discussion n'est plus « à répondre ».
function reconcileAnsweredConversationStates(log = [], statesInput = null) {
  const states = statesInput && typeof statesInput === 'object' && !Array.isArray(statesInput)
    ? statesInput
    : loadConversationStatesAdmin();
  const nowMs = Date.now();
  // V6.33.1 : le recalcul est léger et doit corriger rapidement l'écran après
  // une synchro Meta. 1,5 s évite les réécritures excessives tout en restant instantané.
  if (nowMs - lastAnsweredConversationReconcileAt < 1500) return states;
  lastAnsweredConversationReconcileAt = nowMs;

  const byContact = {};
  for (const entry of Array.isArray(log) ? log : []) {
    const contact = safeString(entry?.contact);
    if (!contact) continue;
    (byContact[contact] ||= []).push(entry);
  }

  let changed = false;
  for (const [contact, rawEntries] of Object.entries(byContact)) {
    const current = states[contact] && typeof states[contact] === 'object' ? states[contact] : {};
    const channel = contact.startsWith('instagram:')
      ? 'instagram'
      : contact.startsWith('facebook:')
        ? 'facebook'
        : safeString(current?.channel).toLowerCase() || 'whatsapp';
    const entries = channel === 'instagram'
      ? normalizeInstagramThreadEntries(rawEntries)
      : [...rawEntries].sort(conversationEntryComparator);
    const evidence = conversationDirectionalEvidence(entries, current);

    // Aucun message client prouvé : ne pas toucher à l'état métier.
    if (!evidence.latestInboundMs) continue;

    // La discussion reste réellement en attente si le dernier échange prouvé
    // est un message client plus récent que toute réponse connue.
    if (evidence.pending) continue;

    const latestInboundIso = evidence.latestInboundIso || safeString(current?.lastCustomerAt);
    const latestResponseIso = evidence.latestOutboundIso || safeString(current?.lastAnsweredAt || current?.lastHumanAt || current?.lastBotAt);
    const latestHumanAnswered = evidence.latestHumanMs >= evidence.latestInboundMs;
    const sla = current?.sla && typeof current.sla === 'object' ? current.sla : null;
    const slaOpen = Boolean(sla && ['pending','late'].includes(safeString(sla.status)));

    const needsRepair =
      Number(current?.unreadCount || 0) > 0 ||
      current?.awaitingResponse === true ||
      (latestHumanAnswered && (current?.commercialAttention === true || current?.imageNeedsCommercial === true)) ||
      slaOpen ||
      !Number.isFinite(conversationTimeMs(current?.lastAnsweredAt)) ||
      conversationTimeMs(current?.lastAnsweredAt) < evidence.latestOutboundMs ||
      !Number.isFinite(conversationTimeMs(current?.lastAnsweredCustomerAt)) ||
      conversationTimeMs(current?.lastAnsweredCustomerAt) < evidence.latestInboundMs;

    if (!needsRepair) continue;

    let nextSla = sla;
    if (slaOpen) {
      const startedMs = conversationTimeMs(sla?.startedAt);
      const dueMs = conversationTimeMs(sla?.dueAt);
      const responseMs = evidence.latestOutboundMs || nowMs;
      const responseSeconds = Number.isFinite(startedMs)
        ? Math.max(0, Math.round((responseMs - startedMs) / 1000))
        : null;
      const late = Number.isFinite(dueMs) && responseMs > dueMs;
      nextSla = {
        ...sla,
        status: late ? 'late_resolved' : 'resolved',
        answeredAt: latestResponseIso || new Date(responseMs).toISOString(),
        responseSeconds,
        lateSeconds: late && Number.isFinite(dueMs)
          ? Math.max(0, Math.round((responseMs - dueMs) / 1000))
          : 0,
        reconciledFromHistory: true,
        reconciledVersion: '6.32.6'
      };
    }

    states[contact] = {
      ...current,
      unreadCount: 0,
      lastUnreadMessageId: '',
      lastReadAt: maxIso(current?.lastReadAt, latestResponseIso),
      lastAnsweredAt: maxIso(current?.lastAnsweredAt, latestResponseIso),
      lastAnsweredCustomerAt: maxIso(current?.lastAnsweredCustomerAt, latestInboundIso),
      awaitingResponse: false,
      // Les alertes de transfert commercial ne sont effacées que lorsqu'une
      // vraie réponse humaine/Meta est prouvée après le dernier client.
      commercialAttention: latestHumanAnswered ? false : Boolean(current?.commercialAttention),
      commercialAttentionReason: latestHumanAnswered ? '' : safeString(current?.commercialAttentionReason),
      imageNeedsCommercial: latestHumanAnswered ? false : Boolean(current?.imageNeedsCommercial),
      ...(evidence.latestHumanIso ? { lastHumanAt:maxIso(current?.lastHumanAt, evidence.latestHumanIso) } : {}),
      ...(nextSla ? { sla: nextSla } : {}),
      counterReconciledAt: new Date().toISOString(),
      counterReconciledVersion: '6.32.6'
    };
    changed = true;
  }

  if (changed) saveConversationStatesAdmin(states);
  return states;
}

function fastPendingMessageStatusFromStates() {
  const states = loadConversationStatesAdmin();
  const cutoffAt = historyImportCutoffIso();
  const result = new Map();

  for (const [contact, stateValue] of Object.entries(states || {})) {
    const state = stateValue && typeof stateValue === 'object' ? stateValue : {};
    const lastCustomerAt = safeString(state?.lastCustomerAt);
    if (!lastCustomerAt || !historyTimeIsRecent(lastCustomerAt, cutoffAt)) continue;

    const channelRaw = safeString(state?.channel).toLowerCase();
    const channel = channelRaw === 'instagram' || contact.startsWith('instagram:')
      ? 'instagram'
      : channelRaw === 'facebook' || contact.startsWith('facebook:')
        ? 'facebook'
        : 'whatsapp';

    const inboundMs = conversationTimeMs(lastCustomerAt);
    const answeredCustomerMs = conversationTimeMs(state?.lastAnsweredCustomerAt);
    const responseCandidates = [
      conversationTimeMs(state?.lastAnsweredAt),
      conversationTimeMs(state?.lastHumanAt),
      conversationTimeMs(state?.lastBotAt),
      conversationTimeMs(state?.lastBusinessAt)
    ].filter(Number.isFinite);
    const responseMs = responseCandidates.length ? Math.max(...responseCandidates) : NaN;

    const acknowledged =
      (Number.isFinite(answeredCustomerMs) && Number.isFinite(inboundMs) && answeredCustomerMs >= inboundMs) ||
      (Number.isFinite(responseMs) && Number.isFinite(inboundMs) && responseMs >= inboundMs);

    result.set(contact, {
      contact,
      channel,
      pending: state?.resolved === true ? false : !acknowledged,
      resolved: state?.resolved === true,
      lastTime: lastCustomerAt
    });
  }
  return result;
}

function pendingMessageStatusByContact(logInput = null) {
  // Les badges/notifications sont rafraîchis fréquemment : utiliser l'état
  // réconcilié, qui tient en mémoire en quelques Ko, au lieu de rescanner
  // WhatsApp + Instagram + Facebook à chaque poll.
  if (!Array.isArray(logInput)) return fastPendingMessageStatusFromStates();

  const log = logInput;
  const states = reconcileAnsweredConversationStates(log, loadConversationStatesAdmin());
  const byContact = {};
  for (const entry of log) {
    const contact = safeString(entry?.contact);
    if (!contact) continue;
    (byContact[contact] ||= []).push(entry);
  }
  const cutoffAt = historyImportCutoffIso();
  const result = new Map();
  for (const [contact, entries] of Object.entries(byContact)) {
    const state = states[contact] || {};
    const sorted = contact.startsWith('instagram:')
      ? normalizeInstagramThreadEntries(entries)
      : [...entries].sort(conversationEntryComparator);
    const last = sorted[sorted.length - 1] || {};
    const channelRaw = safeString(last?.channel || state?.channel).toLowerCase();
    const channel = channelRaw === 'instagram' || contact.startsWith('instagram:')
      ? 'instagram'
      : channelRaw === 'facebook' || contact.startsWith('facebook:')
        ? 'facebook'
        : 'whatsapp';
    const lastTime = safeString(last?.time || state?.lastCustomerAt);
    if (!historyTimeIsRecent(lastTime, cutoffAt)) continue;
    result.set(contact, {
      contact,
      channel,
      pending: state?.resolved === true ? false : conversationNeedsReplyFromEntries(sorted, state),
      resolved: state?.resolved === true,
      lastTime
    });
  }
  return result;
}

function pendingInteractionCountsForUser(user, logInput = null) {
  const messageStatus = pendingMessageStatusByContact(logInput);
  const channelScope = plannedChannelSetForUser(user);
  let pendingMessages = [...messageStatus.values()].filter(item => !item.resolved && item.pending);
  let scopedComments = loadSocialComments();
  if (channelScope) {
    pendingMessages = pendingMessages.filter(item => channelScopeAllowsMessage(channelScope, item.channel));
    scopedComments = scopedComments.filter(item => channelScopeAllowsComment(channelScope, item?.channel));
  }
  const commentCounts = socialCommentCounts(scopedComments, user);
  return {
    messages: pendingMessages.length,
    whatsapp: pendingMessages.filter(item => item.channel === 'whatsapp').length,
    instagramMessages: pendingMessages.filter(item => item.channel === 'instagram').length,
    facebookMessages: pendingMessages.filter(item => item.channel === 'facebook').length,
    comments: Number(commentCounts.pendingReply || 0),
    instagramComments: Number(commentCounts.pendingInstagram || 0),
    facebookComments: Number(commentCounts.pendingFacebook || 0),
    total: pendingMessages.length + Number(commentCounts.pendingReply || 0)
  };
}


router.get('/api/interactions/pending-counts', requireAuth, (req,res) => {
  try {
    return res.json({ counts: pendingInteractionCountsForUser(req.user), checkedAt:new Date().toISOString() });
  } catch (error) {
    console.error('❌ Recalcul compteurs interactions :', error);
    return res.status(500).json({ error:'Impossible de recalculer les compteurs.' });
  }
});

// V6.33.1 — réparation explicite des anciens états importés. Appelé une fois
// après ouverture de l'interface afin que les badges historiques 1/2/3/4
// disparaissent immédiatement si la discussion a déjà une réponse postérieure.
router.post('/api/interactions/reconcile', requireAuth, (req,res) => {
  try {
    lastAnsweredConversationReconcileAt = 0;
    const log = loadWhatsAppLog();
    reconcileAnsweredConversationStates(log, loadConversationStatesAdmin());
    const counts = pendingInteractionCountsForUser(req.user, log);
    return res.json({ success:true, counts, reconciledAt:new Date().toISOString() });
  } catch (error) {
    console.error('❌ Réconciliation compteurs interactions :', error);
    return res.status(500).json({ error:'Impossible de réconcilier les compteurs.' });
  }
});

router.get('/api/conversations', requireAuth, (req, res) => {
  try {
    const log = loadWhatsAppLog();
    const states = reconcileAnsweredConversationStates(log, loadConversationStatesAdmin());

    const byContact = {};

    for (const entry of log) {
      const contact = safeString(entry.contact);
      if (!contact) continue;
      if (!byContact[contact]) byContact[contact] = [];
      byContact[contact].push(entry);
    }

    const conversations = Object.keys(byContact).map(contact => {
      const entries = contact.startsWith('instagram:')
        ? normalizeInstagramThreadEntries(byContact[contact])
        : byContact[contact].sort(conversationEntryComparator);
      const lastActivity = entries[entries.length - 1];
      const last = [...entries].reverse().find(item => {
        const attachments = Array.isArray(item?.attachments) ? item.attachments.filter(Boolean) : [];
        const mediaType = safeString(item?.attachment_type || item?.type).toLowerCase();
        return Boolean(
          safeString(item?.incoming) ||
          safeString(item?.reply) ||
          attachments.length ||
          ['image','video','audio','file','document','attachment'].includes(mediaType)
        );
      }) || lastActivity;
      const state = states[contact] || {};

      return {
        contact,
        messageCount: entries.length,
        lastTime: last?.time || null,
        lastIncoming: safeString(last?.incoming),
        lastReply: safeString(last?.reply),
        lastAction: safeString(last?.action),
        lastReplySent: Boolean(last?.reply_sent),
        lastSource: safeString(last?.source),
        lastMessagePreview: conversationEntryPreview(last),
        lastMessageId: safeString(last?.message_id || last?.meta_message_id),
        channel: (() => {
          const raw = safeString(last?.channel || state?.channel).toLowerCase();
          if (raw === 'instagram' || contact.startsWith('instagram:')) return 'instagram';
          if (raw === 'facebook' || contact.startsWith('facebook:')) return 'facebook';
          return 'whatsapp';
        })(),
        externalContact:
          safeString(
            last?.external_contact ||
            state?.externalContact ||
            (contact.startsWith('instagram:')
              ? contact.slice('instagram:'.length)
              : contact.startsWith('facebook:')
                ? contact.slice('facebook:'.length)
                : contact)
          ),
        instagramUsername:
          safeString(state?.instagramUsername),
        facebookPsid:
          safeString(state?.facebookPsid),
        facebookResponseMode:
          safeString(state?.facebookResponseMode),
        facebookConversationLink:
          safeString(state?.facebookConversationLink),
        mondecoAiEnabled:
          state?.mondecoAiEnabled !== false,
        profilePicture:
          safeString(state?.profilePicture),
        aiModePreference:
          safeString(state?.aiModePreference),
        aiModeChoicePending:
          Boolean(state?.aiModeChoicePending),
        hasAdReferral: Boolean(state.cameFromAd || state.adReferral),
        adHeadline: safeString(state?.adReferral?.headline),
        adBody: safeString(state?.adReferral?.body),
        adCtwaClid: safeString(state?.adReferral?.ctwaClid),
        adProductHint:
          safeString(
            state?.adReferral?.productHint ||
            safeString(state?.adReferral?.headline).split('|')[0]
          ),
        adSourceId: safeString(state?.adReferral?.sourceId),
        adSourceUrl: safeString(state?.adReferral?.sourceUrl),
        adMediaType: safeString(state?.adReferral?.mediaType),
        adMediaUrl: safeString(state?.adReferral?.storedMediaUrl || state?.adReferral?.mediaUrl),
        adCampaignName: safeString(state?.adReferral?.campaignName || state?.adReferral?.campaignId),
        adSetName: safeString(state?.adReferral?.adsetName || state?.adReferral?.adsetId),
        adCreativeName: safeString(state?.adReferral?.creativeName || state?.adReferral?.creativeId),
        sourceContext: state?.sourceContext && typeof state.sourceContext === 'object' ? state.sourceContext : null,
        imageNeedsCommercial: Boolean(state.imageNeedsCommercial),
        lastImageProduct: safeString(state?.lastImageProduct),
        lastImageReason: safeString(state?.lastImageReason),
        commercialAttention: Boolean(state.commercialAttention),
        commercialAttentionReason: safeString(state?.commercialAttentionReason),
        lastCustomerAt: safeString(state?.lastCustomerAt),
        lastInboundType: safeString(state?.lastInboundType),
        profileName: safeString(state?.profileName),
        unreadCount: Number(state.unreadCount || 0),
        priority: Boolean(state.priority),
        favorite: Boolean(state.favorite),
        favoriteAt: safeString(state?.favoriteAt),
        assignedTo: safeString(state?.assignedTo),
        assignedUserId: safeString(state?.assignedUserId),
        sla: computeLiveSla(state),
        slaStatus: safeString(computeLiveSla(state)?.status),
        slaDueAt: safeString(computeLiveSla(state)?.dueAt),
        slaRemainingMs: computeLiveSla(state)?.remainingMs ?? null,
        resolved: Boolean(state.resolved),
        resolvedAt: safeString(state?.resolvedAt),
        activeProductName: safeString(state?.activeProductName),
        manualTakeover: Boolean(state.manualTakeover),
        humanPaused: Boolean(state.humanPaused),
        pausedUntil: safeString(state?.pausedUntil),
        awaitingResponse: Boolean(state.awaitingResponse),
        pendingReply: conversationNeedsReplyFromEntries(entries, state),
        followUpsSent: Number(state.followUpsSent || 0)
      };
    }).sort((a, b) => {
      // V6.33.1 : travail à faire d'abord. Une conversation descend dès qu'une
      // vraie réponse commerciale/IA a été enregistrée.
      const pendingDelta = Number(b?.pendingReply === true) - Number(a?.pendingReply === true);
      if (pendingDelta) return pendingDelta;
      const unreadDelta = Number(Number(b?.unreadCount || 0) > 0) - Number(Number(a?.unreadCount || 0) > 0);
      if (unreadDelta) return unreadDelta;
      const aMs = conversationTimeMs(a.lastTime);
      const bMs = conversationTimeMs(b.lastTime);
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    });

    const retentionCutoff = historyImportCutoffIso();
    const activeCutoff = activeInboxCutoffIso();

    // V6.33.1 : appliquer la rétention de 15 jours à TOUS les rôles, y compris
    // Admin/Responsable. Avant, seuls les commerciaux étaient filtrés, ce qui
    // laissait des milliers d'anciennes conversations dans l'interface admin.
    let retainedConversations = conversations
      .filter(item => item.favorite === true || historyTimeIsRecent(item.lastTime, retentionCutoff))
      .map(item => {
        const isCommercial = req.user?.role === 'commercial';
        const assignedToMe = isCommercial && safeString(item.assignedUserId) === safeString(req.user.id);
        return {
          ...item,
          assignedToMe,
          canWrite: true,
          canReply: true,
          canManage: !isCommercial || assignedToMe,
          readOnly: isCommercial && !assignedToMe
        };
      });

    // V6.33.1 : si un commercial possède un planning aujourd'hui, sa boîte de
    // travail est limitée aux réseaux cochés dans Équipe & planning. Sans planning
    // explicite, on conserve l'accès actuel pour éviter un verrouillage accidentel.
    const commercialChannelScope = plannedChannelSetForUser(req.user);
    if (commercialChannelScope) {
      retainedConversations = retainedConversations.filter(item => channelScopeAllowsMessage(commercialChannelScope, item.channel));
    }

    // Boîte active : toujours conserver le travail à faire, les non lus,
    // priorités et favoris. Une conversation déjà traitée reste visible
    // ACTIVE_INBOX_HOURS heures, puis passe dans « Historique 15j ».
    const activeConversations = retainedConversations.filter(item =>
      item.favorite === true ||
      item.pendingReply === true ||
      Number(item.unreadCount || 0) > 0 ||
      item.priority === true ||
      historyTimeIsRecent(item.lastTime, activeCutoff)
    );

    const countBase = activeConversations;
    const counts = {
      all: countBase.filter(item => !item.resolved).length,
      whatsapp: countBase.filter(item => !item.resolved && item.channel === 'whatsapp').length,
      instagram: countBase.filter(item => !item.resolved && item.channel === 'instagram').length,
      facebook: countBase.filter(item => !item.resolved && item.channel === 'facebook').length,
      unread: countBase.filter(item => !item.resolved && Number(item.unreadCount || 0) > 0).length,
      pendingReply: countBase.filter(item => !item.resolved && item.pendingReply === true).length,
      pendingWhatsApp: countBase.filter(item => !item.resolved && item.pendingReply === true && item.channel === 'whatsapp').length,
      pendingInstagram: countBase.filter(item => !item.resolved && item.pendingReply === true && item.channel === 'instagram').length,
      pendingFacebook: countBase.filter(item => !item.resolved && item.pendingReply === true && item.channel === 'facebook').length,
      priority: countBase.filter(item => !item.resolved && item.priority).length,
      favorites: retainedConversations.filter(item => item.favorite === true).length,
      commercial: countBase.filter(item => !item.resolved && (item.commercialAttention || item.imageNeedsCommercial)).length,
      sla: countBase.filter(item => !item.resolved && ['pending','late'].includes(safeString(item?.slaStatus))).length,
      ads: countBase.filter(item => !item.resolved && item.hasAdReferral).length,
      resolved: retainedConversations.filter(item => item.resolved).length,
      history15: retainedConversations.filter(item => !item.resolved).length,
      activeHours: ACTIVE_INBOX_HOURS
    };

    const requestedFilter = safeString(req.query?.filter).toLowerCase();
    let visibleConversations;
    if (requestedFilter === 'resolved') {
      visibleConversations = retainedConversations.filter(item => item.resolved === true);
    } else if (requestedFilter === 'favorites') {
      visibleConversations = retainedConversations.filter(item => item.favorite === true);
    } else if (requestedFilter === 'history15') {
      visibleConversations = retainedConversations.filter(item => !item.resolved);
    } else {
      visibleConversations = activeConversations.filter(item => !item.resolved);
      if (['whatsapp','instagram','facebook'].includes(requestedFilter)) {
        visibleConversations = visibleConversations.filter(item => item.channel === requestedFilter);
      } else if (requestedFilter === 'unread') {
        visibleConversations = visibleConversations.filter(item => Number(item.unreadCount || 0) > 0);
      } else if (requestedFilter === 'pending') {
        visibleConversations = visibleConversations.filter(item => item.pendingReply === true);
      } else if (requestedFilter === 'priority') {
        visibleConversations = visibleConversations.filter(item => item.priority === true);
      } else if (requestedFilter === 'commercial') {
        visibleConversations = visibleConversations.filter(item => item.commercialAttention || item.imageNeedsCommercial);
      } else if (requestedFilter === 'sla') {
        visibleConversations = visibleConversations.filter(item => ['pending','late'].includes(safeString(item?.slaStatus)));
      } else if (requestedFilter === 'ads') {
        visibleConversations = visibleConversations.filter(item => item.hasAdReferral === true);
      }
    }

    const search = safeString(req.query?.q).toLowerCase();
    if (search) {
      // La recherche couvre tout l'historique conservé 15 jours, même si la
      // conversation est sortie de la boîte active.
      if (!['resolved','favorites'].includes(requestedFilter)) {
        visibleConversations = retainedConversations.filter(item => !item.resolved);
        if (['whatsapp','instagram','facebook'].includes(requestedFilter)) {
          visibleConversations = visibleConversations.filter(item => item.channel === requestedFilter);
        }
      }
      visibleConversations = visibleConversations.filter(item => {
        const entries = byContact[item.contact] || [];
        const searchable = [
          item.contact,
          item.externalContact,
          item.instagramUsername,
          item.facebookPsid,
          item.profileName,
          item.assignedTo,
          item.activeProductName,
          item.adHeadline,
          item.adBody,
          item.adProductHint,
          item.adSourceId,
          item.adCampaignName,
          item.adSetName,
          item.adCreativeName,
          item.sourceContext?.label,
          item.sourceContext?.id,
          item.sourceContext?.caption,
          item.sourceContext?.url,
          item.sourceContext?.raw ? JSON.stringify(item.sourceContext.raw) : '',
          ...entries.flatMap(entry => [
            entry?.incoming,
            entry?.reply,
            entry?.ad_headline,
            entry?.source_caption,
            entry?.source_url
          ])
        ]
          .map(value => safeString(value).toLowerCase())
          .join(' ');
        return searchable.includes(search);
      });
    }

    if (String(req.query?.paged || '') === '1') {
      const limit = Math.max(20, Math.min(200, Number(req.query?.limit || 80) || 80));
      const offset = Math.max(0, Number(req.query?.offset || 0) || 0);
      return res.json({
        items: visibleConversations.slice(offset, offset + limit),
        total: visibleConversations.length,
        offset,
        limit,
        hasMore: offset + limit < visibleConversations.length,
        counts,
        access:{
          whatsappMessages:channelScopeAllowsMessage(commercialChannelScope, 'whatsapp'),
          instagramMessages:channelScopeAllowsMessage(commercialChannelScope, 'instagram'),
          facebookMessages:channelScopeAllowsMessage(commercialChannelScope, 'facebook')
        },
        activeInboxHours: ACTIVE_INBOX_HOURS,
        retentionDays: HISTORY_IMPORT_DAYS
      });
    }

    return res.json(visibleConversations);
  } catch (error) {
    console.error('❌ Liste conversations :', error);
    return res.status(500).json({ error: 'Impossible de lire les conversations.' });
  }
});


// ============================================================
// V6.34.2 — SUPPRESSION DÉFINITIVE D'UN MESSAGE DANS MONDECO
// ============================================================
function rewriteConversationArrayFileForPurge(filePath, targetHash, part) {
  if (!fs.existsSync(filePath)) return 0;
  let items;
  try { items = JSON.parse(fs.readFileSync(filePath,'utf8') || '[]'); }
  catch { return 0; }
  if (!Array.isArray(items)) return 0;
  let removed = 0;
  const next = [];
  for (const original of items) {
    const hash = conversationEntryPartPurgeHash(original, part);
    if (hash !== targetHash) { next.push(original); continue; }
    removed += 1;
    const transformed = applyConversationPurgeTombstones(original);
    if (transformed) next.push(transformed);
  }
  if (removed) writeJsonAtomic(filePath, next);
  return removed;
}

function rewritePersistentConversationEventsForPurge(targetHash, part) {
  if (!fs.existsSync(CONVERSATION_EVENTS_DIR)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(CONVERSATION_EVENTS_DIR)) {
    if (!/^conversation-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const filePath = path.join(CONVERSATION_EVENTS_DIR,name);
    const output = [];
    let changed = false;
    for (const line of fs.readFileSync(filePath,'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const original = JSON.parse(line);
        if (conversationEntryPartPurgeHash(original, part) === targetHash) {
          removed += 1; changed = true;
          const transformed = applyConversationPurgeTombstones(original);
          if (transformed) output.push(JSON.stringify(transformed));
        } else output.push(line);
      } catch { output.push(line); }
    }
    if (changed) fs.writeFileSync(filePath, output.length ? `${output.join('\n')}\n` : '', 'utf8');
  }
  return removed;
}

function purgeMessageIdsFromIndex(entry = {}) {
  const ids = new Set([safeString(entry?.message_id),safeString(entry?.meta_message_id)].filter(Boolean));
  if (!ids.size || !fs.existsSync(MESSAGE_ID_INDEX_PATH)) return 0;
  const lines = fs.readFileSync(MESSAGE_ID_INDEX_PATH,'utf8').split(/\r?\n/).filter(Boolean);
  const next = lines.filter(line => !ids.has(safeString(line)));
  if (next.length !== lines.length) fs.writeFileSync(MESSAGE_ID_INDEX_PATH, next.length ? `${next.join('\n')}\n` : '', 'utf8');
  return lines.length - next.length;
}

function purgeNotificationsForConversationEntry(entry = {}) {
  const ids = new Set([safeString(entry?.message_id),safeString(entry?.meta_message_id)].filter(Boolean));
  const contact = safeString(entry?.contact);
  const time = safeString(entry?.time);
  const store = loadNotificationsStore();
  const before = store.items.length;
  store.items = store.items.filter(item => {
    if (safeString(item?.contact) !== contact) return true;
    const messageId = safeString(item?.messageId || item?.id);
    if (messageId && ids.has(messageId)) return false;
    if (!ids.size && time && safeString(item?.createdAt) === time) return false;
    return true;
  });
  if (store.items.length !== before) saveNotificationsStore(store);
  return before - store.items.length;
}

function rebuildConversationStateAfterPurge(contact) {
  const states = loadConversationStatesAdmin();
  const current = states[contact] && typeof states[contact] === 'object' ? states[contact] : {};
  let entries = loadWhatsAppLog().filter(item => safeString(item?.contact) === safeString(contact));
  entries = contact.startsWith('instagram:') ? normalizeInstagramThreadEntries(entries) : entries.sort(conversationEntryComparator);
  if (!entries.length) {
    delete states[contact];
    saveConversationStatesAdmin(states);
    return {};
  }
  const cleanState = { ...current, lastCustomerAt:'', lastHumanAt:'', lastBotAt:'', lastAnsweredAt:'', lastAnsweredCustomerAt:'', unreadCount:0, lastUnreadMessageId:'' };
  const evidence = conversationDirectionalEvidence(entries, cleanState);
  const latestInbound = [...entries].reverse().find(item => conversationEntryNeedsDirection(item).inbound) || {};
  const latestBot = [...entries].reverse().find(item => {
    const flags = conversationEntryNeedsDirection(item);
    return flags.outbound && !conversationEntryIsBusinessReply(item);
  }) || {};
  states[contact] = {
    ...current,
    lastCustomerAt:safeString(evidence.latestInboundIso),
    lastHumanAt:safeString(evidence.latestHumanIso),
    lastBotAt:safeString(latestBot?.time || latestBot?.reply_time),
    lastAnsweredAt:safeString(evidence.latestOutboundIso),
    lastAnsweredCustomerAt:evidence.answered ? safeString(evidence.latestInboundIso) : '',
    unreadCount:evidence.pending ? 1 : 0,
    lastUnreadMessageId:evidence.pending ? safeString(latestInbound?.message_id || latestInbound?.meta_message_id) : '',
    awaitingResponse:evidence.pending,
    updatedAt:new Date().toISOString()
  };
  saveConversationStatesAdmin(states);
  return states[contact];
}

function purgeConversationMessagePart(target, part) {
  const targetHash = conversationEntryPartPurgeHash(target, part);
  if (!targetHash) throw new Error('Empreinte de message invalide.');
  rememberPurgedHashes([targetHash]);
  let removed = 0;
  removed += rewriteConversationArrayFileForPurge(CONVERSATIONS_LOG_PATH,targetHash,part);
  removed += rewriteConversationArrayFileForPurge(INSTAGRAM_HISTORY_PATH,targetHash,part);
  removed += rewriteConversationArrayFileForPurge(FACEBOOK_HISTORY_PATH,targetHash,part);
  removed += rewritePersistentConversationEventsForPurge(targetHash,part);
  purgeMessageIdsFromIndex(target);
  purgeNotificationsForConversationEntry(target);
  combinedConversationLogCache = { liveStamp:'', historyStamp:'', facebookHistoryStamp:'', persistentStamp:'', entries:[] };
  persistentConversationEventsCache = { stamp:'', entries:[] };
  const state = rebuildConversationStateAfterPurge(safeString(target?.contact));
  return { targetHash, removed, state };
}

router.get('/api/conversations/:contact', requireAuth, (req, res) => {
  try {
    const contact = safeString(req.params.contact);
    const log = loadWhatsAppLog();
    const states = loadConversationStatesAdmin();

    const state = states[contact] || {};
    const accessChannel = safeString(state?.channel).toLowerCase() ||
      (contact.startsWith('instagram:') ? 'instagram' : contact.startsWith('facebook:') ? 'facebook' : 'whatsapp');
    if (!requireCommercialMessageChannelAccess(req, res, accessChannel)) return;
    const isCommercial = safeString(req.user?.role) === 'commercial';
    const replyLock = commercialReplyLockInfo(req.user, state, contact);
    const assignedToMe = isCommercial && replyLock.assignedToMe === true;
    const access = {
      assignedToMe,
      canWrite: !isCommercial || replyLock.canReply === true,
      canReply: !isCommercial || replyLock.canReply === true,
      canTakeover: !isCommercial || replyLock.canTakeover === true,
      canManage: !isCommercial || assignedToMe,
      readOnly: isCommercial && replyLock.canReply !== true,
      lockOwnerUserId: safeString(replyLock.ownerId),
      lockOwnerName: safeString(replyLock.ownerName),
      lockReason: safeString(replyLock.reason),
      lockRetryAt: safeString(replyLock.retryAt),
      lockRemainingMs: Number(replyLock.remainingMs || 0),
      lockMinutes: Number(replyLock.lockMinutes || DEFAULT_CONVERSATION_REPLY_LOCK_MINUTES),
      historyDays: HISTORY_IMPORT_DAYS
    };

    let entries = normalizeInstagramThreadEntries(
      log.filter(entry => safeString(entry.contact) === contact)
    );

    const targetMessageId = safeString(req.query?.messageId);
    let targetWindowApplied = false;
    if (targetMessageId) {
      const targetIndex = entries.findIndex(entry =>
        safeString(entry?.message_id || entry?.meta_message_id) === targetMessageId
      );
      if (targetIndex >= 0) {
        const start = Math.max(0, targetIndex - 80);
        const end = Math.min(entries.length, targetIndex + 41);
        entries = entries.slice(start, end);
        targetWindowApplied = true;
      }
    }

    const beforeTime = Date.parse(safeString(req.query?.before));
    if (!targetWindowApplied && Number.isFinite(beforeTime)) {
      entries = entries.filter(entry => {
        const ms = normalizedConversationTime(entry);
        return Number.isFinite(ms) && ms < beforeTime;
      });
    }

    const requestedLimit = Number(req.query?.limit || 0);
    let hasMore = false;
    let nextBefore = '';
    if (!targetWindowApplied && Number.isFinite(requestedLimit) && requestedLimit > 0) {
      const limit = Math.max(20, Math.min(300, requestedLimit));
      hasMore = entries.length > limit;
      entries = entries.slice(-limit);
      nextBefore = hasMore ? safeString(entries[0]?.time) : '';
    }

    const adReferral =
      state?.adReferral &&
      typeof state.adReferral === 'object'
        ? {
            ...state.adReferral,
            productHint:
              safeString(
                state?.adReferral?.productHint ||
                safeString(state?.adReferral?.headline).split('|')[0]
              )
          }
        : state?.adReferral;

    if (safeString(req.user?.role) === 'commercial') {
      appendTeamActivity({
        type:'conversation_open',
        userId:safeString(req.user.id),
        userName:safeString(req.user.name || req.user.email),
        contact,
        channel:accessChannel
      });
    }

    return res.json({
      contact,
      state: {
        ...state,
        ...(adReferral ? { adReferral } : {}),
        sla: computeLiveSla(state)
      },
      entries: entries.map(entry => ({
        ...entry,
        purgeKeys:{
          incoming: (safeString(entry?.incoming) || attachmentDirectionForPurge(entry) === 'incoming') ? conversationEntryPartPurgeHash(entry,'incoming') : '',
          reply: (safeString(entry?.reply) || attachmentDirectionForPurge(entry) === 'outgoing') ? conversationEntryPartPurgeHash(entry,'reply') : ''
        }
      })),
      hasMore,
      nextBefore,
      access
    });
  } catch (error) {
    console.error('❌ Détail conversation :', error);
    return res.status(500).json({ error: 'Impossible de lire cette conversation.' });
  }
});


router.delete('/api/conversations/:contact/messages/:purgeKey', requireAdmin, (req,res) => {
  try {
    const contact = safeString(req.params.contact);
    const purgeKey = safeString(req.params.purgeKey);
    const part = safeString(req.query?.part).toLowerCase();
    if (!contact || !purgeKey || !['incoming','reply'].includes(part)) {
      return res.status(400).json({ error:'Message ou type de suppression invalide.' });
    }
    const target = loadWhatsAppLog().find(entry =>
      safeString(entry?.contact) === contact && conversationEntryPartPurgeHash(entry,part) === purgeKey
    );
    if (!target) return res.status(404).json({ error:'Message introuvable ou déjà supprimé.' });
    const result = purgeConversationMessagePart(target,part);
    return res.json({
      success:true,
      permanentlyDeleted:true,
      removedLocal:result.removed,
      // Les APIs de messagerie privées ne fournissent pas ici un unsend business générique.
      remoteDeleted:false,
      state:result.state
    });
  } catch (error) {
    console.error('❌ Suppression définitive message :', error);
    return res.status(500).json({ error:'Suppression définitive impossible : '+safeString(error?.message) });
  }
});


router.post(
  '/api/conversations/:contact/read',
  requireAuth,
  (req, res) => {
    const contact =
      safeString(
        req.params.contact
      );

    if (!contact) {
      return res
        .status(400)
        .json({
          error:
            'Contact invalide.'
        });
    }

    const existingState = loadConversationStatesAdmin()[contact] || {};
    const readChannel = safeString(existingState?.channel).toLowerCase() ||
      (contact.startsWith('instagram:') ? 'instagram' : contact.startsWith('facebook:') ? 'facebook' : 'whatsapp');
    if (!requireCommercialMessageChannelAccess(req, res, readChannel)) return;

    // Le statut « lu » suit le périmètre exact du planning du jour.
    const state =
      updateConversationStateAdmin(
        contact,
        current => ({
          ...current,
          unreadCount: 0,
          lastUnreadMessageId: '',
          lastReadAt:
            new Date().toISOString()
        })
      );

    markNotificationsReadForContact(contact, req.user);

    return res.json({
      success: true,
      state
    });
  }
);

router.post(
  '/api/conversations/:contact/favorite',
  requireAuth,
  (req, res) => {
    const contact = safeString(req.params.contact);
    if (!contact) {
      return res.status(400).json({ error: 'Contact invalide.' });
    }

    const existingState = loadConversationStatesAdmin()[contact] || {};
    const favoriteChannel = safeString(existingState?.channel).toLowerCase() ||
      (contact.startsWith('instagram:') ? 'instagram' : contact.startsWith('facebook:') ? 'facebook' : 'whatsapp');
    if (!requireCommercialMessageChannelAccess(req, res, favoriteChannel)) return;

    const favorite = req.body?.favorite === true;
    const state = updateConversationStateAdmin(
      contact,
      current => ({
        ...current,
        favorite,
        favoriteAt: favorite ? new Date().toISOString() : ''
      })
    );

    return res.json({
      success: true,
      state,
      retentionDays: HISTORY_IMPORT_DAYS,
      preservedBeyondRetention: favorite
    });
  }
);

router.post(
  '/api/conversations/:contact/priority',
  requireAuth,
  (req, res) => {
    const contact =
      safeString(
        req.params.contact
      );

    if (!requireCommercialConversationWriteAccess(req, res, contact)) return;

    const priority =
      req.body?.priority === true;

    const state =
      updateConversationStateAdmin(
        contact,
        current => ({
          ...current,
          priority
        })
      );

    return res.json({
      success: true,
      state
    });
  }
);

router.post(
  '/api/conversations/:contact/assign',
  requireAuth,
  (req, res) => {
    const contact =
      safeString(
        req.params.contact
      );

    if (safeString(req.user?.role) === 'commercial') {
      return res.status(403).json({
        error: 'L’affectation des conversations est réservée au responsable commercial ou à l’administrateur.'
      });
    }

    const requestedAssignedTo =
      safeString(
        req.body?.assignedTo
      ).slice(
        0,
        100
      );

    const requestedAssignedUserId = safeString(req.body?.assignedUserId);
    const requestedUser = requestedAssignedUserId
      ? loadUsers().find(user => user.id === requestedAssignedUserId && user.role === 'commercial' && user.active !== false)
      : null;

    const assignedTo =
      req.user?.role ===
        'commercial'
        ? (
            safeString(
              req.user?.name
            ) ||
            safeString(
              req.user?.email
            )
          )
        : requestedAssignedTo;

    const state =
      updateConversationStateAdmin(
        contact,
        current => ({
          ...current,
          assignedTo: requestedUser ? (safeString(requestedUser.name) || safeString(requestedUser.email)) : assignedTo,
          assignedUserId:
            req.user?.role ===
              'commercial'
              ? safeString(req.user?.id)
              : (requestedUser ? safeString(requestedUser.id) : safeString(current.assignedUserId)),
          assignedAt:
            assignedTo
              ? new Date().toISOString()
              : null
        })
      );

    return res.json({
      success: true,
      state
    });
  }
);

router.post(
  '/api/conversations/:contact/takeover',
  requireAuth,
  (req, res) => {
    const contact =
      safeString(
        req.params.contact
      );

    if (!requireCommercialConversationWriteAccess(req, res, contact)) return;

    const existingState = loadConversationStatesAdmin()?.[contact] || {};
    const existingChannel = safeString(existingState.channel || (contact.startsWith('facebook:') ? 'facebook' : '')).toLowerCase();
    if(existingChannel === 'facebook'){
      return res.status(409).json({ error:'Facebook est en mode supervision : les réponses restent gérées par Meta Business AI / Business Suite.' });
    }

    const requestedAssignedTo =
      safeString(
        req.body?.assignedTo
      ).slice(
        0,
        100
      );

    const assignedTo =
      req.user?.role ===
        'commercial'
        ? (
            safeString(
              req.user?.name
            ) ||
            safeString(
              req.user?.email
            )
          )
        : (
            requestedAssignedTo ||
            safeString(
              req.user?.name
            ) ||
            safeString(
              req.user?.email
            )
          );

    const state =
      updateConversationStateAdmin(
        contact,
        current => ({
          ...current,
          manualTakeover: true,
          humanPaused: true,
          pausedUntil: null,
          aiModePreference: 'commercial',
          aiModeChoicePending: false,
          aiModeSelectedAt: new Date().toISOString(),
          commercialAttention: false,
          commercialAttentionReason: '',
          imageNeedsCommercial: false,
          assignedTo:
            assignedTo ||
            safeString(
              current.assignedTo
            ),
          assignedUserId:
            req.user?.role === 'commercial'
              ? safeString(req.user?.id)
              : safeString(current.assignedUserId),
          takeoverAt:
            new Date().toISOString()
        })
      );

    return res.json({
      success: true,
      state
    });
  }
);

router.post(
  '/api/conversations/:contact/reactivate-ai',
  requireAuth,
  (req, res) => {
    const contact =
      safeString(
        req.params.contact
      );

    if (!requireCommercialConversationWriteAccess(req, res, contact)) return;

    const existingState = loadConversationStatesAdmin()?.[contact] || {};
    const existingChannel = safeString(existingState.channel || (contact.startsWith('facebook:') ? 'facebook' : '')).toLowerCase();
    if(existingChannel === 'facebook'){
      return res.status(409).json({ error:'L’IA MONDECO est désactivée sur Facebook. Les réponses restent gérées côté Meta.' });
    }

    const state =
      updateConversationStateAdmin(
        contact,
        current => ({
          ...current,
          manualTakeover: false,
          humanPaused: false,
          pausedUntil: null,
          aiModePreference: 'ai',
          aiModeChoicePending: false,
          aiModeSelectedAt: new Date().toISOString(),
          commercialAttention: false,
          commercialAttentionReason: '',
          imageNeedsCommercial: false,
          aiReactivatedAt:
            new Date().toISOString()
        })
      );

    return res.json({
      success: true,
      state
    });
  }
);

router.post(
  '/api/conversations/:contact/resolve',
  requireAuth,
  (req, res) => {
    const contact =
      safeString(
        req.params.contact
      );

    if (!requireCommercialConversationWriteAccess(req, res, contact)) return;

    const resolved =
      req.body?.resolved === true;

    const state =
      updateConversationStateAdmin(
        contact,
        current => ({
          ...current,
          resolved,
          resolvedAt:
            resolved
              ? new Date().toISOString()
              : null,
          unreadCount:
            resolved
              ? 0
              : Number(
                  current.unreadCount ||
                  0
                )
        })
      );

    return res.json({
      success: true,
      state
    });
  }
);


router.get(
  '/api/notifications',
  requireAuth,
  (req, res) => {
    try {
      const states = loadConversationStatesAdmin();
      const userKey = notificationUserKey(req.user);
      const filter = safeString(req.query?.filter).toLowerCase();
      const sinceMs = Date.parse(safeString(req.query?.since));
      const store = loadNotificationsStore();

      const pendingMessageMap = pendingMessageStatusByContact();
      const notificationChannelScope = plannedChannelSetForUser(req.user);
      let messageItems = store.items
        .filter(item => notificationVisibleToUser(item, req.user, states))
        .map(item => ({
          ...item,
          read: Array.isArray(item?.readBy) && item.readBy.includes(userKey),
          channel: safeString(item?.channel) || (safeString(item?.contact).startsWith('instagram:') ? 'instagram' : safeString(item?.contact).startsWith('facebook:') ? 'facebook' : 'whatsapp'),
          assignedTo: safeString(states[item?.contact]?.assignedTo || item?.assignedTo),
          pendingReply: pendingMessageMap.get(safeString(item?.contact))?.pending === true,
          kind: item?.urgent ? 'commercial' : 'message'
        }));
      if (notificationChannelScope) {
        messageItems = messageItems.filter(item => channelScopeAllowsMessage(notificationChannelScope, item.channel));
      }

      const notificationSocialComments = loadSocialComments();
      const notificationSocialReplyIndex = socialCommentThreadIndex(notificationSocialComments);
      let commentItems = notificationSocialComments
        .filter(item => !item.deleted && safeString(item?.direction) !== 'outgoing')
        .map(item => ({
          id: `social-comment:${safeString(item.key)}`,
          notificationId: `social-comment:${safeString(item.key)}`,
          commentKey: safeString(item.key),
          postId: safeString(item.postId),
          contact: '',
          channel: safeString(item.channel),
          profileName: safeString(item.authorName || item.authorUsername),
          username: safeString(item.authorUsername),
          profilePicture: safeString(item.authorPicture),
          preview: safeString(item.text) || 'Nouveau commentaire',
          createdAt: safeString(item.createdAt) || new Date().toISOString(),
          read: socialCommentReadByUser(item, req.user),
          pendingReply: socialCommentNeedsReply(item, notificationSocialReplyIndex),
          kind: 'comment',
          urgent: false,
          action: 'social_comment'
        }));
      if (notificationChannelScope) {
        commentItems = commentItems.filter(item => channelScopeAllowsComment(notificationChannelScope, item.channel));
      }

      let items = [...messageItems, ...commentItems];
      if (['instagram','whatsapp','facebook'].includes(filter)) {
        items = items.filter(item => item.channel === filter);
      } else if (filter === 'commercial') {
        items = items.filter(item => item.urgent === true);
      } else if (filter === 'comments') {
        items = items.filter(item => item.kind === 'comment');
      } else if (filter === 'pending') {
        items = items.filter(item => item.pendingReply === true);
      }

      items.sort((a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0));

      const unreadMessageCount = messageItems.filter(item => item.read !== true).length;
      const unreadCommentCount = commentItems.filter(item => item.read !== true).length;
      const unreadCount = unreadMessageCount + unreadCommentCount;
      const pendingCounts = pendingInteractionCountsForUser(req.user);

      const messageEvents = messageItems
        .filter(item => {
          if (!Number.isFinite(sinceMs)) return false;
          const ms = Date.parse(item?.createdAt || '');
          return Number.isFinite(ms) && ms > sinceMs;
        })
        .map(item => ({
          id: item.id,
          notificationId: item.id,
          messageId: safeString(item.messageId),
          contact: safeString(item.contact),
          time: safeString(item.createdAt),
          preview: safeString(item.preview),
          action: safeString(item.action),
          urgent: item.urgent === true,
          kind: item.kind,
          channel: item.channel,
          assignedTo: item.assignedTo,
          username: safeString(item.username),
          profileName: safeString(item.profileName),
          profilePicture: safeString(item.profilePicture),
          attachmentPreview: safeString(item.attachmentPreview)
        }));

      const commentEvents = commentItems
        .filter(item => {
          if (!Number.isFinite(sinceMs)) return false;
          const ms = Date.parse(item?.createdAt || '');
          return Number.isFinite(ms) && ms > sinceMs;
        })
        .map(item => ({
          id: item.id,
          notificationId: item.id,
          commentKey: item.commentKey,
          time: item.createdAt,
          preview: item.preview,
          action: 'social_comment',
          urgent: false,
          kind: 'comment',
          channel: item.channel,
          username: item.username,
          profileName: item.profileName,
          profilePicture: item.profilePicture
        }));

      const liveSlaEvents = [];
      for (const [contact, state] of Object.entries(states)) {
        if (req.user?.role === 'commercial' && safeString(state?.assignedUserId) !== safeString(req.user.id)) continue;
        if (notificationChannelScope && !channelScopeAllowsMessage(notificationChannelScope, state?.channel || (contact.startsWith('instagram:') ? 'instagram' : contact.startsWith('facebook:') ? 'facebook' : 'whatsapp'))) continue;
        const sla = computeLiveSla(state);
        if (!sla || !['pending','late'].includes(sla.status)) continue;
        const remaining = Number(sla.remainingMs);
        if (!Number.isFinite(remaining)) continue;
        let threshold = '';
        if (remaining <= 0) threshold = 'breached';
        else if (remaining <= 60 * 1000) threshold = 'one_minute';
        else if (remaining <= (Number(sla.minutes || DEFAULT_COMMERCIAL_SLA_MINUTES) * 60 * 1000) / 2) threshold = 'half';
        if (!threshold) continue;
        liveSlaEvents.push({
          id: `sla-${safeString(sla.id)}-${threshold}`,
          contact,
          time: new Date().toISOString(),
          preview: threshold === 'breached'
            ? 'Délai commercial dépassé'
            : `Client en attente — ${Math.max(0, Math.ceil(remaining / 1000))} s restantes`,
          action: threshold === 'breached' ? 'sla_breached' : 'sla_warning',
          urgent: true,
          kind: 'sla',
          channel: safeString(state?.channel),
          assignedTo: safeString(state?.assignedTo),
          remainingMs: remaining
        });
      }

      const taskEvents = [];
      if (req.user?.role === 'commercial') {
        const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
        const today = dateKeyInTimezone(new Date(), timezone);
        for (const task of loadTasks()) {
          if (safeString(task.userId) !== safeString(req.user.id)) continue;
          if (safeString(task.date) !== today) continue;
          if (['done','cancelled'].includes(safeString(task.status))) continue;
          taskEvents.push({
            id: `task-${safeString(task.id)}`,
            contact: '',
            time: safeString(task.createdAt) || new Date().toISOString(),
            preview: `${safeString(task.title)}${task.dueTime ? ` — avant ${safeString(task.dueTime)}` : ''}`,
            action: 'task_assigned',
            urgent: safeString(task.priority) === 'urgent',
            kind: 'task',
            taskId: safeString(task.id)
          });
        }
      }

      const reportEvents = [];
      if (req.user?.role === 'admin') {
        const report = ensureDailyReportGenerated(false);
        if (report?.finalized === true) {
          reportEvents.push({
            id: `daily-report-${report.date}`,
            contact: '',
            time: report.generatedAt,
            preview: `Rapport commercial du ${report.date} disponible`,
            action: 'daily_report_ready',
            urgent: false,
            kind: 'report',
            reportDate: report.date
          });
        }
      }

      return res.json({
        serverTime: new Date().toISOString(),
        unreadCount,
        unreadMessageCount,
        unreadCommentCount,
        pendingCounts,
        items: items.slice(0, 250),
        events: [...messageEvents, ...commentEvents, ...liveSlaEvents, ...taskEvents, ...reportEvents]
      });
    } catch (error) {
      console.error('❌ Notifications Admin :', error);
      return res.status(500).json({ error: 'Impossible de lire les notifications.' });
    }
  }
);

router.post(
  '/api/notifications/:id/read',
  requireAuth,
  (req, res) => {
    const id = safeString(req.params.id);
    const key = notificationUserKey(req.user);
    if (id.startsWith('social-comment:')) {
      const commentKey = id.slice('social-comment:'.length);
      const target = loadSocialComments().find(item => safeString(item?.key) === commentKey);
      if (!target) return res.status(404).json({ error: 'Commentaire introuvable.' });
      if (!requireCommercialCommentChannelAccess(req, res, target.channel)) return;
      markSocialCommentRead(commentKey, req.user);
      return res.json({ success: true, kind: 'comment' });
    }
    const store = loadNotificationsStore();
    const targetNotification = store.items.find(item => safeString(item?.id) === id);
    if (targetNotification) {
      const targetState = loadConversationStatesAdmin()[safeString(targetNotification?.contact)] || {};
      const targetChannel = safeString(targetNotification?.channel || targetState?.channel).toLowerCase() ||
        (safeString(targetNotification?.contact).startsWith('instagram:') ? 'instagram' :
          safeString(targetNotification?.contact).startsWith('facebook:') ? 'facebook' : 'whatsapp');
      if (!requireCommercialMessageChannelAccess(req, res, targetChannel)) return;
    }
    let found = false;

    store.items = store.items.map(item => {
      if (safeString(item?.id) !== id) return item;
      found = true;
      const readBy = Array.isArray(item?.readBy) ? [...item.readBy] : [];
      if (!readBy.includes(key)) readBy.push(key);
      return { ...item, readBy };
    });

    if (!found) return res.status(404).json({ error: 'Notification introuvable.' });
    saveNotificationsStore(store);
    return res.json({ success: true });
  }
);

router.post(
  '/api/notifications/read-all',
  requireAuth,
  (req, res) => {
    const key = notificationUserKey(req.user);
    const states = loadConversationStatesAdmin();
    const store = loadNotificationsStore();

    const readAllScope = plannedChannelSetForUser(req.user);
    store.items = store.items.map(item => {
      if (!notificationVisibleToUser(item, req.user, states)) return item;
      const channel = safeString(item?.channel || states[item?.contact]?.channel).toLowerCase() ||
        (safeString(item?.contact).startsWith('instagram:') ? 'instagram' : safeString(item?.contact).startsWith('facebook:') ? 'facebook' : 'whatsapp');
      if (readAllScope && !channelScopeAllowsMessage(readAllScope, channel)) return item;
      const readBy = Array.isArray(item?.readBy) ? [...item.readBy] : [];
      if (!readBy.includes(key)) readBy.push(key);
      return { ...item, readBy };
    });

    saveNotificationsStore(store);

    const comments = loadSocialComments().map(comment => {
      if (comment?.deleted || safeString(comment?.direction) === 'outgoing') return comment;
      if (readAllScope && !channelScopeAllowsComment(readAllScope, comment?.channel)) return comment;
      const readBy = Array.isArray(comment?.readBy) ? [...comment.readBy] : [];
      if (!readBy.includes(key)) readBy.push(key);
      return { ...comment, readBy };
    });
    saveSocialComments(comments);

    return res.json({ success: true });
  }
);


// ============================================================
// STATUS / STATS
// ============================================================

router.get(
  '/api/storage-status',
  requireAuth,
  (req, res) => {
    const space = storageSpaceInfo();
    const probe = storageWriteProbe();

    return res.json({
      dataDir: DATA_DIR,

      persistentConfigured:
        DATA_DIR !== APP_DIR,

      railwayVolumeMountPath:
        process.env.RAILWAY_VOLUME_MOUNT_PATH ||
        null,

      dataDirEnv:
        process.env.DATA_DIR ||
        null,

      storageMode:
        COMPACT_STORAGE_MODE ? 'compact' : 'standard',

      writable:
        probe.writable,

      writeErrorCode:
        probe.errorCode || null,

      totalBytes:
        space?.totalBytes ?? null,

      freeBytes:
        space?.freeBytes ?? null,

      usedBytes:
        space?.usedBytes ?? null,

      usagePercent:
        space?.totalBytes ? Math.round((space.usedBytes / space.totalBytes) * 100) : null,

      retentionDays:
        HISTORY_IMPORT_DAYS,

      storageGuard: {
        intervalMinutes: Math.round(STORAGE_GUARD_INTERVAL_MS / 60000),
        targetFreeBytes: STORAGE_RESCUE_TARGET_FREE_BYTES,
        criticalFreeBytes: STORAGE_CRITICAL_FREE_BYTES,
        emergencyMediaRetentionDays: EMERGENCY_MEDIA_RETENTION_DAYS
      },

      retentionMigration: (() => {
        const state = ensureRetention15MigrationState();
        const startedMs = Date.parse(safeString(state?.startedAt));
        const remainingMs = safeString(state?.appliedAt)
          ? 0
          : (Number.isFinite(startedMs)
              ? Math.max(0, RETENTION_15_GRACE_MS - (Date.now() - startedMs))
              : RETENTION_15_GRACE_MS);
        return {
          startedAt: safeString(state?.startedAt),
          appliedAt: safeString(state?.appliedAt),
          pending: !safeString(state?.appliedAt),
          graceRemainingMs: remainingMs
        };
      })(),

      breakdown:
        storageBreakdown(),

      cloudStorage:
        cloudStorageStats(),

      productsFile:
        fs.existsSync(PRODUCTS_PATH),

      instructionsFile:
        fs.existsSync(INSTRUCTIONS_PATH),

      settingsFile:
        fs.existsSync(SETTINGS_PATH),

      woocommerceSyncFile:
        fs.existsSync(
          WOOCOMMERCE_SYNC_PATH
        ),

      secureImageMigrationDone:
        fs.existsSync(
          SECURE_IMAGE_MIGRATION_MARKER
        ),

      instructionMigrationDone:
        fs.existsSync(
          INSTRUCTIONS_MIGRATION_MARKER
        ),

      customizationsFile:
        fs.existsSync(
          CUSTOMIZATIONS_PATH
        ),

      uploadsDirectory:
        fs.existsSync(UPLOADS_DIR),

      customizationsDirectory:
        fs.existsSync(CUSTOMIZATIONS_DIR),

      conversationMediaDirectory:
        fs.existsSync(CONVERSATION_MEDIA_DIR),

      conversationProfileDirectory:
        fs.existsSync(CONVERSATION_PROFILE_DIR),

      conversationEventsDirectory:
        fs.existsSync(CONVERSATION_EVENTS_DIR),

      notificationsFile:
        fs.existsSync(NOTIFICATIONS_PATH),

      backupsDirectory:
        fs.existsSync(BACKUPS_DIR),

      persistenceStrict:
        PERSISTENCE_STRICT,

      snapshotCount:
        listFullSnapshots().length,

      lastSnapshot:
        listFullSnapshots()[0] || null,

      recommendedRailwayMountPath:
        '/data',

      recommendedDataDir:
        '/data'
    });
  }
);

router.post(
  '/api/storage-cleanup',
  requireAdmin,
  (req, res) => {
    try {
      const result = runSafeStorageMaintenance({ forceEmergency: true });
      markRetention15MigrationApplied();
      persistentConversationEventsCache = { stamp: '', entries: [] };
      combinedConversationLogCache = {
        liveStamp: '',
        historyStamp: '',
        facebookHistoryStamp: '',
        persistentStamp: '',
        entries: []
      };
      return res.json({
        success: true,
        retentionDays: HISTORY_IMPORT_DAYS,
        freedBytes: result.freedBytes,
        freeBytesBefore: result.before?.freeBytes ?? null,
        freeBytesAfter: result.after?.freeBytes ?? null,
        breakdown: result.breakdown
      });
    } catch (error) {
      console.error('❌ Nettoyage stockage :', error);
      return res.status(500).json({ error: error.message || 'Nettoyage stockage impossible.' });
    }
  }
);



router.post(
  '/api/storage-cloud-migrate',
  requireAdmin,
  async (req, res) => {
    try {
      const maxFiles = Math.max(10, Math.min(1000, Number(req.body?.maxFiles || CLOUD_MIGRATION_BATCH_FILES) || CLOUD_MIGRATION_BATCH_FILES));
      const result = await runCloudStorageMigration({ maxFiles });
      return res.json({ success: true, ...result, cloudStorage: cloudStorageStats() });
    } catch (error) {
      console.error('❌ Migration Cloudinary :', error);
      return res.status(500).json({ error: error.message || 'Migration Cloudinary impossible.' });
    }
  }
);

router.get(
  '/api/stats',
  requireAuth,
  (req, res) => {
    const products = loadProducts();
    const instructions = loadInstructions();
    const customizations = loadCustomizations();
    const settings = getBotSettings();

    return res.json({
      productCount:
        products.length,

      activeProductCount:
        products.filter(
          product =>
            product.active !== false
        ).length,

      productsWithImages:
        products.filter(
          product =>
            Boolean(product.image)
        ).length,

      woocommerceManagedProducts:
        products.filter(
          product =>
            safeString(
              product.syncSource
            ) === 'woocommerce'
        ).length,

      instructionsCount:
        instructions.length,

      activeInstructionsCount:
        instructions.filter(
          instruction =>
            instruction.active !== false
        ).length,

      customizationCount:
        customizations.length,

      aiEnabled:
        settings.aiEnabled,

      audience:
        settings.audience,

      instructionMigrationDone:
        fs.existsSync(
          INSTRUCTIONS_MIGRATION_MARKER
        ),

      legacyBusinessInfoAvailable:
        Boolean(
          loadLegacyBusinessInfo().trim()
        ),

      storage: {
        dataDir: DATA_DIR,
        persistentConfigured:
          DATA_DIR !== APP_DIR,
        writable:
          storageIsWritable()
      }
    });
  }
);

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  adminRouter: router,
  getBusinessContext,
  getBotSettings,
  setChatHandler,
  setImageChatHandler,
  setCustomizationHandler,
  setCommercialSendHandler,
  setWhatsAppCallHandler,
  createCommercialCorrectionCandidate,
  registerCommercialEscalation,
  resolveCommercialSla,
  processSocialCommentWebhookEntry,
  ensureStorageHeadroom,
  storeCloudAssetBuffer,
  cloudManifestEntry
};
