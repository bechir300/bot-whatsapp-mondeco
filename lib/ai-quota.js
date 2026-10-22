// ============================================================
// MONDECO — quotas IA (maîtrise des coûts)
// lib/ai-quota.js
//
// Au-delà du quota, l'appelant transfère la conversation à un commercial
// sans appel IA payant. 0 désactive la limite correspondante.
// ============================================================

const HOUR_MS = 60 * 60 * 1000;

function createAiQuota({
  maxPerContactPerHour = 30,
  maxPerDay = 5000,
  exemptIds = [],
  maskId = id => id,
  logger = console
} = {}) {
  const exempt = new Set(exemptIds);
  const callsByContact = new Map();
  const warnedContacts = new Set();
  let daily = { day: '', count: 0 };

  const dayKey = now => new Date(now).toISOString().slice(0, 10);

  // Vérifie le quota et, s'il reste de la marge, réserve un appel.
  // Renvoie null si l'appel est autorisé, sinon 'daily_cap' ou 'contact_cap'.
  function reserve(userId, now = Date.now()) {
    const day = dayKey(now);
    if (daily.day !== day) {
      daily = { day, count: 0 };
      warnedContacts.clear();
    }

    if (maxPerDay && daily.count >= maxPerDay) {
      if (daily.count === maxPerDay) {
        daily.count++;
        logger.error(`🚨 Plafond IA quotidien atteint (${maxPerDay} appels) : transfert systématique aux commerciaux jusqu'à minuit UTC.`);
      }
      return 'daily_cap';
    }

    const key = String(userId ?? '');
    if (maxPerContactPerHour && key && !exempt.has(key)) {
      const recent = (callsByContact.get(key) || []).filter(time => time > now - HOUR_MS);

      if (recent.length >= maxPerContactPerHour) {
        callsByContact.set(key, recent);
        if (!warnedContacts.has(key)) {
          warnedContacts.add(key);
          logger.warn(`⚠️ Quota IA atteint pour ${maskId(key)} (${maxPerContactPerHour}/h) : transfert au commercial.`);
        }
        return 'contact_cap';
      }

      recent.push(now);
      callsByContact.set(key, recent);
      warnedContacts.delete(key);
    }

    daily.count++;
    return null;
  }

  function sweep(now = Date.now()) {
    for (const [key, times] of callsByContact.entries()) {
      if (!times.some(time => time > now - HOUR_MS)) callsByContact.delete(key);
    }
  }

  function stats(now = Date.now()) {
    const day = dayKey(now);
    return {
      day,
      callsToday: daily.day === day ? Math.min(daily.count, maxPerDay || daily.count) : 0,
      maxCallsPerDay: maxPerDay,
      maxRepliesPerContactPerHour: maxPerContactPerHour,
      trackedContacts: callsByContact.size
    };
  }

  return { reserve, sweep, stats };
}

module.exports = { createAiQuota };
