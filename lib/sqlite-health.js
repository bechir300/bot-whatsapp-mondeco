// ============================================================
// MONDECO — connexion SQLite (mondeco.db) et son état de santé
// lib/sqlite-health.js
//
// V6.46 — Avant, un échec d'ouverture de mondeco.db (fichier corrompu,
// restauré d'une mauvaise version, appartenant à root après un lancement
// avec sudo, module natif incompatible) était avalé : la base était
// ré-ouverte (require + new Database) à CHAQUE accès, avec une ligne
// d'erreur à chaque fois (une quinzaine par message, alertes en rafale),
// et /health répondait « ok ».
//
// Désormais :
// - l'échec est mémorisé : nouvel essai seulement après une attente
//   croissante (30 s, 1 min, 2 min… 5 min au plus) ;
// - une seule ligne d'erreur (donc une alerte ALERT_WEBHOOK_URL) par
//   erreur différente, puis une ligne quand la base redevient disponible ;
// - une base à moitié ouverte est refermée (plus de descripteurs perdus) ;
// - /health interroge probe() : « degraded » (HTTP 503) avec la raison.
//
// Admin.js crée la connexion (registerSqliteConnection) ; server.js la lit
// pour /health via sharedSqliteConnection() (même instance de module).
//
// V6.46 — Une base ouverte et lisible mais où l'on ne peut pas ÉCRIRE
// (fichier en lecture seule, appartenant à root, verrou d'un autre
// processus) répondait « ok » : le résultat de la dernière écriture de
// l'état des conversations (noteWrite) est désormais pris en compte —
// « degraded » tant que la dernière écriture a échoué. Attente maximale
// sur un verrou : 500 ms (avant : 5 s par écriture, serveur figé).
// ============================================================

'use strict';

function errorMessage(error) {
  return String((error && error.message) || error || 'erreur inconnue').slice(0, 300);
}

function createSqliteConnection({
  dbPath,
  openDatabase = filePath => {
    const Database = require('better-sqlite3');
    return new Database(filePath, { timeout: 500 });
  },
  initialize = () => {},
  logger = console,
  retryMs = 30 * 1000,
  maxRetryMs = 5 * 60 * 1000,
  now = () => Date.now(),
  label = 'mondeco.db'
} = {}) {
  let handle = null;
  let openedAt = 0;
  let failures = 0;
  let failedAt = 0;
  let firstFailedAt = 0;
  let lastError = '';
  let lastLoggedError = '';
  let probeError = '';
  let lastLoggedProbeError = '';
  // V6.46 — Résultat des écritures (lib/conversation-state-store.js).
  let writeError = '';
  let writeFailedAt = 0;
  let writeOkAt = 0;

  function noteWrite(ok, error = null) {
    if (ok) {
      writeOkAt = now();
      writeError = '';
      return;
    }
    writeFailedAt = now();
    writeError = errorMessage(error);
  }

  function writeFailing() {
    return Boolean(writeError) && writeFailedAt >= writeOkAt;
  }

  function retryDelay() {
    const base = Math.max(0, Number(retryMs) || 0);
    const exponent = Math.max(0, Math.min(failures - 1, 6));
    return Math.min(Math.max(base, Number(maxRetryMs) || base), base * Math.pow(2, exponent));
  }

  function inBackoff() {
    return !handle && failures > 0 && now() - failedAt < retryDelay();
  }

  // Renvoie la base ouverte, ou null (échec mémorisé, aucun nouvel essai
  // avant la fin de l'attente).
  function get() {
    if (handle) return handle;
    if (inBackoff()) return null;

    let candidate = null;
    try {
      candidate = openDatabase(dbPath);
      initialize(candidate);
      handle = candidate;
      openedAt = now();
      if (failures) {
        logger.warn(`♻️ SQLite (${label}) de nouveau disponible après ${failures} échec(s) d'ouverture.`);
      } else {
        logger.log(`✅ SQLite (${label}) initialisé.`);
      }
      failures = 0;
      failedAt = 0;
      firstFailedAt = 0;
      lastError = '';
      lastLoggedError = '';
      return handle;
    } catch (error) {
      if (candidate && typeof candidate.close === 'function') {
        try { candidate.close(); } catch {}
      }
      failures++;
      failedAt = now();
      if (!firstFailedAt) firstFailedAt = failedAt;
      lastError = errorMessage(error);
      if (lastError !== lastLoggedError) {
        lastLoggedError = lastError;
        logger.error(
          `🚨 Base SQLite ${label} indisponible : ${lastError}. ` +
          `L'état des conversations continue sur le fichier JSON ; /health signale « degraded ». ` +
          `Nouvel essai automatique dans ${Math.round(retryDelay() / 1000)} s (cette erreur n'est plus répétée). ` +
          'Vérifiez le fichier (propriétaire, droits, intégrité) puis redémarrez le service.'
        );
      }
      return null;
    }
  }

  // Vérification pour /health : ouvre la base si besoin (en respectant
  // l'attente après un échec) et lit sqlite_master (détecte un fichier qui
  // n'est pas une base ou une base corrompue).
  function probe() {
    const db = get();
    if (!db) {
      return {
        ok: false,
        error: lastError || 'base non ouverte',
        failures,
        since: firstFailedAt ? new Date(firstFailedAt).toISOString() : null,
        retry_in_s: Math.max(0, Math.ceil((retryDelay() - (now() - failedAt)) / 1000))
      };
    }
    try {
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      if (probeError) {
        logger.warn(`♻️ SQLite (${label}) : lecture de nouveau possible.`);
      }
      probeError = '';
      lastLoggedProbeError = '';
      if (writeFailing()) {
        return {
          ok: false,
          error: `écriture impossible : ${writeError}`,
          write_failed_at: new Date(writeFailedAt).toISOString(),
          last_write_ok_at: writeOkAt ? new Date(writeOkAt).toISOString() : null
        };
      }
      return { ok: true, opened_at: new Date(openedAt).toISOString() };
    } catch (error) {
      probeError = errorMessage(error);
      if (probeError !== lastLoggedProbeError) {
        lastLoggedProbeError = probeError;
        logger.error(`🚨 Base SQLite ${label} illisible : ${probeError}. /health signale « degraded ».`);
      }
      return { ok: false, error: probeError };
    }
  }

  function status() {
    return {
      open: Boolean(handle),
      failures,
      lastError,
      probeError,
      writeError: writeFailing() ? writeError : '',
      since: firstFailedAt ? new Date(firstFailedAt).toISOString() : null
    };
  }

  return { get, probe, status, noteWrite };
}

let sharedConnection = null;

function registerSqliteConnection(connection) {
  sharedConnection = connection || null;
  return sharedConnection;
}

function sharedSqliteConnection() {
  return sharedConnection;
}

module.exports = {
  createSqliteConnection,
  registerSqliteConnection,
  sharedSqliteConnection
};
