// Tests du calcul des indicateurs (lib/kpi.js).
const assert = require('assert');
const { computeDailyKpis, combineKpis } = require('../lib/kpi');

const at = (hh, mm, ss = 0) => `2026-10-22T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;

const events = [
  // Client A : résolu par l'IA, réponse 20 s après réception.
  { contact: 'A', channel: 'whatsapp', action: 'ai_reply', incoming: 'Bonjour, prix de la table Opale ?', incoming_at: at(9, 0, 0), reply: 'Elle est à 890 DT', reply_sent: true, time: at(9, 0, 20) },
  // Client B : transfert commercial puis réponse humaine 10 min après.
  { contact: 'B', channel: 'instagram', action: 'ai_needs_commercial', incoming: 'Vous êtes où ? adresse du showroom', reply_sent: false, time: at(10, 0) },
  { contact: 'B', channel: 'instagram', action: 'commercial_reply', source: 'commercial_inbox', reply: 'À La Soukra', reply_sent: true, time: at(10, 10) },
  // Client C : venu d'une pub, resté sans réponse.
  { contact: 'C', channel: 'facebook', action: 'human_pause', incoming: 'Disponible ?', source: 'meta_ad', reply_sent: false, time: at(11, 0) },
  // Ancienne entrée combinée sans incoming_at : délai non mesurable.
  { contact: 'D', channel: 'whatsapp', action: 'ai_reply', incoming: 'Bonsoir', reply: 'Bonsoir !', reply_sent: true, time: at(12, 0) },
  // Événement sans message client : ignoré dans le décompte des conversations.
  { contact: 'E', channel: 'whatsapp', action: 'facebook_message_read', time: at(12, 30) }
];

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}

const day = computeDailyKpis(events, { date: '2026-10-22' });

test('comptage des conversations et messages', () => {
  assert.strictEqual(day.conversations, 4);
  assert.strictEqual(day.inboundMessages, 4);
  assert.strictEqual(day.aiReplies, 2);
  assert.strictEqual(day.humanReplies, 1);
});

test('taux de résolution IA et de transfert', () => {
  assert.strictEqual(day.aiResolved, 2);
  assert.strictEqual(day.handedOff, 2);
  assert.strictEqual(day.aiResolutionRate, 50);
  assert.strictEqual(day.unanswered, 1);
});

test('délais de réponse IA et humain', () => {
  assert.strictEqual(day.aiResponseTime.count, 1);
  assert.strictEqual(day.aiResponseTime.medianSeconds, 20);
  assert.strictEqual(day.humanResponseTime.medianSeconds, 600);
  assert.strictEqual(day.firstResponseTime.count, 2, 'D sans incoming_at est exclu');
});

test('intentions, publicité, canaux, motifs de transfert', () => {
  assert.strictEqual(day.showroomIntent, 1);
  assert.strictEqual(day.priceIntent, 1);
  assert.strictEqual(day.fromAds, 1);
  assert.deepStrictEqual(day.channels, { whatsapp: 2, instagram: 1, facebook: 1 });
  assert.deepStrictEqual(day.handoffReasons, { ai_needs_commercial: 1, human_pause: 1 });
});

test('aucune donnée personnelle dans le résultat', () => {
  const serialized = JSON.stringify(day);
  for (const secret of ['Opale', 'Soukra', 'Bonsoir', '"A"', 'Disponible']) {
    assert.ok(!serialized.includes(secret), secret);
  }
});

test('combinaison de plusieurs journées', () => {
  const total = combineKpis([day, day]);
  assert.strictEqual(total.conversations, 8);
  assert.strictEqual(total.aiResolutionRate, 50);
  assert.strictEqual(total.humanResponseTime.averageSeconds, 600);
  assert.strictEqual(total.channels.whatsapp, 4);
});

console.log(`ALL ${passed} KPI TESTS PASSED`);
