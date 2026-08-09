// ============================================================
// MONDECO - ADMINISTRATION
// Admin.js
// Produits + Instructions + Personnalisation + Paramètres + Responsable commercial + SLA + Inbox commerciale — V6.19.6
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
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const ADMIN_ENV_SYNC_PATH = path.join(DATA_DIR, '.admin-env-credentials-fingerprint');
const CONVERSATIONS_LOG_PATH = path.join(DATA_DIR, 'conversation-log.json');
// V6.19.4 — historique Instagram importé via Conversations API.
// Il reste séparé du journal temps réel afin de ne jamais être tronqué par
// la rotation du fichier conversation-log.json.
const INSTAGRAM_HISTORY_PATH = path.join(DATA_DIR, 'instagram-history.json');
const INSTAGRAM_HISTORY_SYNC_STATE_PATH = path.join(DATA_DIR, 'instagram-history-sync.json');
const CONVERSATION_STATE_PATH_ADMIN = path.join(DATA_DIR, 'conversation-state.json');
const CONVERSATION_EVENTS_DIR = path.join(DATA_DIR, 'conversation-events');
const NOTIFICATIONS_PATH = path.join(DATA_DIR, 'notifications.json');
const MESSAGE_ID_INDEX_PATH = path.join(DATA_DIR, 'conversation-message-ids.jsonl');

const INSTAGRAM_ACCESS_TOKEN = (
  process.env.INSTAGRAM_ACCESS_TOKEN ||
  ''
).trim();

const INSTAGRAM_ACCOUNT_ID = (
  process.env.INSTAGRAM_ACCOUNT_ID ||
  ''
).trim();

const META_API_VERSION = (
  process.env.META_API_VERSION ||
  'v26.0'
).trim();
const WOOCOMMERCE_SYNC_PATH = path.join(DATA_DIR, 'woocommerce-sync.json');
const SCHEDULES_PATH = path.join(DATA_DIR, 'schedules.json');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const SLA_EVENTS_PATH = path.join(DATA_DIR, 'sla-events.json');
const DAILY_REPORTS_PATH = path.join(DATA_DIR, 'daily-reports.json');
const ATTENDANCE_PATH = path.join(DATA_DIR, 'attendance-log.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CUSTOMIZATIONS_DIR = path.join(DATA_DIR, 'customizations');
const CONVERSATION_MEDIA_DIR = path.join(DATA_DIR, 'conversation-media');
const CONVERSATION_PROFILE_DIR = path.join(DATA_DIR, 'conversation-profile');

const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const JSON_BACKUPS_DIR = path.join(BACKUPS_DIR, 'json');
const SNAPSHOTS_DIR = path.join(BACKUPS_DIR, 'snapshots');
const RECYCLE_DIR = path.join(BACKUPS_DIR, 'recycle');

const MAX_JSON_BACKUPS_PER_FILE = 50;
const MAX_FULL_SNAPSHOTS = 20;

const IS_RAILWAY = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME
);

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

