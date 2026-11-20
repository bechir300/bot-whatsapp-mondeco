// ============================================================
// MONDECO — journal des messages entrants non encore traités
// lib/inbound-journal.js
//
// V6.45 — Meta reçoit 200 AVANT le traitement d'un message (il ne le
// renverra jamais) et le message n'était journalisé qu'à la FIN du
// traitement (réponse IA envoyée). Un redémarrage, un déploiement ou un
// plantage pendant la génération IA faisait donc disparaître le message,
// sans trace dans l'Inbox. Chaque message est maintenant inscrit ici, de
// façon synchrone, avant tout traitement, puis marqué « terminé ». Au
// démarrage, les messages restés en attente sont rejoués (ou, trop anciens,
// présentés au commercial).
//
// Format : une ligne JSON par événement (append-only), compacté au
// démarrage et périodiquement.
//   {"t":"in","id":"wamid…","at":"…","payload":{…}}
//   {"t":"done","id":"wamid…"}
// ============================================================

const fs = require('fs');
const path = require('path');

function createInboundJournal({
  filePath,
  compactEvery = 500,
  logger = console
} = {}) {
  if (!filePath) throw new Error('filePath requis');
  let doneSinceCompact = 0;

  function append(record) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch (error) {
      logger.error('❌ Journal des messages entrants :', error.message);
      return false;
    }
  }

  function readAll() {
    const pending = new Map();
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') logger.error('❌ Lecture du journal des messages entrants :', error.message);
      return pending;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const id = String(record?.id || '');
      if (!id) continue;
      if (record.t === 'in') {
        if (!pending.has(id)) pending.set(id, record);
      } else if (record.t === 'done') {
        pending.delete(id);
      }
    }
    return pending;
  }

  // Inscrit un message reçu (synchrone : appelé avant tout await).
  function record(id, payload) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return false;
    return append({ t: 'in', id: cleanId, at: new Date().toISOString(), payload });
  }

  function done(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return false;
    const ok = append({ t: 'done', id: cleanId });
    doneSinceCompact += 1;
    if (doneSinceCompact >= compactEvery) compact();
    return ok;
  }

  function pending() {
    return [...readAll().values()];
  }

  // Réécrit le fichier avec les seuls messages encore en attente.
  function compact() {
    doneSinceCompact = 0;
    try {
      const keep = pending();
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, keep.map(item => JSON.stringify(item)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
      fs.renameSync(tempPath, filePath);
      return keep.length;
    } catch (error) {
      logger.error('❌ Compactage du journal des messages entrants :', error.message);
      return -1;
    }
  }

  return { record, done, pending, compact };
}

module.exports = { createInboundJournal };
