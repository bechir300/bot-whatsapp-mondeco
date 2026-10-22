// ============================================================
// MONDECO — données personnelles dans les logs
// lib/log-privacy.js
// Par défaut, numéros masqués et contenu des messages non écrit.
// LOG_MESSAGE_CONTENT=true réactive le contenu (débogage ponctuel).
// ============================================================

function createLogPrivacy({ logMessageContent = false } = {}) {
  function maskPhoneForLog(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (!digits) return String(value ?? '');
    if (logMessageContent) return digits;
    return `***${digits.slice(-4)}`;
  }

  function messageContentForLog(value) {
    const text = String(value ?? '');
    if (logMessageContent) return text;
    return `[${text.length} caractère(s) masqué(s)]`;
  }

  return { maskPhoneForLog, messageContentForLog };
}

module.exports = {
  createLogPrivacy,
  ...createLogPrivacy({
    logMessageContent:
      String(process.env.LOG_MESSAGE_CONTENT || '').trim().toLowerCase() === 'true'
  })
};
