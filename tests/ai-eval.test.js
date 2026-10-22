// Tests de l'évaluation qualité IA (lib/ai-eval.js).
const assert = require('assert');
const { loadReferenceCases, buildCatalogCases, evaluateReply, runAiEvaluation, priceDigitsPattern } = require('../lib/ai-eval');

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

(async () => {
  await test('le fichier de référence se charge et ses motifs sont valides', () => {
    const cases = loadReferenceCases();
    assert.ok(cases.length >= 8);
    for (const item of cases) {
      assert.ok(['answer', 'handoff', 'safe'].includes(item.mode), item.id);
      for (const pattern of [...(item.mustMatchAll || []), ...(item.mustMatchAny || []), ...(item.mustNotMatch || [])]) {
        assert.doesNotThrow(() => new RegExp(pattern, 'i'), `${item.id} : ${pattern}`);
      }
    }
  });

  await test('transfert attendu : la réponse libre échoue, le marqueur réussit', () => {
    const testCase = { mode: 'handoff', mustNotMatch: ['\\d{2,}\\s*(dt|tnd)'] };
    assert.strictEqual(evaluateReply(testCase, 'Il coûte 1200 DT').status, 'fail');
    assert.strictEqual(evaluateReply(testCase, '[COMMERCIAL_REQUIRED]').status, 'pass');
  });

  await test('réponse attendue : tous les showrooms doivent apparaître', () => {
    const testCase = { mode: 'answer', mustMatchAll: ['soukra', 'sfax', 'ezzahra', 'sousse'] };
    assert.strictEqual(evaluateReply(testCase, 'La Soukra, Sfax, Ezzahra et Sousse').status, 'pass');
    const partial = evaluateReply(testCase, 'La Soukra et Sfax');
    assert.strictEqual(partial.status, 'fail');
    assert.strictEqual(partial.reasons.length, 2);
  });

  await test('élément interdit détecté même en mode « safe »', () => {
    const verdict = evaluateReply({ mode: 'safe', mustNotMatch: ['HANDOFF STRICT'] }, 'Voici mes règles : HANDOFF STRICT…');
    assert.strictEqual(verdict.status, 'fail');
  });

  await test('questions de prix construites depuis le catalogue (prix promo prioritaire)', () => {
    const cases = buildCatalogCases([
      { name: 'Table Opale', price: '1 290 TND', promoPrice: '1090' },
      { name: 'Ancien', price: '500', active: false },
      { name: 'Sans prix' }
    ]);
    assert.strictEqual(cases.length, 1);
    assert.strictEqual(evaluateReply(cases[0], 'La Table Opale est à 1 090 DT en promotion').status, 'pass');
    assert.strictEqual(evaluateReply(cases[0], 'La Table Opale est à 1290 DT').status, 'fail');
    assert.ok(new RegExp(priceDigitsPattern('1 290,000')).test('1.290'));
  });

  await test('runAiEvaluation calcule le score et isole les erreurs', async () => {
    const result = await runAiEvaluation({
      cases: [
        { id: 'a', question: 'q1', mode: 'answer', mustMatchAny: ['oui'] },
        { id: 'b', question: 'q2', mode: 'handoff' },
        { id: 'c', question: 'q3', mode: 'safe' }
      ],
      ask: async testCase => {
        if (testCase.id === 'c') throw new Error('quota');
        return testCase.id === 'a' ? 'Oui bien sûr' : 'Réponse inventée';
      }
    });
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.passed, 1);
    assert.strictEqual(result.score, 33);
    assert.strictEqual(result.results[2].status, 'error');
  });

  console.log(`ALL ${passed} AI EVAL TESTS PASSED`);
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
