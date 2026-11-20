// ============================================================
// MONDECO — garde-fou factuel des réponses IA (prix, composition)
// lib/reply-fact-guard.js
//
// V6.45 — Rien ne vérifiait les montants et la composition d'une réponse
// IA avant envoi : « Chambre à coucher Bianca (lit + 2 tables de nuit)
// 2800 dt » est parti tel quel alors que la fiche du site indique 6590 dt
// (au lieu de 7200 dt) et une composition complète. Ce module :
// - extrait les montants d'une réponse (dt, tnd, dinar, د.ت, chiffres
//   arabes-indiens, séparateurs de milliers) ;
// - compare chaque montant aux prix du produit identifié (normal, promo,
//   variantes) et aux montants fixes autorisés (frais de livraison…) ;
// - compare la liste de meubles annoncée (lit, tables de nuit, dressing…)
//   à la composition du catalogue ;
// - construit la réponse de remplacement à partir du catalogue.
// ============================================================

'use strict';

const {
  normalizeText,
  toLatinDigits,
  tokenize,
  displayProductName,
  buildProductIndex,
  findIndexedProduct,
  resolveProduct,
  STRONG_TYPES,
  WEAK_TYPES
} = require('./product-resolver');
const { otherSpecsText } = require('./woo-description');

function safeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// ------------------------------------------------------------
// Montants
// ------------------------------------------------------------

// « 6590 », « 6 590 », « 6.590 » (milliers), « 6590.000 » (millimes),
// « 289,5 ».
function parseAmountString(raw) {
  const text = toLatinDigits(safeText(raw)).replace(/[\s  ٬']/g, '').replace(/٫/g, '.');
  if (!/^\d[\d.,]*$/.test(text)) return 0;
  // V6.45 — « 6.590,000 » / « 6,590.000 » : le dernier séparateur est la
  // virgule décimale (millimes), l'autre sépare les milliers.
  if (text.includes('.') && text.includes(',')) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    const [integer, fraction = ''] = text.split(thousands).join('').split(decimal);
    if (fraction.includes('.') || fraction.includes(',')) return 0;
    return (Number(integer) || 0) + (fraction ? Number(`0.${fraction}`) : 0);
  }
  const groups = text.split(/[.,]/);
  if (groups.length === 1) return Number(groups[0]) || 0;
  const last = groups[groups.length - 1];
  const thousands =
    groups[0].length <= 3 &&
    groups.slice(1).every(group => group.length === 3);
  if (thousands) return Number(groups.join('')) || 0;
  if (last.length <= 3) {
    const integer = Number(groups.slice(0, -1).join('')) || 0;
    return integer + Number(`0.${last}`);
  }
  return Number(groups.join('')) || 0;
}

function parsePriceValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const text = safeText(value).replace(/\s*(?:dt|tnd|dinars?|د\.?\s?ت)\s*$/i, '');
  const amount = parseAmountString(text);
  return amount > 0 ? amount : 0;
}

function sameAmount(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.5;
}

