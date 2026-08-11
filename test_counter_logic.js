function safeString(v){return v==null?'':String(v)}
function conversationTimeMs(v){const n=Date.parse(String(v||''));return Number.isFinite(n)?n:Number.NaN}
function conversationEntryNeedsDirection(entry){
  const direction=safeString(entry?.direction||entry?.attachment_direction).toLowerCase();
  const senderKind=safeString(entry?.sender_kind).toLowerCase();
  const source=safeString(entry?.source).toLowerCase();
  const action=safeString(entry?.action).toLowerCase();
  const incoming=Boolean(safeString(entry?.incoming));
  const reply=Boolean(safeString(entry?.reply));
  const inbound=direction==='incoming'||senderKind==='client'||incoming;
  const outbound=direction==='outgoing'||entry?.reply_sent===true||source.startsWith('commercial')||action==='ai_reply'||action==='commercial_reply'||(!inbound&&reply);
  return {inbound,outbound};
}
function conversationNeedsReplyFromEntries(entries=[],state={}){
  if(state?.resolved===true)return false;
  let lastInboundMs=0,lastOutboundMs=0;
  for(const entry of entries){
    const ms=conversationTimeMs(entry?.time||entry?.createdAt||entry?.timestamp);
    if(!Number.isFinite(ms)||ms<=0)continue;
    const flags=conversationEntryNeedsDirection(entry);
    if(flags.inbound)lastInboundMs=Math.max(lastInboundMs,ms);
    if(flags.outbound)lastOutboundMs=Math.max(lastOutboundMs,ms);
  }
  const stateInboundMs=conversationTimeMs(state?.lastCustomerAt);
  const stateHumanMs=conversationTimeMs(state?.lastHumanAt);
  const stateBotMs=conversationTimeMs(state?.lastBotAt);
  const stateAnsweredMs=conversationTimeMs(state?.lastAnsweredAt);
  const answeredCustomerMs=conversationTimeMs(state?.lastAnsweredCustomerAt);
  if(Number.isFinite(stateInboundMs))lastInboundMs=Math.max(lastInboundMs,stateInboundMs);
  if(Number.isFinite(stateHumanMs))lastOutboundMs=Math.max(lastOutboundMs,stateHumanMs);
  if(Number.isFinite(stateBotMs))lastOutboundMs=Math.max(lastOutboundMs,stateBotMs);
  if(Number.isFinite(stateAnsweredMs))lastOutboundMs=Math.max(lastOutboundMs,stateAnsweredMs);
  if(Number.isFinite(stateInboundMs)&&Number.isFinite(answeredCustomerMs)&&Number.isFinite(stateAnsweredMs)&&answeredCustomerMs>=stateInboundMs&&stateAnsweredMs>=stateInboundMs)return false;
  return lastInboundMs>0&&lastInboundMs>lastOutboundMs;
}
function socialCommentNeedsReply(item,childReplyMs=0){
  if(!item||item.deleted||safeString(item?.direction)==='outgoing')return false;
  const createdMs=Date.parse(safeString(item?.createdAt))||0;
  const latestReplyMs=Math.max(Date.parse(safeString(item?.lastReplyAt))||0,Date.parse(safeString(item?.privateReplySentAt))||0,Date.parse(safeString(item?.answeredAt))||0,childReplyMs||0);
  return createdMs>0&&latestReplyMs<createdMs;
}
const t0='2026-08-11T10:00:00.000Z', t1='2026-08-11T10:01:00.000Z', t2='2026-08-11T10:02:00.000Z';
const tests=[
 ['WA inbound => pending', conversationNeedsReplyFromEntries([{time:t1,direction:'incoming',incoming:'bonjour'}],{}), true],
 ['WA human reply => cleared', conversationNeedsReplyFromEntries([{time:t1,direction:'incoming',incoming:'bonjour'},{time:t2,direction:'outgoing',reply:'bonjour'}],{}), false],
 ['IG inbound => pending', conversationNeedsReplyFromEntries([{time:t1,channel:'instagram',direction:'incoming',incoming:'prix'}],{}), true],
 ['IG commercial state marker => cleared', conversationNeedsReplyFromEntries([{time:t1,channel:'instagram',direction:'incoming',incoming:'prix'}],{lastCustomerAt:t1,lastAnsweredCustomerAt:t1,lastAnsweredAt:t2}), false],
 ['FB inbound => pending', conversationNeedsReplyFromEntries([{time:t1,channel:'facebook',direction:'incoming',incoming:'dispo'}],{}), true],
 ['FB reply => cleared', conversationNeedsReplyFromEntries([{time:t1,channel:'facebook',direction:'incoming',incoming:'dispo'},{time:t2,channel:'facebook',action:'commercial_reply',reply:'oui'}],{}), false],
 ['New inbound after reply => pending again', conversationNeedsReplyFromEntries([{time:t0,direction:'incoming',incoming:'a'},{time:t1,direction:'outgoing',reply:'b'},{time:t2,direction:'incoming',incoming:'c'}],{}), true],
 ['Resolved => never pending', conversationNeedsReplyFromEntries([{time:t2,direction:'incoming',incoming:'c'}],{resolved:true}), false],
 ['IG comment inbound => pending', socialCommentNeedsReply({createdAt:t1,direction:'incoming'}), true],
 ['IG comment public reply => cleared', socialCommentNeedsReply({createdAt:t1,direction:'incoming',lastReplyAt:t2}), false],
 ['FB comment private reply => cleared', socialCommentNeedsReply({createdAt:t1,direction:'incoming',privateReplySentAt:t2}), false],
 ['FB comment child outgoing reply => cleared', socialCommentNeedsReply({createdAt:t1,direction:'incoming'},Date.parse(t2)), false],
];
let failed=0;
for(const [name,got,want] of tests){const ok=got===want;console.log(ok?'PASS':'FAIL',name,'got=',got,'want=',want);if(!ok)failed++;}
if(failed)process.exit(1);
console.log(`ALL ${tests.length} COUNTER LOGIC TESTS PASSED`);
