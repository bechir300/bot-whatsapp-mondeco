'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationNeedsReplyFromEntries: needsReply } = require('./_load-admin');

const t0 = '2026-08-11T10:00:00.000Z';
const t1 = '2026-08-11T10:01:00.000Z';
const t2 = '2026-08-11T10:02:00.000Z';
const t3 = '2026-08-11T10:03:00.000Z';

const inbound = (time, extra = {}) => ({ time, direction: 'incoming', incoming: 'bonjour', ...extra });

test('un message client sans réponse est à traiter', () => {
  assert.equal(needsReply([inbound(t1)], {}), true);
  assert.equal(needsReply([inbound(t1, { channel: 'instagram' })], {}), true);
  assert.equal(needsReply([inbound(t1, { channel: 'facebook' })], {}), true);
});

test('une réponse sortante postérieure solde la conversation', () => {
  assert.equal(needsReply([inbound(t1), { time: t2, direction: 'outgoing', reply: 'ok' }], {}), false);
  assert.equal(needsReply([inbound(t1), { time: t2, action: 'commercial_reply', reply: 'oui' }], {}), false);
  assert.equal(needsReply([inbound(t1), { time: t2, direction: 'outgoing', reply: 'oui', sender_kind: 'meta' }], {}), false);
  assert.equal(needsReply([inbound(t1), { time: t2, direction: 'outgoing', reply: 'oui', source: 'commercial_instagram_history' }], {}), false);
});

test('les sources commerciales Meta comptent comme réponse', () => {
  for (const source of ['commercial_admin', 'commercial_whatsapp_app', 'commercial_instagram_history']) {
    assert.equal(needsReply([inbound(t0), { time: t1, reply: 'ok', reply_sent: true, source }], {}), false, source);
  }
});

test('message client et réponse dans la même entrée : soldé', () => {
  assert.equal(needsReply([{ time: t1, incoming: 'prix', reply: 'oui', reply_sent: true }], {}), false);
});

test('un nouveau message après la réponse rouvre la conversation', () => {
  const entries = [inbound(t0), { time: t1, direction: 'outgoing', reply: 'b' }, inbound(t2)];
  assert.equal(needsReply(entries, {}), true);
});

test("l'état persistant : client plus récent que le journal → à traiter", () => {
  assert.equal(needsReply([{ time: t1, direction: 'outgoing', reply: 'old' }], { lastCustomerAt: t3 }), true);
});

test("l'état persistant : marqueur de réponse → soldé", () => {
  assert.equal(needsReply([], { lastCustomerAt: t2, lastAnsweredAt: t3, lastAnsweredCustomerAt: t2 }), false);
  assert.equal(needsReply([inbound(t1, { channel: 'instagram' })], { lastCustomerAt: t1, lastAnsweredCustomerAt: t1, lastAnsweredAt: t2 }), false);
});

test('une réponse visible prime sur un ancien compteur non lu', () => {
  const entries = [inbound(t1), { time: t2, direction: 'outgoing', reply: 'oui', source: 'commercial_instagram_history' }];
  assert.equal(needsReply(entries, { unreadCount: 4, lastCustomerAt: t1 }), false);
});

test('une conversation résolue ne réclame jamais de réponse', () => {
  assert.equal(needsReply([inbound(t3)], { resolved: true }), false);
});