// V6.45 — « 127.400 TND » (6 mois x 127.400) : en dinars, trois chiffres
// après le point sont souvent des millimes (127,4 dt), pas des milliers.
// Les deux lectures sont gardées pour la comparaison.
function alternateAmountReading(raw) {
  const text = toLatinDigits(safeText(raw)).replace(/[\s  ']/g, '');
  const match = text.match(/^(\d{1,3})[.,٫](\d{3})$/);
  if (!match) return 0;
  return Number(match[1]) + Number(`0.${match[2]}`);
}

function amountValues(item) {
  return item.alt > 0 ? [item.value, item.alt] : [item.value];
}

const CURRENCY_ALTERNATION = 'dt|d\\.\\s?t\\.?|tnd|dinars?|د\\.?\\s?ت|دينار|دنانير|دينارات';
const CURRENCY_PATTERN = `(?:${CURRENCY_ALTERNATION})`;
const NUMBER_PATTERN = '(\\d{1,3}(?:[\\s\\u00a0\\u202f.,\\u066c]\\d{3})+(?:[.,]\\d{1,3})?|\\d+(?:[.,]\\d{1,3})?)';
const AMOUNT_WITH_CURRENCY = new RegExp(`${NUMBER_PATTERN}\\s*${CURRENCY_PATTERN}(?![\\p{L}])`, 'giu');
// Unités qui font qu'un nombre n'est pas un prix (« 160 x 200 », « 50 km »).
const NOT_PRICE_UNIT =
  `(?:${CURRENCY_ALTERNATION}|cm|mm|m\\b|m[eè]tres?|km|kg|g\\b|x|×|%|places?|pi[eè]ces?|ans?\\b|jours?|mois|h\\b|heures?|min|portes?|tiroirs?|personnes?|chaises?|كم|سم|\\d)`;
// Nombre sans devise mais annoncé comme un prix (« au prix de 2800 »).
// V6.45 — aussi « est à 2800 », « pour 2800 », « c'est 2800 ».
const PRICE_CONTEXT_NUMBER = new RegExp(
  `(?:prix|tarif|co[uû]te(?:nt)?|vaut|au\\s+lieu\\s+de|seulement|[àa]\\s+partir\\s+de|` +
  `\\b(?:est|sont)\\s+[àa]\\s|\\bc['’]?\\s?est\\s+(?:[àa]\\s+)?|\\bpour\\s|` +
  `سعر|السعر|بسوم|سومها|سومو|ثمن|عوض)` +
  `[^\\d\\n]{0,25}?${NUMBER_PATTERN}(?!\\s*${NOT_PRICE_UNIT})`,
  'giu'
);
// « بـ 2800 », « ب2800 » (préfixe arabe collé au nombre) et
// « 2800 seulement ».
const PRICE_PREFIX_NUMBER = new RegExp(
  `(?:^|[^\\p{L}])بـ?\\s?${NUMBER_PATTERN}(?!\\s*${NOT_PRICE_UNIT})`,
  'gu'
);
const PRICE_SUFFIX_NUMBER = new RegExp(
  `${NUMBER_PATTERN}\\s+(?:seulement|uniquement|فقط|برك)`,
  'giu'
);

// V6.45 — Ni un numéro de téléphone (« appelez le 70 123 456 ») ni une
// année (« valable en 2026 ») ne sont des prix.
const DATE_CONTEXT = /(?:\b(?:en|depuis|jusqu['’]?\s?en|jusqu['’]?\s?au|ann[ée]e|an|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|collection|saison|rentr[ée]e)\s*|عام|سنة|سنه)$/i;

// Code postal, adresse (« code postal 4000 », « avenue 14 janvier »).
const ADDRESS_CONTEXT = /(?:code\s+postal|\bcp|\bn[°o]|num[ée]ro|\brue|avenue|\bav\.?|route|\bkm)\s*:?\s*$/i;

function isNotPriceNumber(source, numberStart, raw) {
  const digits = toLatinDigits(raw).replace(/\D/g, '');
  if (digits.length >= 8) return true;
  if (ADDRESS_CONTEXT.test(source.slice(Math.max(0, numberStart - 20), numberStart))) return true;
  if (/^(?:19[89]\d|20[0-4]\d)$/.test(digits)) {
    const before = source.slice(Math.max(0, numberStart - 20), numberStart).trimEnd();
    if (DATE_CONTEXT.test(before)) return true;
  }
  return false;
}

function extractAmounts(text) {
  const source = toLatinDigits(safeText(text));
  const found = [];
  const taken = [];
  const push = (match, withCurrency) => {
    const numberStart = match.index + match[0].lastIndexOf(match[1]);
    if (taken.some(([start, end]) => numberStart >= start && numberStart < end)) return;
    if (!withCurrency && isNotPriceNumber(source, numberStart, match[1])) return;
    const value = parseAmountString(match[1]);
    if (!(value > 0) || (!withCurrency && value < 100)) return;
    found.push({ value, alt: alternateAmountReading(match[1]), raw: match[0].trim(), withCurrency });
    taken.push([numberStart, numberStart + match[1].length]);
  };
  for (const match of source.matchAll(AMOUNT_WITH_CURRENCY)) push(match, true);
  for (const regex of [PRICE_CONTEXT_NUMBER, PRICE_PREFIX_NUMBER, PRICE_SUFFIX_NUMBER]) {
    for (const match of source.matchAll(regex)) push(match, false);
  }
  return found;
}

// Nombres « nus » (3 à 6 chiffres, sans unité) : utilisés seulement pour
// repérer le prix d'un produit voisin (« Lit Bianca » 2800) cité sans
// devise pour le produit identifié.
const BARE_NUMBER = new RegExp(`(?<![\\d.,])${NUMBER_PATTERN}(?!\\s*${NOT_PRICE_UNIT})`, 'gu');

function extractBareNumbers(text) {
  const source = toLatinDigits(safeText(text));
  const found = [];
  for (const match of source.matchAll(BARE_NUMBER)) {
    if (isNotPriceNumber(source, match.index, match[1])) continue;
    const value = parseAmountString(match[1]);
    // Au-delà des dimensions courantes (cm) : seuls les montants de prix.
    if (value >= 400) found.push({ value, alt: alternateAmountReading(match[1]), raw: match[1], withCurrency: false });
  }
  return found;
}

// Tous les montants qu'une réponse peut citer pour ce produit.
function productAllowedAmounts(product) {
  const values = [];
  if (!product || typeof product !== 'object') return values;
  const add = value => {
    const amount = parsePriceValue(value);
    if (amount > 0) values.push(amount);
  };
  const addPair = (regular, promo) => {
    add(regular);
    add(promo);
    const r = parsePriceValue(regular);
    const p = parsePriceValue(promo);
    // « vous économisez 610 dt »
    if (r > 0 && p > 0 && r > p) values.push(r - p);
  };
  addPair(product.price, product.promoPrice);
  add(product.priceFrom);
  add(product.priceTo);
  add(product.regularPrice);
  add(product.salePrice);
  for (const variation of Array.isArray(product.variations) ? product.variations : []) {
    if (!variation || typeof variation !== 'object') continue;
    addPair(variation.regular_price || variation.regularPrice || variation.price, variation.sale_price || variation.salePrice || variation.promoPrice);
    add(variation.price);
  }
  return [...new Set(values.map(value => Math.round(value * 100) / 100))];
}

function hasCatalogPrice(product) {
  return productAllowedAmounts(product).length > 0;
}

// V6.45 — Montants de paiement imprimés sur la fiche du produit identifié
// (« Facilité en 6 fois : payer à la commande 396 TND … 6 mois x 264
// TND ») : la réponse peut les reprendre.
const PAYMENT_CONTEXT = /facilit|mois|mensualit|commande|avance|acompte|tranche|versement|\bfois\b|تقسيط|اقساط|شهر/i;

function productText(product) {
  const specs = product?.specs && typeof product.specs === 'object'
    ? Object.entries(product.specs).map(([label, value]) => `${label} : ${safeText(value)}`).join(' ; ')
    : '';
  return `${safeText(product?.description)} ${specs}`;
}

function productPaymentAmounts(product) {
  if (!product || typeof product !== 'object') return [];
  const source = toLatinDigits(productText(product));
  const values = [];
  for (const match of source.matchAll(AMOUNT_WITH_CURRENCY)) {
    const window = source.slice(Math.max(0, match.index - 60), match.index + match[0].length + 20);
    if (!PAYMENT_CONTEXT.test(window)) continue;
    const value = parseAmountString(match[1]);
    if (value > 0) values.push(value);
    const alt = alternateAmountReading(match[1]);
    if (alt > 0) values.push(alt);
  }
  return values;
}

// V6.45 — Prix des autres produits qui portent le même nom de modèle que
// le produit identifié (« Lit Bianca + 2 chevets » 2800 pour la « Chambre
// à Coucher Bianca ») : repérés même sans devise.
function siblingCatalogAmounts(product, catalog) {
  if (!product || !catalog) return [];
  try {
    const index = buildProductIndex(catalog);
    const item = findIndexedProduct(index, product);
    if (!item || !item.models.length) return [];
    const own = productAllowedAmounts(product);
    const values = [];
    for (const other of index.items) {
      if (other === item || !other.models.some(token => item.models.includes(token))) continue;
      for (const value of productAllowedAmounts(other.product)) {
        if (!own.some(amount => sameAmount(amount, value))) values.push(value);
      }
    }
    return [...new Set(values)];
  } catch {
    return [];
  }
}

// Montants fixes autorisés (frais de livraison…) : « 30, 50 » ou tableau.
function parseAllowedAmountList(value) {
  const list = Array.isArray(value) ? value : safeText(value).split(/[;,|\s]+/);
  return list.map(parsePriceValue).filter(amount => amount > 0);
}

// Montants cités dans les instructions MONDECO transmises au modèle, mais
// seulement dans un contexte livraison / paiement et sans meuble à côté :
// « Frais de livraison : 30 dt » oui, « Chambre Bianca : 2800 dt » non.
const SAFE_AMOUNT_CONTEXT = /livraison|livrer|frais|transport|montage|installation|avance|acompte|paiement|tranche|minimum|commande|توصيل|التوصيل|الخلاص|خلاص|تسبقه|التركيب/i;

// V6.45 — Le meuble n'est cherché que dans la phrase du montant (avant
// lui) : « Livraison gratuite pour les chambres. Pour les autres articles :
// 30 dt » autorise 30. Un meuble dans la même phrase n'est toléré que pour
// des frais de service (livraison, montage… cités avant le meuble) d'un
// petit montant : « Montage d'un dressing seul : 80 dt » oui, « Livraison
// offerte pour la chambre Bianca à 2800 dt » non.
const SERVICE_FEE_MAX = 300;

function safeInstructionAmounts(texts = []) {
  const allowed = [];
  for (const text of (Array.isArray(texts) ? texts : [texts]).map(safeText).filter(Boolean)) {
    const source = toLatinDigits(text);
    for (const match of source.matchAll(AMOUNT_WITH_CURRENCY)) {
      const start = Math.max(0, match.index - 160);
      const window = source.slice(start, match.index + match[0].length + 40);
      if (!SAFE_AMOUNT_CONTEXT.test(window)) continue;
      const value = parseAmountString(match[1]);
      if (!(value > 0)) continue;
      const clause = source.slice(start, match.index).split(/[.;!?؟\n]/).pop();
      const words = normalizeText(clause).split(' ').filter(Boolean);
      const furnitureAt = words.findIndex(word => {
        const token = tokenize(word)[0];
        return Boolean(token) && (STRONG_TYPES.has(token) || WEAK_TYPES.has(token));
      });
      if (furnitureAt >= 0) {
        const serviceAt = words.findIndex(word => SAFE_AMOUNT_CONTEXT.test(word));
        const serviceFirst = serviceAt >= 0 && serviceAt < furnitureAt;
        if (!serviceFirst || value >= SERVICE_FEE_MAX) continue;
      }
      allowed.push(value);
      const alt = alternateAmountReading(match[1]);
      if (alt > 0) allowed.push(alt);
    }
  }
  return allowed;
}

// ------------------------------------------------------------
// Composition (liste de meubles)
// ------------------------------------------------------------

const COUNT_WORDS = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8,
  'واحد': 1, 'واحده': 1, 'زوز': 2, 'اثنين': 2, 'ثلاثه': 3, 'اربعه': 4, 'سته': 6
};
const COUNT_PATTERN = '(\\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|واحد|واحده|زوز|اثنين|ثلاثه|اربعه|سته)';

// Ordre important : les expressions longues avant les mots simples
// (« pouf de lit » n'est pas un lit, « table de nuit » n'est pas une table).
const ITEM_PATTERNS = [
  ['pouf', '(?:pouf|banc|banquette|coffre)s?\\s+(?:de\\s+|bout\\s+de\\s+)?lits?|bouts?\\s+de\\s+lits?'],
  ['chevet', 'chevets?'],
  // V6.45 — « coiffeuse avec miroir rond » : un seul meuble.
  ['coiffeuse', '(?:coiffeuses?|tables?\\s+(?:de\\s+)?coiffure)(?:\\s+(?:suspendue\\s+)?(?:avec|a)\\s+(?:un\\s+|son\\s+|le\\s+)?miroirs?(?:\\s+(?:rond|led|ovale))*)?'],
  ['lit', 'tetes?\\s+de\\s+lits?|lits?|sommiers?'],
  ['armoire', '(?:armoires?|dressings?|penderies?|garde\\s+robes?)(?:\\s+(?:avec|a)\\s+(?:un\\s+|son\\s+)?miroirs?)?'],
  ['commode', 'commodes?'],
  ['miroir', 'miroirs?'],
  ['pouf', 'poufs?|bancs?|banquettes?'],
  ['bureau', 'bureaux|bureau'],
  ['chaise', 'chaises?'],
  ['buffet', 'buffets?|vaisseliers?|bahuts?'],
  ['canape', 'canapes?'],
  ['fauteuil', 'fauteuils?'],
  ['matelas', 'matelas'],
  ['etagere', 'etageres?|bibliotheques?'],
  ['meuble tv', 'meubles?\\s+tv'],
  ['table', 'tables?']
];
const ITEM_REGEXES = ITEM_PATTERNS.map(([item, body]) => [
  item,
  new RegExp(`(?:${COUNT_PATTERN}\\s*(?:x\\s*)?)?\\b(?:${body})\\b`, 'g')
]);

const LISTING_CUES = /\b(?:comprend|comprenant|compren|compose|composee|composees|composition|inclut|incluant|inclus|incluse|contient|contenant|avec|constitue|constituee)\b|(?:^|\s)(?:يحتوي|تحتوي|فيها|فيه|متكونه|تتكون|يتكون)(?=\s|$)/;

// Map item -> nombre (null si non précisé).
function extractFurnitureItems(text) {
  // normalizeText remplace « tables de nuit » par « chevet » et le tounsi
  // par les mots du catalogue (كومودينو -> chevet, فرش -> lit…).
  let normalized = ` ${normalizeText(text).replace(/\bchevet\b/g, ' chevet ')} `;
  const items = new Map();
  for (const [item, regex] of ITEM_REGEXES) {
    regex.lastIndex = 0;
    normalized = normalized.replace(regex, (match, count) => {
      const raw = safeText(count);
      const value = raw ? (Number(raw) || COUNT_WORDS[raw] || null) : null;
      const previous = items.has(item) ? items.get(item) : undefined;
      if (previous === undefined) items.set(item, value);
      else if (previous !== null && value !== null) items.set(item, previous + value);
      return ' ';
    });
  }
  return items;
}

function isListing(text, items) {
  if (items.size >= 3) return true;
  if (items.size < 2) return false;
  return LISTING_CUES.test(normalizeText(text)) || /[+(:]/.test(safeText(text));
}

// V6.45 — Réponse oui/non sur quelques éléments (« Oui, elle comprend bien
// les 2 tables de nuit et le pouf ») : ce n'est pas la liste complète.
// Seulement si le client a demandé si ces éléments sont inclus, et que la
// réponse confirme leur inclusion sans en citer d'autres : « c'est lit + 2
// chevets ? » / « Oui, elle comprend un lit et 2 tables de nuit » reste
// refusé (présenté comme toute la chambre).
const CONFIRMATION_CUES = /\b(?:comprend|inclut|contient|sont|est)\s+bien\b|\bbien\s+(?:inclus|incluse|inclues|incluses|compris|comprise|comprises|fournis|fournie|fournies)\b|\bfai(?:t|saient|sait)?\s+partie\b|\bfont\s+partie\b|\b(?:aussi|egalement)\b/;
const INCLUSION_QUESTION = /\binclu|\bcompris|\bfai(?:t|s)?\s+partie|\bfont\s+partie|\by a\b|\baussi\b|\begalement\b|يجي|تجي|معاها|معاه/;

function isConfirmationOfItems(reply, replyItems, customerText) {
  const question = normalizeText(customerText);
  if (!question || !INCLUSION_QUESTION.test(question)) return false;
  if (!CONFIRMATION_CUES.test(normalizeText(reply))) return false;
  const asked = extractFurnitureItems(customerText);
  return asked.size > 0 && [...replyItems.keys()].every(item => asked.has(item));
}

function checkComposition(reply, product, { customerText = '' } = {}) {
  const replyItems = extractFurnitureItems(reply);
  if (!isListing(reply, replyItems)) return { ok: true, listed: false };

  // Miroir (accessoire) cité par la fiche elle-même (« coiffeuse : avec
  // miroir rond ») : accepté.
  const ownText = extractFurnitureItems(`${safeText(product?.name)} ${productText(product)}`);
  const accessoryOk = item => item === 'miroir' && ownText.has('miroir');

  const composition = safeText(product?.composition);
  if (composition) {
    const catalogItems = extractFurnitureItems(composition);
    if (catalogItems.size) {
      const extra = [...replyItems.keys()].filter(item => !catalogItems.has(item) && !accessoryOk(item));
      if (extra.length) return { ok: false, listed: true, reason: `éléments absents de la fiche : ${extra.join(', ')}` };
      const wrongCount = [...replyItems.entries()].filter(([item, count]) =>
        count !== null && catalogItems.get(item) !== null && catalogItems.get(item) !== undefined && catalogItems.get(item) !== count
      );
      if (wrongCount.length) return { ok: false, listed: true, reason: `quantités différentes de la fiche : ${wrongCount.map(([item]) => item).join(', ')}` };
      if (
        catalogItems.size >= 3 &&
        replyItems.size * 2 <= catalogItems.size &&
        !isConfirmationOfItems(reply, replyItems, customerText)
      ) {
        return { ok: false, listed: true, reason: 'composition incomplète par rapport à la fiche' };
      }
      return { ok: true, listed: true };
    }
  }

  // Sans ligne Composition : chaque meuble cité doit au moins figurer dans
  // le nom, la description ou les caractéristiques du produit.
  const unknown = [...replyItems.keys()].filter(item => !ownText.has(item));
  if (unknown.length) return { ok: false, listed: true, reason: `éléments absents de la fiche : ${unknown.join(', ')}` };
  return { ok: true, listed: true };
}

// ------------------------------------------------------------
// Vérification d'une réponse
// ------------------------------------------------------------

const HANDOFF_MARKER = /\[COMMERCIAL_REQUIRED\]/i;

// V6.45 — Plusieurs produits possibles : chaque phrase qui cite un montant
// doit nommer le produit concerné (ou suivre une phrase qui le nomme), et
// le montant doit être un prix de CE produit : le prix de la Chambre Enfant
// Bianca Junior n'est jamais accepté pour la Chambre à Coucher Bianca.
function splitSegments(text) {
  return safeText(text)
    .split(/\n+|(?<=[.!?؟])\s+|\s+[•·]\s+|^[•·]\s*/m)
    .map(part => part.trim())
    .filter(Boolean);
}

function ambiguousBadAmounts(text, candidates, globalAllowed, matches) {
  let index;
  try {
    index = buildProductIndex(candidates);
  } catch {
    return null;
  }
  const bad = [];
  let named = [];
  for (const segment of splitSegments(text)) {
    const resolution = resolveProduct({ message: segment }, index);
    if (resolution.status === 'resolved') named = [resolution.product];
    else if (resolution.status === 'ambiguous' && resolution.candidates.length) named = resolution.candidates;
    const amounts = extractAmounts(segment);
    if (!amounts.length) continue;
    const allowed = [...globalAllowed, ...named.flatMap(productAllowedAmounts)];
    for (const item of amounts) {
      if (!matches(allowed, item)) bad.push(item.value);
    }
  }
  return bad;
}

// options : { status: 'resolved'|'ambiguous'|'none', product, candidates[],
//             allowedAmounts[], instructionTexts[], customerText, catalog }
function checkReplyFacts(reply, options = {}) {
  const text = safeText(reply);
  if (!text || HANDOFF_MARKER.test(text)) return { ok: true, skipped: true, amounts: [], badAmounts: [] };

  const status = safeText(options.status) || 'none';
  const product = status === 'resolved' ? options.product : null;
  const candidates = status === 'ambiguous' && Array.isArray(options.candidates) ? options.candidates.filter(Boolean) : [];
  const matches = (allowedList, item) =>
    amountValues(item).some(candidate => allowedList.some(value => sameAmount(value, candidate)));

  const amounts = extractAmounts(text);
  const catalogAmounts = [
    ...(product ? productAllowedAmounts(product) : []),
    ...candidates.flatMap(productAllowedAmounts)
  ];
  // V6.45 — Montant cité par le client (« toujours à 2800 dt ? ») : repris
  // seulement s'il n'y a pas de prix catalogue, ou si la réponse cite aussi
  // un vrai prix du catalogue (« votre budget 3000 dt ; elle est à 6590
  // dt »). Sinon le prix périmé que le client a vu ailleurs serait
  // confirmé.
  const citesCatalog = amounts.some(item => matches(catalogAmounts, item));
  const customerAmounts = !catalogAmounts.length || citesCatalog
    ? extractAmounts(options.customerText).flatMap(amountValues)
    : [];
  const globalAllowed = [
    ...parseAllowedAmountList(options.allowedAmounts || []),
    ...safeInstructionAmounts(options.instructionTexts || []),
    ...customerAmounts
  ];
  const allowed = [
    ...catalogAmounts,
    ...(product ? productPaymentAmounts(product) : []),
    ...globalAllowed
  ];

  let badAmounts = null;
  if (candidates.length > 1) {
    badAmounts = ambiguousBadAmounts(text, candidates, globalAllowed, matches);
  }
  if (!badAmounts) {
    badAmounts = amounts
      .filter(item => !matches(allowed, item))
      .map(item => item.value);
  }

  // Prix d'un produit voisin du même modèle cité sans devise ni mot-clé.
  if (product && options.catalog) {
    const siblings = siblingCatalogAmounts(product, options.catalog);
    if (siblings.length) {
      for (const item of extractBareNumbers(text)) {
        if (matches(allowed, item)) continue;
        if (matches(siblings, item) && !badAmounts.some(value => sameAmount(value, item.value))) badAmounts.push(item.value);
      }
    }
  }

  const composition = product
    ? checkComposition(text, product, { customerText: options.customerText })
    : { ok: true, listed: false };

  const reasons = [];
  if (badAmounts.length) {
    reasons.push(product || candidates.length
      ? `montant(s) hors fiche : ${badAmounts.join(', ')}`
      : `montant(s) cités sans produit identifié : ${badAmounts.join(', ')}`);
  }
  if (!composition.ok) reasons.push(composition.reason);

  return {
    ok: reasons.length === 0,
    amounts: amounts.map(item => item.value),
    allowed: [...new Set(allowed)],
    badAmounts,
    composition,
    reasons
  };
}

// ------------------------------------------------------------
// Réponses construites à partir du catalogue
// ------------------------------------------------------------

function formatAmount(value) {
  const amount = parsePriceValue(value);
  if (!(amount > 0)) return '';
  return Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 100) / 100);
}

