// V6.45 — Règles des envois automatiques (lib/messaging-rules.js) : pause
// IA identique au badge de l'Inbox, relances (24 h, fenêtre WhatsApp),
// réponse groupée aux non-lus (idempotente, prises en main respectées),
// contenu des médias conservé.
const assert = require('assert');
const {
  conversationAiPauseReason,
  inboundMessageTimeMs,
  followUpSkipReason,
  aiBulkUnreadKey,
  aiBulkUnreadSkipReason,
  whatsappMediaSummary
} = require('../lib/messaging-rules');

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const minutesAgo = minutes => new Date(NOW - minutes * 60 * 1000).toISOString();
const minutesLater = minutes => new Date(NOW + minutes * 60 * 1000).toISOString();

test('pause IA : prise en main, pause sans échéance ou non expirée', () => {
  assert.strictEqual(conversationAiPauseReason(null, NOW), '');
  assert.strictEqual(conversationAiPauseReason({}, NOW), '');
  assert.strictEqual(conversationAiPauseReason({ manualTakeover: true }, NOW), 'manual_takeover');
  // Handoff IA (V6.45) : sans échéance → pause jusqu'à réactivation / SLA.
  assert.strictEqual(conversationAiPauseReason({ humanPaused: true, pausedUntil: null }, NOW), 'human_pause');
  assert.strictEqual(conversationAiPauseReason({ humanPaused: true, pausedUntil: minutesLater(5) }, NOW), 'human_pause');
  // Pause WhatsApp Business expirée : l'IA peut répondre (badge « IA active »).
  assert.strictEqual(conversationAiPauseReason({ humanPaused: true, pausedUntil: minutesAgo(1) }, NOW), '');
  // Échéance illisible : prudence, pause maintenue.
  assert.strictEqual(conversationAiPauseReason({ humanPaused: true, pausedUntil: 'n/a' }, NOW), 'human_pause');
});

test('pause IA : « Commercial requis » seul ne coupe pas l’IA (données existantes inchangées)', () => {
  assert.strictEqual(conversationAiPauseReason({ commercialAttention: true }, NOW), '');
  assert.strictEqual(conversationAiPauseReason({ imageNeedsCommercial: true }, NOW), '');
  // Handoff IA V6.45 : alerte + pause sans échéance → en pause.
  assert.strictEqual(conversationAiPauseReason({ commercialAttention: true, humanPaused: true, pausedUntil: null }, NOW), 'human_pause');
});

test('heure du message client : timestamp Meta (secondes ou millisecondes)', () => {
  assert.strictEqual(inboundMessageTimeMs({ timestamp: '1794470400' }, NOW), 1794470400 * 1000);
  assert.strictEqual(inboundMessageTimeMs({ timestamp: 1794470400123 }, NOW), 1794470400123);
  assert.strictEqual(inboundMessageTimeMs({}, NOW), NOW);
});

test('régression F18 : relance seulement dans la fenêtre WhatsApp de 24 h', () => {
  const options = { nowMs: NOW, delayMs: 15 * 60 * 1000, maxFollowUps: 3, lastFollowUpAtMs: 0 };
  const base = { awaitingResponse: true, lastBotAt: minutesAgo(60), lastCustomerAt: minutesAgo(70), followUpsSent: 0 };
  assert.strictEqual(followUpSkipReason(base, options), '');
  assert.strictEqual(followUpSkipReason({ ...base, lastCustomerAt: minutesAgo(23 * 60 + 55) }, options), 'outside_24h_window');
  assert.strictEqual(followUpSkipReason({ ...base, lastCustomerAt: minutesAgo(25 * 60) }, options), 'outside_24h_window');
  assert.strictEqual(followUpSkipReason({ ...base, lastCustomerAt: '' }, options), 'outside_24h_window');
});

test('relance : jamais si un commercial a la main, au plus une par 24 h, maximum respecté', () => {
  const options = { nowMs: NOW, delayMs: 15 * 60 * 1000, maxFollowUps: 2, lastFollowUpAtMs: 0 };
  const base = { awaitingResponse: true, lastBotAt: minutesAgo(60), lastCustomerAt: minutesAgo(70), followUpsSent: 0 };
  assert.strictEqual(followUpSkipReason({ ...base, manualTakeover: true }, options), 'paused');
  assert.strictEqual(followUpSkipReason({ ...base, humanPaused: true, pausedUntil: minutesAgo(5) }, options), 'paused');
  assert.strictEqual(followUpSkipReason({ ...base, followUpsSent: 2 }, options), 'max_reached');
  assert.strictEqual(followUpSkipReason(base, { ...options, lastFollowUpAtMs: NOW - 60 * 60 * 1000 }), 'throttled');
  assert.strictEqual(followUpSkipReason({ ...base, lastBotAt: minutesAgo(5) }, options), 'too_soon');
  assert.strictEqual(followUpSkipReason({ ...base, awaitingResponse: false }, options), 'not_awaiting');
});

