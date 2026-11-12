// Réconciliation « vraiment en attente » (journal + état) et fils de commentaires.
// V6.46 — Teste les VRAIES fonctions d'Admin.js (tests/helpers/source-functions.js)
// et non plus une copie collée ici, qui pouvait diverger du code réel.
const { loadFunctions } = require('./tests/helpers/source-functions');

const {
  conversationNeedsReplyFromEntries,
  socialCommentThreadIndex
} = loadFunctions('Admin.js', [
  'safeString',
  'conversationTimeMs',
  'normalizedConversationTime',
  'conversationEntryComparator',
  'conversationEntryNeedsDirection',
  'conversationEntryIsBusinessReply',
  'conversationDirectionalEvidence',
  'conversationNeedsReplyFromEntries',
  'socialCommentThreadIndex'
]);

const t0='2026-08-11T10:00:00Z',t1='2026-08-11T10:01:00Z',t2='2026-08-11T10:02:00Z',t3='2026-08-11T10:03:00Z';
const tests=[]; const add=(n,g,w)=>tests.push([n,g,w]);
add('WA inbound pending',conversationNeedsReplyFromEntries([{time:t1,direction:'incoming',incoming:'prix'}],{}),true);
add('WA reply clears',conversationNeedsReplyFromEntries([{time:t1,direction:'incoming',incoming:'prix'},{time:t2,direction:'outgoing',reply:'oui',source:'commercial_admin'}],{}),false);
add('Combined inbound+reply same event clears',conversationNeedsReplyFromEntries([{time:t1,incoming:'prix',reply:'oui',reply_sent:true}],{}),false);
add('IG visible reply overrides stale unread state',conversationNeedsReplyFromEntries([{time:t1,direction:'incoming',incoming:'prix'},{time:t2,direction:'outgoing',reply:'oui',source:'commercial_instagram_history'}],{unreadCount:4,lastCustomerAt:t1}),false);
add('FB Meta outgoing clears',conversationNeedsReplyFromEntries([{time:t1,direction:'incoming',incoming:'prix'},{time:t2,direction:'outgoing',reply:'oui',sender_kind:'meta'}],{}),false);
add('New inbound after reply pending',conversationNeedsReplyFromEntries([{time:t1,direction:'incoming',incoming:'a'},{time:t2,direction:'outgoing',reply:'b'},{time:t3,direction:'incoming',incoming:'c'}],{}),true);
add('State-only newer inbound pending',conversationNeedsReplyFromEntries([{time:t1,direction:'outgoing',reply:'old'}],{lastCustomerAt:t3}),true);
add('State answered marker clears same state inbound',conversationNeedsReplyFromEntries([],{lastCustomerAt:t2,lastAnsweredAt:t3,lastAnsweredCustomerAt:t2}),false);
add('Resolved never pending',conversationNeedsReplyFromEntries([{time:t3,direction:'incoming',incoming:'c'}],{resolved:true}),false);
const comments=[
 {key:'ig:a',channel:'instagram',postId:'p',commentId:'a',direction:'incoming',createdAt:t1},
 {key:'ig:b',channel:'instagram',postId:'p',commentId:'b',parentId:'a',direction:'outgoing',createdAt:t2},
 {key:'ig:c',channel:'instagram',postId:'p',commentId:'c',parentId:'a',direction:'incoming',createdAt:t3},
];
let idx=socialCommentThreadIndex(comments);add('Comment thread with newest client reply => 1 pending thread',[...idx.threads.values()].filter(x=>x.pending).length,1);add('Only newest inbound row actionable',idx.pendingByKey.get('ig:c'),true);add('Old parent not separately pending',idx.pendingByKey.get('ig:a'),false);
idx=socialCommentThreadIndex([...comments,{key:'ig:d',channel:'instagram',postId:'p',commentId:'d',parentId:'a',direction:'outgoing',createdAt:'2026-08-11T10:04:00Z'}]);add('Later public reply clears whole thread',[...idx.threads.values()].filter(x=>x.pending).length,0);
idx=socialCommentThreadIndex([{key:'fb:a',channel:'facebook',postId:'p2',commentId:'a',direction:'incoming',createdAt:t1,privateReplySentAt:t2}]);add('Private reply clears thread',[...idx.threads.values()].filter(x=>x.pending).length,0);
idx=socialCommentThreadIndex([{key:'1',channel:'facebook',postId:'p',commentId:'1',direction:'incoming',createdAt:t1},{key:'2',channel:'facebook',postId:'p',commentId:'2',direction:'incoming',createdAt:t2}]);add('Two separate top-level comments => 2 pending threads',[...idx.threads.values()].filter(x=>x.pending).length,2);
let fails=0;for(const [n,g,w] of tests){const ok=JSON.stringify(g)===JSON.stringify(w);console.log(ok?'PASS':'FAIL',n,'got',g,'want',w);if(!ok)fails++}if(fails)process.exit(1);console.log(`ALL ${tests.length} TRUE-PENDING TESTS PASSED`);
