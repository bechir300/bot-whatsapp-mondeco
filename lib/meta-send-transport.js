// ============================================================
// MONDECO — transport HTTPS natif des envois Meta (WhatsApp, Messenger,
// Instagram)
// lib/meta-send-transport.js
//
// V6.45 — Extrait de server.js (V6.36.0) pour être testable, avec deux
// corrections :
// - la promesse se termine TOUJOURS : coupure après les en-têtes de la
//   réponse ('aborted', 'error', 'close' sur la réponse) et délai maximal
//   (la promesse est rejetée avant de détruire la requête). Avant, une
//   coupure au milieu de la réponse laissait l'envoi en attente pour
//   toujours et bloquait la file du client jusqu'au redémarrage ;
// - une nouvelle tentative n'a lieu QUE si la connexion n'a jamais été
//   établie (DNS, connexion refusée, coupure pendant la négociation TLS) :
//   la requête n'a alors pas pu atteindre Meta. Une coupure (« socket hang
//   up », ECONNRESET) après l'envoi de la requête n'est plus rejouée : le
//   client recevait jusqu'à 3 fois le même message.
// ============================================================

const PREFLIGHT_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

function uncertainNetworkError(cause) {
  const error = new Error(
    'Coupure réseau pendant l’envoi. ' +
    'Le message a peut-être été délivré malgré tout : ' +
    'vérifiez la conversation avant de renvoyer.'
  );
  error.code = 'SEND_NETWORK_UNCERTAIN';
  error.cause = cause;
  error.requestMayHaveReachedMeta = true;
  return error;
}

function notSentNetworkError(cause) {
  const error = new Error(
    'Connexion à Meta impossible : le message n’a pas été envoyé.'
  );
  error.code = 'SEND_NETWORK_NOT_SENT';
  error.cause = cause;
  error.requestMayHaveReachedMeta = false;
  return error;
}

// Échec survenu AVANT tout contact avec Meta : la requête n'est pas partie,
// une nouvelle tentative ne peut pas provoquer de doublon.
function isPreflightNetworkFailure(error) {
  if (!error) return false;
  if (error.requestMayHaveReachedMeta === false) return true;
  if (error.requestMayHaveReachedMeta === true) return false;
  if (error.name === 'AbortError') return false;
  const code = String(error?.cause?.code || error?.code || '');
  return PREFLIGHT_ERROR_CODES.has(code);
}

function createMetaSendTransport({
  https,
  agent = undefined,
  timeoutMs = 20000,
  family = 4,
  logger = console,
  logNetworkError = () => {},
  retryDelayMs = 600,
  maxAttempts = 3
} = {}) {
  if (!https || typeof https.request !== 'function') throw new Error('Module https requis');

  function request(url, options = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();

      let target;
      try {
        target = new URL(url);
      } catch (error) {
        reject(error);
        return;
      }

      const headers = { ...(options.headers || {}) };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'connection') delete headers[key];
      }

      let body = options.body ?? null;
      if (body !== null && body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
        body = String(body);
      }
      const bodyBuffer =
        body === null || body === undefined
          ? null
          : Buffer.isBuffer(body)
            ? body
            : Buffer.from(body);

      if (bodyBuffer && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
        headers['Content-Length'] = bodyBuffer.length;
      }

      logger.log('⏱️ HTTPS-META START 0ms');

      let settled = false;
      // Vrai dès que la requête a pu partir vers Meta (connexion établie,
      // ou connexion keep-alive réutilisée).
      let dispatched = false;
      let response = null;
      let overallTimer = null;

      const finish = (error, value) => {
        if (settled) return false;
        settled = true;
        clearTimeout(overallTimer);
        if (error) reject(error);
        else resolve(value);
        return true;
      };

      const req = https.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          path: `${target.pathname}${target.search}`,
          method: options.method || 'GET',
          headers,
          family,
          agent: options.agent !== undefined ? options.agent : agent
        },
        res => {
          response = res;
          dispatched = true;
          logger.log(
            `⏱️ HTTPS-META HEADERS ${Date.now() - startedAt}ms ` +
            `HTTP=${res.statusCode || 0} REUSED=${req.reusedSocket ? 'yes' : 'no'}`
          );

          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));

          // Réponse interrompue après les en-têtes : Meta a reçu la requête.
          const onBroken = cause => {
            if (settled) return;
            const error = cause instanceof Error ? cause : new Error('Réponse Meta interrompue');
            logNetworkError(error, 'node:https (réponse)');
            const wrapped = uncertainNetworkError(error);
            wrapped.status = Number(res.statusCode || 0);
            finish(wrapped);
          };
          res.on('aborted', () => onBroken(new Error('Réponse Meta interrompue (aborted)')));
          res.on('error', onBroken);
          res.on('close', () => {
            if (!res.complete) onBroken(new Error('Réponse Meta interrompue (close)'));
          });

          res.on('end', () => {
            if (settled) return;
            if (res.complete === false) {
              onBroken(new Error('Réponse Meta incomplète'));
              return;
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            logger.log(`⏱️ HTTPS-META END ${Date.now() - startedAt}ms`);
            const responseHeaders = res.headers || {};
            finish(null, {
              ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300,
              status: Number(res.statusCode || 0),
              statusText: res.statusMessage || '',
              headers: {
                get(name) {
                  const value = responseHeaders[String(name || '').toLowerCase()];
                  if (Array.isArray(value)) return value.join(', ');
                  return value == null ? null : String(value);
                }
              },
              async text() {
                return raw;
              },
              async json() {
                if (!raw) return {};
                return JSON.parse(raw);
              }
            });
          });
        }
      );

      req.on('socket', socket => {
        if (!socket.connecting) {
          // Connexion keep-alive réutilisée : la requête part tout de suite.
          dispatched = true;
          return;
        }
        const readyEvent = socket.encrypted ? 'secureConnect' : 'connect';
        socket.once(readyEvent, () => {
          dispatched = true;
          if (socket.encrypted) {
            logger.log(`⏱️ HTTPS-META TLS ${Date.now() - startedAt}ms IP=${socket.remoteAddress || '?'}`);
          }
        });
      });

      req.on('error', error => {
        if (settled) return;
        logNetworkError(error, 'node:https');
        if (error?.code === 'SEND_TIMEOUT_UNCERTAIN') {
          finish(error);
          return;
        }
        finish(dispatched ? uncertainNetworkError(error) : notSentNetworkError(error));
      });

      overallTimer = setTimeout(() => {
        if (settled) return;
        const timeoutError = new Error(
          `Envoi interrompu après ${Math.round(timeoutMs / 1000)}s ` +
          'sans réponse de Meta. Le message a peut-être été délivré malgré tout : ' +
          'vérifiez la conversation avant de renvoyer.'
        );
        timeoutError.code = 'SEND_TIMEOUT_UNCERTAIN';
        timeoutError.requestMayHaveReachedMeta = dispatched;
        // On rejette AVANT de détruire : la promesse se termine même si la
        // requête est déjà fermée (destroy() sans effet).
        finish(timeoutError);
        try {
          if (response) response.destroy();
          req.destroy(timeoutError);
        } catch {}
      }, timeoutMs);
      if (typeof overallTimer.unref === 'function') overallTimer.unref();

      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
    });
  }

  // Nouvelle tentative uniquement pour un échec avant connexion (aucun envoi).
  async function requestWithPreflightRetry(url, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await request(url, options);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && isPreflightNetworkFailure(error)) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  return { request, requestWithPreflightRetry };
}

module.exports = {
  createMetaSendTransport,
  isPreflightNetworkFailure,
  PREFLIGHT_ERROR_CODES
};