test('régression F17 : réponse groupée aux non-lus — une seule réponse par message', () => {
  const state = {
    unreadCount: 1,
    lastCustomerText: 'Bonjour',
    lastCustomerAt: minutesAgo(10),
    lastUnreadMessageId: 'wamid.A',
    lastBotAt: minutesAgo(30)
  };
  assert.strictEqual(aiBulkUnreadSkipReason(state, { nowMs: NOW }), '');
  // Après l'envoi : clé mémorisée → second clic sans effet.
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, aiBulkAnsweredKey: aiBulkUnreadKey(state) }, { nowMs: NOW }), 'already_answered');
  // Réponse (IA ou commercial) postérieure au dernier message client.
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, lastBotAt: minutesAgo(1) }, { nowMs: NOW }), 'already_answered');
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, lastHumanAt: minutesAgo(1) }, { nowMs: NOW }), 'already_answered');
  // Transfert déjà décidé par l'IA pour ce même message.
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, aiBulkAttemptedKey: aiBulkUnreadKey(state) }, { nowMs: NOW }), 'already_attempted');
  // Nouveau message du client : la clé change, la réponse est de nouveau possible.
  assert.strictEqual(
    aiBulkUnreadSkipReason({ ...state, aiBulkAnsweredKey: aiBulkUnreadKey(state), lastUnreadMessageId: 'wamid.B', lastCustomerAt: minutesAgo(2) }, { nowMs: NOW }),
    ''
  );
});

test('régression F17 : prises en main respectées, fenêtre de 24 h, envoi commercial en cours', () => {
  const state = { unreadCount: 2, lastCustomerText: 'Prix ?', lastCustomerAt: minutesAgo(10), lastUnreadMessageId: 'wamid.C' };
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, manualTakeover: true }, { nowMs: NOW }), 'manual_takeover');
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, humanPaused: true, pausedUntil: minutesLater(60) }, { nowMs: NOW }), 'manual_takeover');
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, manualTakeover: true }, { nowMs: NOW, includeTakeovers: true }), '');
  assert.strictEqual(aiBulkUnreadSkipReason(state, { nowMs: NOW, windowExpired: true }), 'outside_24h_window');
  assert.strictEqual(aiBulkUnreadSkipReason(state, { nowMs: NOW, humanSending: true }), 'human_sending');
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, resolved: true }, { nowMs: NOW }), 'resolved');
  assert.strictEqual(aiBulkUnreadSkipReason({ ...state, unreadCount: 0 }, { nowMs: NOW }), 'no_unread');
});

test('F19 : contenu des médias conservé (vidéo, document, localisation, contact)', () => {
  assert.strictEqual(whatsappMediaSummary({ type: 'video', video: { caption: 'Mon salon' } }), '🎬 Vidéo : Mon salon');
  assert.strictEqual(whatsappMediaSummary({ type: 'document', document: { filename: 'devis.pdf', caption: 'Voici' } }), '📄 Document : devis.pdf : Voici');
  const location = whatsappMediaSummary({ type: 'location', location: { latitude: 36.8, longitude: 10.18, name: 'Maison' } });
  assert.ok(location.includes('Maison') && location.includes('36.8, 10.18') && location.includes('maps.google.com'));
  assert.strictEqual(
    whatsappMediaSummary({ type: 'contacts', contacts: [{ name: { formatted_name: 'Sami' }, phones: [{ phone: '+216 22 123 456' }] }] }),
    '👤 Contact partagé : Sami +216 22 123 456'
  );
  assert.ok(whatsappMediaSummary({ type: 'unsupported' }).includes('WhatsApp Business'));
  assert.strictEqual(whatsappMediaSummary({ type: 'text', text: { body: 'x' } }), '');
});

console.log(`ALL ${passed} MESSAGING RULES TESTS PASSED`);
