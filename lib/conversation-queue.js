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

function createConversationQueue({
  isMessageLogged = () => false,
  releaseMessageId = () => {},
  retryDelaysMs = [15 * 1000, 60 * 1000],
  logger = console
} = {}) {
  const queues = new Map();
  const inFlightJobs = new Set();
  const pendingRetryTimers = new Set();
  let stopped = false;

  function run(key, task) {
    const queueKey = String(key ?? '') || 'unknown';
    const previous = queues.get(queueKey) || Promise.resolve();
    const job = previous
      .catch(() => {})
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

  function runWithRetry({ queueKey, messageIds = [], label = 'message', task, attempt = 0 }) {
    const ids = messageIds.map(id => String(id ?? '').trim()).filter(Boolean);

    return run(queueKey, task).catch(error => {
      const delayMs = retryDelaysMs[attempt];
      const retryable =
        !stopped &&
        delayMs !== undefined &&
        ids.length > 0 &&
        releaseUnloggedMessageIds(ids);

      if (!retryable) throw error;

      logger.warn(
        `🔁 Échec ${label} (${error?.message || error}) : nouvelle tentative dans ${Math.round(delayMs / 1000)} s (${attempt + 1}/${retryDelaysMs.length}).`
      );

      const timer = setTimeout(() => {
        pendingRetryTimers.delete(timer);
        runWithRetry({ queueKey, messageIds: ids, label, task, attempt: attempt + 1 })
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
