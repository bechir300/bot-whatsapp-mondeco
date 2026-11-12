'use strict';
// Réponse humaine / Meta prouvée après le dernier message client.
// V6.46 — Teste les VRAIES fonctions d'Admin.js (tests/helpers/source-functions.js),
// avec la même règle que reconcileAnsweredConversationStates
// (latestHumanMs >= latestInboundMs), et non plus une copie collée ici.
const assert = require('assert');
const { loadFunctions } = require('./tests/helpers/source-functions');

const { conversationDirectionalEvidence } = loadFunctions('Admin.js', [
  'safeString',
  'conversationTimeMs',
  'normalizedConversationTime',
  'conversationEntryComparator',
  'conversationEntryNeedsDirection',
  'conversationEntryIsBusinessReply',
  'conversationDirectionalEvidence'
]);

function answered(entries, state = {}) {
  const evidence = conversationDirectionalEvidence(entries, state);
  return evidence.latestInboundMs > 0 && evidence.latestHumanMs >= evidence.latestInboundMs;
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
