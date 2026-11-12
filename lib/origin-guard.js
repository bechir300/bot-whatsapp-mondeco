// ============================================================
// MONDECO — origine des requêtes d'administration (CSRF) et proxy
// lib/origin-guard.js
//
// V6.45 — Le cookie de session (SameSite=Lax) ne protège pas contre une
// page d'un autre sous-domaine du même site (ex. *.mondeco.tn) qui
// soumettrait un formulaire vers /admin. Toute requête qui modifie des
// données (POST, PUT, PATCH, DELETE) doit donc venir de l'application
// elle-même :
// - en-tête Origin (ou, à défaut, Referer) dont le nom d'hôte est celui de
//   l'application (en-tête Host ou X-Forwarded-Host), ou listé dans
//   ADMIN_ALLOWED_ORIGINS / PUBLIC_BASE_URL ;
// - ou Sec-Fetch-Site: same-origin (en-tête posé par le navigateur, non
//   falsifiable par une page web), utile si un proxy réécrit l'en-tête Host ;
// - ou l'en-tête propre à l'application X-Mondeco-Client (envoyé par
//   apiFetch) : une page d'une autre origine ne peut pas l'ajouter sans
//   autorisation CORS préalable, que le serveur n'accorde jamais. Il couvre
//   un proxy qui réécrit Host avec un navigateur ancien (sans Sec-Fetch-Site) ;
// - une requête sans aucune de ces informations est refusée (les
//   navigateurs les envoient toujours) ; les webhooks serveur à serveur
//   signés (WooCommerce) sont exemptés explicitement.
// ADMIN_ORIGIN_CHECK=report : journalise sans bloquer ; off : désactivé.
// ============================================================

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const APP_CLIENT_HEADER = 'x-mondeco-client';

