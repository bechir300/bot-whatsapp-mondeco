// ============================================================
// MONDECO — règles des envois automatiques (fonctions pures, testables)
// lib/messaging-rules.js
//
// V6.45 — Regroupe les décisions « l'IA peut-elle écrire à ce client ? »
// utilisées par server.js, pour qu'elles soient identiques partout (réponse
// IA, relance automatique, réponse groupée aux non-lus) et identiques au
// badge « IA en pause » de l'Inbox (Admin.html, conversationAiPausedForUi).
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// V6.45 — Prédicat UNIQUE « l'IA est en pause pour cette conversation » :
// - prise en main par un commercial (manualTakeover) : sans échéance, levée
//   uniquement par « Réactiver IA » ;
// - pause humaine (humanPaused) : sans échéance (handoff décidé par l'IA,
//   levé par « Réactiver IA », une réponse commerciale ou la reprise
//   automatique à l'expiration du SLA, affichée dans l'historique), ou
//   jusqu'à pausedUntil (réponse depuis WhatsApp Business).
// commercialAttention (« ⚠ Commercial requis ») est une alerte affichée à
// part : elle ne met pas l'IA en pause à elle seule (comportement inchangé
// pour les conversations existantes).
// Renvoie la raison de la pause, ou '' si l'IA peut répondre.
function conversationAiPauseReason(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') return '';
  if (state.manualTakeover === true) return 'manual_takeover';
  if (state.humanPaused === true) {
    const rawPausedUntil = text(state.pausedUntil);
    const until = Date.parse(rawPausedUntil);
    // Sans échéance (ou échéance illisible) : pause indéfinie.
    if (!rawPausedUntil || !Number.isFinite(until) || until > nowMs) return 'human_pause';
  }
  return '';
}

// Heure d'envoi du message client (timestamp Meta, en secondes).
function inboundMessageTimeMs(message, nowMs = Date.now()) {
  const raw = Number(message?.timestamp || 0);
  if (Number.isFinite(raw) && raw > 0) return raw > 1e12 ? raw : raw * 1000;
  return nowMs;
}

// V6.45 — Relance automatique : raison de NE PAS relancer, ou ''.
// - jamais quand un commercial a la main (même règle que l'Inbox) ;
// - une relance par client et par 24 h au plus ;
// - jamais hors de la fenêtre WhatsApp de 24 h depuis le dernier message
//   du client (Meta refuse un message libre : la relance partait puis
//   échouait en silence).
function followUpSkipReason(state, {
  nowMs = Date.now(),
  delayMs = 60 * 60 * 1000,
  maxFollowUps = 1,
  lastFollowUpAtMs = 0,
  windowMarginMs = 10 * 60 * 1000
} = {}) {
  if (!state || typeof state !== 'object') return 'no_state';
  if (!state.awaitingResponse) return 'not_awaiting';
  if (state.humanPaused === true || conversationAiPauseReason(state, nowMs)) return 'paused';
  if (Number(state.followUpsSent || 0) >= maxFollowUps) return 'max_reached';
  if (nowMs - Number(lastFollowUpAtMs || 0) < DAY_MS) return 'throttled';
  const lastBotAt = Date.parse(text(state.lastBotAt));
  if (!Number.isFinite(lastBotAt) || nowMs - lastBotAt < delayMs) return 'too_soon';
  const lastCustomerMs = Date.parse(text(state.lastCustomerAt));
  if (!Number.isFinite(lastCustomerMs) || nowMs - lastCustomerMs > DAY_MS - windowMarginMs) {
    return 'outside_24h_window';
  }
  return '';
}

// V6.45 — Réponse groupée « IA : répondre à tous les non-lus » : clé du
// dernier message non lu (une seule réponse IA par message, même après
// plusieurs clics ou depuis plusieurs postes).
function aiBulkUnreadKey(state) {
  return `${text(state?.lastUnreadMessageId)}|${text(state?.lastCustomerAt)}`;
}

