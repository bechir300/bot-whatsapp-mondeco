// MONDECO - Accuse de lecture + indicateur de frappe
const fs = require('fs');
const path = require('path');
// V6.46 — Interrupteur d'arrêt cherché dans le dossier des données
// (DATA_DIR, même règle que server.js) ; l'ancien emplacement /data reste lu.
const DATA_DIR = (
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  __dirname
).trim();
const OFF_FLAGS = [path.join(DATA_DIR, 'read-receipt.off'), '/data/read-receipt.off'];
async function markRead(o) {
  if (OFF_FLAGS.some(file => fs.existsSync(file))) return 'off';
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
      // V6.45 — o.typing === false : accusé de lecture seul, sans
      // « en train d'écrire… » (l'IA ne répondra pas : pause, commercial).
      body: JSON.stringify(Object.assign({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: o.messageId
      }, o.typing === false ? {} : { typing_indicator: { type: 'text' } }))
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
