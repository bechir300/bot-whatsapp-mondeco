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
  STRONG_TYPES,
  WEAK_TYPES
} = require('./product-resolver');

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

const CURRENCY_ALTERNATION = 'dt|d\\.\\s?t\\.?|tnd|dinars?|د\\.?\\s?ت|دينار|دنانير|دينارات';
const CURRENCY_PATTERN = `(?:${CURRENCY_ALTERNATION})`;
const NUMBER_PATTERN = '(\\d{1,3}(?:[\\s\\u00a0\\u202f.,\\u066c]\\d{3})+(?:[.,]\\d{1,3})?|\\d+(?:[.,]\\d{1,3})?)';
const AMOUNT_WITH_CURRENCY = new RegExp(`${NUMBER_PATTERN}\\s*${CURRENCY_PATTERN}(?![\\p{L}])`, 'giu');
// Nombre sans devise mais annoncé comme un prix (« au prix de 2800 »).
const PRICE_CONTEXT_NUMBER = new RegExp(
  `(?:prix|tarif|co[uû]te(?:nt)?|vaut|au\\s+lieu\\s+de|seulement|[àa]\\s+partir\\s+de|سعر|السعر|بسوم|سومها|سومو|ثمن|عوض)` +
  `[^\\d\\n]{0,25}?${NUMBER_PATTERN}(?!\\s*(?:${CURRENCY_ALTERNATION}|cm|mm|m\\b|km|kg|g\\b|x|×|%|places?|pi[eè]ces?|ans?\\b|jours?|mois|h\\b|heures?|min|portes?|tiroirs?|personnes?|chaises?|كم|سم|\\d))`,
  'giu'
);

