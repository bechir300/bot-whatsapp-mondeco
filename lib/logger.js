// ============================================================
// MONDECO — logs structurés, corrélation et alertes
// lib/logger.js
//
// Sans modifier les milliers d'appels console.* existants :
// - chaque requête HTTP (webhook compris) reçoit un identifiant de
//   corrélation, ajouté à toutes les lignes de log émises pendant son
//   traitement, y compris les traitements asynchrones qu'elle déclenche ;
// - LOG_FORMAT=json produit une ligne JSON par log (niveau, horodatage,
//   identifiant), lisible et filtrable dans Railway ;
// - ALERT_WEBHOOK_URL (Slack, Discord, Google Chat, Teams…) reçoit un résumé
//   des erreurs, regroupées et limitées à un envoi toutes les
//   ALERT_MIN_INTERVAL_MINUTES (défaut 10).
// ============================================================

const crypto = require('crypto');
const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');

const logContext = new AsyncLocalStorage();
let installed = null;

function newRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

function withLogContext(fields, fn) {
  const parent = logContext.getStore() || {};
  return logContext.run({ ...parent, ...fields }, fn);
}

function currentLogContext() {
  return logContext.getStore() || null;
}

function installConsoleLogger({
  format = String(process.env.LOG_FORMAT || 'text').trim().toLowerCase(),
  alertWebhookUrl = String(process.env.ALERT_WEBHOOK_URL || '').trim(),
  alertMinIntervalMs = Math.max(1, Number(process.env.ALERT_MIN_INTERVAL_MINUTES) || 10) * 60 * 1000,
  serviceName = 'mondeco',
  fetchImpl = (...args) => fetch(...args)
} = {}) {
  if (installed) return installed;

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const json = format === 'json';
  const pendingAlerts = [];
  let lastAlertAt = 0;
  let alertTimer = null;
  let droppedAlerts = 0;

  function sendAlerts() {
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = null;
    if (!pendingAlerts.length) return Promise.resolve();

    const items = pendingAlerts.splice(0);
    const extra = droppedAlerts;
    droppedAlerts = 0;
    lastAlertAt = Date.now();

    const lines = items.map(item => `• ${item.requestId ? `[${item.requestId}] ` : ''}${item.message}`);
    if (extra) lines.push(`… et ${extra} autre(s) erreur(s).`);
    const text = `🚨 ${serviceName} : ${items.length + extra} erreur(s)\n${lines.join('\n')}`.slice(0, 3500);

    // `text` (Slack, Google Chat, Teams) et `content` (Discord).
    return Promise.resolve()
      .then(() => fetchImpl(alertWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(10000)
      }))
      .then(response => {
        if (response && !response.ok) original.warn(`⚠️ Alerte non envoyée (HTTP ${response.status}).`);
      })
      .catch(error => original.warn('⚠️ Alerte non envoyée :', error.message));
  }

  function queueAlert(message, context) {
    if (!alertWebhookUrl) return;
    if (pendingAlerts.length >= 10) {
      droppedAlerts++;
    } else {
      pendingAlerts.push({ message: message.slice(0, 300), requestId: context?.requestId || '' });
    }
    if (alertTimer) return;
    const wait = Math.max(0, alertMinIntervalMs - (Date.now() - lastAlertAt));
    alertTimer = setTimeout(sendAlerts, Math.max(wait, 2000));
    if (typeof alertTimer.unref === 'function') alertTimer.unref();
  }

  function emit(level, writer, args) {
    const context = logContext.getStore();
    const message = util.format(...args);

    if (json) {
      const line = {
        time: new Date().toISOString(),
        level,
        msg: message,
        ...(context || {})
      };
      writer(JSON.stringify(line));
    } else if (context?.requestId) {
      writer(`[${context.requestId}]`, ...args);
    } else {
      writer(...args);
    }

    if (level === 'error') queueAlert(message, context);
  }

  console.log = (...args) => emit('info', original.log, args);
  console.info = (...args) => emit('info', original.info, args);
  console.warn = (...args) => emit('warn', original.warn, args);
  console.error = (...args) => emit('error', original.error, args);

  installed = {
    format: json ? 'json' : 'text',
    alertsEnabled: Boolean(alertWebhookUrl),
    flushAlerts: sendAlerts,
    restore() {
      Object.assign(console, original);
      if (alertTimer) clearTimeout(alertTimer);
      installed = null;
    }
  };
  return installed;
}

// Middleware Express : identifiant de corrélation par requête, renvoyé dans
// l'en-tête X-Request-Id.
function requestContextMiddleware(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const requestId = incoming || newRequestId();
  res.setHeader('X-Request-Id', requestId);
  withLogContext({ requestId }, next);
}

module.exports = {
  installConsoleLogger,
  requestContextMiddleware,
  withLogContext,
  currentLogContext,
  newRequestId
};
