// ============================================================
// MONDECO — magasin JSON en mémoire avec écriture différée
// lib/json-object-store.js
//
// Un seul exemplaire en mémoire, partagé par server.js et Admin.js (même
// processus). Les modifications sont regroupées et écrites sur disque au
// plus tard après `maxDelayMs`, au lieu de réécrire tout le fichier (15 Mo+
// pour conversation-state.json) à chaque mise à jour, de façon bloquante.
//
// Le format du fichier ne change pas : sauvegardes, snapshots, export et
// restauration continuent de fonctionner sur le même fichier JSON.
//
// Garde-fous :
// - fichier illisible : relecture de la sauvegarde .bak ; si elle échoue
//   aussi, aucune écriture n'a lieu (on n'écrase jamais l'existant avec un
//   objet vide) ;
// - modification externe du fichier (restauration) : rechargée
//   automatiquement s'il n'y a pas de modification en attente ; sinon
//   `reload()` doit être appelé explicitement après la restauration ;
// - `flush()` est appelé à l'arrêt du processus (SIGTERM, exit) et avant
//   chaque snapshot ou export.
//
// V6.46 — Fichier vide (0 octet, écriture interrompue) : traité comme un
// fichier illisible (reprise du .bak), plus jamais comme « {} » puis
// réécrit. Fichier illisible remplacé par son .bak : il est d'abord mis de
// côté (<fichier>.corrupt-<date>) pour que la prochaine écriture ne copie
// pas la version abîmée sur le .bak. Option `onUnreadable: 'quarantine'`
// (notifications) : sans .bak valide, le fichier illisible est mis de côté
// et le magasin repart vide au lieu de bloquer toutes les écritures.
// ============================================================

const fs = require('fs');
const path = require('path');

const registeredStores = new Set();

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readObjectFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.size) {
    const error = new Error('fichier vide (0 octet)');
    error.code = 'EMPTY_JSON_FILE';
    throw error;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return isPlainObject(parsed) ? parsed : {};
}

function quarantineCorruptFile(filePath, logger, label) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${filePath}.corrupt-${stamp}`;
    fs.renameSync(filePath, target);
    logger.error(`🚨 ${label} illisible mis de côté : ${path.basename(target)}`);
    return target;
  } catch (error) {
    logger.error(`❌ ${label} illisible non mis de côté :`, error.message);
    return '';
  }
}

function createJsonObjectStore({
  filePath,
  label = path.basename(filePath),
  write,
  flushDelayMs = 1500,
  maxDelayMs = 5000,
  onUnreadable = 'block',
  logger = console
}) {
  if (typeof write !== 'function') {
    throw new Error('createJsonObjectStore : fonction write obligatoire.');
  }

  let data = null;
  let stamp = '';
  let dirty = false;
  let unreadable = false;
  let firstDirtyAt = 0;
  let timer = null;
  let version = 0;

  function loadFromDisk() {
    let emptyFile = false;
    try {
      const value = readObjectFile(filePath);
      unreadable = false;
      return value || {};
    } catch (error) {
      emptyFile = error?.code === 'EMPTY_JSON_FILE';
      logger.error(`❌ Lecture ${label} impossible :`, error.message);
    }

    try {
      const backup = readObjectFile(`${filePath}.bak`);
      if (backup) {
        logger.warn(`♻️ ${label} restauré depuis ${label}.bak`);
        // Le fichier abîmé est mis de côté : la prochaine écriture ne
        // remplacera pas le .bak valide par cette version illisible.
        if (!emptyFile) quarantineCorruptFile(filePath, logger, label);
        unreadable = false;
        return backup;
      }
    } catch (error) {
      logger.error(`❌ ${label}.bak invalide :`, error.message);
    }

    if (emptyFile) {
      // 0 octet et aucune sauvegarde : rien à préserver, on repart vide.
      logger.error(`🚨 ${label} vide (0 octet) et sans sauvegarde valide : contenu repris à zéro.`);
      unreadable = false;
      return {};
    }

    if (onUnreadable === 'quarantine' && quarantineCorruptFile(filePath, logger, label)) {
      unreadable = false;
      return {};
    }

    unreadable = true;
    logger.error(`🚨 ${label} illisible : écritures suspendues pour ne pas écraser le fichier. Restaurez une sauvegarde.`);
    return {};
  }

  function ensureLoaded() {
    if (data && (dirty || fileStamp(filePath) === stamp)) return data;
    data = loadFromDisk();
    stamp = fileStamp(filePath);
    version++;
    return data;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    const waited = Date.now() - firstDirtyAt;
    const delay = Math.max(0, Math.min(flushDelayMs, maxDelayMs - waited));
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function markDirty() {
    version++;
    if (!dirty) {
      dirty = true;
      firstDirtyAt = Date.now();
    }
    schedule();
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || !data) return false;
    if (unreadable) {
      logger.error(`🚨 ${label} non enregistré : le fichier d'origine est illisible.`);
      return false;
    }
    try {
      write(filePath, data);
      stamp = fileStamp(filePath);
      dirty = false;
      return true;
    } catch (error) {
      logger.error(`❌ Écriture ${label} impossible (nouvelle tentative) :`, error.message);
      firstDirtyAt = Date.now();
      schedule();
      return false;
    }
  }

  const store = {
    label,
    filePath,
    // Copie superficielle : l'appelant peut la modifier puis la passer à
    // replaceAll(), comme avec l'ancien couple load/save.
    getAll() {
      return { ...ensureLoaded() };
    },
    get(key) {
      const value = ensureLoaded()[key];
      return isPlainObject(value) ? value : null;
    },
    replaceAll(next) {
      // V6.46 — Fichier jamais lu : lu d'abord, pour qu'un fichier illisible
      // soit détecté (mis de côté ou protégé) avant toute écriture.
      if (data === null) ensureLoaded();
      data = isPlainObject(next) ? next : {};
      markDirty();
    },
    update(key, updater) {
      const current = ensureLoaded();
      const previous = isPlainObject(current[key]) ? current[key] : {};
      const updated = updater({ ...previous }) || previous;
      current[key] = updated;
      markDirty();
      return updated;
    },
    flush,
    // À appeler après une restauration qui a remplacé le fichier : les
    // modifications en attente sont abandonnées au profit du fichier.
    reload() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;
      data = null;
      stamp = '';
      ensureLoaded();
    },
    version() {
      ensureLoaded();
      return version;
    },
    stats() {
      return { label, dirty, unreadable, version, keys: data ? Object.keys(data).length : 0 };
    }
  };

  registeredStores.add(store);
  return store;
}

function flushAllJsonStores({ skipMissingDirectory = false } = {}) {
  let flushed = 0;
  for (const store of registeredStores) {
    // V6.46 — À la sortie : dossier de données disparu (volume démonté,
    // dossier temporaire de test supprimé) = rien à écrire ; ne jamais
    // recréer un dossier de données vide à sa place.
    if (skipMissingDirectory && !fs.existsSync(path.dirname(store.filePath))) continue;
    if (store.flush()) flushed++;
  }
  return flushed;
}

// Filet de sécurité : 'exit' est émis aussi après une exception non gérée.
process.on('exit', () => {
  try { flushAllJsonStores({ skipMissingDirectory: true }); } catch {}
});

module.exports = {
  createJsonObjectStore,
  flushAllJsonStores
};
