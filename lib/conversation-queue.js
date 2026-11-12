// ============================================================
// MONDECO — file d'attente par conversation + reprise des échecs
// lib/conversation-queue.js
//
// Meta envoie chaque message dans un webhook séparé : sans sérialisation,
// deux messages rapprochés d'un même client étaient traités en parallèle
// (historique entremêlé, double réponse IA, état écrasé). Les conversations
// différentes restent traitées en parallèle.
//
// Reprise : Meta reçoit 200 avant le traitement et ne renvoie donc jamais un
// message dont le traitement a planté. Un message en échec est rejoué, sauf
// s'il est déjà journalisé (donc déjà répondu) : pas de double réponse.
// ============================================================

// V6.45 — Garde-fou : un traitement bloqué (envoi Meta qui ne se termine
// jamais, appel IA suspendu) ne bloque plus indéfiniment la file d'un
// client. Passé `stuckJobTimeoutMs`, le message suivant est traité quand
// même (le traitement bloqué continue en arrière-plan).
const DEFAULT_STUCK_JOB_TIMEOUT_MS = 3 * 60 * 1000;

function createConversationQueue({
  isMessageLogged = () => false,
  releaseMessageId = () => {},
  retryDelaysMs = [15 * 1000, 60 * 1000],
  stuckJobTimeoutMs = DEFAULT_STUCK_JOB_TIMEOUT_MS,
  logger = console
} = {}) {
  const queues = new Map();
  const inFlightJobs = new Set();
  const pendingRetryTimers = new Set();
  let stopped = false;

  // Attend la fin du traitement précédent, au plus `maxWaitMs`.
  function waitAtMost(previous, maxWaitMs, queueKey) {
    const settled = previous.catch(() => {});
    const limit = Number(maxWaitMs);
    if (!Number.isFinite(limit) || limit <= 0) return settled;
    return new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        logger.warn(`⏱️ File ${queueKey} : traitement précédent toujours en cours après ${Math.round(limit / 1000)} s, le suivant démarre quand même.`);
        resolve();
      }, limit);
      if (typeof timer.unref === 'function') timer.unref();
      settled.then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // `options.maxWaitMs` : attente maximale du traitement précédent pour cette
  // tâche (par défaut stuckJobTimeoutMs).
  function run(key, task, options = {}) {
    const queueKey = String(key ?? '') || 'unknown';
    const previous = queues.get(queueKey) || Promise.resolve();
    const maxWaitMs = options && options.maxWaitMs !== undefined ? options.maxWaitMs : stuckJobTimeoutMs;
    const job = waitAtMost(previous, maxWaitMs, queueKey)
      .then(task);
    // `tracked` ne rejette jamais : l'erreur remonte à l'appelant via `job`.
    const tracked = job.catch(() => {}).finally(() => {
      inFlightJobs.delete(tracked);
      if (queues.get(queueKey) === tracked) queues.delete(queueKey);
    });
    inFlightJobs.add(tracked);
    queues.set(queueKey, tracked);
    return job;
  }

  // Libère les IDs non journalisés pour que la reprise ne soit pas prise
  // pour un doublon. Renvoie vrai si tous les IDs ont pu être libérés.
  function releaseUnloggedMessageIds(messageIds) {
    let released = 0;
    for (const id of messageIds) {
      if (isMessageLogged(id)) continue;
      releaseMessageId(id);
      released++;
    }
    return released === messageIds.length;
  }

  // V6.45 — `onGiveUp(error)` : appelé une seule fois quand le message ne
  // sera plus rejoué (dernière tentative en échec, arrêt du serveur, message
  // déjà journalisé), pour qu'il ne disparaisse jamais sans trace.
  function runWithRetry({ queueKey, messageIds = [], label = 'message', task, attempt = 0, onGiveUp = null }) {
    const ids = messageIds.map(id => String(id ?? '').trim()).filter(Boolean);

    return run(queueKey, task).catch(error => {
      const delayMs = retryDelaysMs[attempt];
      const retryable =
        !stopped &&
        delayMs !== undefined &&
        ids.length > 0 &&
        releaseUnloggedMessageIds(ids);

      if (!retryable) {
        if (typeof onGiveUp === 'function') {
          try {
            onGiveUp(error);
          } catch (giveUpError) {
            logger.error(`❌ Abandon ${label} :`, giveUpError?.message || giveUpError);
          }
        }
        throw error;
      }

      logger.warn(
        `🔁 Échec ${label} (${error?.message || error}) : nouvelle tentative dans ${Math.round(delayMs / 1000)} s (${attempt + 1}/${retryDelaysMs.length}).`
      );

      const timer = setTimeout(() => {
        pendingRetryTimers.delete(timer);
        runWithRetry({ queueKey, messageIds: ids, label, task, attempt: attempt + 1, onGiveUp })
          .catch(finalError => {
            logger.error(`❌ Échec définitif ${label} :`, finalError?.message || finalError);
          });
      }, delayMs);

      if (typeof timer.unref === 'function') timer.unref();
      pendingRetryTimers.add(timer);
    });
  }

  // Arrêt : plus aucune reprise programmée. Renvoie le nombre annulé.
  function stopRetries() {
    stopped = true;
    const cancelled = pendingRetryTimers.size;
    for (const timer of pendingRetryTimers) clearTimeout(timer);
    pendingRetryTimers.clear();
    return cancelled;
  }

  return {
    run,
    runWithRetry,
    stopRetries,
    inFlightJobs,
    waitForIdle: () => Promise.allSettled([...inFlightJobs])
  };
}

// Clé symétrique (client ↔ page) : un message entrant et l'écho d'une
// réponse de la page tombent dans la même file.
function metaEventQueueKey(channel, event) {
  const ids = [
    String(event?.sender?.id ?? ''),
    String(event?.recipient?.id ?? '')
  ].sort();
  return `${channel}:${ids.join('|')}`;
}

module.exports = { createConversationQueue, metaEventQueueKey };
