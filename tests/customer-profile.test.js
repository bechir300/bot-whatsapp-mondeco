// Tests de la fiche client et du parcours de vente (lib/customer-profile.js).
const assert = require('assert');
const {
  applyCustomerProfileUpdate,
  highestStageRank,
  computeSalesFunnel,
  buildProfileExtractionPrompt,
  parseProfileExtraction
} = require('../lib/customer-profile');

let passed = 0;
function test(label, fn) { fn(); passed++; console.log('PASS', label); }

const showroomKeys = ['soukra', 'sfax'];

test('mise à jour : champs nettoyés, auteur et date, historique des étapes', () => {
  const first = applyCustomerProfileUpdate(null, {
    stage: 'qualifie', city: '  Sfax\n', budget: '3000 DT', products: 'salon', showroom: 'sfax', note: 'Rappeler\r\nlundi'
  }, { actor: 'Leila', now: '2026-10-23T09:00:00.000Z', showroomKeys });
  assert.deepStrictEqual(first, {
    stage: 'qualifie', city: 'Sfax', budget: '3000 DT', products: 'salon', showroom: 'sfax', note: 'Rappeler\nlundi',
    stageChangedAt: '2026-10-23T09:00:00.000Z',
    stageHistory: [{ stage: 'qualifie', at: '2026-10-23T09:00:00.000Z', by: 'Leila' }],
    updatedAt: '2026-10-23T09:00:00.000Z', updatedBy: 'Leila'
  });

  const second = applyCustomerProfileUpdate(first, { stage: 'devis', city: 'Sfax' }, { actor: 'Sami', now: '2026-10-24T09:00:00.000Z', showroomKeys });
  assert.strictEqual(second.stageHistory.length, 2);
  assert.strictEqual(second.city, 'Sfax');
  assert.strictEqual(second.updatedBy, 'Sami');
});

test('aucun changement = null ; étape ou showroom inconnus ignorés', () => {
  const base = { stage: 'devis', city: 'Sousse', showroom: 'soukra' };
  assert.strictEqual(applyCustomerProfileUpdate(base, { stage: 'devis', city: 'Sousse' }, { showroomKeys }), null);
  assert.strictEqual(applyCustomerProfileUpdate(base, { stage: 'vendu', showroom: 'paris' }, { showroomKeys }), null);
  assert.strictEqual(applyCustomerProfileUpdate({}, {}, { showroomKeys }), null);
});

test('étape la plus avancée jamais atteinte', () => {
  assert.strictEqual(highestStageRank({ stage: 'perdu', stageHistory: [{ stage: 'qualifie' }, { stage: 'visite' }, { stage: 'perdu' }] }), 3);
  assert.strictEqual(highestStageRank(null), 0);
});

test('parcours de vente : période, étapes atteintes, publicités', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const recent = '2026-10-22T10:00:00Z';
  const states = {
    a: { lastCustomerAt: recent, adReferral: { productHint: 'Salon Fiorie' }, customerProfile: { stage: 'commande', stageHistory: [{ stage: 'qualifie' }, { stage: 'commande' }] } },
    b: { lastCustomerAt: recent, adReferral: { headline: 'Salon Fiorie | -20%' }, customerProfile: { stage: 'perdu', stageHistory: [{ stage: 'devis' }, { stage: 'perdu' }] } },
    c: { lastCustomerAt: recent, adReferral: { productHint: 'Table Opale' } },
    d: { lastCustomerAt: recent },
    old: { lastCustomerAt: '2026-08-01T10:00:00Z', customerProfile: { stage: 'commande' } }
  };
  const funnel = computeSalesFunnel(states, { sinceMs: now - 30 * 86400000 });
  assert.deepStrictEqual(funnel.reached, { conversations: 4, qualifie: 2, devis: 2, visite: 1, commande: 1 });
  assert.strictEqual(funnel.current.perdu, 1);
  assert.strictEqual(funnel.current.nouveau, 2);
  assert.strictEqual(funnel.withProfile, 2);
  assert.strictEqual(funnel.rates.commande, 25);
  assert.deepStrictEqual(funnel.ads[0], { ad: 'Salon Fiorie', conversations: 2, qualifie: 2, devis: 2, visite: 1, commande: 1, orderRate: 50 });
  assert.strictEqual(funnel.ads[1].ad, 'Table Opale');
  assert.ok(!JSON.stringify(funnel).includes('"a"'));
});

test('analyse IA : JSON entouré de texte, valeurs filtrées', () => {
  const prompt = buildProfileExtractionPrompt([{ key: 'sfax', name: 'Sfax' }]);
  assert.ok(prompt.includes('sfax (Sfax)'));
  const parsed = parseProfileExtraction('```json\n{"city":"Sfax","budget":"","products":"salon d\'angle","showroom":"SFAX","stage":"commande","note":"Veut livrer en décembre."}\n```\n\n🛋️ Découvrez toute la gamme : https://mondeco.tn/categorie-produit/salon/', { showroomKeys });
  assert.deepStrictEqual(parsed, { city: 'Sfax', budget: '', products: "salon d'angle", showroom: 'sfax', stage: 'commande', note: 'Veut livrer en décembre.' });
  assert.strictEqual(parseProfileExtraction('{"showroom":"paris","stage":"perdu"}', { showroomKeys }).showroom, '');
  assert.strictEqual(parseProfileExtraction('{"stage":"perdu"}', { showroomKeys }).stage, '');
  assert.strictEqual(parseProfileExtraction('[COMMERCIAL_REQUIRED]'), null);
  assert.strictEqual(parseProfileExtraction('{pas du json}'), null);
});

console.log(`${passed} test(s) fiche client OK`);
