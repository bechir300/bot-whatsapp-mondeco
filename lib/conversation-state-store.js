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
//
// V6.46 — Base SQLite indisponible (fichier corrompu, module natif
// incompatible, disque plein à l'ouverture) :
// - l'ouverture n'est plus retentée à chaque appel (attente croissante de
//   `sqliteRetryMs` à 5 min, une seule ligne d'erreur par tentative) ;
// - la reprise SQLite → mémoire du démarrage, impossible sans la base, est
//   faite dès que la base redevient disponible (avant toute écriture vers
//   SQLite), sans jamais remplacer une conversation modifiée depuis le
//   démarrage : la resynchronisation complète ne peut plus écraser des
//   lignes SQLite plus récentes avec la copie JSON ;
// - update() n'enregistre rien pour une conversation inconnue quand la
//   fonction de mise à jour ne renvoie rien (ou un objet vide / inchangé).
// conversation-state.json vide (0 octet) : traité comme absent (reprise
// complète depuis SQLite, écriture du JSON autorisée), jamais comme « {} ».
// La resynchronisation complète ne réécrit plus une ligne SQLite plus
// récente que le JSON (horodatage rétrogradé, copie JSON plus ancienne).
// V6.46 — JSON vide, absent ou illisible ET base SQLite indisponible : la
// mémoire est amorcée depuis conversation-state.json.bak (avant : {} — prises
// en main, affectations et origines publicitaires perdues, l'IA répondait à
// une conversation reprise par un commercial) et le JSON n'est plus écrit
// tant que la reprise SQLite différée n'a pas eu lieu (le .bak valide n'est
// plus écrasé par « {} »). Une conversation modifiée pendant la panne est
// fusionnée à la réouverture avec sa ligne SQLite : seuls les champs
// réellement modifiés depuis le démarrage remplacent ceux de la base.
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
  sqliteRetryMs = 30 * 1000,
  // V6.46 — (ok, erreur) après chaque écriture SQLite (pour /health).
  onWriteResult = null,
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

  // V6.46 — Suivi des échecs d'ouverture SQLite (attente avant nouvel essai).
  let sqliteFailedAt = 0;
  let sqliteFailures = 0;
  let sqliteLastError = '';
  // V6.46 — Échecs d'écriture (base en lecture seule, verrouillée) : une
  // seule ligne d'erreur par message différent, puis une ligne au retour.
  let sqliteLastWriteError = '';
  let sqliteLastWriteErrorAt = 0;
  let sqliteLastWriteOkAt = 0;
  let sqliteLoggedWriteError = '';

  function reportWrite(ok, error) {
    if (typeof onWriteResult !== 'function') return;
    try {
      onWriteResult(ok, error);
    } catch {}
  }
  // Reprise SQLite → mémoire du démarrage restée en attente faute de base :
  // { minUpdatedAt } (-Infinity = toutes les lignes).
  let pendingOverlay = null;
  let overlayRunning = false;
  let overlayRuns = 0;
  // V6.46 — Mémoire amorcée sans référence fiable (JSON vide / absent /
  // illisible, base indisponible) : JSON non écrit jusqu'à la reprise SQLite.
  let jsonHeldForOverlay = false;
  let jsonHeldLogged = false;
  let seededFromBackup = 0;
  // V6.46 — Conversations modifiées pendant la panne SQLite (avant la reprise
  // différée) : { wasKnown, fields:Set, removed }.
  const outageChanges = new Map();

  function sqliteRetryDelay() {
    const base = Math.max(0, Number(sqliteRetryMs) || 0);
    return Math.min(5 * 60 * 1000, base * Math.pow(2, Math.max(0, Math.min(sqliteFailures - 1, 4))));
  }

  function db() {
    if (!dbRef && sqliteFailedAt && Date.now() - sqliteFailedAt < sqliteRetryDelay()) {
      return null;
    }
    let handle = null;
    try {
      handle = openDb() || null;
      if (!handle) sqliteLastError = sqliteLastError || 'base SQLite non ouverte';
    } catch (error) {
      sqliteLastError = error.message;
      logger.error('❌ État des conversations : base SQLite indisponible :', error.message);
      handle = null;
    }
    if (!handle) {
      sqliteFailedAt = Date.now();
      sqliteFailures++;
    } else if (sqliteFailures) {
      logger.warn(`♻️ État des conversations : base SQLite de nouveau disponible (après ${sqliteFailures} échec(s)).`);
      sqliteFailedAt = 0;
      sqliteFailures = 0;
      sqliteLastError = '';
    }
    if (handle !== dbRef) {
      dbRef = handle;
      upsertStmt = null;
      selectStmt = null;
      writeManyTx = null;
      if (handle && pendingOverlay && !overlayRunning) runPendingOverlay(handle);
    }
    return handle;
  }

  // V6.46 — Reprise différée : appliquée dès que la base s'ouvre. Une
  // conversation modifiée depuis le démarrage (présente dans lastWrite)
  // garde les champs modifiés depuis, fusionnés avec sa ligne SQLite
  // (avant : la ligne SQLite — prise en main, affectation, origine pub —
  // était remplacée par l'état reconstruit à partir de {} pendant la panne).
  function runPendingOverlay(handle) {
    if (!pendingOverlay || !cache) return 0;
    const { minUpdatedAt } = pendingOverlay;
    pendingOverlay = null;
    overlayRunning = true;
    overlayRuns++;
    try {
      const applied = applyOverlayRows(
        handle,
        cache,
        minUpdatedAt,
        contact => lastWrite.has(contact) || outageChanges.has(contact),
        contact => {
          seq += 1;
          lastWrite.set(contact, { seq, token: null });
        }
      );
      const merged = mergeOutageChanges(handle, minUpdatedAt);
      if (jsonHeldForOverlay) {
        jsonHeldForOverlay = false;
        jsonHeldLogged = false;
        logger.warn('♻️ État des conversations : reprise SQLite faite, écriture de conversation-state.json de nouveau autorisée.');
        scheduleJsonWrite();
      } else if (applied || merged) {
        scheduleJsonWrite();
      }
      return applied + merged;
    } finally {
      overlayRunning = false;
    }
  }

  // V6.46 — {...ligne SQLite, ...champs modifiés pendant la panne}.
  function mergeOutageChanges(handle, minUpdatedAt) {
    if (!outageChanges.size) return 0;
    let merged = 0;
    let select = null;
    try {
      select = handle.prepare('SELECT data, updated_at FROM conversation_states WHERE contact = ?');
    } catch (error) {
      logger.warn('⚠️ Fusion des conversations modifiées pendant la panne SQLite :', error.message);
      outageChanges.clear();
      return 0;
    }
    for (const [contact, change] of outageChanges) {
      try {
        const mine = cache[contact];
        if (change.removed || !isPlainObject(mine)) continue;
        const row = select.get(contact);
        if (!row) continue;
        // Conversation déjà dans le JSON chargé au démarrage : une ligne
        // SQLite plus ancienne que ce JSON n'apporte rien.
        if (change.wasKnown && Number.isFinite(minUpdatedAt) && Number(row.updated_at) < minUpdatedAt) continue;
        const base = JSON.parse(row.data);
        if (!isPlainObject(base)) continue;
        const next = { ...base };
        for (const key of change.fields) {
          if (hasOwn(mine, key)) next[key] = mine[key];
          else delete next[key];
        }
        if (sameState(next, mine)) continue;
        cache[contact] = next;
        seq += 1;
        lastWrite.set(contact, { seq, token: null });
        merged++;
      } catch {}
    }
    outageChanges.clear();
    if (merged) {
      logger.warn(`♻️ État des conversations : ${merged} conversation(s) modifiée(s) pendant la panne SQLite fusionnée(s) avec leur ligne SQLite.`);
    }
    return merged;
  }

  function noteOutageChange(contact, previous, next, removed = false) {
    if (!pendingOverlay) return;
    let change = outageChanges.get(contact);
    if (!change) {
      change = { wasKnown: previous !== undefined, fields: new Set(), removed: false };
      outageChanges.set(contact, change);
    }
    change.removed = Boolean(removed);
    const before = isPlainObject(previous) ? previous : {};
    const after = isPlainObject(next) ? next : {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!sameState(before[key], after[key])) change.fields.add(key);
    }
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
    const overlaysBefore = overlayRuns;
    const handle = db();
    if (!handle) return false;
    if (overlayRuns !== overlaysBefore && cache) {
      // V6.46 — La reprise différée vient de remplacer ou fusionner des
      // conversations : on écrit leur version à jour, jamais l'ancienne.
      entries = entries.map(([contact, state]) => (
        isPlainObject(cache[contact]) && cache[contact] !== state ? [contact, cache[contact]] : [contact, state]
      ));
    }
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
      if (sqliteLastWriteError) {
        logger.warn('♻️ État des conversations : écriture SQLite de nouveau possible.');
      }
      sqliteLastWriteError = '';
      sqliteLoggedWriteError = '';
      sqliteLastWriteOkAt = Date.now();
      reportWrite(true);
      return true;
    } catch (error) {
      // La conversation reste marquée « non synchronisée » : le prochain
      // enregistrement groupé (flush) retentera l'écriture.
      sqliteLastWriteError = String(error?.message || error);
      sqliteLastWriteErrorAt = Date.now();
      if (sqliteLastWriteError !== sqliteLoggedWriteError) {
        sqliteLoggedWriteError = sqliteLastWriteError;
        logger.error('❌ État des conversations : écriture SQLite impossible (cette erreur n’est plus répétée) :', sqliteLastWriteError);
      }
      reportWrite(false, error);
      return false;
    }
  }

  // Au premier chargement : réintègre les conversations écrites dans SQLite
  // après la dernière écriture du JSON (arrêt brutal entre deux écritures).
  // `minUpdatedAt` = -Infinity : toutes les lignes (JSON absent ou illisible).
  function overlayFromSqlite(target, minUpdatedAt) {
    const handle = db();
    if (!handle) {
      // V6.46 — Base indisponible : la reprise sera faite à sa réouverture.
      const previous = pendingOverlay ? pendingOverlay.minUpdatedAt : Infinity;
      pendingOverlay = { minUpdatedAt: Math.min(previous, minUpdatedAt) };
      logger.error('🚨 État des conversations : reprise depuis SQLite impossible (base indisponible) ; elle sera faite dès la réouverture de la base.');
      return 0;
    }
    return applyOverlayRows(handle, target, minUpdatedAt, null);
  }

  function applyOverlayRows(handle, target, minUpdatedAt, skipContact, onApplied = null) {
    try {
      const rows = Number.isFinite(minUpdatedAt)
        ? handle.prepare('SELECT contact, data FROM conversation_states WHERE updated_at >= ?').all(Math.floor(minUpdatedAt))
        : handle.prepare('SELECT contact, data FROM conversation_states').all();
      let applied = 0;
      for (const row of rows) {
        try {
          if (skipContact && skipContact(row.contact)) continue;
          const data = JSON.parse(row.data);
          if (!isPlainObject(data)) continue;
          if (hasOwn(target, row.contact) && JSON.stringify(target[row.contact]) === row.data) {
            sqliteRefs.set(row.contact, target[row.contact]);
            continue;
          }
          target[row.contact] = data;
          sqliteRefs.set(row.contact, data);
          if (onApplied) onApplied(row.contact);
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

  function readBackupCopy() {
    try {
      const raw = fs.readFileSync(`${jsonPath}.bak`, 'utf8');
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // V6.46 — Premier chargement sans JSON exploitable : SQLite fait foi ; si
  // la base est indisponible, la mémoire est amorcée depuis le .bak et le
  // JSON n'est plus écrit avant la reprise SQLite (`kind` : missing, empty,
  // unreadable). Installation neuve (ni JSON ni .bak) : comportement inchangé.
  function seedWithoutJson(kind) {
    cache = {};
    overlayFromSqlite(cache, -Infinity);
    if (!pendingOverlay) return;
    const backup = readBackupCopy();
    if (backup) {
      Object.assign(cache, backup);
      seededFromBackup = Object.keys(backup).length;
      logger.error(`🛟 État des conversations : base SQLite indisponible, ${seededFromBackup} conversation(s) reprise(s) depuis conversation-state.json.bak.`);
    }
    if (kind === 'missing' && !backup) return;
    jsonHeldForOverlay = true;
  }

  function loadFromDisk(stamp, external) {
    if (stamp === 'missing') {
      // Installation neuve ou JSON supprimé : SQLite fait foi.
      if (!cache) seedWithoutJson('missing');
      cacheStamp = 'missing';
      unreadable = false;
      return cache;
    }

    let parsed;
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      if (!raw.trim()) {
        // V6.46 — Fichier vide (0 octet : écriture interrompue, coupure de
        // courant) : jamais lu comme « aucune conversation ». La mémoire
        // est gardée ou reconstruite depuis SQLite, puis le JSON réécrit.
        logger.error('❌ conversation-state.json vide (0 octet) : état repris depuis la mémoire / SQLite puis réécrit.');
        unreadable = false;
        unreadableStamp = '';
        if (!cache) seedWithoutJson('empty');
        cacheStamp = stamp;
        scheduleJsonWrite();
        return cache;
      }
      parsed = JSON.parse(raw);
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
        seedWithoutJson('unreadable');
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
      // V6.46 — Le fichier remplacé fait foi : plus de JSON retenu ni de
      // fusion de champs ; une reprise SQLite encore en attente n'applique
      // que les lignes plus récentes que ce fichier.
      jsonHeldForOverlay = false;
      outageChanges.clear();
      if (pendingOverlay) {
        let restoredAt = Date.now();
        try {
          restoredAt = fs.statSync(jsonPath).mtimeMs;
        } catch {}
        pendingOverlay = { minUpdatedAt: restoredAt };
      }
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
    if (pendingOverlay) noteOutageChange(contact, hasOwn(map, contact) ? map[contact] : undefined, next);
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
    const known = hasOwn(map, key);
    const current = currentState(map, key) || {};
    let next = typeof updater === 'function' ? updater(cloneState(current)) : updater;
    if (!isPlainObject(next)) next = current;
    // V6.46 — Conversation absente de la mémoire : rien n'est créé (ni
    // entrée vide, ni copie inchangée de la ligne SQLite) quand la mise à
    // jour ne renvoie rien, un objet vide ou l'état reçu sans changement.
    if (!known && (next === current || !Object.keys(next).length || sameState(next, current))) {
      return current;
    }
    if (next !== current) next = slim(next) || next;
    return commit(key, next);
  }

  function sameState(a, b) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
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
      if (pendingOverlay) noteOutageChange(contact, map[contact], undefined, true);
      delete map[contact];
      seq += 1;
      lastWrite.set(contact, { seq, token: meta ? meta.token : null });
      removed++;
    }

    const rows = [];
    for (const contact of changed) {
      if (pendingOverlay) noteOutageChange(contact, hasOwn(map, contact) ? map[contact] : undefined, states[contact]);
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
    // V6.46 — Reprise différée d'abord (si la base est revenue), avant de
    // lister les conversations à écrire.
    if (pendingOverlay) db();
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

    if (jsonHeldForOverlay) {
      // V6.46 — État incomplet (JSON vide/absent, base indisponible) : ni le
      // JSON ni son .bak ne sont remplacés avant la reprise SQLite.
      if (!jsonHeldLogged) {
        jsonHeldLogged = true;
        logger.error('🚨 conversation-state.json non écrit : base SQLite indisponible et état incomplet ; écriture reprise dès la réouverture de la base (.bak conservé).');
      }
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
    // V6.46 — Lignes SQLite plus récentes que le JSON (écrites après sa
    // dernière écriture) : jamais réécrites avec un horodatage plus ancien
    // ni avec la copie JSON. La mémoire les contient déjà (reprise au
    // chargement) et toute modification depuis est écrite tout de suite.
    const newerInSqlite = new Set();
    try {
      for (const row of handle.prepare('SELECT contact FROM conversation_states WHERE updated_at > ?').all(asOf)) {
        if (!lastWrite.has(row.contact)) newerInSqlite.add(row.contact);
      }
    } catch {}
    try {
      for (let index = 0; index < entries.length; index += 500) {
        const current = cache || {};
        const batch = entries
          .slice(index, index + 500)
          .filter(([contact, state]) => contact && isPlainObject(state) && current[contact] === state && sqliteRefs.get(contact) !== state && !newerInSqlite.has(contact));
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
      lastJsonWriteAt,
      // V6.46 — état de la base (lecture seule, pour /health).
      sqliteAvailable: Boolean(dbRef),
      sqliteFailures,
      sqliteLastError,
      sqliteOverlayPending: Boolean(pendingOverlay),
      sqliteLastWriteError,
      sqliteLastWriteErrorAt,
      sqliteLastWriteOkAt,
      jsonHeldForOverlay,
      seededFromBackup
    })
  };
}

module.exports = { createConversationStateStore, cloneState };
