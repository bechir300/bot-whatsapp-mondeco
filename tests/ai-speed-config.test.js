// V6.47 — Vitesse des réponses IA : niveau de réflexion Gemini par défaut,
// marge de jetons pour la réflexion, effort de raisonnement du secours Groq.
// Vraies fonctions de server.js chargées dans un bac à sable (sans démarrer
// le serveur).
'use strict';

const assert = require('assert');
const { loadFunctions, readSource } = require('./helpers/source-functions');

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS', label);
}

const { safeEnvThinkingLevel, geminiThinkingHeadroom } =
  loadFunctions('server.js', ['safeEnvThinkingLevel', 'geminiThinkingHeadroom']);

function buildFor(level) {
  return loadFunctions('server.js', ['buildGeminiRequest'], {
    GEMINI_THINKING_LEVEL: level,
    geminiThinkingHeadroom,
    safeString: value => (value == null ? '' : String(value)),
    toGeminiParts: content => [{ text: String(content) }]
  }).buildGeminiRequest;
}

const payload = {
  messages: [
    { role: 'system', content: 'Tu es le conseiller MONDECO.' },
    { role: 'user', content: 'Prix chambre Bianca complète ?' }
  ],
  max_completion_tokens: 700
};

test('sans réglage : réflexion « low » (plus « défaut Google », lent)', () => {
  assert.strictEqual(safeEnvThinkingLevel(undefined), 'low');
  assert.strictEqual(safeEnvThinkingLevel(''), 'low');
  assert.strictEqual(safeEnvThinkingLevel('n importe quoi'), 'low');
});

test('niveaux explicites respectés, « default » rend le réglage de Google', () => {
  for (const level of ['minimal', 'low', 'medium', 'high']) {
    assert.strictEqual(safeEnvThinkingLevel(` ${level.toUpperCase()} `), level);
  }
  assert.strictEqual(safeEnvThinkingLevel('default'), '');
});

test('requête Gemini : niveau envoyé et marge pour la réflexion', () => {
  const request = buildFor('low')(payload);
  assert.strictEqual(request.generationConfig.thinkingConfig.thinkingLevel, 'low');
  // 700 pour la réponse + 2048 de marge : la réflexion ne vide plus la réponse.
  assert.strictEqual(request.generationConfig.maxOutputTokens, 700 + 2048);
});

test('« default » : pas de thinkingConfig, marge maximale', () => {
  const request = buildFor('')(payload);
  assert.strictEqual(request.generationConfig.thinkingConfig, undefined);
  assert.strictEqual(request.generationConfig.maxOutputTokens, 700 + 8192);
  assert.strictEqual(geminiThinkingHeadroom('high'), 8192);
  assert.strictEqual(geminiThinkingHeadroom('minimal'), 512);
});

test('secours Groq : effort de raisonnement « low » pour gpt-oss seulement', () => {
  const source = readSource('server.js');
  assert.match(source, /process\.env\.GROQ_REASONING_EFFORT \|\| 'low'/);
  assert.match(source, /\/gpt-oss\/i\.test\(fallbackModel\)\s*\n?\s*\? \{ reasoning_effort: GROQ_REASONING_EFFORT \}/);
});

console.log(`${passed} test(s) vitesse IA OK`);
