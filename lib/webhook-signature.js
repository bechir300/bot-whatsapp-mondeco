// ============================================================
// MONDECO — signature des webhooks Meta (X-Hub-Signature-256)
// lib/webhook-signature.js
//
// V6.45 — Politique « signature obligatoire » :
// - pour chaque canal couvert par un App Secret (META_APP_SECRET ou le
//   secret du canal), la signature est OBLIGATOIRE par défaut : un webhook
//   invalide ou non signé est refusé (401) ; un canal sans secret reste
//   accepté (alerte au démarrage nommant ce canal) ;
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

const WEBHOOK_CHANNELS = ['whatsapp', 'instagram', 'facebook'];
const OBJECT_CHANNELS = {
  whatsapp_business_account: 'whatsapp',
  instagram: 'instagram',
  page: 'facebook'
};

// secrets : { whatsapp: '...', instagram: '...', facebook: '...', meta: '...' }
//
// V6.45 — Par défaut (WEBHOOK_SIGNATURE_REQUIRED absent), la signature est
// obligatoire canal par canal : pour chaque canal couvert par un secret
// (le sien ou META_APP_SECRET). Avant, un seul INSTAGRAM_APP_SECRET rendait
// la signature obligatoire partout et TOUS les webhooks WhatsApp (canal
// sans secret) étaient refusés.
function resolveWebhookSignaturePolicy({ envValue, secrets = {} } = {}) {
  const has = name => Boolean(String(secrets?.[name] || '').trim());
  const configuredChannels = Object.keys(secrets || {}).filter(has);
  const explicit = parseBooleanEnv(envValue);
  const anySecret = configuredChannels.length > 0;
  const coveredChannels = WEBHOOK_CHANNELS.filter(channel => has(channel) || has('meta'));
  const uncoveredChannels = anySecret
    ? WEBHOOK_CHANNELS.filter(channel => !coveredChannels.includes(channel))
    : [];
  // Signature exigée pour un webhook de cet objet Meta (« page »,
  // « instagram », « whatsapp_business_account », autre).
  const requiredForObject = object => {
    if (explicit !== null) return explicit;
    const channel = OBJECT_CHANNELS[String(object || '')];
    if (!channel) return anySecret;
    return coveredChannels.includes(channel);
  };
  return {
    required: explicit === null ? anySecret : explicit,
    requiredForObject,
    explicit,
    anySecret,
    configuredChannels,
    coveredChannels,
    uncoveredChannels,
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
    const uncovered = Array.isArray(policy.uncoveredChannels) ? policy.uncoveredChannels : [];
    const covered = Array.isArray(policy.coveredChannels) ? policy.coveredChannels : [];
    messages.push({
      level: 'log',
      text: `🔐 Signature des webhooks Meta obligatoire${covered.length ? ` pour : ${covered.join(', ')}` : ''} (secrets : ${policy.configuredChannels.join(', ')}).`
    });
    if (uncovered.length && policy.explicit === true) {
      messages.push({
        level: 'error',
        text: `❌ WEBHOOK_SIGNATURE_REQUIRED=true sans App Secret pour : ${uncovered.join(', ')} — TOUS les webhooks de ce(s) canal(aux) seront refusés. Ajoutez META_APP_SECRET ou le secret du canal.`
      });
    } else if (uncovered.length) {
      messages.push({
        level: 'error',
        text: `⚠️ SÉCURITÉ : aucun App Secret pour : ${uncovered.join(', ')} — leurs webhooks sont acceptés SANS vérification de signature. Ajoutez META_APP_SECRET (ou le secret du canal).`
      });
    }
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
