// MONDECO - Accuse de lecture + indicateur de frappe
const fs = require('fs');
const OFF = '/data/read-receipt.off';
async function markRead(o) {
  if (fs.existsSync(OFF)) return 'off';
  if (!o || !o.messageId || !o.token || !o.phoneNumberId) {
    return 'skip';
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(
      'https://graph.facebook.com/' + o.apiVersion + '/' +
      o.phoneNumberId + '/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        Authorization: 'Bearer ' + o.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: o.messageId,
        typing_indicator: { type: 'text' }
      })
    });
    if (!r.ok) {
      throw new Error('HTTP ' + r.status + ' ' +
        (await r.text()).slice(0, 150));
    }
    return 'ok';
  } finally {
    clearTimeout(t);
  }
}
module.exports = { markRead };