function hostnameOf(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'null') return '';
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(`http://${raw}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function headerValues(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function parseOriginCheckMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['off', 'false', '0', 'disabled', 'non'].includes(raw)) return 'off';
  if (['report', 'log', 'warn', 'report-only'].includes(raw)) return 'report';
  return 'enforce';
}

function originGuardOptionsFromEnv(env = process.env, extra = {}) {
  const allowedHosts = [
    ...headerValues(env.ADMIN_ALLOWED_ORIGINS),
    env.PUBLIC_BASE_URL
  ]
    .map(hostnameOf)
    .filter(Boolean);
  return {
    mode: parseOriginCheckMode(env.ADMIN_ORIGIN_CHECK),
    allowedHosts,
    ...extra
  };
}

// Renvoie { ok, reason, host } sans effet de bord.
function evaluateRequestOrigin(req, { allowedHosts = [], exemptPaths = [] } = {}) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true, reason: 'safe_method', host: '' };

  const requestPath = String(req?.path || '');
  if (exemptPaths.includes(requestPath)) return { ok: true, reason: 'exempt', host: '' };

  const headers = req?.headers || {};
  const fetchSite = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  const ownHosts = new Set([
    hostnameOf(headers.host),
    ...headerValues(headers['x-forwarded-host']).map(hostnameOf),
    ...allowedHosts.map(hostnameOf)
  ].filter(Boolean));

  const originHeader = String(headers.origin || '').trim();
  const refererHeader = String(headers.referer || headers.referrer || '').trim();
  const sourceHost = originHeader && originHeader !== 'null'
    ? hostnameOf(originHeader)
    : (!originHeader ? hostnameOf(refererHeader) : '');

  if (sourceHost && ownHosts.has(sourceHost)) {
    return { ok: true, reason: originHeader ? 'origin' : 'referer', host: sourceHost };
  }

  // Le navigateur indique lui-même une requête de la même origine (cas d'un
  // proxy qui ne transmet pas l'en-tête Host d'origine).
  if (fetchSite === 'same-origin') {
    return { ok: true, reason: 'fetch_metadata', host: sourceHost };
  }

  // Le navigateur atteste une autre origine : refus, même avec l'en-tête
  // de l'application (défense en profondeur si un CORS apparaissait un jour).
  if (fetchSite === 'same-site' || fetchSite === 'cross-site') {
    return { ok: false, reason: 'foreign_origin', host: sourceHost || fetchSite };
  }

  // En-tête personnalisé : impossible à poser depuis une autre origine sans
  // pré-vérification CORS (jamais accordée par ce serveur).
  if (String(headers[APP_CLIENT_HEADER] || '').trim()) {
    return { ok: true, reason: 'app_header', host: sourceHost };
  }

  if (sourceHost || originHeader === 'null') {
    return { ok: false, reason: 'foreign_origin', host: sourceHost || 'null' };
  }

  return { ok: false, reason: 'missing_origin', host: '' };
}

function createOriginGuard({
  mode = 'enforce',
  allowedHosts = [],
  exemptPaths = [],
  label = 'admin',
  logger = console,
  logIntervalMs = 60 * 1000
} = {}) {
  const lastLogAt = new Map();

  return function originGuard(req, res, next) {
    if (mode === 'off') return next();
    const verdict = evaluateRequestOrigin(req, { allowedHosts, exemptPaths });
    if (verdict.ok) return next();

    const key = `${verdict.reason}|${req.method}|${req.path}`;
    const now = Date.now();
    if (now - (lastLogAt.get(key) || 0) >= logIntervalMs) {
      lastLogAt.set(key, now);
      if (lastLogAt.size > 500) lastLogAt.clear();
      logger.warn(
        `🛡️ Requête ${req.method} ${req.originalUrl || req.path} ${mode === 'report' ? 'signalée' : 'refusée'} (${label}) : ` +
        `origine ${verdict.host || 'absente'} non autorisée (${verdict.reason}).`
      );
    }

    if (mode === 'report') return next();
    return res.status(403).json({
      error: 'Requête refusée : elle ne provient pas du centre de pilotage MONDECO (protection CSRF). Rechargez la page puis réessayez.',
      errorCode: 'CSRF_ORIGIN_REJECTED'
    });
  };
}

// V6.45 — Routes de diagnostic en GET qui consomment des ressources (ex.
// /test-ia : un appel IA facturé). La vérification d'origine ci-dessus ne
// concerne que les méthodes d'écriture ; ici, une requête que le navigateur
// déclare venir d'un autre site (Sec-Fetch-Site: same-site / cross-site,
// ex. <img src> sur *.mondeco.tn) est refusée. Saisie directe de l'adresse
// (none), même origine ou client sans cet en-tête : acceptés.
function createCrossSiteGetGuard({ label = 'diagnostic', logger = console } = {}) {
  return function crossSiteGetGuard(req, res, next) {
    const fetchSite = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
    if (fetchSite !== 'same-site' && fetchSite !== 'cross-site') return next();
    logger.warn(`🛡️ Requête ${req.method} ${req.originalUrl || req.path} refusée (${label}) : appel depuis un autre site (${fetchSite}).`);
    return res.status(403).json({
      error: 'Requête refusée : ouvrez cette adresse directement depuis le navigateur.',
      errorCode: 'CSRF_CROSS_SITE_REJECTED'
    });
  };
}

// ------------------------------------------------------------
// trust proxy (adresse IP réelle des clients)
// ------------------------------------------------------------

function isRailwayEnvironment(env = process.env) {
  return Boolean(
    String(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || '').trim()
  );
}

function resolveTrustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const hops = Math.max(0, Number(raw) || 0);
    return { value: hops, source: 'env', label: `${hops} proxy(s) de confiance (TRUST_PROXY_HOPS)` };
  }
  if (isRailwayEnvironment(env)) {
    return { value: 1, source: 'railway', label: '1 proxy de confiance (Railway détecté, TRUST_PROXY_HOPS non défini)' };
  }
  return { value: 'loopback', source: 'default', label: 'proxys locaux uniquement (Nginx sur la même machine)' };
}

function isLoopbackAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

// Avertit (une fois par heure au plus) si des requêtes arrivent d'un proxy
// distant alors que seuls les proxys locaux sont crus : toutes les
// connexions partagent alors la même adresse IP (limite de connexion).
function createRemoteProxyDetector({ logger = console, intervalMs = 60 * 60 * 1000 } = {}) {
  let lastWarnAt = 0;
  return function remoteProxyDetector(req, res, next) {
    if (req.headers['x-forwarded-for']) {
      const remote = req.socket?.remoteAddress || '';
      const now = Date.now();
      if (remote && !isLoopbackAddress(remote) && now - lastWarnAt >= intervalMs) {
        lastWarnAt = now;
        logger.warn(
          '⚠️ Requête reçue via un proxy distant alors que TRUST_PROXY_HOPS n’est pas défini : ' +
          'toutes les connexions semblent venir de la même adresse IP (limite de connexion partagée par toute l’équipe). ' +
          'Définissez TRUST_PROXY_HOPS=1 (nombre de proxys devant l’application).'
        );
      }
    }
    next();
  };
}

module.exports = {
  APP_CLIENT_HEADER,
  createCrossSiteGetGuard,
  hostnameOf,
  parseOriginCheckMode,
  originGuardOptionsFromEnv,
  evaluateRequestOrigin,
  createOriginGuard,
  isRailwayEnvironment,
  resolveTrustProxySetting,
  isLoopbackAddress,
  createRemoteProxyDetector
};
