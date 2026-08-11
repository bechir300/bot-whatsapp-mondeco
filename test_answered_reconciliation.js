'use strict';
const assert = require('assert');
const safeString = v => v === undefined || v === null ? '' : String(v).trim();
const timeMs = v => { const n=Date.parse(safeString(v)); return Number.isFinite(n)?n:NaN; };
function entryFlags(entry){
  const direction=safeString(entry.direction||entry.attachment_direction).toLowerCase();
  const senderKind=safeString(entry.sender_kind).toLowerCase();
  const source=safeString(entry.source).toLowerCase();
  const action=safeString(entry.action).toLowerCase();
  const incoming=Boolean(safeString(entry.incoming));
  const reply=Boolean(safeString(entry.reply));
  const inbound=direction==='incoming'||senderKind==='client'||incoming;
  const outbound=direction==='outgoing'||entry.reply_sent===true||source.startsWith('commercial')||action==='ai_reply'||action==='commercial_reply'||(!inbound&&reply);
  return {inbound,outbound};
}
function business(entry){
  const flags=entryFlags(entry); if(!flags.outbound) return false;
  const source=safeString(entry.source).toLowerCase();
  const action=safeString(entry.action).toLowerCase();
  const senderKind=safeString(entry.sender_kind).toLowerCase();
  return Boolean(source.startsWith('commercial')||action==='commercial_reply'||senderKind==='human'||senderKind==='meta'||safeString(entry.commercial_user_id)||safeString(entry.commercial_user_name)||safeString(entry.facebook_response_owner));
}
function answered(entries,state={}){
  let inMs=0,bizMs=0;
  for(const e of entries){ const ms=timeMs(e.time); if(!Number.isFinite(ms)) continue; const f=entryFlags(e); if(f.inbound) inMs=Math.max(inMs,ms); if(business(e)) bizMs=Math.max(bizMs,ms); }
  const st=timeMs(state.lastCustomerAt); if(Number.isFinite(st)) inMs=Math.max(inMs,st);
  return inMs>0 && bizMs>=inMs;
}
const inbound={incoming:'bonjour',direction:'incoming',sender_kind:'client',time:'2026-08-11T10:00:00Z'};
assert.equal(answered([inbound,{reply:'ok',reply_sent:true,source:'commercial_admin',action:'commercial_reply',time:'2026-08-11T10:05:00Z'}]),true,'admin reply');
assert.equal(answered([inbound,{reply:'ok',reply_sent:true,source:'commercial_whatsapp_app',action:'commercial_reply',time:'2026-08-11T10:05:00Z'}]),true,'WhatsApp Business reply');
assert.equal(answered([inbound,{reply:'ok',reply_sent:true,source:'commercial_instagram_history',direction:'outgoing',time:'2026-08-11T10:05:00Z'}]),true,'Instagram business reply');
assert.equal(answered([inbound,{reply:'ok',reply_sent:true,sender_kind:'meta',direction:'outgoing',time:'2026-08-11T10:05:00Z'}]),true,'Facebook Business Suite reply');
assert.equal(answered([inbound,{reply:'auto',reply_sent:true,source:'organic',action:'ai_reply',time:'2026-08-11T10:05:00Z'}]),false,'AI alone is not a human/business acknowledgement');
assert.equal(answered([{reply:'ok',reply_sent:true,source:'commercial_admin',time:'2026-08-11T10:05:00Z'},{incoming:'new',direction:'incoming',time:'2026-08-11T10:06:00Z'}]),false,'new customer message reopens');
assert.equal(answered([inbound,{reply:'ok',reply_sent:true,source:'commercial_admin',time:'2026-08-11T10:05:00Z'}],{lastCustomerAt:'2026-08-11T10:07:00Z'}),false,'state with newer customer message stays pending');
console.log('7/7 answered-reconciliation tests OK');