function extractAmounts(text) {
  const source = toLatinDigits(safeText(text));
  const found = [];
  const taken = [];
  for (const match of source.matchAll(AMOUNT_WITH_CURRENCY)) {
    const value = parseAmountString(match[1]);
    if (value > 0) {
      found.push({ value, raw: match[0].trim(), withCurrency: true });
      taken.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of source.matchAll(PRICE_CONTEXT_NUMBER)) {
    const numberStart = match.index + match[0].lastIndexOf(match[1]);
    if (taken.some(([start, end]) => numberStart >= start && numberStart < end)) continue;
    const value = parseAmountString(match[1]);
    if (value >= 100) found.push({ value, raw: match[0].trim(), withCurrency: false });
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

// Montants fixes autorisés (frais de livraison…) : « 30, 50 » ou tableau.
function parseAllowedAmountList(value) {
  const list = Array.isArray(value) ? value : safeText(value).split(/[;,|\s]+/);
  return list.map(parsePriceValue).filter(amount => amount > 0);
}

// Montants cités dans les instructions MONDECO transmises au modèle, mais
// seulement dans un contexte livraison / paiement et sans meuble à côté :
// « Frais de livraison : 30 dt » oui, « Chambre Bianca : 2800 dt » non.
const SAFE_AMOUNT_CONTEXT = /livraison|livrer|frais|transport|montage|installation|avance|acompte|paiement|tranche|minimum|commande|توصيل|التوصيل|الخلاص|خلاص|تسبقه|التركيب/i;

function safeInstructionAmounts(texts = []) {
  const allowed = [];
  for (const text of (Array.isArray(texts) ? texts : [texts]).map(safeText).filter(Boolean)) {
    const source = toLatinDigits(text);
    for (const match of source.matchAll(AMOUNT_WITH_CURRENCY)) {
      const start = Math.max(0, match.index - 80);
      const window = source.slice(start, match.index + match[0].length + 40);
      if (!SAFE_AMOUNT_CONTEXT.test(window)) continue;
      const furniture = tokenize(window).some(token => STRONG_TYPES.has(token) || WEAK_TYPES.has(token));
      if (furniture) continue;
      const value = parseAmountString(match[1]);
      if (value > 0) allowed.push(value);
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
  ['coiffeuse', 'coiffeuses?|tables?\\s+(?:de\\s+)?coiffure'],
  ['lit', 'tetes?\\s+de\\s+lits?|lits?|sommiers?'],
  ['armoire', 'armoires?|dressings?|penderies?|garde\\s+robes?'],
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

function checkComposition(reply, product) {
  const replyItems = extractFurnitureItems(reply);
  if (!isListing(reply, replyItems)) return { ok: true, listed: false };

  const composition = safeText(product?.composition);
  if (composition) {
    const catalogItems = extractFurnitureItems(composition);
    if (catalogItems.size) {
      const extra = [...replyItems.keys()].filter(item => !catalogItems.has(item));
      if (extra.length) return { ok: false, listed: true, reason: `éléments absents de la fiche : ${extra.join(', ')}` };
      const wrongCount = [...replyItems.entries()].filter(([item, count]) =>
        count !== null && catalogItems.get(item) !== null && catalogItems.get(item) !== undefined && catalogItems.get(item) !== count
      );
      if (wrongCount.length) return { ok: false, listed: true, reason: `quantités différentes de la fiche : ${wrongCount.map(([item]) => item).join(', ')}` };
      if (catalogItems.size >= 3 && replyItems.size * 2 <= catalogItems.size) {
        return { ok: false, listed: true, reason: 'composition incomplète par rapport à la fiche' };
      }
      return { ok: true, listed: true };
    }
  }

  // Sans ligne Composition : chaque meuble cité doit au moins figurer dans
  // le nom ou la description du produit.
  const reference = extractFurnitureItems(`${safeText(product?.name)} ${safeText(product?.description)}`);
  const unknown = [...replyItems.keys()].filter(item => !reference.has(item));
  if (unknown.length) return { ok: false, listed: true, reason: `éléments absents de la fiche : ${unknown.join(', ')}` };
  return { ok: true, listed: true };
}

// ------------------------------------------------------------
// Vérification d'une réponse
// ------------------------------------------------------------

const HANDOFF_MARKER = /\[COMMERCIAL_REQUIRED\]/i;

// options : { status: 'resolved'|'ambiguous'|'none', product, candidates[],
//             allowedAmounts[], instructionTexts[], customerText }
function checkReplyFacts(reply, options = {}) {
  const text = safeText(reply);
  if (!text || HANDOFF_MARKER.test(text)) return { ok: true, skipped: true, amounts: [], badAmounts: [] };

  const status = safeText(options.status) || 'none';
  const product = status === 'resolved' ? options.product : null;
  const candidates = status === 'ambiguous' && Array.isArray(options.candidates) ? options.candidates : [];

  const allowed = [
    ...(product ? productAllowedAmounts(product) : []),
    ...candidates.flatMap(productAllowedAmounts),
    ...parseAllowedAmountList(options.allowedAmounts || []),
    ...safeInstructionAmounts(options.instructionTexts || []),
    // Le client peut citer son budget : la réponse peut le reprendre.
    ...extractAmounts(options.customerText).map(item => item.value)
  ];

  const amounts = extractAmounts(text);
  const badAmounts = amounts
    .filter(item => !allowed.some(value => sameAmount(value, item.value)))
    .map(item => item.value);

  const composition = product ? checkComposition(text, product) : { ok: true, listed: false };

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

function productFactsBlock(product, { maxDescriptionChars = 600 } = {}) {
  if (!product) return '';
  const lines = [`Produit : ${displayProductName(product)}`];
  const fullName = safeText(product.name);
  if (fullName && fullName !== displayProductName(product)) lines.push(`Nom complet : ${fullName}`);
  if (safeText(product.category)) lines.push(`Catégorie : ${safeText(product.category)}`);
  const regular = formatAmount(product.price);
  const promo = formatAmount(product.promoPrice);
  if (regular) lines.push(`Prix normal : ${regular} TND`);
  if (promo && promo !== regular) lines.push(`Prix promotionnel : ${promo} TND (promotion en cours : donner le prix promotionnel ET le prix normal)`);
  if (!regular && !promo) {
    const from = formatAmount(product.priceFrom);
    const to = formatAmount(product.priceTo);
    if (from) lines.push(`Prix : à partir de ${from} TND${to && to !== from ? ` (jusqu'à ${to} TND)` : ''}`);
  }
  const variations = variationPrices(product);
  if (variations.length) {
    lines.push(`Variantes : ${variations.slice(0, 8).map(item => `${item.label} = ${item.promo ? `${item.promo} TND (au lieu de ${item.regular} TND)` : `${item.regular} TND`}`).join(' ; ')}`);
  }
  if (!regular && !promo && !variations.length && !formatAmount(product.priceFrom)) {
    lines.push('Prix : non renseigné dans le catalogue (ne cite aucun prix)');
  }
  lines.push(safeText(product.composition)
    ? `Composition : ${safeText(product.composition)}`
    : 'Composition : non renseignée (n’énumère aucun élément)');
  if (safeText(product.dimensions)) lines.push(`Dimensions : ${safeText(product.dimensions)}`);
  const availability = safeText(product.availability || product.woocommerceStockStatus);
  if (availability) lines.push(`Disponibilité : ${AVAILABILITY_LABELS[availability] || availability}`);
  if (safeText(product.colors)) lines.push(`Couleurs disponibles : ${safeText(product.colors)}`);
  if (safeText(product.showrooms)) lines.push(`Showrooms : ${safeText(product.showrooms)}`);
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
  priceSentence,
  buildCatalogAnswer,
  buildDisambiguationQuestion,
  productFactsBlock,
  formatAmount
};