function storageIsWritable() {
  const testFile = path.join(
    DATA_DIR,
    `.write-test-${process.pid}-${Date.now()}`
  );

  try {
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
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

  if (!storageIsWritable()) {
    throw new Error(
      `Le dossier de données ${DATA_DIR} n'est pas accessible en écriture.`
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
    { source: ATTENDANCE_PATH, name: 'attendance-log.json' }
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

  for (const item of snapshotFiles()) {
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
      customizations.length
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
    woocommerceSync:
      loadWooCommerceSyncState(),
    note:
      'Cet export JSON contient les données structurées. Les images restent protégées dans le Volume et les snapshots complets /data/backups/snapshots.'
  };
}

function ensureDailySnapshot() {
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
  const tempPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (fileExistsWithContent(filePath)) {
    backupJsonVersion(filePath);

    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (error) {
      console.warn('⚠️ Backup JSON impossible :', error.message);
    }
  }

  fs.writeFileSync(
    tempPath,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  fs.renameSync(tempPath, filePath);
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

ensurePersistenceSafety();
migrateLegacyData();
initializePersistentInstructions();
initializeSettings();
migrateSecureImageModeV676();
initializeQuickReplies();
initializeUsers();
syncBootstrapAdminFromEnvironment();
ensureDailySnapshot();

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

const sessions = new Map();
const loginAttempts = new Map();

const SESSION_DURATION =
  24 * 60 * 60 * 1000;

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
      sessions.delete(
        token
      );
    }
  }
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

  const session =
    sessions.get(token);

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

  sessions.set(token, session);
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

  const session =
    sessions.get(
      token
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
    sessions.delete(
      token
    );

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
    sessions.delete(
      token
    );

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
    '/api/notifications',
    '/api/quick-replies',
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
      pathStarts(reqPath, '/api/notifications') ||
      pathStarts(reqPath, '/api/instagram-history') ||
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
    user.role === 'commercial' &&
    pathStarts(req.path, '/api/conversations') &&
    safeString(req.params?.contact)
  ) {
    const contactState = loadConversationStatesAdmin()[safeString(req.params.contact)] || {};
    if (safeString(contactState.assignedUserId) !== safeString(user.id)) {
      return res.status(403).json({ error: 'Cette conversation n’est pas affectée à votre compte.' });
    }
  }

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

  sessions.set(
    token,
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
      <div class="brand-kicker">Agent WhatsApp + Instagram • Administration</div>
    </div>
    <div class="brand-copy">
      <h1>Centre de pilotage MONDECO</h1>
      <p>Gérez l'agent WhatsApp + Instagram, l’équipe commerciale, les produits et les paramètres depuis une interface unique.</p>
    </div>
    <div class="brand-foot">Accès réservé</div>
  </aside>
  <main class="form-side">
    <div class="form-box">
      <img class="mobile-logo" src="${MONDECO_LOGO_DATA_URL}" alt="MONDECO">
      <div class="eyebrow">Administration</div>
      <div class="login-title-row">
        <h2>Connexion</h2>
        <span class="login-version">V6.19.6</span>
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
    sessions.delete(token);
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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

function commercialMediaFileFilter(req, file, callback) {
  if (!ALLOWED_COMMERCIAL_MEDIA_TYPES.has(file.mimetype)) {
    return callback(
      new Error(
        'Format non accepté. Utilisez PDF, DOC, DOCX, JPG, PNG ou WEBP.'
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
  (req, res) => {
    const filename =
      path.basename(req.params.filename || '');

    if (!filename) return res.sendStatus(404);

    const filePath =
      path.join(
        CONVERSATION_MEDIA_DIR,
        filename
      );

    if (!fs.existsSync(filePath)) {
      return res.sendStatus(404);
    }

    res.setHeader(
      'Cache-Control',
      'private, max-age=3600'
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; sandbox");

    const extension = path.extname(filename).toLowerCase();
    if (['.pdf','.doc','.docx','.bin'].includes(extension)) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[\"\r\n]/g, '')}"`);
    }

    return res.sendFile(filePath);
  }
);


router.get(
  '/conversation-profile/:filename',
  requireAuth,
  (req, res) => {
    const filename =
      path.basename(req.params.filename || '');

    if (!filename) return res.sendStatus(404);

    const filePath =
      path.join(
        CONVERSATION_PROFILE_DIR,
        filename
      );

    if (!fs.existsSync(filePath)) {
      return res.sendStatus(404);
    }

    res.setHeader(
      'Cache-Control',
      'private, max-age=86400'
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return res.sendFile(filePath);
  }
);



// ============================================================
// ÉQUIPE / UTILISATEURS / RAPPORTS
// ============================================================

function invalidateUserSessions(
  userId
) {
  for (
    const [
      token,
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
      sessions.delete(
        token
      );
    }
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

  const log =
    loadWhatsAppLog();

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

    const users =
      loadUsers()
        .map(user => ({
          ...sanitizeUserForClient(user),
          presence:
            getPresenceForUser(user.id)
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

function normalizeChannels(value) {
  const raw = Array.isArray(value) ? value : [value];
  const allowed = new Set(['whatsapp', 'instagram']);
  const channels = [...new Set(raw.map(item => safeString(item).toLowerCase()).filter(item => allowed.has(item)))];
  return channels.length ? channels : ['whatsapp', 'instagram'];
}

function scheduleIsActiveNow(schedule, now = new Date(), channel = '') {
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const today = dateKeyInTimezone(now, timezone);
  if (safeString(schedule?.date) !== today || schedule?.active === false) return false;
  const start = timeMinutes(schedule?.startTime);
  const end = timeMinutes(schedule?.endTime);
  const current = tunisMinutesNow(now);
  if (start === null || end === null || current < start || current >= end) return false;
  const breakStart = timeMinutes(schedule?.breakStart);
  const breakEnd = timeMinutes(schedule?.breakEnd);
  if (breakStart !== null && breakEnd !== null && current >= breakStart && current < breakEnd) return false;
  const requestedChannel = safeString(channel).toLowerCase();
  return !requestedChannel || normalizeChannels(schedule?.channels).includes(requestedChannel);
}

function recordAttendance(user) {
  if (!user?.id || user.role !== 'commercial') return;
  const nowMs = Date.now();
  const previousWrite = Number(attendanceWriteThrottle.get(user.id) || 0);
  if (nowMs - previousWrite < 60 * 1000) return;
  attendanceWriteThrottle.set(user.id, nowMs);
  const timezone = safeTimezone(getBotSettings()?.timezone || 'Africa/Tunis');
  const date = dateKeyInTimezone(new Date(), timezone);
  const key = `${date}:${user.id}`;
  const now = new Date().toISOString();
  const attendance = loadAttendance();
  const current = attendance[key] || {};
  attendance[key] = {
    date,
    userId: user.id,
    name: safeString(user.name),
    firstSeenAt: current.firstSeenAt || now,
    lastSeenAt: now,
    heartbeats: Number(current.heartbeats || 0) + 1
  };
  saveAttendance(attendance);
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
  if (!user || !/^\d{4}-\d{2}-\d{2}$/.test(date) || timeMinutes(startTime) === null || timeMinutes(endTime) === null || timeMinutes(endTime) <= timeMinutes(startTime)) {
    return res.status(400).json({error:'Commercial, date ou horaires invalides.'});
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
  if(!user||timeMinutes(startTime)===null||timeMinutes(endTime)===null||timeMinutes(endTime)<=timeMinutes(startTime))return res.status(400).json({error:'Planning invalide.'});
  items[index]={...current,userId,userName:safeString(user.name),date:safeString(req.body?.date??current.date),startTime,endTime,breakStart:safeString(req.body?.breakStart??current.breakStart),breakEnd:safeString(req.body?.breakEnd??current.breakEnd),channels:normalizeChannels(req.body?.channels??current.channels),mission:safeString(req.body?.mission??current.mission).slice(0,1000),priority:safeString(req.body?.priority??current.priority),slaMinutes:Math.max(1,Math.min(120,Number(req.body?.slaMinutes??current.slaMinutes??DEFAULT_COMMERCIAL_SLA_MINUTES)||DEFAULT_COMMERCIAL_SLA_MINUTES)),active:req.body?.active===undefined?current.active!==false:req.body.active===true,updatedAt:new Date().toISOString()};
  saveSchedules(items); return res.json(items[index]);
});

router.delete('/api/schedules/:id', requireAdminOrCommercialManager, (req,res) => { const items=loadSchedules(); const next=items.filter(item=>item.id!==req.params.id); if(next.length===items.length)return res.status(404).json({error:'Planning introuvable.'}); saveSchedules(next); return res.json({success:true}); });

router.get('/api/tasks', requireAuth, (req,res) => { const date=safeString(req.query?.date); let items=loadTasks().filter(item=>!date||safeString(item.date)===date); if(req.user?.role==='commercial'){items=items.filter(item=>safeString(item.userId)===safeString(req.user.id));}else if(!['admin','responsable_commercial'].includes(safeString(req.user?.role))){return res.status(403).json({error:'Accès non autorisé.'});} return res.json(items.sort((a,b)=>safeString(a.startTime).localeCompare(safeString(b.startTime)))); });

router.post('/api/tasks', requireAdminOrCommercialManager, (req,res) => {
  const userId=safeString(req.body?.userId); const user=loadUsers().find(item=>item.id===userId&&item.role==='commercial'&&item.active!==false); const title=safeString(req.body?.title); const date=safeString(req.body?.date);
  if(!user||!title||!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:'Commercial, date et tâche sont obligatoires.'});
  const now=new Date().toISOString(); const item={id:crypto.randomUUID(),userId,userName:safeString(user.name),date,channel:safeString(req.body?.channel||'both'),startTime:safeString(req.body?.startTime),dueTime:safeString(req.body?.dueTime),title:title.slice(0,180),details:safeString(req.body?.details).slice(0,1500),priority:safeString(req.body?.priority||'normal'),status:'todo',createdBy:safeString(req.user?.id),createdAt:now,updatedAt:now}; const items=loadTasks();items.push(item);saveTasks(items);return res.status(201).json(item);
});

router.put('/api/tasks/:id', requireAuth, (req,res) => {
  const items=loadTasks();const index=items.findIndex(item=>item.id===req.params.id);if(index<0)return res.status(404).json({error:'Tâche introuvable.'});const current=items[index];
  const manager=req.user.role==='admin'||req.user.role==='responsable_commercial'; if(!manager&&!(req.user.role==='commercial'&&safeString(current.userId)===safeString(req.user.id)))return res.status(403).json({error:'Accès non autorisé à cette tâche.'});
  const allowedStatus=new Set(['todo','in_progress','done','late','cancelled']);const requestedStatus=safeString(req.body?.status||current.status);if(!allowedStatus.has(requestedStatus))return res.status(400).json({error:'Statut de tâche invalide.'});
  const editable=manager?{...current,...req.body}:{...current,status:requestedStatus}; items[index]={...editable,id:current.id,userId:current.userId,userName:current.userName,status:requestedStatus,completedAt:requestedStatus==='done'?(current.completedAt||new Date().toISOString()):null,updatedAt:new Date().toISOString()};saveTasks(items);return res.json(items[index]);
});

router.delete('/api/tasks/:id', requireAdminOrCommercialManager, (req,res) => {const items=loadTasks();const next=items.filter(item=>item.id!==req.params.id);if(next.length===items.length)return res.status(404).json({error:'Tâche introuvable.'});saveTasks(next);return res.json({success:true});});

router.get('/api/my-workday', requireAuth, (req,res) => {
  if(req.user?.role!=='commercial') return res.status(403).json({error:'Compte commercial requis.'});
  const timezone=safeTimezone(getBotSettings()?.timezone||'Africa/Tunis');
  const date=safeString(req.query?.date)||dateKeyInTimezone(new Date(),timezone);
  const schedules=getSchedulesForDate(date).filter(item=>safeString(item.userId)===safeString(req.user.id));
  const tasks=loadTasks().filter(item=>safeString(item.date)===date&&safeString(item.userId)===safeString(req.user.id));
  return res.json({date,schedules,tasks});
});

router.get('/api/team/operations', requireAdminOrCommercialManager, (req,res) => {
  const timezone=safeTimezone(getBotSettings()?.timezone||'Africa/Tunis');const date=safeString(req.query?.date)||dateKeyInTimezone(new Date(),timezone);const states=loadConversationStatesAdmin();
  const users=loadUsers().filter(user=>user.role==='commercial').map(user=>{const presence=getPresenceForUser(user.id);const shifts=getSchedulesForDate(date).filter(s=>s.userId===user.id);const tasks=loadTasks().filter(t=>t.date===date&&t.userId===user.id);const assigned=Object.values(states).filter(st=>safeString(st?.assignedUserId)===user.id&&st?.resolved!==true);const slas=assigned.map(st=>computeLiveSla(st)).filter(Boolean);return {...sanitizeUserForClient(user),presence,shifts,tasks,activeConversations:assigned.length,pendingSla:slas.filter(s=>['pending','late'].includes(s.status)).length,lateSla:slas.filter(s=>s.status==='late').length,nextSlaRemainingMs:slas.filter(s=>['pending','late'].includes(s.status)&&Number.isFinite(s.remainingMs)).sort((a,b)=>a.remainingMs-b.remainingMs)[0]?.remainingMs??null};});
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

      return res.json({
        dataDir:
          DATA_DIR,
        persistentConfigured:
          !samePath(DATA_DIR, APP_DIR),
        writable:
          storageIsWritable(),
        persistenceStrict:
          PERSISTENCE_STRICT,
        railwayVolumeMountPath:
          process.env.RAILWAY_VOLUME_MOUNT_PATH ||
          null,
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
              'L’envoi WhatsApp commercial n’est pas encore connecté.'
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
        requestedChannel === 'instagram' ||
        contact.startsWith('instagram:')
          ? 'instagram'
          : 'whatsapp';

      const externalContact =
        safeString(
          req.body?.externalContact
        ) ||
        (channel === 'instagram'
          ? contact.replace(/^instagram:/, '')
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

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible d’envoyer le message commercial.'
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
              'L’envoi WhatsApp commercial n’est pas encore connecté.'
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
        requestedChannel === 'instagram' ||
        contact.startsWith('instagram:')
          ? 'instagram'
          : 'whatsapp';

      const externalContact =
        safeString(
          req.body?.externalContact
        ) ||
        (channel === 'instagram'
          ? contact.replace(/^instagram:/, '')
          : normalizePhone(contact));

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
              'Ajoutez un PDF, un document Word ou une photo.'
          });
      }

      const mediaKind =
        req.file.mimetype.startsWith('image/')
          ? 'image'
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

let persistentConversationEventsCache = {
  stamp: '',
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
  const stamp = conversationEventsDirectoryStamp();
  if (persistentConversationEventsCache.stamp === stamp) {
    return persistentConversationEventsCache.entries;
  }

  const entries = [];

  try {
    const files = fs
      .readdirSync(CONVERSATION_EVENTS_DIR)
      .filter(name => /^conversation-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();

    for (const name of files) {
      const content = fs.readFileSync(path.join(CONVERSATION_EVENTS_DIR, name), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            entries.push(parsed);
          }
        } catch (error) {
          console.warn(`⚠️ Ligne JSONL ignorée dans ${name} :`, error.message);
        }
      }
    }
  } catch (error) {
    console.warn('⚠️ Lecture conversation-events :', error.message);
  }

  persistentConversationEventsCache = { stamp, entries };
  return entries;
}

let combinedConversationLogCache = {
  liveStamp: '',
  historyStamp: '',
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

function loadWhatsAppLog() {
  const liveStamp =
    fileChangeStamp(
      CONVERSATIONS_LOG_PATH
    );

  const historyStamp =
    fileChangeStamp(
      INSTAGRAM_HISTORY_PATH
    );

  const persistentStamp =
    conversationEventsDirectoryStamp();

  if (
    combinedConversationLogCache.liveStamp === liveStamp &&
    combinedConversationLogCache.historyStamp === historyStamp &&
    combinedConversationLogCache.persistentStamp === persistentStamp
  ) {
    return combinedConversationLogCache.entries;
  }

  const historical =
    readJsonArray(
      INSTAGRAM_HISTORY_PATH,
      'instagram-history.json'
    );

  const persistent =
    loadPersistentConversationEvents();

  const live =
    readJsonArray(
      CONVERSATIONS_LOG_PATH,
      'conversation-log.json'
    );

  // L'historique est chargé en premier et les événements persistants puis le
  // cache temps réel l'écrasent en cas de doublon.
  // cas de doublon. Ainsi une conversation importée puis reçue par webhook
  // ne s'affiche jamais deux fois.
  const merged = new Map();

  for (const entry of [...historical, ...persistent, ...live]) {
    merged.set(
      conversationLogDedupeKey(entry),
      entry
    );
  }

  const entries =
    [...merged.values()];

  combinedConversationLogCache = {
    liveStamp,
    historyStamp,
    persistentStamp,
    entries
  };

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

async function listAllInstagramConversations() {
  if (!INSTAGRAM_ACCOUNT_ID) {
    throw new Error('INSTAGRAM_ACCOUNT_ID manquant.');
  }

  const conversations = [];
  const seenIds = new Set();

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

    for (const item of Array.isArray(data?.data) ? data.data : []) {
      const id = safeString(item?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      conversations.push({
        id,
        updatedTime:
          safeString(item?.updated_time)
      });
    }

    nextUrl =
      safeString(data?.paging?.next);

    pageCount += 1;
  }

  console.log(`📚 Instagram : ${conversations.length} conversation(s) listée(s) sur ${pageCount} page(s), pagination épuisée.`);

  return {
    conversations,
    truncated: false,
    pageCount
  };
}

async function listAllInstagramConversationMessageRefs(conversationId) {
  const encodedId = encodeURIComponent(safeString(conversationId));
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

    for (const item of pageData) {
      const id = safeString(item?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      refs.push({
        id,
        created_time: safeString(item?.created_time)
      });
    }

    nextUrl = safeString(data?.messages?.paging?.next || data?.paging?.next);
  }

  return refs.sort((a, b) =>
    new Date(b?.created_time || 0) - new Date(a?.created_time || 0)
  );
}

async function getInstagramConversationRecentMessages(conversationId) {
  const refs = await listAllInstagramConversationMessageRefs(conversationId);
  const detailedRefs = refs.slice(0, 20);
  const detailsById = new Map();

  // Meta documente que le détail n'est disponible que pour les 20 messages
  // les plus récents. Les IDs/date plus anciens sont néanmoins conservés.
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
      return {
        ...ref,
        ...detail,
        meta_content_available: true
      };
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

    fs.writeFileSync(
      path.join(CONVERSATION_PROFILE_DIR, filename),
      buffer
    );

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

  console.log('📚 Instagram : pagination maximale activée. Meta ne fournit le détail complet que pour les 20 messages les plus récents de chaque discussion ; les anciens IDs/dates seront conservés sans direction inventée.');

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
    truncated: false,
    metaMessageDetailLimit: 20,
    messageIdsDiscovered: 0,
    contentUnavailableMessages: 0
  };

  saveInstagramHistorySyncState(
    instagramHistorySyncJob
  );

  try {
    const listed =
      await listAllInstagramConversations();

    const conversations =
      listed.conversations;

    instagramHistorySyncJob.totalConversations =
      conversations.length;

    instagramHistorySyncJob.truncated =
      Boolean(listed.truncated);

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

    const knownMessageIds =
      new Set(
        [...live, ...historical]
          .map(entry =>
            safeString(entry?.message_id) ||
            safeString(entry?.meta_message_id)
          )
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
                  conversation.id
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
    instagramHistorySyncJob.completedAt =
      new Date().toISOString();

    saveInstagramHistorySyncState(
      instagramHistorySyncJob
    );
  } catch (error) {
    instagramHistorySyncJob.running = false;
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
    const persisted =
      loadInstagramHistorySyncState();

    return res.json({
      configured:
        Boolean(
          INSTAGRAM_ACCESS_TOKEN &&
          INSTAGRAM_ACCOUNT_ID
        ),
      ...persisted,
      ...(instagramHistorySyncJob.running
        ? instagramHistorySyncJob
        : {})
    });
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

function conversationEntryPreview(entry) {
  const attachments = Array.isArray(entry?.attachments) ? entry.attachments.filter(Boolean) : [];
  const source = safeString(entry?.source);
  const commercialName = safeString(entry?.commercial_user_name || entry?.actor_name);

  if (entry?.reply_sent && safeString(entry?.reply)) {
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

router.get('/api/conversations', requireAuth, (req, res) => {
  try {
    const log = loadWhatsAppLog();
    const states = loadConversationStatesAdmin();

    const byContact = {};

    for (const entry of log) {
      const contact = safeString(entry.contact);
      if (!contact) continue;
      if (!byContact[contact]) byContact[contact] = [];
      byContact[contact].push(entry);
    }

    const conversations = Object.keys(byContact).map(contact => {
      const entries = byContact[contact].sort(
        (a, b) => new Date(a.time || 0) - new Date(b.time || 0)
      );
      const last = entries[entries.length - 1];
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
        channel:
          safeString(
            last?.channel ||
            state?.channel ||
            (contact.startsWith('instagram:') ? 'instagram' : 'whatsapp')
          ).toLowerCase() === 'instagram'
            ? 'instagram'
            : 'whatsapp',
        externalContact:
          safeString(
            last?.external_contact ||
            state?.externalContact ||
            (contact.startsWith('instagram:')
              ? contact.slice('instagram:'.length)
              : contact)
          ),
        instagramUsername:
          safeString(state?.instagramUsername),
        profilePicture:
          safeString(state?.profilePicture),
        aiModePreference:
          safeString(state?.aiModePreference),
        aiModeChoicePending:
          Boolean(state?.aiModeChoicePending),
        hasAdReferral: Boolean(state.cameFromAd || state.adReferral),
        adHeadline: safeString(state?.adReferral?.headline),
        adBody: safeString(state?.adReferral?.body),
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
        followUpsSent: Number(state.followUpsSent || 0)
      };
    }).sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0));

    let visibleConversations = req.user?.role === 'commercial'
      ? conversations.filter(item => safeString(item.assignedUserId) === safeString(req.user.id))
      : conversations;

    const countBase = visibleConversations;
    const counts = {
      all: countBase.filter(item => !item.resolved).length,
      whatsapp: countBase.filter(item => !item.resolved && item.channel === 'whatsapp').length,
      instagram: countBase.filter(item => !item.resolved && item.channel === 'instagram').length,
      unread: countBase.filter(item => !item.resolved && Number(item.unreadCount || 0) > 0).length,
      priority: countBase.filter(item => !item.resolved && item.priority).length,
      commercial: countBase.filter(item => !item.resolved && (item.commercialAttention || item.imageNeedsCommercial)).length,
      sla: countBase.filter(item => !item.resolved && ['pending','late'].includes(safeString(item?.slaStatus))).length,
      ads: countBase.filter(item => !item.resolved && item.hasAdReferral).length,
      resolved: countBase.filter(item => item.resolved).length
    };

    const requestedFilter = safeString(req.query?.filter).toLowerCase();
    if (requestedFilter === 'resolved') {
      visibleConversations = visibleConversations.filter(item => item.resolved === true);
    } else {
      visibleConversations = visibleConversations.filter(item => !item.resolved);
      if (requestedFilter === 'whatsapp' || requestedFilter === 'instagram') {
        visibleConversations = visibleConversations.filter(item => item.channel === requestedFilter);
      } else if (requestedFilter === 'unread') {
        visibleConversations = visibleConversations.filter(item => Number(item.unreadCount || 0) > 0);
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
      visibleConversations = visibleConversations.filter(item => {
        const entries = byContact[item.contact] || [];
        const searchable = [
          item.contact,
          item.externalContact,
          item.instagramUsername,
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
        counts
      });
    }

    return res.json(visibleConversations);
  } catch (error) {
    console.error('❌ Liste conversations :', error);
    return res.status(500).json({ error: 'Impossible de lire les conversations.' });
  }
});

router.get('/api/conversations/:contact', requireAuth, (req, res) => {
  try {
    const contact = safeString(req.params.contact);
    const log = loadWhatsAppLog();
    const states = loadConversationStatesAdmin();

    const state = states[contact] || {};
    if (req.user?.role === 'commercial' && safeString(state.assignedUserId) !== safeString(req.user.id)) {
      return res.status(403).json({ error: 'Cette conversation n’est pas affectée à votre compte.' });
    }

    let entries = log
      .filter(entry => safeString(entry.contact) === contact)
      .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));

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
        const ms = Date.parse(entry?.time || '');
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

    return res.json({
      contact,
      state: {
        ...state,
        ...(adReferral ? { adReferral } : {}),
        sla: computeLiveSla(state)
      },
      entries,
      hasMore,
      nextBefore
    });
  } catch (error) {
    console.error('❌ Détail conversation :', error);
    return res.status(500).json({ error: 'Impossible de lire cette conversation.' });
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
  '/api/conversations/:contact/priority',
  requireAuth,
  (req, res) => {
    const contact =
      safeString(
        req.params.contact
      );

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

      let items = store.items
        .filter(item => notificationVisibleToUser(item, req.user, states))
        .map(item => ({
          ...item,
          read: Array.isArray(item?.readBy) && item.readBy.includes(userKey),
          channel: safeString(item?.channel) || (safeString(item?.contact).startsWith('instagram:') ? 'instagram' : 'whatsapp'),
          assignedTo: safeString(states[item?.contact]?.assignedTo || item?.assignedTo),
          kind: item?.urgent ? 'commercial' : 'message'
        }));

      if (filter === 'instagram' || filter === 'whatsapp') {
        items = items.filter(item => item.channel === filter);
      } else if (filter === 'commercial') {
        items = items.filter(item => item.urgent === true);
      }

      items.sort((a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0));

      const unreadCount = store.items
        .filter(item => notificationVisibleToUser(item, req.user, states))
        .filter(item => !(Array.isArray(item?.readBy) && item.readBy.includes(userKey)))
        .length;

      const events = items
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

      const liveSlaEvents = [];
      for (const [contact, state] of Object.entries(states)) {
        if (req.user?.role === 'commercial' && safeString(state?.assignedUserId) !== safeString(req.user.id)) continue;
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
        items: items.slice(0, 200),
        events: [...events, ...liveSlaEvents, ...taskEvents, ...reportEvents]
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
    const store = loadNotificationsStore();
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

    store.items = store.items.map(item => {
      if (!notificationVisibleToUser(item, req.user, states)) return item;
      const readBy = Array.isArray(item?.readBy) ? [...item.readBy] : [];
      if (!readBy.includes(key)) readBy.push(key);
      return { ...item, readBy };
    });

    saveNotificationsStore(store);
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

      writable:
        storageIsWritable(),

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
  createCommercialCorrectionCandidate,
  registerCommercialEscalation,
  resolveCommercialSla
};