// Raison d'ignorer une conversation pour la réponse groupée, ou ''.
function aiBulkUnreadSkipReason(state, {
  includeTakeovers = false,
  humanSending = false,
  windowExpired = false,
  nowMs = Date.now()
} = {}) {
  if (!state || typeof state !== 'object') return 'no_state';
  if (state.resolved === true) return 'resolved';
  if (Number(state.unreadCount || 0) <= 0) return 'no_unread';
  if (!text(state.lastCustomerText)) return 'no_text';
  const key = aiBulkUnreadKey(state);
  if (text(state.aiBulkAnsweredKey) && state.aiBulkAnsweredKey === key) return 'already_answered';
  // L'IA a déjà jugé ce même message hors de sa portée (transféré).
  if (text(state.aiBulkAttemptedKey) && state.aiBulkAttemptedKey === key) return 'already_attempted';
  const lastCustomerMs = Date.parse(text(state.lastCustomerAt));
  const lastAnswerMs = Math.max(
    Date.parse(text(state.lastHumanAt)) || 0,
    Date.parse(text(state.lastBotAt)) || 0
  );
  if (Number.isFinite(lastCustomerMs) && lastAnswerMs >= lastCustomerMs) return 'already_answered';
  if (!includeTakeovers) {
    // Prise en main par un commercial (Admin) ou réponse depuis WhatsApp
    // Business encore active : on ne force pas la reprise par l'IA.
    if (state.manualTakeover === true) return 'manual_takeover';
    const pausedUntilMs = Date.parse(text(state.pausedUntil));
    if (state.humanPaused === true && Number.isFinite(pausedUntilMs) && pausedUntilMs > nowMs) {
      return 'manual_takeover';
    }
  }
  if (humanSending) return 'human_sending';
  if (windowExpired) return 'outside_24h_window';
  return '';
}

// V6.45 — Contenu lisible des médias sans traitement IA (vidéo, document,
// localisation, contact partagé, sticker, message non pris en charge) :
// avant, seul le type était journalisé et le commercial ne voyait rien.
function whatsappMediaSummary(message) {
  const type = text(message?.type);
  if (type === 'video') {
    const caption = text(message?.video?.caption);
    return caption ? `🎬 Vidéo : ${caption}` : '🎬 Vidéo';
  }
  if (type === 'document') {
    const name = text(message?.document?.filename);
    const caption = text(message?.document?.caption);
    return ['📄 Document', name, caption].filter(Boolean).join(' : ');
  }
  if (type === 'location') {
    const location = message?.location || {};
    const coordinates = [location.latitude, location.longitude]
      .filter(value => value !== null && value !== undefined && value !== '')
      .map(value => Number(value))
      .filter(Number.isFinite);
    const label = [text(location.name), text(location.address)].filter(Boolean).join(', ');
    return [
      '📍 Localisation',
      label,
      coordinates.length === 2 ? `${coordinates[0]}, ${coordinates[1]}` : '',
      coordinates.length === 2 ? `https://maps.google.com/?q=${coordinates[0]},${coordinates[1]}` : ''
    ].filter(Boolean).join(' · ');
  }
  if (type === 'contacts') {
    const contacts = Array.isArray(message?.contacts) ? message.contacts : [];
    const parts = contacts.map(contact => {
      const name = text(contact?.name?.formatted_name || contact?.name?.first_name);
      const phones = (Array.isArray(contact?.phones) ? contact.phones : [])
        .map(phone => text(phone?.phone || phone?.wa_id))
        .filter(Boolean)
        .join(', ');
      return [name, phones].filter(Boolean).join(' ');
    }).filter(Boolean);
    return parts.length ? `👤 Contact partagé : ${parts.join(' ; ')}` : '👤 Contact partagé';
  }
  if (type === 'sticker') return '😊 Sticker';
  if (type === 'unsupported') {
    return '⚠️ Message non pris en charge par l’API WhatsApp : à consulter dans l’application WhatsApp Business.';
  }
  return '';
}

module.exports = {
  conversationAiPauseReason,
  inboundMessageTimeMs,
  followUpSkipReason,
  aiBulkUnreadKey,
  aiBulkUnreadSkipReason,
  whatsappMediaSummary
};