function safeUrl(value) {
  const url = safeText(value);
  return /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : '';
}

function variationLabel(variation) {
  const attributes = Array.isArray(variation?.attributes)
    ? variation.attributes
    : variation?.attributes && typeof variation.attributes === 'object'
      ? Object.entries(variation.attributes).map(([name, option]) => ({ name, option }))
      : [];
  const label = attributes
    .map(attribute => safeText(attribute?.option ?? attribute?.value))
    .filter(Boolean)
    .join(' / ');
  return label || safeText(variation?.name) || safeText(variation?.sku);
}

function variationPrices(product) {
  return (Array.isArray(product?.variations) ? product.variations : [])
    .map(variation => {
      const regular = formatAmount(variation?.regular_price || variation?.regularPrice || variation?.price);
      const promo = formatAmount(variation?.sale_price || variation?.salePrice || variation?.promoPrice);
      return {
        label: variationLabel(variation),
        regular,
        promo: promo && promo !== regular ? promo : ''
      };
    })
    .filter(item => item.label && (item.regular || item.promo));
}

// Texte de prix, ex. « 6590 dt au lieu de 7200 dt (promotion en cours) ».
function priceSentence(product, { arabic = false } = {}) {
  const regular = formatAmount(product?.price);
  const promo = formatAmount(product?.promoPrice);
  const variations = variationPrices(product);
  if (variations.length > 1) {
    const list = variations
      .slice(0, 6)
      .map(item => `${item.label} : ${item.promo ? `${item.promo} dt (${arabic ? 'عوض' : 'au lieu de'} ${item.regular} dt)` : `${item.regular} dt`}`)
      .join(' ; ');
    return arabic ? `حسب الاختيار : ${list}` : `selon le modèle choisi : ${list}`;
  }
  if (promo && regular && promo !== regular) {
    return arabic
      ? `${promo} dt عوض ${regular} dt (برومو)`
      : `${promo} dt au lieu de ${regular} dt (promotion en cours)`;
  }
  const single = promo || regular || formatAmount(product?.priceFrom);
  if (!single) return '';
  if (!regular && !promo && formatAmount(product?.priceTo) && formatAmount(product?.priceTo) !== single) {
    return arabic
      ? `من ${single} dt حتى ${formatAmount(product.priceTo)} dt`
      : `à partir de ${single} dt (jusqu'à ${formatAmount(product.priceTo)} dt selon le modèle)`;
  }
  return `${single} dt`;
}

