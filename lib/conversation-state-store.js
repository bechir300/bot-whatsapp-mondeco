// ============================================================
// MONDECO — état des conversations : source de vérité unique
// lib/conversation-state-store.js
//
// V6.45 — server.js et Admin.js tournent dans le même processus mais
// gardaient deux copies de l'état : server.js lisait/écrivait SQLite,
// Admin.js écrivait seulement le cache JSON en mémoire, synchronisé vers
// SQLite par une écriture groupée (8 s à 60 s plus tard). Une prise en main
// (« Prendre en main »), une réactivation de l'IA, une affectation ou un SLA
// écrits par Admin.js étaient donc invisibles pour le bot pendant ce délai,
// puis effacés par la première écriture de server.js (message client,
// statut « lu » Meta…) faite à partir de la ligne SQLite périmée.
//
// Désormais :
// - la carte en mémoire est la seule référence, pour les deux fichiers ;
// - chaque modification d'une conversation est écrite tout de suite dans
//   SQLite (écriture traversante, ~1 ms) ;
// - le fichier JSON complet reste écrit de façon groupée (au plus une fois
//   par minute, et à l'arrêt) : même format qu'avant ;
// - une sauvegarde de la carte complète faite à partir d'une copie ancienne
//   (boucle avec des await au milieu) ne peut plus écraser une conversation
//   modifiée entre-temps par quelqu'un d'autre.
// ============================================================

const fs = require('fs');

