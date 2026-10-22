// ============================================================
// MONDECO — lectures réseau robustes
// lib/http.js
// ============================================================

const READ_FETCH_TIMEOUT_MS = 15000;
const MEDIA_FETCH_TIMEOUT_MS = 45000;
const READ_FETCH_MAX_RETRY_WAIT_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readRetryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (response && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, READ_FETCH_MAX_RETRY_WAIT_MS);
  }
  return Math.min(700 * 2 ** attempt + Math.floor(Math.random() * 300), READ_FETCH_MAX_RETRY_WAIT_MS);
}

// Lecture (GET, rejouable sans risque) : délai maximal par tentative et
// nouvelle tentative sur erreur réseau, 429 et 5xx, en respectant
// Retry-After (plafonné). Chaque tentative a son propre délai.
// Ne jamais l'utiliser pour un envoi : un envoi n'est pas rejouable.
async function fetchReadWithRetry(
  url,
  options = {},
  { timeoutMs = READ_FETCH_TIMEOUT_MS, retries = 2, fetchImpl = fetch } = {}
) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(readRetryDelayMs(null, attempt));
      continue;
    }

    const retryableStatus = response.status === 429 || response.status >= 500;
    if (!retryableStatus || attempt >= retries) return response;

    try { await response.arrayBuffer(); } catch {}
    await sleep(readRetryDelayMs(response, attempt));
  }
}

// Lit le corps d'une réponse en s'arrêtant dès que la limite est dépassée.
// content-length n'est pas fiable (absent en transfert « chunked »).
async function readResponseBufferWithLimit(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`Fichier trop volumineux (${declared} octets, limite ${maxBytes}).`);
  }

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`Fichier trop volumineux (limite ${maxBytes} octets).`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`Fichier trop volumineux (limite ${maxBytes} octets).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

module.exports = {
  READ_FETCH_TIMEOUT_MS,
  MEDIA_FETCH_TIMEOUT_MS,
  fetchReadWithRetry,
  readResponseBufferWithLimit,
  readRetryDelayMs
};