// Réponse déterministe : nom, composition, prix promo + normal, lien.
// Chaîne vide si le catalogue n'a pas de prix (=> transfert commercial).
function buildCatalogAnswer(product, { arabic = false, includeLink = true } = {}) {
  if (!product) return '';
  const price = priceSentence(product, { arabic });
  if (!price) return '';
  const name = displayProductName(product);
  const composition = safeText(product.composition);
  const head = `${name}${composition ? ` (${composition})` : ''}`;
  const lines = [
    arabic ? `${head} : ${price} 😊` : `${head} : ${price} 😊`
  ];
  const url = includeLink ? safeUrl(product.productUrl) || safeUrl(product.categoryUrl) : '';
  if (url) lines.push(arabic ? `تنجم تشوفو هنا : ${url}` : `Voir le produit : ${url}`);
  lines.push(arabic
    ? 'تحب تفاصيل أخرى (القياسات، التوفر في الشوروم) ؟'
    : 'Souhaitez-vous d’autres détails (dimensions, disponibilité en showroom) ?');
  return lines.join('\n');
}

// Question de choix entre plusieurs produits, avec leurs prix catalogue.
function buildDisambiguationQuestion(candidates = [], { arabic = false } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean).slice(0, 3);
  if (!list.length) return '';
  const lines = list.map(product => {
    const price = priceSentence(product, { arabic });
    return `• ${displayProductName(product)}${price ? ` : ${price}` : ''}`;
  });
  if (list.length === 1) {
    return arabic
      ? `تحكي على ${displayProductName(list[0])} ؟ 😊`
      : `Vous parlez bien de : ${displayProductName(list[0])} ? 😊`;
  }
  return [
    arabic ? 'عندنا برشا موديلات بهذا الاسم 😊 شنوة اللي يهمك ؟' : 'Nous avons plusieurs modèles qui correspondent 😊 Lequel vous intéresse ?',
    ...lines
  ].join('\n');
}

