// ============================================================
// MONDECO — indicateurs de performance (KPI)
// lib/kpi.js
//
// Calcule les indicateurs d'une journée à partir des événements de
// conversation (conversation-events/*.jsonl). Le résultat ne contient que
// des agrégats (aucun numéro, nom ni texte de message) : il peut être
// conservé durablement, alors que les événements bruts ne sont gardés que
// quelques jours.
// ============================================================

const KPI_SCHEMA_VERSION = 1;

// Actions qui signifient « l'IA passe la main à un commercial ».
const HANDOFF_ACTIONS = new Set([
  'ai_needs_commercial',
  'commercial_required',
  'ai_error_no_reply',
  'ai_error_fallback_sent',
  'secure_image_commercial_required',
  'secure_image_analysis_error',
  'image_analysis_error',
  'human_pause'
]);

// Intention de visite : showroom, adresse, villes des showrooms, arabe/tunisien.
const SHOWROOM_INTENT_PATTERN =
  /showroom|show-room|magasin|adresse|localisation|visite[rz]?\b|soukra|sfax|ezzahra|sousse|وين|فين|العنوان|المعرض|الماقازة|الحانوت/i;

const PRICE_INTENT_PATTERN =
  /prix|combien|tarif|coût|cout|بقداش|قداش|السوم|الثمن|سعر/i;

function text(value) {
  return String(value ?? '').trim();
}

function timeMs(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : NaN;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeDurations(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, medianSeconds: null, p90Seconds: null, averageSeconds: null };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    medianSeconds: Math.round(percentile(sorted, 50) / 1000),
    p90Seconds: Math.round(percentile(sorted, 90) / 1000),
    averageSeconds: Math.round(total / sorted.length / 1000)
  };
}

function isOutbound(entry) {
  const action = text(entry?.action);
  if (entry?.reply_sent === false) return false;
  if (!text(entry?.reply)) return false;
  return action === 'ai_reply' ||
    action === 'commercial_reply' ||
    text(entry?.source).startsWith('commercial') ||
    text(entry?.sender_kind) === 'human' ||
    text(entry?.sender_kind) === 'ai';
}

function responderKind(entry) {
  const action = text(entry?.action);
  if (action === 'commercial_reply' || text(entry?.source).startsWith('commercial') || text(entry?.sender_kind) === 'human') {
    return 'human';
  }
  return 'ai';
}

