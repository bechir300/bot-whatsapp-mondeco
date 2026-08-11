function safeString(v){return v==null?'':String(v)}
function conversationTimeMs(v){const raw=safeString(v); if(!raw)return Number.NaN; const n=Date.parse(raw); return Number.isFinite(n)?n:Number.NaN}
function normalizedConversationTime(entry){for(const v of [entry?.meta_created_time,entry?.event_time,entry?.created_time,entry?.time,entry?.timestamp]){const n=conversationTimeMs(v);if(Number.isFinite(n))return n}return 0}
function conversationEntryComparator(a,b){const am=normalizedConversationTime(a),bm=normalizedConversationTime(b);if(am!==bm)return am-bm;const rank=e=>safeString(e?.incoming)?0:safeString(e?.reply)?1:2;return rank(a)-rank(b)}
function conversationEntryNeedsDirection(entry){
 const direction=safeString(entry?.direction||entry?.attachment_direction).toLowerCase();
 const senderKind=safeString(entry?.sender_kind).toLowerCase();
 const source=safeString(entry?.source).toLowerCase();
 const action=safeString(entry?.action).toLowerCase();
 const incoming=Boolean(safeString(entry?.incoming)); const reply=Boolean(safeString(entry?.reply));
 const inbound=direction==='incoming'||senderKind==='client'||incoming;
 const outbound=direction==='outgoing'||entry?.reply_sent===true||source.startsWith('commercial')||action==='ai_reply'||action==='commercial_reply'||senderKind==='human'||senderKind==='meta'||(!inbound&&reply);
 return {inbound,outbound};
}
function conversationEntryIsBusinessReply(entry){const flags=conversationEntryNeedsDirection(entry);if(!flags.outbound)return false;const source=safeString(entry?.source).toLowerCase();const action=safeString(entry?.action).toLowerCase();const senderKind=safeString(entry?.sender_kind).toLowerCase();return Boolean(source.startsWith('commercial')||action==='commercial_reply'||senderKind==='human'||senderKind==='meta'||safeString(entry?.commercial_user_id)||safeString(entry?.commercial_user_name)||safeString(entry?.facebook_response_owner))}
function conversationDirectionalEvidence(entries=[],state={}){
 let latestInboundMs=0,latestInboundIso='',latestOutboundMs=0,latestOutboundIso='',latestHumanMs=0;
 for(const entry of [...entries].sort(conversationEntryComparator)){let ms=normalizedConversationTime(entry);if(!Number.isFinite(ms)||ms<=0)continue;const flags=conversationEntryNeedsDirection(entry);if(flags.inbound&&ms>=latestInboundMs){latestInboundMs=ms;latestInboundIso=safeString(entry?.time)}if(flags.outbound){const om=flags.inbound?ms+1:ms;if(om>=latestOutboundMs){latestOutboundMs=om;latestOutboundIso=safeString(entry?.reply_time||entry?.time)}if(conversationEntryIsBusinessReply(entry)&&om>=latestHumanMs)latestHumanMs=om}}
 const stateInboundMs=conversationTimeMs(state?.lastCustomerAt), stateHumanMs=conversationTimeMs(state?.lastHumanAt), stateBotMs=conversationTimeMs(state?.lastBotAt), stateAnsweredMs=conversationTimeMs(state?.lastAnsweredAt), answeredCustomerMs=conversationTimeMs(state?.lastAnsweredCustomerAt);
 const stateResponseMs=Math.max(Number.isFinite(stateHumanMs)?stateHumanMs:0,Number.isFinite(stateBotMs)?stateBotMs:0,Number.isFinite(stateAnsweredMs)?stateAnsweredMs:0);
 let effectiveInboundMs=latestInboundMs;if(Number.isFinite(stateInboundMs)&&stateInboundMs>effectiveInboundMs){const stateAlreadyAnswered=stateResponseMs>=stateInboundMs||(Number.isFinite(answeredCustomerMs)&&answeredCustomerMs>=stateInboundMs);if(!stateAlreadyAnswered)effectiveInboundMs=stateInboundMs}
 const effectiveOutboundMs=Math.max(latestOutboundMs,stateResponseMs);return {pending:effectiveInboundMs>0&&effectiveOutboundMs<effectiveInboundMs,answered:effectiveInboundMs>0&&effectiveOutboundMs>=effectiveInboundMs,latestInboundMs:effectiveInboundMs,latestOutboundMs:effectiveOutboundMs,latestHumanMs};
}
function conversationNeedsReplyFromEntries(entries=[],state={}){if(state?.resolved===true)return false;return conversationDirectionalEvidence(entries,state).pending}
function socialCommentThreadIndex(items=[]){
 const active=items.filter(x=>x&&!x.deleted); const by=new Map(); for(const x of active){if(x.commentId)by.set(`${x.channel}|${x.postId}|${x.commentId}`,x)}
 const cache=new Map(); const rootId=item=>{const own=`${item.channel}|${item.postId}|${item.commentId}`;if(cache.has(own))return cache.get(own);let cur=item;const seen=new Set();for(let d=0;d<25;d++){const pid=safeString(cur.parentId);if(!pid)break;const pk=`${cur.channel}|${cur.postId}|${pid}`;if(seen.has(pk))break;seen.add(pk);const p=by.get(pk);if(!p)break;cur=p}const root=`${cur.channel}|${cur.postId}|${cur.commentId}`;cache.set(own,root);return root};
 const threads=new Map(); for(const item of active){const root=rootId(item);const t=threads.get(root)||{root,channel:item.channel,items:[],latestIncomingMs:0,latestIncomingItem:null,latestOutgoingMs:0,latestAckMs:0};t.items.push(item);const ms=Date.parse(safeString(item.createdAt||item.updatedAt))||0;if(item.direction==='outgoing'){t.latestOutgoingMs=Math.max(t.latestOutgoingMs,ms)}else{if(ms>=t.latestIncomingMs){t.latestIncomingMs=ms;t.latestIncomingItem=item}for(const f of ['lastReplyAt','privateReplySentAt','answeredAt'])t.latestAckMs=Math.max(t.latestAckMs,Date.parse(safeString(item[f]))||0)}threads.set(root,t)}
 const pendingByKey=new Map();for(const t of threads.values()){t.pending=t.latestIncomingMs>Math.max(t.latestOutgoingMs,t.latestAckMs);const actionable=t.pending?safeString(t.latestIncomingItem?.key):'';for(const item of t.items)pendingByKey.set(item.key,Boolean(actionable&&item.key===actionable))}return {threads,pendingByKey};
}
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