// Bloc « PRODUIT ACTIF » du prompt : données structurées et compactes,
// description plafonnée.
const AVAILABILITY_LABELS = {
  in_stock: 'En stock',
  on_order: 'Sur commande',
  out_of_stock: 'Rupture',
  clearance: 'Déstockage',
  unknown: 'À confirmer',
  instock: 'En stock',
  outofstock: 'Rupture',
  onbackorder: 'Sur commande'
};

function productFactsBlock(product, { maxDescriptionChars = 600, maxSpecsChars = 400 } = {}) {
  if (!product) return '';
  const lines = [`Produit : ${displayProductName(product)}`];
  const fullName = safeText(product.name);
  if (fullName && fullName !== displayProductName(product)) lines.push(`Nom complet : ${fullName}`);
  if (safeText(product.category)) lines.push(`Catégorie : ${safeText(product.category)}`);
  const regular = formatAmount(product.price);
  const promo = formatAmount(product.promoPrice);
  const variations = variationPrices(product);
  // V6.45 — Produit variable à prix différents : price / promoPrice sont
  // ceux de la variante la moins chère ; ils ne sont jamais présentés comme
  // le prix du produit (« Junior Salma en bleu » n'est pas en promotion).
  const signatures = new Set(variations.map(item => `${item.regular}|${item.promo}`));
  const variablePrices = variations.length > 1 && signatures.size > 1;
  if (variablePrices) {
    const effective = variations
      .map(item => Number(item.promo || item.regular))
      .filter(value => Number.isFinite(value) && value > 0);
    const from = formatAmount(Math.min(...effective));
    const to = formatAmount(Math.max(...effective));
    lines.push(`Prix : à partir de ${from} TND${to && to !== from ? ` (jusqu'à ${to} TND selon la variante)` : ''} — donner le prix de la variante demandée, sinon la liste des variantes`);
  } else {
    if (regular) lines.push(`Prix normal : ${regular} TND`);
    if (promo && promo !== regular) lines.push(`Prix promotionnel : ${promo} TND (promotion en cours : donner le prix promotionnel ET le prix normal)`);
    if (!regular && !promo) {
      const from = formatAmount(product.priceFrom);
      const to = formatAmount(product.priceTo);
      if (from) lines.push(`Prix : à partir de ${from} TND${to && to !== from ? ` (jusqu'à ${to} TND)` : ''}`);
    }
  }
  if (variations.length) {
    lines.push(`${variablePrices ? 'Prix par variante' : 'Variantes'} : ${variations.slice(0, 8).map(item => `${item.label} = ${item.promo ? `${item.promo} TND en promotion (au lieu de ${item.regular} TND)` : `${item.regular} TND`}`).join(' ; ')}`);
  }
  if (!regular && !promo && !variations.length && !formatAmount(product.priceFrom)) {
    lines.push('Prix : non renseigné dans le catalogue (ne cite aucun prix)');
  }
  // V6.45 — Pack sans ligne « Composition » fiable : la description et les
  // caractéristiques listent les ensembles ; le garde-fou accepte les
  // meubles qui y figurent.
  const describedItems = extractFurnitureItems(productText(product)).size;
  lines.push(safeText(product.composition)
    ? `Composition : ${safeText(product.composition)}`
    : describedItems >= 2
      ? 'Composition : voir la description et les caractéristiques (n’énumère que les éléments qui y figurent)'
      : 'Composition : non renseignée (n’énumère aucun élément)');
  if (safeText(product.dimensions)) lines.push(`Dimensions : ${safeText(product.dimensions)}`);
  const availability = safeText(product.availability || product.woocommerceStockStatus);
  if (availability) lines.push(`Disponibilité : ${AVAILABILITY_LABELS[availability] || availability}`);
  if (safeText(product.colors)) lines.push(`Couleurs disponibles : ${safeText(product.colors)}`);
  if (safeText(product.showrooms)) lines.push(`Showrooms : ${safeText(product.showrooms)}`);
  // V6.45 — Caractéristiques (matière, structure, mousse…) et
  // personnalisation : le bloc complet du produit n'est plus dans le
  // contexte, elles doivent figurer ici.
  const specsText = product.specs && typeof product.specs === 'object'
    ? otherSpecsText(product.specs, maxSpecsChars)
    : '';
  if (specsText) lines.push(`Caractéristiques : ${specsText}`);
  const customizations = [
    product.customizableColor === true ? 'couleur' : '',
    product.customizableFabric === true ? 'tissu' : '',
    product.customizableDimensions === true ? 'dimensions' : '',
    product.customizableCorner === true ? 'coin/orientation' : ''
  ].filter(Boolean);
  if (customizations.length) lines.push(`Personnalisation possible : ${customizations.join(', ')}`);
  if (safeUrl(product.productUrl)) lines.push(`Lien produit : ${safeUrl(product.productUrl)}`);
  const description = safeText(product.description).replace(/\[\/?vc_[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (description) {
    lines.push(`Description : ${description.length > maxDescriptionChars ? `${description.slice(0, maxDescriptionChars).replace(/\s+\S*$/, '')}…` : description}`);
  }
  return lines.join('\n');
}

module.exports = {
  parseAmountString,
  parsePriceValue,
  extractAmounts,
  productAllowedAmounts,
  hasCatalogPrice,
  parseAllowedAmountList,
  safeInstructionAmounts,
  extractFurnitureItems,
  checkComposition,
  checkReplyFacts,
  productPaymentAmounts,
  siblingCatalogAmounts,
  priceSentence,
  buildCatalogAnswer,
  buildDisambiguationQuestion,
  productFactsBlock,
  formatAmount
};
