'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { socialCommentNeedsReply, socialCommentThreadIndex } = require('./_load-admin');

const t1 = '2026-08-11T10:01:00Z';
const t2 = '2026-08-11T10:02:00Z';
const t3 = '2026-08-11T10:03:00Z';
const t4 = '2026-08-11T10:04:00Z';

const pendingThreads = index => [...index.threads.values()].filter(t => t.pending).length;

test('commentaire isolé : en attente puis soldé par une réponse', () => {
  assert.equal(socialCommentNeedsReply({ createdAt: t1, direction: 'incoming' }), true);
  assert.equal(socialCommentNeedsReply({ createdAt: t1, direction: 'incoming', lastReplyAt: t2 }), false);
  assert.equal(socialCommentNeedsReply({ createdAt: t1, direction: 'incoming', privateReplySentAt: t2 }), false);
  assert.equal(socialCommentNeedsReply({ createdAt: t1, direction: 'outgoing' }), false);
  assert.equal(socialCommentNeedsReply({ createdAt: t1, direction: 'incoming', deleted: true }), false);
});

const thread = [
  { key: 'ig:a', channel: 'instagram', postId: 'p', commentId: 'a', direction: 'incoming', createdAt: t1 },
  { key: 'ig:b', channel: 'instagram', postId: 'p', commentId: 'b', parentId: 'a', direction: 'outgoing', createdAt: t2 },
  { key: 'ig:c', channel: 'instagram', postId: 'p', commentId: 'c', parentId: 'a', direction: 'incoming', createdAt: t3 }
];

test('fil : seule la dernière relance client est actionnable', () => {
  const index = socialCommentThreadIndex(thread);
  assert.equal(pendingThreads(index), 1);
  assert.equal(index.pendingByKey.get('ig:c'), true);
  assert.equal(index.pendingByKey.get('ig:a'), false);
  assert.equal(socialCommentNeedsReply(thread[2], index), true);
  assert.equal(socialCommentNeedsReply(thread[0], index), false);
});

test('fil : une réponse publique plus récente solde tout le fil', () => {
  const index = socialCommentThreadIndex([
    ...thread,
    { key: 'ig:d', channel: 'instagram', postId: 'p', commentId: 'd', parentId: 'a', direction: 'outgoing', createdAt: t4 }
  ]);
  assert.equal(pendingThreads(index), 0);
});

test('fil : une réponse privée solde le fil', () => {
  const index = socialCommentThreadIndex([
    { key: 'fb:a', channel: 'facebook', postId: 'p2', commentId: 'a', direction: 'incoming', createdAt: t1, privateReplySentAt: t2 }
  ]);
  assert.equal(pendingThreads(index), 0);
});

test('deux commentaires racines distincts : deux fils en attente', () => {
  const index = socialCommentThreadIndex([
    { key: '1', channel: 'facebook', postId: 'p', commentId: '1', direction: 'incoming', createdAt: t1 },
    { key: '2', channel: 'facebook', postId: 'p', commentId: '2', direction: 'incoming', createdAt: t2 }
  ]);
  assert.equal(pendingThreads(index), 2);
});
