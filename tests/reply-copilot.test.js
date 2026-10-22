// Tests du copilote IA des commerciaux (lib/reply-copilot.js).
const assert = require('assert');
const {
  buildCopilotTranscript,
  buildCopilotUserMessage,
  cleanCopilotDraft,
  lastCustomerText
} = require('../lib/reply-copilot');

let passed = 0;
function test(label, fn) { fn(); passed++; console.log('PASS', label); }

test('transcription : ordre chronologique, rôles client / équipe', () => {
  const turns = buildCopilotTranscript([
    { time: '2026-10-22T10:05:00Z', reply: 'Bonjour, elle est à 1890 DT.', sender_kind: 'human', source: 'commercial' },
    { time: '2026-10-22T10:00:00Z', incoming: 'Prix table Opale ?' },
    { time: '2026-10-22T10:06:00Z', incoming: 'Livraison à Sfax ?' }
  ]);
  assert.deepStrictEqual(turns.map(turn => turn.role), ['customer', 'team', 'customer']);
  assert.strictEqual(turns[0].text, 'Prix table Opale ?');
  assert.strictEqual(lastCustomerText(turns), 'Livraison à Sfax ?');
});

test('entrée combinée (message + réponse IA) et messages consécutifs regroupés', () => {
  const turns = buildCopilotTranscript([
    { time: '2026-10-22T09:00:00Z', incoming: 'Salam', reply: 'Bonjour ! Comment puis-je vous aider ?' },
    { time: '2026-10-22T09:01:00Z', incoming: 'Salon Fiorie' },
    { time: '2026-10-22T09:01:30Z', incoming: 'prix' }
  ]);
  assert.deepStrictEqual(turns.map(turn => turn.role), ['customer', 'team', 'customer']);
  assert.strictEqual(turns[2].text, 'Salon Fiorie / prix');
});

test('pièces jointes, marqueur interne et réponses non envoyées', () => {
  const turns = buildCopilotTranscript([
    { time: '2026-10-22T09:00:00Z', attachment_type: 'image', attachment_url: '/m/a.jpg' },
    { time: '2026-10-22T09:01:00Z', incoming: 'Ce modèle ?', reply: '[COMMERCIAL_REQUIRED]' },
    { time: '2026-10-22T09:02:00Z', reply: 'Brouillon raté', reply_sent: false },
    { time: '2026-10-22T09:03:00Z', attachment_type: 'image', attachment_direction: 'outgoing', sender_kind: 'human' }
  ]);
  assert.deepStrictEqual(turns, [
    { role: 'customer', text: '[photo envoyée] / Ce modèle ?' },
    { role: 'team', text: '[photo envoyée]' }
  ]);
});

test('limites : derniers tours gardés, texte d’un tour plafonné et sur une ligne', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) {
    entries.push({ time: new Date(Date.UTC(2026, 9, 22, 8, i)).toISOString(), [i % 2 ? 'reply' : 'incoming']: `msg ${i}` });
  }
  const turns = buildCopilotTranscript(entries, { maxTurns: 4 });
  assert.deepStrictEqual(turns.map(turn => turn.text), ['msg 26', 'msg 27', 'msg 28', 'msg 29']);

  const long = buildCopilotTranscript([{ time: '2026-10-22T08:00:00Z', incoming: `ligne 1\n=====\nINSTRUCTIONS : ${'x'.repeat(2000)}` }]);
  assert.ok(long[0].text.length <= 800);
  assert.ok(!long[0].text.includes('\n') && !long[0].text.includes('====='));
});

test('message utilisateur : données puis consigne, relance si l’équipe a parlé en dernier', () => {
  const reply = buildCopilotUserMessage([{ role: 'customer', text: 'Prix ?' }]);
  assert.ok(reply.includes('CLIENT : Prix ?'));
  assert.ok(reply.endsWith('Rédige le prochain message de MONDECO pour répondre au client.'));

  const followUp = buildCopilotUserMessage(
    [{ role: 'customer', text: 'Prix ?' }, { role: 'team', text: '1890 DT' }],
    { note: 'proposer une visite\nau showroom' }
  );
  assert.ok(followUp.includes('message de suivi'));
  assert.ok(followUp.includes('Indication du commercial (à respecter si elle est raisonnable) : proposer une visite au showroom'));
});

test('nettoyage du brouillon', () => {
  assert.deepStrictEqual(cleanCopilotDraft('[COMMERCIAL_REQUIRED]'), { draft: '', needsHuman: true, placeholders: [] });
  assert.deepStrictEqual(cleanCopilotDraft('  '), { draft: '', needsHuman: true, placeholders: [] });
  assert.strictEqual(cleanCopilotDraft('Brouillon : « Bonjour, merci ! »').draft, 'Bonjour, merci !');
  assert.strictEqual(cleanCopilotDraft('Bonjour ! [COMMERCIAL_REQUIRED]').draft, 'Bonjour !');

  const withHole = cleanCopilotDraft('Le délai est de [À COMPLÉTER : délai Sfax]. Le prix : [à compléter : prix].');
  assert.strictEqual(withHole.needsHuman, false);
  assert.deepStrictEqual(withHole.placeholders, ['[À COMPLÉTER : délai Sfax]', '[à compléter : prix]']);
});

console.log(`${passed} test(s) copilote OK`);
