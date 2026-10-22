// MONDECO - Detecte si un message nomme un produit
const fs = require('fs');
const PRODUCTS = '/data/products.json';
let cache = { t: 0, words: null };

function norm(t) {
  return String(t || '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const STOP = new Set((
  'table chambre salon avec manger enfant pack ' +
  'chaises tunisie basse bureau mariage portes ' +
  'meuble coffre pouf capitonne coucher armoire ' +
  'moderne fauteuil chaise rangement matelas ' +
  'porte enfants nuit bois sans confort jardin ' +
  'chaussures canape cuisine salle places lits ' +
  'coiffeuse coin blanc ronde buffet dressing ' +
  'orthopedique niche entree argentiere miroir ' +
  'adulte element angle gris noir bleu beige ' +
  'confortex'
).split(' '));

const KEEP = new Set((
  'ibiza zina ramla violette bianca eline moka ' +
  'tiago twins iris'
).split(' '));

function modelWords() {
  if (cache.words && Date.now() - cache.t < 600000) {
    return cache.words;
  }
  const count = {};
  try {
    const raw = JSON.parse(fs.readFileSync(PRODUCTS, 'utf8'));
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    for (const p of list) {
      if (!p || p.active === false) continue;
      const seen = new Set(
        norm(p.name).split(/[^a-z0-9]+/)
          .filter(w => w.length >= 4 && !/^\d+$/.test(w))
      );
      seen.forEach(w => { count[w] = (count[w] || 0) + 1; });
    }
  } catch (e) { /* liste vide */ }
  const set = new Set();
  Object.keys(count).forEach(w => {
    if (STOP.has(w)) return;
    if (KEEP.has(w) || count[w] < 20) set.add(w);
  });
  cache = { t: Date.now(), words: set };
  return set;
}

function hasArabic(t) {
  return /[\u0600-\u06FF]/.test(String(t || ''));
}

function namedProduct(text) {
  const words = modelWords();
  return norm(text).split(/[^a-z0-9]+/)
    .filter(w => words.has(w));
}

module.exports = { namedProduct, modelWords, hasArabic };