// entries : événements d'une journée (tous canaux). Renvoie des agrégats.
function computeDailyKpis(entries = [], { date = '' } = {}) {
  const byContact = new Map();
  for (const entry of entries) {
    const contact = text(entry?.contact);
    if (!contact || !Number.isFinite(timeMs(entry?.time))) continue;
    if (!byContact.has(contact)) byContact.set(contact, []);
    byContact.get(contact).push(entry);
  }

  const delays = { all: [], ai: [], human: [] };
  const firstResponse = [];
  const channels = {};
  const handoffReasons = {};
  let inboundMessages = 0;
  let aiReplies = 0;
  let humanReplies = 0;
  let conversations = 0;
  let aiResolved = 0;
  let handedOff = 0;
  let unanswered = 0;
  let fromAds = 0;
  let showroomIntent = 0;
  let priceIntent = 0;

  for (const list of byContact.values()) {
    list.sort((a, b) => timeMs(a.time) - timeMs(b.time));

    let hasInbound = false;
    let hasAiReply = false;
    let hasHumanReply = false;
    let hasHandoff = false;
    let waitingSince = null;
    let firstResponseRecorded = false;
    let channel = '';
    let ad = false;
    let showroom = false;
    let price = false;

    for (const entry of list) {
      const action = text(entry.action);
      const incoming = text(entry.incoming);
      channel = channel || text(entry.channel) || 'whatsapp';
      if (text(entry.source) === 'meta_ad' || entry.ad_referral) ad = true;

      if (HANDOFF_ACTIONS.has(action)) {
        hasHandoff = true;
        handoffReasons[action] = (handoffReasons[action] || 0) + 1;
      }

      if (incoming && text(entry.sender_kind) !== 'human') {
        hasInbound = true;
        inboundMessages++;
        if (SHOWROOM_INTENT_PATTERN.test(incoming)) showroom = true;
        if (PRICE_INTENT_PATTERN.test(incoming)) price = true;

        // Une entrée qui contient à la fois le message client et la réponse
        // IA n'a une heure de réception fiable que si incoming_at est présent
        // (ajouté en V6.39). Sinon le délai n'est pas mesurable.
        const combined = Boolean(text(entry.reply));
        const receivedMs = timeMs(entry.incoming_at || (combined ? '' : entry.time));
        if (waitingSince === null) waitingSince = Number.isFinite(receivedMs) ? receivedMs : 'unknown';
      }

      if (isOutbound(entry)) {
        const kind = responderKind(entry);
        if (kind === 'human') { humanReplies++; hasHumanReply = true; } else { aiReplies++; hasAiReply = true; }

        if (waitingSince !== null) {
          if (waitingSince !== 'unknown') {
            const delay = Math.max(0, timeMs(entry.time) - waitingSince);
            delays.all.push(delay);
            delays[kind].push(delay);
            if (!firstResponseRecorded) firstResponse.push(delay);
          }
          firstResponseRecorded = true;
          waitingSince = null;
        }
      }
    }

    if (!hasInbound) continue;
    conversations++;
    channels[channel] = (channels[channel] || 0) + 1;
    if (ad) fromAds++;
    if (showroom) showroomIntent++;
    if (price) priceIntent++;
    if (hasHandoff || hasHumanReply) handedOff++;
    if (hasAiReply && !hasHandoff && !hasHumanReply) aiResolved++;
    if (waitingSince !== null) unanswered++;
  }

  const ratio = (part, total) => (total ? Math.round((part / total) * 1000) / 10 : null);

  return {
    schema: KPI_SCHEMA_VERSION,
    date,
    conversations,
    inboundMessages,
    aiReplies,
    humanReplies,
    aiResolved,
    handedOff,
    unanswered,
    fromAds,
    showroomIntent,
    priceIntent,
    aiResolutionRate: ratio(aiResolved, conversations),
    handoffRate: ratio(handedOff, conversations),
    unansweredRate: ratio(unanswered, conversations),
    responseTime: summarizeDurations(delays.all),
    firstResponseTime: summarizeDurations(firstResponse),
    aiResponseTime: summarizeDurations(delays.ai),
    humanResponseTime: summarizeDurations(delays.human),
    channels,
    handoffReasons
  };
}

// Additionne plusieurs journées. Les médianes ne s'additionnent pas : on
// garde une moyenne pondérée des moyennes et la pire valeur P90.
function combineKpis(days = []) {
  const sumKeys = ['conversations', 'inboundMessages', 'aiReplies', 'humanReplies', 'aiResolved', 'handedOff', 'unanswered', 'fromAds', 'showroomIntent', 'priceIntent'];
  const total = Object.fromEntries(sumKeys.map(key => [key, 0]));
  const channels = {};
  const handoffReasons = {};
  const timing = {};

  for (const day of days) {
    for (const key of sumKeys) total[key] += Number(day?.[key] || 0);
    for (const [key, value] of Object.entries(day?.channels || {})) channels[key] = (channels[key] || 0) + value;
    for (const [key, value] of Object.entries(day?.handoffReasons || {})) handoffReasons[key] = (handoffReasons[key] || 0) + value;
    for (const metric of ['responseTime', 'firstResponseTime', 'aiResponseTime', 'humanResponseTime']) {
      const item = day?.[metric];
      if (!item?.count) continue;
      const acc = timing[metric] || (timing[metric] = { count: 0, weighted: 0, p90Seconds: 0 });
      acc.count += item.count;
      acc.weighted += item.averageSeconds * item.count;
      acc.p90Seconds = Math.max(acc.p90Seconds, item.p90Seconds || 0);
    }
  }

  const ratio = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
  const timingOut = metric => {
    const acc = timing[metric];
    return acc
      ? { count: acc.count, averageSeconds: Math.round(acc.weighted / acc.count), p90Seconds: acc.p90Seconds }
      : { count: 0, averageSeconds: null, p90Seconds: null };
  };

  return {
    ...total,
    aiResolutionRate: ratio(total.aiResolved, total.conversations),
    handoffRate: ratio(total.handedOff, total.conversations),
    unansweredRate: ratio(total.unanswered, total.conversations),
    responseTime: timingOut('responseTime'),
    firstResponseTime: timingOut('firstResponseTime'),
    aiResponseTime: timingOut('aiResponseTime'),
    humanResponseTime: timingOut('humanResponseTime'),
    channels,
    handoffReasons
  };
}

module.exports = {
  KPI_SCHEMA_VERSION,
  HANDOFF_ACTIONS,
  computeDailyKpis,
  combineKpis
};
