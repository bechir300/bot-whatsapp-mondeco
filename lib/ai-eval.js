// ============================================================
// MONDECO — évaluation de la qualité des réponses IA
// lib/ai-eval.js
//
// Rejoue un jeu de questions de référence (evals/ai-reference-questions.json)
// et quelques questions de prix construites à partir du catalogue réel, puis
// vérifie chaque réponse : transfert attendu ou non, éléments obligatoires,
// éléments interdits (prix inventé, fuite des instructions…).
// ============================================================

const fs = require('fs');
const path = require('path');

const HANDOFF_MARKER = /\[COMMERCIAL_REQUIRED\]/i;
const REFERENCE_PATH = path.join(__dirname, '..', 'evals', 'ai-reference-questions.json');

function loadReferenceCases(filePath = REFERENCE_PATH) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return (Array.isArray(parsed?.cases) ? parsed.cases : [])
    .filter(item => item && item.id && item.question)
    .map(item => ({ ...item, source: 'reference' }));
}

// Motif tolérant aux séparateurs de milliers : « 1290 » ↔ « 1 290 » / « 1.290 ».
function priceDigitsPattern(price) {
  const integer = String(price ?? '').replace(/[^\d.,]/g, '').split(/[.,](?=\d{1,3}$)/)[0].replace(/\D/g, '');
  if (!integer || Number(integer) <= 0) return '';
  const groups = [];
  for (let end = integer.length; end > 0; end -= 3) groups.unshift(integer.slice(Math.max(0, end - 3), end));
  return groups.join('[\\s.,\\u202f\\u00a0]?');
}

// Jusqu'à `limit` produits actifs avec un prix : l'IA doit donner le bon prix
// (promotionnel s'il existe, normal sinon).
function buildCatalogCases(products = [], limit = 3) {
  return (Array.isArray(products) ? products : [])
    .filter(product => product && product.active !== false && String(product.name || '').trim())
    .map(product => {
      const promo = priceDigitsPattern(product.promoPrice);
      const normal = priceDigitsPattern(product.price);
      return { product, pattern: promo || normal };
    })
    .filter(item => item.pattern)
    .slice(0, limit)
    .map(({ product, pattern }, index) => ({
      id: `catalogue-${index + 1}`,
      question: `Quel est le prix de ${String(product.name).trim()} ?`,
      mode: 'answer',
      mustMatchAll: [pattern],
      note: `Prix attendu d'après le catalogue : ${product.promoPrice || product.price}`,
      source: 'catalogue'
    }));
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

// Renvoie { status: 'pass' | 'fail', handoff, reasons[] }.
function evaluateReply(testCase, rawReply) {
  const reply = String(rawReply ?? '');
  const handoff = HANDOFF_MARKER.test(reply) || !reply.trim();
  const text = reply.replace(HANDOFF_MARKER, '').trim();
  const reasons = [];
  const mode = testCase.mode || 'safe';

  if (mode === 'answer' && handoff) reasons.push('Transfert au commercial alors qu’une réponse était attendue.');
  if (mode === 'handoff' && !handoff) reasons.push('Réponse donnée alors qu’un transfert au commercial était attendu.');

  if (!handoff) {
    for (const pattern of testCase.mustMatchAll || []) {
      const regex = safeRegex(pattern);
      if (regex && !regex.test(text)) reasons.push(`Élément attendu absent : ${pattern}`);
    }
    const any = (testCase.mustMatchAny || []).map(safeRegex).filter(Boolean);
    if (any.length && !any.some(regex => regex.test(text))) {
      reasons.push(`Aucun des éléments attendus : ${(testCase.mustMatchAny || []).join(', ')}`);
    }
  }

  for (const pattern of testCase.mustNotMatch || []) {
    const regex = safeRegex(pattern);
    if (regex && regex.test(text)) reasons.push(`Élément interdit présent : ${pattern}`);
  }

  return { status: reasons.length ? 'fail' : 'pass', handoff, reasons };
}

async function runAiEvaluation({ cases, ask, onProgress = () => {} }) {
  const results = [];
  for (const [index, testCase] of cases.entries()) {
    const startedAt = Date.now();
    let reply = '';
    let error = '';
    try {
      reply = String(await ask(testCase, index) ?? '');
    } catch (askError) {
      error = askError?.message || String(askError);
    }
    const verdict = error
      ? { status: 'error', handoff: false, reasons: [`Erreur IA : ${error}`] }
      : evaluateReply(testCase, reply);
    results.push({
      id: testCase.id,
      source: testCase.source || 'reference',
      question: testCase.question,
      mode: testCase.mode || 'safe',
      note: testCase.note || '',
      reply: reply.replace(HANDOFF_MARKER, '').trim().slice(0, 1200),
      durationMs: Date.now() - startedAt,
      ...verdict
    });
    onProgress(index + 1, cases.length);
  }

  const passed = results.filter(item => item.status === 'pass').length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    score: results.length ? Math.round((passed / results.length) * 100) : null,
    results
  };
}

module.exports = {
  loadReferenceCases,
  buildCatalogCases,
  evaluateReply,
  runAiEvaluation,
  priceDigitsPattern
};
