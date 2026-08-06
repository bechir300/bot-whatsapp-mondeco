// ============================================================
// MONDECO - ADMINISTRATION
// Admin.js
// Produits + Instructions + Personnalisation + Paramètres
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
const CUSTOMIZATIONS_PATH = path.join(DATA_DIR, 'customization-requests.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CUSTOMIZATIONS_DIR = path.join(DATA_DIR, 'customizations');

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

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(CUSTOMIZATIONS_DIR, { recursive: true });
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
    }
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

  imageHandling: 'commercial',

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
          `${index + 1}. ${safeString(item.title)}\n` +
          safeString(item.content)
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
// AUTHENTIFICATION
// ============================================================

const sessions = new Map();

const SESSION_DURATION =
  24 * 60 * 60 * 1000;

function parseCookies(header = '') {
  const cookies = {};

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    const key =
      part.slice(0, index).trim();

    const value =
      part.slice(index + 1).trim();

    if (!key) continue;

    try {
      cookies[key] =
        decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }

  return cookies;
}

function cleanupSessions() {
  const now = Date.now();

  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getSessionToken(req) {
  return (
    parseCookies(req.headers.cookie || '')
      .mondeco_admin_session ||
    ''
  );
}

function isAuthenticated(req) {
  cleanupSessions();

  const token = getSessionToken(req);
  if (!token) return false;

  const expiresAt = sessions.get(token);

  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res
      .status(401)
      .json({
        error: 'Non authentifié'
      });
  }

  return res.redirect('/admin/login');
}

function secureCookie(req) {
  const forwardedProto =
    safeString(
      req.headers['x-forwarded-proto']
    );

  return (
    forwardedProto === 'https' ||
    Boolean(
      process.env.RAILWAY_ENVIRONMENT_NAME
    )
  );
}

function renderLoginPage() {
  return `
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
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
.brand-logo{display:block;width:185px;max-width:90%;height:auto;filter:brightness(0) invert(1)}
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
.mobile-logo{display:none}
@media(max-width:760px){body{display:block;min-height:100dvh;padding:0;background:#fff}.login-wrap{width:100%;min-height:100dvh;display:block;border:0;border-radius:0}.brand-side{display:none}.form-side{min-height:100dvh;align-items:flex-start;padding:calc(34px + env(safe-area-inset-top)) 22px calc(28px + env(safe-area-inset-bottom));background:#fff}.form-box{max-width:100%}.mobile-logo{display:block;width:162px;margin-bottom:54px;filter:none}h2{font-size:33px}.sub{margin-bottom:25px}}
@media(max-width:390px){.form-side{padding-left:18px;padding-right:18px}.mobile-logo{width:150px;margin-bottom:46px}h2{font-size:31px}}
</style>
</head>
<body>
<div class="login-wrap">
  <aside class="brand-side">
    <div>
      <div class="brand-kicker">Agent WhatsApp • Administration</div>
    </div>
    <div class="brand-copy">
      <h1>Centre de pilotage MONDECO</h1>
      <p>Gérez l'agent WhatsApp, les produits, les instructions et les paramètres depuis une interface unique.</p>
    </div>
    <div class="brand-foot">Accès réservé</div>
  </aside>
  <main class="form-side">
    <div class="form-box">
      <div class="eyebrow">Administration</div>
      <h2>Connexion</h2>
      <div class="sub">Entrez votre mot de passe administrateur pour continuer.</div>
      <form id="form">
        <label for="password">Mot de passe</label>
        <div class="password-row">
          <input id="password" type="password" required autofocus autocomplete="current-password" placeholder="Votre mot de passe">
          <button class="show-pass" id="togglePassword" type="button" aria-label="Afficher ou masquer le mot de passe" title="Afficher / masquer">◉</button>
        </div>
        <button class="submit-btn" id="btn" type="submit">Se connecter</button>
        <div id="err" class="err"></div>
      </form>
      <div class="security-note"><strong>Accès sécurisé.</strong> Utilisez le mot de passe défini dans Railway via <b>ADMIN_PASSWORD</b>.</div>
    </div>
  </main>
</div>
<script>
const form=document.getElementById('form');
const btn=document.getElementById('btn');
const err=document.getElementById('err');
const passwordInput=document.getElementById('password');
const togglePassword=document.getElementById('togglePassword');
togglePassword.addEventListener('click',()=>{const show=passwordInput.type==='password';passwordInput.type=show?'text':'password';togglePassword.textContent=show?'◌':'◉';});
form.addEventListener('submit',async event=>{event.preventDefault();err.style.display='none';btn.disabled=true;btn.textContent='Connexion...';try{const response=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:passwordInput.value})});const data=await response.json();if(response.ok&&data.success){location.href='/admin';return;}err.textContent=data.error||'Mot de passe incorrect.';err.style.display='block';}catch{err.textContent='Impossible de contacter le serveur.';err.style.display='block';}finally{btn.disabled=false;btn.textContent='Se connecter';}});
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
  const password =
    safeString(req.body?.password);

  if (!password || password !== ADMIN_PASSWORD) {
    return res
      .status(401)
      .json({
        error: 'Mot de passe incorrect.'
      });
  }

  const token =
    crypto
      .randomBytes(32)
      .toString('hex');

  sessions.set(
    token,
    Date.now() + SESSION_DURATION
  );

  const cookieParts = [
    `mondeco_admin_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_DURATION / 1000)}`
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

  return res.sendFile(ADMIN_HTML_PATH);
});

// ============================================================
// MULTER
// ============================================================

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

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
// DISCUSSION DE TEST
// ============================================================

let chatHandler = null;
let imageChatHandler = null;

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

      if (mode === 'whatsapp') {
        return res.json({
          reply:
            'Simulation WhatsApp : image reçue. Aucune réponse automatique ne serait envoyée au client ; un commercial doit reprendre la conversation.',
          action:
            'commercial_required'
        });
      }

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
          }
        );

      return res.json({
        reply,
        action: 'vision_analysis'
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

const CONVERSATIONS_LOG_PATH = path.join(DATA_DIR, 'conversation-log.json');
const CONVERSATION_STATE_PATH_ADMIN = path.join(DATA_DIR, 'conversation-state.json');

function loadWhatsAppLog() {
  return readJsonArray(CONVERSATIONS_LOG_PATH, 'conversation-log.json');
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
        humanPaused: Boolean(state.humanPaused),
        awaitingResponse: Boolean(state.awaitingResponse),
        followUpsSent: Number(state.followUpsSent || 0)
      };
    }).sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0));

    return res.json(conversations);
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

    const entries = log
      .filter(entry => safeString(entry.contact) === contact)
      .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));

    return res.json({
      contact,
      state: states[contact] || {},
      entries
    });
  } catch (error) {
    console.error('❌ Détail conversation :', error);
    return res.status(500).json({ error: 'Impossible de lire cette conversation.' });
  }
});

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
  setCustomizationHandler
};
