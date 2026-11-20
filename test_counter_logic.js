// Compteurs « à répondre » (messages et commentaires).
// V6.46 — Teste les VRAIES fonctions d'Admin.js (tests/helpers/source-functions.js)
// et non plus une copie collée ici, qui avait divergé du code réel
// (sender_kind human/meta, lastBusinessAt).
const { loadFunctions } = require('./tests/helpers/source-functions');

const {
  conversationNeedsReplyFromEntries,
  socialCommentNeedsReply
} = loadFunctions('Admin.js', [
  'safeString',
  'conversationTimeMs',
  'normalizedConversationTime',
  'conversationEntryComparator',
  'conversationEntryNeedsDirection',
  'conversationEntryIsBusinessReply',
  'conversationDirectionalEvidence',
  'conversationNeedsReplyFromEntries',
  'socialCommentNeedsReply'
]);

const t0 = '2026-08-11T10:00:00.000Z';
const t1 = '2026-08-11T10:01:00.000Z';
const t2 = '2026-08-11T10:02:00.000Z';
const tests = [
  ['WA inbound => pending', conversationNeedsReplyFromEntries([{ time: t1, direction: 'incoming', incoming: 'bonjour' }], {}), true],
  ['WA human reply => cleared', conversationNeedsReplyFromEntries([{ time: t1, direction: 'incoming', incoming: 'bonjour' }, { time: t2, direction: 'outgoing', reply: 'bonjour' }], {}), false],
  ['IG inbound => pending', conversationNeedsReplyFromEntries([{ time: t1, channel: 'instagram', direction: 'incoming', incoming: 'prix' }], {}), true],
  ['IG commercial state marker => cleared', conversationNeedsReplyFromEntries([{ time: t1, channel: 'instagram', direction: 'incoming', incoming: 'prix' }], { lastCustomerAt: t1, lastAnsweredCustomerAt: t1, lastAnsweredAt: t2 }), false],
  ['FB inbound => pending', conversationNeedsReplyFromEntries([{ time: t1, channel: 'facebook', direction: 'incoming', incoming: 'dispo' }], {}), true],
  ['FB reply => cleared', conversationNeedsReplyFromEntries([{ time: t1, channel: 'facebook', direction: 'incoming', incoming: 'dispo' }, { time: t2, channel: 'facebook', action: 'commercial_reply', reply: 'oui' }], {}), false],
  ['New inbound after reply => pending again', conversationNeedsReplyFromEntries([{ time: t0, direction: 'incoming', incoming: 'a' }, { time: t1, direction: 'outgoing', reply: 'b' }, { time: t2, direction: 'incoming', incoming: 'c' }], {}), true],
  ['Resolved => never pending', conversationNeedsReplyFromEntries([{ time: t2, direction: 'incoming', incoming: 'c' }], { resolved: true }), false],
  // Cas que l'ancienne copie ne connaissait pas (code réel).
  ['Human sender_kind reply => cleared', conversationNeedsReplyFromEntries([{ time: t1, direction: 'incoming', incoming: 'prix' }, { time: t2, sender_kind: 'human', reply: 'ok' }], {}), false],
  ['Business state marker (lastBusinessAt) => cleared', conversationNeedsReplyFromEntries([{ time: t1, direction: 'incoming', incoming: 'prix' }], { lastBusinessAt: t2 }), false],
  ['IG comment inbound => pending', socialCommentNeedsReply({ createdAt: t1, direction: 'incoming' }), true],
  ['IG comment public reply => cleared', socialCommentNeedsReply({ createdAt: t1, direction: 'incoming', lastReplyAt: t2 }), false],
  ['FB comment private reply => cleared', socialCommentNeedsReply({ createdAt: t1, direction: 'incoming', privateReplySentAt: t2 }), false],
  ['FB comment child outgoing reply => cleared', socialCommentNeedsReply({ createdAt: t1, direction: 'incoming', commentId: 'c1' }, new Map([['c1', Date.parse(t2)]])), false],
  ['Outgoing comment => never pending', socialCommentNeedsReply({ createdAt: t1, direction: 'outgoing' }), false]
];

let failed = 0;
for (const [name, got, want] of tests) {
  const ok = got === want;
  console.log(ok ? 'PASS' : 'FAIL', name, 'got=', got, 'want=', want);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`ALL ${tests.length} COUNTER LOGIC TESTS PASSED`);
