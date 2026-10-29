'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  readJsonFileSafe,
  writeJsonAtomic,
  sessionIsExpired,
  resolveCommercialSendRecipient,
  getLoginAttemptState,
  registerLoginFailure,
  clearLoginFailures
} = require('./_load-admin');

const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR, 'json-'));

test('un fichier JSON corrompu est mis en quarantaine et restauré depuis .bak', () => {
  const file = path.join(dir, 'state.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  fs.writeFileSync(file, '{"a": 2, tronqué');
  const data = readJsonFileSafe(file, {});
  assert.deepEqual(data, { a: 1 });
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('state.json.corrupt-')));
});

test('sans sauvegarde valide, la valeur de repli est renvoyée sans effacer le fichier', () => {
  const file = path.join(dir, 'seul.json');
  fs.writeFileSync(file, 'pas du json');
  assert.deepEqual(readJsonFileSafe(file, { vide: true }), { vide: true });
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('seul.json.corrupt-')));
});

test('session : expiration absolue et par inactivité', () => {
  const now = Date.now();
  assert.equal(sessionIsExpired(null, now), true);
  assert.equal(sessionIsExpired({ expiresAt: now - 1 }, now), true);
  assert.equal(sessionIsExpired({ expiresAt: now + 3600e3, lastUsedAt: now - 60e3 }, now), false);
  assert.equal(sessionIsExpired({ expiresAt: now + 3600e3 * 48, lastUsedAt: now - 3600e3 * 13 }, now), true);
});

const states = {
  '21698111222': { channel: 'whatsapp', externalContact: '21698111222' },
  'instagram:42': { channel: 'instagram', externalContact: '42' }
};
const deps = { states, loadLog: () => [] };
const commercial = { role: 'commercial' };

test("un commercial ne peut pas rediriger l'envoi vers un autre numéro", () => {
  const r = resolveCommercialSendRecipient(commercial, '21698111222', 'whatsapp', '21699000000', deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('le destinataire est déduit de la conversation', () => {
  const r = resolveCommercialSendRecipient(commercial, '21698111222', 'whatsapp', '', deps);
  assert.equal(r.ok, true);
  assert.equal(r.externalContact, '21698111222');
  const ig = resolveCommercialSendRecipient(commercial, 'instagram:42', '', '42', deps);
  assert.equal(ig.ok, true);
  assert.equal(ig.channel, 'instagram');
});

test('conversation inconnue ou canal incohérent refusés', () => {
  assert.equal(resolveCommercialSendRecipient(commercial, '21690000000', 'whatsapp', '', deps).status, 404);
  assert.equal(resolveCommercialSendRecipient(commercial, 'instagram:42', 'whatsapp', '', deps).status, 400);
});

test("la limite de connexion par e-mail ne dépend pas de l'adresse IP", () => {
  const email = 'cible@mondeco.tn';
  for (let i = 0; i < 10; i += 1) {
    registerLoginFailure({ ip: `10.0.0.${i}`, headers: {} }, email);
  }
  const state = getLoginAttemptState({ ip: '10.9.9.9', headers: {} }, email);
  assert.ok(state.blockedUntil > Date.now());
  clearLoginFailures({ ip: '10.9.9.9', headers: {} }, email);
});