const UPSERT_SQL = `
  INSERT INTO conversation_states (contact, data, updated_at)
  VALUES (@contact, @data, @updated_at)
  ON CONFLICT(contact) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneState(value) {
  if (!value || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createConversationStateStore({
  jsonPath,
  openDb = () => null,
  writeJson,
  fileStamp,
  slim = state => state,
  writeDebounceMs = 8000,
  jsonMinIntervalMs = 60 * 1000,
  slowLogMs = 500,
  logger = console
} = {}) {
  if (!jsonPath) throw new Error('jsonPath requis');
  if (typeof writeJson !== 'function') throw new Error('writeJson requis');

  const stampOf = typeof fileStamp === 'function'
    ? fileStamp
    : filePath => {
        try {
          const stat = fs.statSync(filePath);
          return `${stat.size}:${stat.mtimeMs}`;
        } catch {
          return 'missing';
        }
      };

  let cache = null;
  let cacheStamp = '';
  let unreadable = false;
  let unreadableStamp = '';

  // Numéro de version : chaque écriture d'une conversation reçoit un numéro
  // croissant. Une copie complète obtenue par loadAll() retient le numéro du
  // moment où elle a été faite ; à saveAll(), une conversation modifiée
  // depuis par un autre écrivain n'est pas écrasée.
  let seq = 0;
  let reloadSeq = 0;
  let tokenCounter = 0;
  const lastWrite = new Map();
  const snapshots = new WeakMap();

  // Dernier objet écrit dans SQLite pour chaque conversation (comparaison de
  // références, comme V6.37.2).
  const sqliteRefs = new Map();
  let fullSyncPending = false;

  let lastConflictLogAt = 0;

  let jsonDirty = false;
  let jsonTimer = null;
  let lastJsonWriteAt = 0;

  let dbRef = null;
  let upsertStmt = null;
  let selectStmt = null;
  let writeManyTx = null;

  function db() {
    let handle = null;
    try {
      handle = openDb() || null;
    } catch (error) {
      logger.error('❌ État des conversations : base SQLite indisponible :', error.message);
      handle = null;
    }
    if (handle !== dbRef) {
      dbRef = handle;
      upsertStmt = null;
      selectStmt = null;
      writeManyTx = null;
    }
    return handle;
  }

  function readRow(contact) {
    const handle = db();
    if (!handle) return null;
    try {
      if (!selectStmt) selectStmt = handle.prepare('SELECT data FROM conversation_states WHERE contact = ?');
      const row = selectStmt.get(contact);
      if (!row) return null;
      const parsed = JSON.parse(row.data);
      return isPlainObject(parsed) ? parsed : null;
    } catch (error) {
      logger.error(`❌ Lecture SQLite de l'état (${contact}) :`, error.message);
      return null;
    }
  }

  function writeRows(entries, updatedAt = Date.now()) {
    if (!entries.length) return true;
    const handle = db();
    if (!handle) return false;
    try {
      if (!upsertStmt) upsertStmt = handle.prepare(UPSERT_SQL);
      if (!writeManyTx) {
        writeManyTx = handle.transaction((list, at) => {
          for (const [contact, state] of list) {
            upsertStmt.run({ contact, data: JSON.stringify(state), updated_at: at });
          }
        });
      }
      writeManyTx(entries, updatedAt);
      for (const [contact, state] of entries) sqliteRefs.set(contact, state);
      return true;
    } catch (error) {
      // La conversation reste marquée « non synchronisée » : le prochain
      // enregistrement groupé (flush) retentera l'écriture.
      logger.error('❌ État des conversations : écriture SQLite impossible :', error.message);
      return false;
    }
  }

  // Au premier chargement : réintègre les conversations écrites dans SQLite
  // après la dernière écriture du JSON (arrêt brutal entre deux écritures).
  // `minUpdatedAt` = -Infinity : toutes les lignes (JSON absent ou illisible).
  function overlayFromSqlite(target, minUpdatedAt) {
    const handle = db();
    if (!handle) return 0;
    try {
      const rows = Number.isFinite(minUpdatedAt)
        ? handle.prepare('SELECT contact, data FROM conversation_states WHERE updated_at >= ?').all(Math.floor(minUpdatedAt))
        : handle.prepare('SELECT contact, data FROM conversation_states').all();
      let applied = 0;
      for (const row of rows) {
        try {
          const data = JSON.parse(row.data);
          if (!isPlainObject(data)) continue;
          if (hasOwn(target, row.contact) && JSON.stringify(target[row.contact]) === row.data) {
            sqliteRefs.set(row.contact, target[row.contact]);
            continue;
          }
          target[row.contact] = data;
          sqliteRefs.set(row.contact, data);
          applied++;
        } catch {}
      }
      if (applied) {
        logger.log(`♻️ État des conversations : ${applied} conversation(s) plus récente(s) reprise(s) depuis SQLite.`);
      }
      return applied;
    } catch (error) {
      logger.warn('⚠️ Reprise SQLite → état des conversations :', error.message);
      return 0;
    }
  }

  function scheduleJsonWrite() {
    jsonDirty = true;
    if (jsonTimer) return;
    const sinceLast = Date.now() - lastJsonWriteAt;
    const delay = Math.max(writeDebounceMs, jsonMinIntervalMs - sinceLast);
    jsonTimer = setTimeout(() => {
      jsonTimer = null;
      try {
        flush(false);
      } catch (error) {
        logger.error('❌ Écriture différée conversation-state.json :', error.message);
      }
    }, Math.max(0, delay));
    if (typeof jsonTimer.unref === 'function') jsonTimer.unref();
  }

  function scheduleFullSync() {
    fullSyncPending = true;
    const timer = setTimeout(() => {
      backgroundFullSync().catch(error => logger.error('❌ Resynchronisation SQLite :', error.message));
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function loadFromDisk(stamp, external) {
    if (stamp === 'missing') {
      // Installation neuve ou JSON supprimé : SQLite fait foi.
      if (!cache) {
        cache = {};
        overlayFromSqlite(cache, -Infinity);
      }
      cacheStamp = 'missing';
      unreadable = false;
      return cache;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8') || '{}');
      if (!isPlainObject(parsed)) parsed = {};
    } catch (error) {
      // Fichier présent mais illisible : on n'écrira plus le JSON (pour ne
      // jamais remplacer les conversations existantes) ; la mémoire est
      // reconstruite depuis SQLite pour que le bot et l'Inbox continuent.
      if (!unreadable || unreadableStamp !== stamp) {
        logger.error('❌ Lecture conversation-state.json impossible (écritures JSON suspendues, état repris depuis SQLite) :', error.message);
      }
      unreadable = true;
      unreadableStamp = stamp;
      if (!cache) {
        cache = {};
        overlayFromSqlite(cache, -Infinity);
        cacheStamp = stamp;
      }
      return cache;
    }

    unreadable = false;
    unreadableStamp = '';

    if (external && cache) {
      // Fichier remplacé hors de ce module (restauration d'une sauvegarde) :
      // il devient la référence ; SQLite est resynchronisé en arrière-plan.
      seq += 1;
      reloadSeq = seq;
      sqliteRefs.clear();
      jsonDirty = false;
      if (jsonTimer) {
        clearTimeout(jsonTimer);
        jsonTimer = null;
      }
      cache = parsed;
      cacheStamp = stamp;
      logger.warn('♻️ conversation-state.json modifié sur disque : état des conversations rechargé.');
      scheduleFullSync();
      return cache;
    }

    cache = parsed;
    cacheStamp = stamp;
    for (const [contact, state] of Object.entries(cache)) sqliteRefs.set(contact, state);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(jsonPath).mtimeMs;
    } catch {}
    const recovered = overlayFromSqlite(cache, mtimeMs);
    if (recovered) scheduleJsonWrite();
    return cache;
  }

  function ensureLoaded() {
    const stamp = stampOf(jsonPath);
    if (cache) {
      if (stamp === cacheStamp || stamp === 'missing') return cache;
      if (unreadable && stamp === unreadableStamp) return cache;
      return loadFromDisk(stamp, true);
    }
    return loadFromDisk(stamp, false);
  }

  function cleanContact(contact) {
    return String(contact ?? '').trim();
  }

  function commit(contact, next, token = null) {
    const map = ensureLoaded();
    if (map[contact] === next) return next;
    map[contact] = next;
    seq += 1;
    lastWrite.set(contact, { seq, token });
    writeRows([[contact, next]]);
    scheduleJsonWrite();
    return next;
  }

  function currentState(map, contact) {
    if (hasOwn(map, contact)) {
      const value = map[contact];
      return isPlainObject(value) ? value : null;
    }
    // Conversation absente de la carte (retirée par la purge des terminées) :
    // même comportement qu'avant, la dernière version SQLite est reprise.
    return readRow(contact);
  }

  // Lecture d'UNE conversation : copie indépendante (comme une ligne SQLite
  // relue), modifiable sans effet de bord.
  function get(contact) {
    const key = cleanContact(contact);
    if (!key) return null;
    const value = currentState(ensureLoaded(), key);
    return value ? cloneState(value) : null;
  }

  // Lecture-modification-écriture atomique d'UNE conversation (aucun await).
  function update(contact, updater) {
    const key = cleanContact(contact);
    if (!key) return null;
    const map = ensureLoaded();
    const current = currentState(map, key) || {};
    let next = typeof updater === 'function' ? updater(cloneState(current)) : updater;
    if (!isPlainObject(next)) next = current;
    if (next !== current) next = slim(next) || next;
    return commit(key, next);
  }

  function set(contact, state) {
    const key = cleanContact(contact);
    if (!key || !isPlainObject(state)) return null;
    return commit(key, slim(state) || state);
  }

  // Copie superficielle de la carte complète (listes, rapports, boucles).
  function loadAll() {
    const copy = { ...ensureLoaded() };
    snapshots.set(copy, { baseSeq: seq, token: ++tokenCounter });
    return copy;
  }

  // Carte vivante, en lecture seule (statistiques rapides).
  function live() {
    return ensureLoaded();
  }

  function newerThanSnapshot(contact, meta) {
    if (!meta) return false;
    if (reloadSeq > meta.baseSeq) return true;
    const written = lastWrite.get(contact);
    return Boolean(written && written.seq > meta.baseSeq && written.token !== meta.token);
  }

  // Enregistre une carte complète obtenue par loadAll() (ou construite par
  // l'appelant). Seules les conversations que l'appelant a réellement
  // changées sont appliquées ; une conversation modifiée par un autre
  // écrivain après la copie est conservée telle quelle.
  function saveAll(states) {
    if (!isPlainObject(states)) return;
    const map = ensureLoaded();

    if (states === map) {
      // Carte vivante modifiée directement : on synchronise ce qui a changé.
      catchUpSqlite(true);
      scheduleJsonWrite();
      return;
    }

    const meta = snapshots.get(states) || null;
    const changed = [];
    let conflicts = 0;
    let removed = 0;

    for (const contact of Object.keys(states)) {
      const next = states[contact];
      if (map[contact] === next) continue;
      if (newerThanSnapshot(contact, meta)) {
        conflicts++;
        continue;
      }
      changed.push(contact);
    }

    // Suppression (purge) : uniquement depuis une copie obtenue par
    // loadAll(). Une carte construite autrement (origine inconnue) ne peut
    // jamais effacer de conversations.
    for (const contact of (meta ? Object.keys(map) : [])) {
      if (hasOwn(states, contact)) continue;
      if (newerThanSnapshot(contact, meta)) continue;
      delete map[contact];
      seq += 1;
      lastWrite.set(contact, { seq, token: meta ? meta.token : null });
      removed++;
    }

    const rows = [];
    for (const contact of changed) {
      map[contact] = states[contact];
      seq += 1;
      lastWrite.set(contact, { seq, token: meta ? meta.token : null });
      if (isPlainObject(states[contact])) rows.push([contact, states[contact]]);
    }
    writeRows(rows);

    // Cas normal pour une copie gardée pendant un await : on le signale au
    // plus une fois par minute pour ne pas encombrer les journaux.
    if (conflicts && Date.now() - lastConflictLogAt > 60 * 1000) {
      lastConflictLogAt = Date.now();
      logger.log(`ℹ️ État des conversations : ${conflicts} conversation(s) modifiée(s) depuis la copie conservée(s) dans leur version la plus récente.`);
    }
    if (changed.length || removed) scheduleJsonWrite();
  }

  // Écrit dans SQLite toute conversation dont la version en mémoire n'y est
  // pas encore (écriture précédente en échec, modification directe).
  function catchUpSqlite(force = false) {
    if (!cache) return 0;
    if (fullSyncPending && !force) return 0;
    const rows = [];
    for (const [contact, state] of Object.entries(cache)) {
      if (!contact || !isPlainObject(state)) continue;
      if (sqliteRefs.get(contact) !== state) rows.push([contact, state]);
    }
    if (rows.length) writeRows(rows);
    if (sqliteRefs.size > Object.keys(cache).length * 1.2 + 100) {
      for (const contact of sqliteRefs.keys()) {
        if (!hasOwn(cache, contact)) sqliteRefs.delete(contact);
      }
    }
    return rows.length;
  }

  // `force` (par défaut) : écrit le JSON tout de suite. La minuterie passe
  // `false` et respecte l'intervalle minimal entre deux écritures.
  function flush(force = true) {
    const forceJson = force !== false;
    if (!cache) return;
    const startedAt = Date.now();
    const sqliteRows = catchUpSqlite(forceJson);
    const sqliteMs = Date.now() - startedAt;

    if (!jsonDirty) return;

    if (unreadable) {
      logger.error('🚨 conversation-state.json non écrit : le fichier existant est illisible. Restaurez une sauvegarde puis redémarrez.');
      jsonDirty = false;
      return;
    }

    const sinceLast = Date.now() - lastJsonWriteAt;
    if (!forceJson && sinceLast < jsonMinIntervalMs) {
      jsonDirty = false;
      scheduleJsonWrite();
      return;
    }

    if (jsonTimer) {
      clearTimeout(jsonTimer);
      jsonTimer = null;
    }

    // Ne jamais écraser un fichier remplacé entre-temps (restauration).
    const stamp = stampOf(jsonPath);
    if (cacheStamp && cacheStamp !== 'missing' && stamp !== 'missing' && stamp !== cacheStamp) {
      ensureLoaded();
      return;
    }

    const jsonStartedAt = Date.now();
    try {
      writeJson(jsonPath, cache);
      cacheStamp = stampOf(jsonPath);
      lastJsonWriteAt = Date.now();
      jsonDirty = false;
    } catch (error) {
      logger.error('❌ Écriture différée conversation-state.json :', error.message);
      scheduleJsonWrite();
    }
    const jsonMs = Date.now() - jsonStartedAt;

    if (jsonMs + sqliteMs >= slowLogMs) {
      let sizeMb = 0;
      try {
        sizeMb = fs.statSync(jsonPath).size / 1e6;
      } catch {}
      logger.warn(
        `⏱️ État des conversations : ${Date.now() - startedAt} ms | JSON ${jsonMs} ms (${sizeMb.toFixed(1)} Mo) | SQLite ${sqliteMs} ms (${sqliteRows} conversation(s))`
      );
    }
  }

  // Resynchronisation complète mémoire → SQLite par lots de 500, en rendant
  // la main entre deux lots (une fois après le démarrage, et après un
  // rechargement du JSON).
  async function backgroundFullSync() {
    const handle = db();
    if (!handle || !cache) {
      fullSyncPending = false;
      return 0;
    }
    const startedAt = Date.now();
    const entries = Object.entries(cache);
    let asOf = Date.now();
    try {
      // Horodatage antérieur au JSON : ces lignes ne seront pas reprises
      // comme « plus récentes » au démarrage suivant.
      asOf = Math.floor(fs.statSync(jsonPath).mtimeMs) - 1;
    } catch {}
    let synced = 0;
    try {
      for (let index = 0; index < entries.length; index += 500) {
        const current = cache || {};
        const batch = entries
          .slice(index, index + 500)
          .filter(([contact, state]) => contact && isPlainObject(state) && current[contact] === state && sqliteRefs.get(contact) !== state);
        if (batch.length && writeRows(batch, asOf)) synced += batch.length;
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally {
      fullSyncPending = false;
    }
    logger.log(`🗄️ SQLite resynchronisé en arrière-plan : ${synced} conversation(s) en ${Date.now() - startedAt} ms.`);
    return synced;
  }

  // Après le démarrage : toutes les conversations chargées depuis le JSON
  // sont réécrites une fois dans SQLite (comme V6.37.3).
  async function startupFullSync() {
    if (!cache) ensureLoaded();
    if (!cache) return 0;
    const refsBefore = new Map(sqliteRefs);
    sqliteRefs.clear();
    // Les conversations déjà écrites depuis le démarrage gardent leur ligne.
    for (const [contact, state] of refsBefore) {
      if (lastWrite.has(contact) && cache[contact] === state) sqliteRefs.set(contact, state);
    }
    fullSyncPending = true;
    return backgroundFullSync();
  }

  return {
    get,
    update,
    set,
    loadAll,
    saveAll,
    live,
    flush,
    backgroundFullSync: startupFullSync,
    isUnreadable: () => unreadable,
    stats: () => ({
      loaded: Boolean(cache),
      contacts: cache ? Object.keys(cache).length : 0,
      seq,
      jsonDirty,
      unreadable,
      lastJsonWriteAt
    })
  };
}

module.exports = { createConversationStateStore, cloneState };
