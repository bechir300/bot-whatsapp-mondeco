// ============================================================
// MONDECO — envoi du token Meta aux seuls hôtes Meta autorisés
// lib/meta-token-host.js
//
// V6.45 — Les téléchargements de médias (pièces jointes WhatsApp /
// Instagram / Messenger, visuels de publicités) envoyaient le token Meta
// (en-tête Authorization: Bearer …) à N'IMPORTE QUEL hôte indiqué dans le
// webhook ou dans la réponse Graph. Les liens CDN (fbcdn.net,
// cdninstagram.com) sont déjà signés et n'en ont pas besoin : le token ne
// part plus que vers l'API Graph et les hôtes « lookaside » de Meta, en
// HTTPS. Un hôte supplémentaire peut être autorisé sans déploiement via
// META_TOKEN_EXTRA_HOSTS (liste séparée par des virgules, noms exacts).
// ============================================================

const DEFAULT_META_TOKEN_HOSTS = Object.freeze([
  'graph.facebook.com',
  'graph.instagram.com',
  'lookaside.fbsbx.com',
  'lookaside.instagram.com'
]);

function parseHostList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase().replace(/\.$/, ''))
    .filter(item => /^[a-z0-9.-]+$/.test(item) && item.includes('.'));
}

function metaTokenHosts(env = process.env) {
  return new Set([...DEFAULT_META_TOKEN_HOSTS, ...parseHostList(env?.META_TOKEN_EXTRA_HOSTS)]);
}

let cachedHosts = null;

// Vrai si le token Meta peut être joint à une requête vers cette URL :
// HTTPS, port standard, sans identifiants dans l'URL, hôte exact autorisé.
function canSendMetaToken(url, { hosts } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;
  const allowed = hosts || (cachedHosts = cachedHosts || metaTokenHosts());
  return allowed.has(parsed.hostname.toLowerCase().replace(/\.$/, ''));
}

// En-têtes d'un téléchargement : Authorization seulement vers un hôte
// autorisé.
function metaMediaHeaders(url, token, extra = {}) {
  const headers = { ...extra };
  if (token && canSendMetaToken(url)) headers.Authorization = `Bearer ${token}`;
  return headers;
}

module.exports = {
  DEFAULT_META_TOKEN_HOSTS,
  metaTokenHosts,
  canSendMetaToken,
  metaMediaHeaders
};
