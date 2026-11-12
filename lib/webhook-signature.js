// ============================================================
// MONDECO — signature des webhooks Meta (X-Hub-Signature-256)
// lib/webhook-signature.js
//
// V6.45 — Politique « signature obligatoire » :
// - dès qu'un App Secret est configuré (META_APP_SECRET ou un secret par
//   canal), la signature est OBLIGATOIRE par défaut : un webhook invalide,
//   non signé, ou d'un canal sans secret est refusé (401) ;
// - sans aucun secret, les webhooks restent acceptés (compatibilité) mais
//   un avertissement bien visible est écrit au démarrage ;
// - WEBHOOK_SIGNATURE_REQUIRED=false : désactivation explicite (urgence),
//   les canaux sans secret sont acceptés sans vérification ; une signature
//   présente mais fausse reste toujours refusée ;
// - WEBHOOK_SIGNATURE_REQUIRED=true : obligatoire même sans secret (tous
//   les webhooks sont alors refusés tant que le secret manque).
// ============================================================

const crypto = require('crypto');

function parseBooleanEnv(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (['true', '1', 'yes', 'oui', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'non', 'off'].includes(raw)) return false;
  return null;
}

// secrets : { whatsapp: '...', instagram: '...', facebook: '...', meta: '...' }
function resolveWebhookSignaturePolicy({ envValue, secrets = {} } = {}) {
  const configuredChannels = Object.entries(secrets || {})
    .filter(([, value]) => String(value || '').trim())
    .map(([name]) => name);
  const explicit = parseBooleanEnv(envValue);
  const anySecret = configuredChannels.length > 0;
  return {
    required: explicit === null ? anySecret : explicit,
    explicit,
    anySecret,
    configuredChannels,
    source: explicit === null ? 'default' : 'env'
  };
}

// Renvoie true (valide), false (invalide ou absente) ou null (aucun secret).
function verifyMetaSignature(rawBody, header, secret) {
  const appSecret = String(secret || '').trim();
  if (!appSecret) return null;

  const received = String(header || '').trim();
  if (!received.startsWith('sha256=')) return false;
  if (!Buffer.isBuffer(rawBody)) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex')}`;

  try {
    const left = Buffer.from(received, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

// Décision finale pour un webhook : { accept, status, reason }.
function webhookSignatureDecision({ signatureValid, required }) {
  if (signatureValid === true) return { accept: true, status: 200, reason: 'valid' };
  if (signatureValid === false) return { accept: false, status: 401, reason: 'invalid' };
  if (required) return { accept: false, status: 401, reason: 'no_secret' };
  return { accept: true, status: 200, reason: 'unsigned' };
}

// Messages de démarrage (aucun secret n'est jamais écrit dans les logs).
function webhookSignatureStartupMessages(policy) {
  const messages = [];
  if (!policy.anySecret && policy.required) {
    messages.push({
      level: 'error',
      text: '❌ WEBHOOK_SIGNATURE_REQUIRED=true mais aucun App Secret Meta n’est configuré : TOUS les webhooks Meta seront refusés. Ajoutez META_APP_SECRET.'
    });
  } else if (!policy.anySecret) {
    messages.push({
      level: 'error',
      text:
        '⚠️⚠️⚠️ SÉCURITÉ : aucun App Secret Meta (META_APP_SECRET) n’est configuré. ' +
        'Les webhooks /webhook sont acceptés SANS vérification de signature : n’importe qui peut ' +
        'injecter de faux messages clients. Ajoutez META_APP_SECRET (Meta > Paramètres de l’app > ' +
        'Clé secrète) : la signature deviendra obligatoire automatiquement.'
    });
  } else if (policy.explicit === false) {
    messages.push({
      level: 'warn',
      text: '⚠️ WEBHOOK_SIGNATURE_REQUIRED=false : désactivation d’urgence, les canaux sans App Secret sont acceptés sans signature. Retirez cette variable dès que possible.'
    });
  } else {
    messages.push({
      level: 'log',
      text: `🔐 Signature des webhooks Meta obligatoire (secrets : ${policy.configuredChannels.join(', ')}).`
    });
  }
  return messages;
}

// V6.45 — Numéro WhatsApp visé par le webhook (value.metadata.phone_number_id).
// Avant, la vérification était sautée quand le champ manquait : un faux
// webhook sans metadata passait. Désormais, si PHONE_NUMBER_ID est
// configuré, un webhook « messages » doit porter exactement ce numéro
// (Meta l'envoie toujours) ; pour les autres champs (appels, échos de
// l'application WhatsApp Business), seul un numéro différent est refusé.
function whatsappPhoneNumberIdAccepted({ configured, incoming, requirePresence = true } = {}) {
  const expected = String(configured || '').trim();
  const received = String(incoming || '').trim();
  if (!expected) return true;
  if (!received) return !requirePresence;
  return received === expected;
}

module.exports = {
  whatsappPhoneNumberIdAccepted,
  parseBooleanEnv,
  resolveWebhookSignaturePolicy,
  verifyMetaSignature,
  webhookSignatureDecision,
  webhookSignatureStartupMessages
};
