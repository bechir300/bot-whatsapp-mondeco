// ============================================================
// MONDECO — rapport de santé (/health)
// lib/health.js
//
// V6.46 — /health répondait toujours 200 « ok » (même avec une base SQLite
// illisible, sans .env chargé ou juste avant un plantage) et publiait la
// version exacte de Node. Désormais :
// - « status » vaut « ok » (HTTP 200) ou « degraded » (HTTP 503) avec la
//   liste des raisons ;
// - vérifications : dossier des données accessible en écriture, base
//   SQLite lisible, configuration indispensable (en production) ;
// - « version » (package.json) et « commit » identifient le code déployé ;
// - âge du dernier webhook Meta reçu (information : la nuit, l'absence de
//   message est normale, ce n'est donc jamais une raison de 503) ;
// - plus aucune version de Node ni de dépendance.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Écriture réelle d'un petit fichier (détecte droits insuffisants, système
// de fichiers en lecture seule, disque plein). Résultat gardé `ttlMs` pour
// ne pas écrire à chaque appel de la supervision.
function createDataDirProbe(dataDir, { ttlMs = 15 * 1000, now = () => Date.now() } = {}) {
  let cached = null;
  let cachedAt = 0;
  const probePath = path.join(dataDir, '.mondeco-health-probe');

  return function probeDataDir() {
    if (cached && now() - cachedAt < ttlMs) return cached;
    try {
      fs.writeFileSync(probePath, String(now()));
      fs.unlinkSync(probePath);
      cached = { ok: true };
    } catch (error) {
      cached = { ok: false, error: `${error.code || 'ERREUR'} : ${String(error.message || error).slice(0, 200)}` };
      try { fs.unlinkSync(probePath); } catch {}
    }
    cachedAt = now();
    return cached;
  };
}

function ageSeconds(atMs, nowMs) {
  return atMs > 0 ? Math.max(0, Math.round((nowMs - atMs) / 1000)) : null;
}

function isoOrNull(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

// Construit la réponse de /health. Fonction pure (testée sans serveur).
function buildHealthReport({
  service = 'bot-whatsapp-mondeco',
  version = '',
  commit = '',
  startedAtMs = 0,
  nowMs = Date.now(),
  dataDir = { ok: true },
  sqlite = { ok: true },
  config = { required: {}, enforce: false, warnings: [] },
  lastWebhook = {},
  channels = {},
  ignoredWebhooks = {},
  ai = {}
} = {}) {
  const reasons = [];
  if (!dataDir || dataDir.ok !== true) {
    reasons.push(`data_dir: ${(dataDir && dataDir.error) || 'écriture impossible'}`);
  }
  if (!sqlite || sqlite.ok !== true) {
    reasons.push(`sqlite: ${(sqlite && sqlite.error) || 'indisponible'}`);
  }
  const missing = Object.entries((config && config.required) || {})
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (config && config.enforce && missing.length) {
    reasons.push(`config: ${missing.join(', ')} manquant(s)`);
  }

  const status = reasons.length ? 'degraded' : 'ok';
  const lastAny = Number(lastWebhook.any) || 0;
  const lastWhatsApp = Number(lastWebhook.whatsapp) || 0;

  return {
    httpStatus: reasons.length ? 503 : 200,
    body: {
      status,
      ...(reasons.length ? { reasons } : {}),
      service,
      version,
      commit: commit || null,
      uptime_s: startedAtMs > 0 ? Math.max(0, Math.round((nowMs - startedAtMs) / 1000)) : null,
      ...ai,
      channels,
      checks: {
        data_dir: dataDir,
        sqlite,
        config: {
          ok: missing.length === 0,
          ...(missing.length ? { missing } : {}),
          ...(config && Array.isArray(config.warnings) && config.warnings.length ? { warnings: config.warnings } : {})
        },
        last_webhook: {
          at: isoOrNull(lastAny),
          age_s: ageSeconds(lastAny, nowMs),
          whatsapp_at: isoOrNull(lastWhatsApp),
          whatsapp_age_s: ageSeconds(lastWhatsApp, nowMs)
        },
        ...(Object.keys(ignoredWebhooks || {}).length ? { ignored_webhooks: ignoredWebhooks } : {})
      },
      timestamp: new Date(nowMs).toISOString()
    }
  };
}

module.exports = {
  createDataDirProbe,
  buildHealthReport
};
