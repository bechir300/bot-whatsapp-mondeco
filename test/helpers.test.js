'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationTimeMs, normalizePhone, conversationEntryNeedsDirection } = require('./_load-admin');

test('conversationTimeMs accepte ISO, secondes et millisecondes Unix', () => {
  const iso = '2026-08-11T10:00:00.000Z';
  const ms = Date.parse(iso);
  assert.equal(conversationTimeMs(iso), ms);
  assert.equal(conversationTimeMs(String(ms / 1000)), ms);
  assert.equal(conversationTimeMs(String(ms)), ms);
  assert.ok(Number.isNaN(conversationTimeMs('')));
  assert.ok(Number.isNaN(conversationTimeMs(null)));
});

test('normalizePhone ne garde que les chiffres', () => {
  assert.equal(normalizePhone('+216 98 123 456'), '21698123456');
  assert.equal(normalizePhone(null), '');
});

test('direction des entrées du journal', () => {
  assert.deepEqual(conversationEntryNeedsDirection({ direction: 'incoming' }), { inbound: true, outbound: false });
  assert.deepEqual(conversationEntryNeedsDirection({ action: 'ai_reply', reply: 'x' }), { inbound: false, outbound: true });
  assert.deepEqual(conversationEntryNeedsDirection({ sender_kind: 'human', reply: 'x' }), { inbound: false, outbound: true });
});
