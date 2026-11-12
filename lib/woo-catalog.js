// ============================================================
// MONDECO — règles catalogue de la synchronisation WooCommerce
// lib/woo-catalog.js
//
// V6.45 — Fonctions pures utilisées par Admin.js (synchronisation
// WooCommerce, contexte IA) :
// - clés de nom qui gardent les caractères significatifs (« Salon Baya »
//   et « Salon Baya+ » sont deux produits différents) ;
// - variations des produits variables (prix par variante, « à partir de ») ;
// - corrections manuelles volontaires (product.overrides) qui ne doivent
//   pas être écrasées par la synchronisation ;
// - repérage des fiches manuelles qui doublonnent un produit du site
//   (ex. « Chambre Bianca » 2800 DT saisie à la main alors que le site
//   vend « Chambre à Coucher Bianca » 7200 / 6590 DT).
//
// V6.46 — Prix saisis à la main (« 4 190 DT », « 4.190 »), promotion
// réellement en vigueur (dates du site, jamais ≥ prix normal), corrections
// de l'équipe étendues (nom, catégorie, liens, disponibilité, prix figé sur
// demande) et masquage / suppression d'une fiche du site (hiddenByAdmin).
// ============================================================

'use strict';

const { cleanInlineText } = require('./woo-description');

function text(value) {
  return String(value ?? '').trim();
}

// ------------------------------------------------------------
// Noms
// ------------------------------------------------------------

// Nom replié pour comparaison : entités décodées, accents retirés,
// minuscules, « × » → x. Le « + » est conservé (Baya ≠ Baya+).
function foldProductName(value) {
  return cleanInlineText(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/×/g, ' x ')
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1 x ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function productNameTokens(value) {
  return foldProductName(value)
    .split(' ')
    .filter(token => token && token !== '+');
}

// ------------------------------------------------------------
// Prix
// ------------------------------------------------------------

function priceNumber(value) {
  const raw = text(value).replace(/\s+/g, '').replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Montant affichable : « 2570 », « 104.5 » (jamais d'exposant ni de « .0 »).
function priceText(value) {
  const number = priceNumber(value);
  if (number === null) return '';
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 1000) / 1000);
}

// V6.46 — Montant saisi par un humain (fiche manuelle, correction) :
// « 4 190 », « 4190 DT », « 4.190 » (séparateur de milliers à la
// tunisienne), « 4,5 », « 1.290,500 ». Retourne un nombre > 0 ou null.
// Un seul groupe « .ddd » après 1 ou 2 chiffres est un séparateur de
// milliers (« 4.190 » = 4190 DT) ; après 3 chiffres ce sont des millimes
// (« 104.500 » = 104,5 DT : 104 500 DT n'existe pas au catalogue).
function parsePriceInput(value) {
  const raw = text(value)
    .replace(/[\s  ]+/g, '')
    .replace(/^(?:dt|tnd)/i, '')
    .replace(/(?:dt|tnd|dinars?|d)\.?$/i, '');
  if (!raw) return null;

  let normalized = null;
  if (/^\d+$/.test(raw)) {
    normalized = raw;
  } else if (/^[1-9]\d{0,2}([.,])\d{3}(?:\1\d{3})+$/.test(raw)) {
    normalized = raw.replace(/[.,]/g, ''); // 1.290.000
  } else if (/^[1-9]\d?[.,]\d{3}$/.test(raw)) {
    normalized = raw.replace(/[.,]/, ''); // 4.190 / 12,500
  } else if (/^[1-9]\d{0,2}(?:\.\d{3})+,\d{1,3}$/.test(raw)) {
    normalized = raw.replace(/\./g, '').replace(',', '.'); // 1.290,5
  } else if (/^[1-9]\d{0,2}(?:,\d{3})+\.\d{1,3}$/.test(raw)) {
    normalized = raw.replace(/,/g, ''); // 1,290.5
  } else if (/^\d+[.,]\d{1,3}$/.test(raw)) {
    normalized = raw.replace(',', '.'); // 4,5 / 104.500 / 0.500
  }
  if (normalized === null) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Montant saisi → texte enregistré (« 4190 », « 104.5 ») ou null si ce
// n'est pas un prix lisible.
function normalizePriceInput(value) {
  const number = parsePriceInput(value);
  if (number === null) return null;
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 1000) / 1000);
}

// Date WooCommerce « _gmt » (sans fuseau) ou ISO complète → millisecondes.
function siteDateMs(value) {
  const raw = text(value);
  if (!raw) return NaN;
  return Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`);
}

// V6.46 — Prix promotionnel réellement en vigueur, ou '' :
// - jamais un « promo » supérieur ou égal au prix normal (« 4290 au lieu de
//   3990 ») ;
// - jamais avant le début ni après la fin de la promotion programmée sur le
//   site (product.promoStartsAt / promoEndsAt, dates WooCommerce GMT), même
//   si la synchronisation n'est pas encore repassée.
// Un montant illisible (texte libre) est rendu tel quel, comme avant.
function effectivePromoPrice(product, now = Date.now()) {
  const promo = text(product?.promoPrice);
  if (!promo) return '';
  const promoValue = parsePriceInput(promo);
  const priceValue = parsePriceInput(product?.price);
  if (promoValue !== null && priceValue !== null && promoValue >= priceValue) return '';
  const start = siteDateMs(product?.promoStartsAt);
  const end = siteDateMs(product?.promoEndsAt);
  if (Number.isFinite(start) && now < start) return '';
  if (Number.isFinite(end) && now > end) return '';
  return promo;
}

// ------------------------------------------------------------
// Variations (produits variables)
// ------------------------------------------------------------

function wooStockToAvailability(stockStatus) {
  const value = text(stockStatus).toLowerCase();
  if (value === 'instock') return 'in_stock';
  if (value === 'outofstock') return 'out_of_stock';
  if (value === 'onbackorder') return 'on_order';
  return 'unknown';
}

// Variation REST v3 (/products/{id}/variations) → format local compact.
// Retourne null pour une variation non publiée ou sans prix.
function mapWooVariation(variation) {
  if (!variation || typeof variation !== 'object') return null;
  const status = text(variation.status).toLowerCase();
  if (status && status !== 'publish') return null;

  const price = priceText(variation.price);
  if (!price) return null;

  const regularPrice = priceText(variation.regular_price) || price;
  const salePrice = priceText(variation.sale_price);
  const onSale =
    variation.on_sale !== false &&
    Boolean(salePrice) &&
    priceNumber(salePrice) < priceNumber(regularPrice) &&
    priceNumber(price) === priceNumber(salePrice);

  const attributes = (Array.isArray(variation.attributes) ? variation.attributes : [])
    .map(attribute => ({
      name: cleanInlineText(attribute?.name),
      option: cleanInlineText(attribute?.option)
    }))
    .filter(attribute => attribute.name || attribute.option);

  const label = attributes
    .map(attribute => attribute.option || `tout ${attribute.name}`.trim())
    .filter(Boolean)
    .join(' / ') || `Variante ${Number(variation.id) || ''}`.trim();

  return {
    id: Number(variation.id) || null,
    sku: text(variation.sku),
    label,
    attributes,
    price: onSale ? salePrice : price,
    regularPrice,
    salePrice: onSale ? salePrice : '',
    onSale,
    availability: wooStockToAvailability(variation.stock_status)
  };
}

function mapWooVariations(variations) {
  return (Array.isArray(variations) ? variations : [])
    .map(mapWooVariation)
    .filter(Boolean)
    .sort((a, b) =>
      priceNumber(a.price) - priceNumber(b.price) ||
      a.label.localeCompare(b.label, 'fr')
    );
}

// Résumé de prix d'une liste de variations (format local).
// uniform : toutes les variantes ont le même prix normal et promo.
function summarizeVariationPrices(variations) {
  const list = (Array.isArray(variations) ? variations : [])
    .filter(item => item && priceNumber(item.price) !== null);
  if (!list.length) return null;

  const effective = list.map(item => priceNumber(item.price));
  const from = Math.min(...effective);
  const to = Math.max(...effective);
  const cheapest = list.find(item => priceNumber(item.price) === from) || list[0];
  const signature = item =>
    `${priceNumber(item.regularPrice || item.price)}|${item.onSale ? priceNumber(item.salePrice) : ''}`;
  const uniform = list.every(item => signature(item) === signature(list[0]));

  return {
    count: list.length,
    priceFrom: priceText(from),
    priceTo: priceText(to),
    uniform,
    // Prix « catalogue » du produit : celui de la variante la moins chère
    // (prix normal + promo éventuelle), comme le « à partir de » du site.
    price: priceText(cheapest.regularPrice || cheapest.price),
    promoPrice: cheapest.onSale ? priceText(cheapest.salePrice) : ''
  };
}

// Nom(s) d'attribut des variations (« Largeur Lit », « couleur »).
function variationAttributeNames(variations) {
  const names = [];
  for (const item of Array.isArray(variations) ? variations : []) {
    for (const attribute of Array.isArray(item?.attributes) ? item.attributes : []) {
      const name = text(attribute?.name);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

const MAX_CONTEXT_VARIATIONS = 12;

// Lignes de prix pour le contexte IA d'un produit variable.
// - prix différents : « Prix : à partir de 590 TND » + « Prix par variante
//   (Largeur Lit) : 90 cm : 590 TND ; 120 cm : 690 TND » ;
// - prix identiques : null pour les prix (les lignes « Prix normal » /
//   « Prix promotionnel » habituelles restent valables) et la liste des
//   variantes.
function variationContextLines(product) {
  const variations = Array.isArray(product?.variations) ? product.variations : [];
  const summary = summarizeVariationPrices(variations);
  if (!summary) return null;

  const attributeNames = variationAttributeNames(variations);
  const scope = attributeNames.length ? ` (${attributeNames.join(' / ')})` : '';
  const shown = variations.slice(0, MAX_CONTEXT_VARIATIONS);
  const more = variations.length > shown.length
    ? ` ; … (${variations.length - shown.length} autre(s) variante(s))`
    : '';
  const stockNote = item =>
    item.availability === 'out_of_stock' ? ' (rupture)' : '';

  if (summary.uniform) {
    return {
      uniform: true,
      priceLines: null,
      detailLines: [
        `Variantes${scope} : ${shown.map(item => `${item.label}${stockNote(item)}`).join(', ')}${more} — même prix pour toutes les variantes`
      ]
    };
  }

  const variantPrice = item =>
    item.onSale
      ? `${item.label} : ${priceText(item.salePrice)} TND en promotion au lieu de ${priceText(item.regularPrice)} TND${stockNote(item)}`
      : `${item.label} : ${priceText(item.price)} TND${stockNote(item)}`;

  return {
    uniform: false,
    priceLines: [
      `Prix : à partir de ${summary.priceFrom} TND (jusqu'à ${summary.priceTo} TND selon la variante)`,
      `Prix par variante${scope} : ${shown.map(variantPrice).join(' ; ')}${more}`
    ],
    detailLines: []
  };
}

// ------------------------------------------------------------
// Corrections manuelles volontaires (product.overrides)
// ------------------------------------------------------------

// Champs qu'un administrateur peut volontairement figer sur une fiche
// synchronisée (descriptifs : la correction reste jusqu'à ce qu'on vide le
// champ ou qu'on rende la fiche au site).
// V6.46 — aussi le nom, la catégorie et les liens.
const WOO_OVERRIDABLE_FIELDS = Object.freeze([
  'dimensions',
  'composition',
  'colors',
  'showrooms',
  'description',
  'name',
  'category',
  'productUrl',
  'categoryUrl'
]);

// V6.46 — Champs commerciaux : la disponibilité modifiée par l'équipe est
// gardée ; un prix ou une promotion seulement sur demande explicite
// (meta.lockPrice). La correction mémorise la valeur du site au moment où
// elle a été faite (siteValue) et tombe d'elle-même dès que le site change
// cette valeur (prix corrigé sur mondeco.tn, nouvelle promotion…).
const WOO_SITE_OVERRIDE_FIELDS = Object.freeze([
  'price',
  'promoPrice',
  'availability'
]);

const WOO_PRICE_FIELDS = Object.freeze(['price', 'promoPrice']);

function sanitizeOverrides(overrides) {
  const clean = {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return clean;
  }
  for (const field of [...WOO_OVERRIDABLE_FIELDS, ...WOO_SITE_OVERRIDE_FIELDS]) {
    const entry = overrides[field];
    if (!entry || typeof entry !== 'object') continue;
    clean[field] = {
      value: text(entry.value),
      by: text(entry.by),
      at: text(entry.at),
      source: text(entry.source)
    };
    if (WOO_SITE_OVERRIDE_FIELDS.includes(field)) {
      clean[field].siteValue = text(entry.siteValue);
    }
  }
  return clean;
}

function comparableValue(value) {
  return text(value).replace(/\s+/g, ' ');
}

// V6.46 — Produit variable à prix différents selon la variante : l'IA cite
// les prix par variante, un prix figé sur la fiche n'aurait aucun effet ;
// il se corrige sur le site.
function hasVariantPrices(product) {
  const summary = summarizeVariationPrices(product?.variations);
  return Boolean(summary && !summary.uniform);
}

// Valeur comparable d'un champ commercial (« 2990 » = « 2990.0 »).
function comparableSiteValue(field, value) {
  if (WOO_PRICE_FIELDS.includes(field)) {
    const number = priceNumber(value);
    return number === null ? comparableValue(value) : String(number);
  }
  return comparableValue(value).toLowerCase();
}

// Enregistre (ou retire) les corrections volontaires d'une fiche
// synchronisée : un champ modifié devient une correction ; un champ vidé
// retire la correction (la valeur du site revient à la synchronisation
// suivante). Retourne la fiche (inchangée si ce n'est pas une fiche
// WooCommerce).
// meta.lockPrice (V6.46) : le prix / la promotion saisis sont figés
// (demande explicite) ; sans lui, ils restent ceux du site.
function recordProductOverrides(before, after, meta = {}) {
  if (!after || text(after.syncSource) !== 'woocommerce') return after;

  const overrides = sanitizeOverrides(after.overrides || before?.overrides);
  let touched = false;
  const stamp = () => ({
    by: text(meta.by),
    at: text(meta.at) || new Date().toISOString(),
    source: text(meta.source) || 'admin'
  });

  for (const field of WOO_OVERRIDABLE_FIELDS) {
    if (meta.fields && !meta.fields.includes(field)) continue;
    const previous = comparableValue(before?.[field]);
    const next = comparableValue(after[field]);
    if (previous === next) continue;
    touched = true;
    if (!next) {
      delete overrides[field];
      continue;
    }
    overrides[field] = {
      value: text(after[field]),
      ...stamp()
    };
  }

  for (const field of WOO_SITE_OVERRIDE_FIELDS) {
    if (meta.fields && !meta.fields.includes(field)) continue;
    const previous = comparableSiteValue(field, before?.[field]);
    const next = comparableSiteValue(field, after[field]);
    if (previous === next) continue;
    // V6.46 — Disponibilité absente complétée en « unknown » (« À
    // confirmer », même affichage) par la route PUT produit : ce n'est pas
    // une correction. Sans cela, toute modification partielle d'une fiche
    // du site sans disponibilité (« Revenir à la valeur du site », « Pas un
    // doublon ») enregistrait une fausse correction de disponibilité.
    if (
      field === 'availability' &&
      (!previous || previous === 'unknown') &&
      (!next || next === 'unknown')
    ) {
      continue;
    }
    if (
      WOO_PRICE_FIELDS.includes(field) &&
      (meta.lockPrice !== true || hasVariantPrices(after))
    ) {
      continue;
    }
    touched = true;
    const siteValue = overrides[field]
      ? overrides[field].siteValue
      : text(before?.[field]);
    // Retour à la valeur du site, ou champ vidé (sauf la promotion : « pas
    // de promotion » est une correction valable) : correction retirée.
    if (
      next === comparableSiteValue(field, siteValue) ||
      (!next && field !== 'promoPrice')
    ) {
      delete overrides[field];
      continue;
    }
    overrides[field] = {
      value: text(after[field]),
      siteValue,
      ...stamp()
    };
  }

  if (!touched) return after;

  const result = { ...after };
  if (Object.keys(overrides).length) {
    result.overrides = overrides;
  } else {
    delete result.overrides;
  }
  return result;
}

// V6.46 — Modifications d'une fiche synchronisée qui NE seront PAS gardées
// (valeur du site reprise à la synchronisation suivante) : prix ou
// promotion sans demande explicite, fiche réactivée alors que le site ne la
// publie pas. Sert à l'avertissement affiché à l'équipe.
function siteManagedChanges(before, after, meta = {}) {
  if (!after || text(after.syncSource) !== 'woocommerce') return [];
  const fields = [];
  const variantPrices = hasVariantPrices(after);
  if (meta.lockPrice !== true || variantPrices) {
    for (const field of WOO_PRICE_FIELDS) {
      if (meta.fields && !meta.fields.includes(field)) continue;
      if (comparableSiteValue(field, before?.[field]) !== comparableSiteValue(field, after[field])) {
        fields.push(field);
      }
    }
    if (variantPrices && fields.length) fields.push('variations');
  }
  if (
    (!meta.fields || meta.fields.includes('active')) &&
    after.active !== false &&
    before?.active === false &&
    before?.hiddenByAdmin !== true &&
    (text(before?.woocommerceStatus) !== 'publish' || before?.wooMissingAt)
  ) {
    fields.push('active');
  }
  return fields;
}

// V6.46 — Fiche synchronisée masquée par l'équipe (case « Actif » décochée
// ou suppression) : hiddenByAdmin la garde inactive malgré la
// synchronisation ; la recocher la rend au site.
function applyAdminVisibility(before, after, meta = {}) {
  if (!after || text(after.syncSource) !== 'woocommerce') return after;
  const at = text(meta.at) || new Date().toISOString();
  if (after.active === false && before?.active !== false) {
    return {
      ...after,
      hiddenByAdmin: true,
      hiddenByAdminAt: at,
      hiddenByAdminBy: text(meta.by)
    };
  }
  if (after.active !== false && (before?.hiddenByAdmin === true || after.hiddenByAdmin === true)) {
    const result = { ...after };
    delete result.hiddenByAdmin;
    delete result.hiddenByAdminAt;
    delete result.hiddenByAdminBy;
    delete result.deletedByAdmin;
    delete result.deletedByAdminAt;
    return result;
  }
  return after;
}

// V6.46 — « Supprimer » une fiche synchronisée : elle reste enregistrée,
// inactive et marquée (sinon la synchronisation suivante la recréait avec
// un nouvel identifiant et la remettait en vente).
function adminTombstone(product, meta = {}) {
  const at = text(meta.at) || new Date().toISOString();
  return {
    ...product,
    active: false,
    hiddenByAdmin: true,
    hiddenByAdminAt: text(product?.hiddenByAdminAt) || at,
    hiddenByAdminBy: text(product?.hiddenByAdminBy) || text(meta.by),
    deletedByAdmin: true,
    deletedByAdminAt: at,
    updatedAt: at
  };
}

// V6.46 — À la synchronisation : corrections commerciales encore valables
// (le site n'a pas changé la valeur depuis) et corrections tombées.
// siteValues : valeurs calculées du site ({ price, promoPrice,
// availability }).
function resolveSiteOverrides(overrides, siteValues = {}) {
  const kept = {};
  const expired = [];
  for (const [field, entry] of Object.entries(sanitizeOverrides(overrides))) {
    if (
      !WOO_SITE_OVERRIDE_FIELDS.includes(field) ||
      comparableSiteValue(field, siteValues[field]) === comparableSiteValue(field, entry.siteValue)
    ) {
      kept[field] = entry;
    } else {
      expired.push(field);
    }
  }
  return { overrides: kept, expired };
}

// ------------------------------------------------------------
// Fiches manuelles en doublon d'un produit du site
// ------------------------------------------------------------

const NAME_STOPWORDS = new Set((
  'a au aux avec de des du d en et l la le les ou pour par sur sans un une ' +
  'x cm mm m tunisie mondeco tn the'
).split(' '));

// Type principal d'un nom (premier mot de type rencontré).
const TYPE_ALIASES = {
  chambre: 'chambre', chambres: 'chambre',
  lit: 'lit', lits: 'lit', sommier: 'lit',
  salon: 'salon', salons: 'salon', canape: 'canape', canapes: 'canape',
  banquette: 'canape', meridienne: 'canape',
  table: 'table', tables: 'table',
  chaise: 'chaise', chaises: 'chaise', tabouret: 'chaise', tabourets: 'chaise',
  pouf: 'pouf', poufs: 'pouf',
  fauteuil: 'fauteuil', fauteuils: 'fauteuil',
  coiffeuse: 'coiffeuse', coiffeuses: 'coiffeuse',
  dressing: 'dressing', armoire: 'armoire', armoires: 'armoire',
  bureau: 'bureau', bureaux: 'bureau',
  commode: 'commode', commodes: 'commode',
  chevet: 'chevet', chevets: 'chevet',
  buffet: 'buffet', argentiere: 'buffet', vitrine: 'buffet',
  meuble: 'meuble', console: 'console', miroir: 'miroir',
  matelas: 'matelas', etagere: 'etagere', bibliotheque: 'etagere',
  pack: 'pack', ensemble: 'pack', salle: 'salle'
};

// Ensembles et éléments qui les composent : « Lit Bianca + 2 chevets »
// peut être l'ancienne fiche de la « Chambre à Coucher Bianca ».
const SET_COMPONENTS = {
  chambre: new Set(['lit', 'chevet', 'dressing', 'armoire', 'coiffeuse', 'commode']),
  salon: new Set(['canape', 'fauteuil']),
  salle: new Set(['table', 'chaise', 'buffet']),
  pack: null // un pack peut tout contenir
};

// Public / gamme : « enfant », « junior », « mariage »… distinguent des
// produits différents du même modèle.
const QUALIFIERS = new Set((
  'enfant enfants junior ado ados adolescent bebe adulte adultes mariage ' +
  'parent parents mini xl'
).split(' '));

// Mots descriptifs, jamais des noms de modèle.
const DESCRIPTORS = new Set((
  'coucher manger nuit places place angle coin moderne modernes design luxe ' +
  'capitonne capitonnee capitonnes complete complet complets bois blanc ' +
  'blanche blancs noir noire gris grise beige bleu rose rouge vert marron ' +
  'moka taupe dore doree ronde rond carre carree rectangulaire ovale ' +
  'extensible convertible porte portes tiroir tiroirs niche led murale mural ' +
  'rangement coffre miroir premium nouveau nouvelle collection simple double ' +
  'tissu velours cuir bouclette metal metallique verre marbre mdf blenz ' +
  'orthopedique confort chevets chevet tables chaises lit lits deux trois ' +
  'quatre cinq six huit dressing coiffeuse coiffure pouf'
).split(' '));

function analyseName(name) {
  const tokens = productNameTokens(name);
  let mainType = '';
  const qualifiers = new Set();
  const words = [];
  // Mesures (160, 200, 90…) et quantités (« 4 chaises », « 2 chevets ») :
  // un matelas 160×190 n'est pas le doublon d'un matelas 160×200.
  const measures = new Set();
  const counts = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^\d+$/.test(token)) {
      if (token.length >= 2) {
        measures.add(Number(token));
      } else if (tokens[index + 1] && !/^\d+$/.test(tokens[index + 1])) {
        counts.set(tokens[index + 1].replace(/s$/, ''), Number(token));
      }
    }
    if (NAME_STOPWORDS.has(token)) continue;
    let type = TYPE_ALIASES[token] || '';
    // « table de nuit » est un chevet, pas une table.
    if (type === 'table' && tokens.slice(index + 1, index + 3).includes('nuit')) {
      type = 'chevet';
    }
    if (type && !mainType) mainType = type;
    if (QUALIFIERS.has(token)) qualifiers.add(token.replace(/s$/, ''));
    words.push(token);
  }
  return { tokens: words, mainType, qualifiers, measures, counts };
}

// Mesures ou quantités contradictoires entre les deux noms.
function numbersConflict(manual, woo) {
  if (manual.measures.size && woo.measures.size) {
    for (const value of manual.measures) {
      if (!woo.measures.has(value)) return true;
    }
  }
  for (const [word, count] of manual.counts) {
    if (woo.counts.has(word) && woo.counts.get(word) !== count) return true;
  }
  return false;
}

function isModelToken(token, frequency, maxFrequency) {
  if (!token || token.length < 3) return false;
  if (/^\d+$/.test(token) || /^\d+x\d+$/.test(token)) return false;
  if (NAME_STOPWORDS.has(token) || TYPE_ALIASES[token] || QUALIFIERS.has(token) || DESCRIPTORS.has(token)) {
    return false;
  }
  return (frequency.get(token) || 0) <= maxFrequency;
}

// Même type : +4. Fiche manuelle = élément d'un ensemble vendu sur le site
// (« Lit Bianca + 2 chevets » / « Chambre à Coucher Bianca ») : +1. L'inverse
// (fiche manuelle « Chambre », produit du site « Coiffeuse ») n'est pas un
// doublon, ni deux types sans rapport.
function typeCompatibility(manualType, wooType) {
  if (!manualType || !wooType) return 1;
  if (manualType === wooType) return 4;
  const components = SET_COMPONENTS[wooType];
  if (
    Object.prototype.hasOwnProperty.call(SET_COMPONENTS, wooType) &&
    (components === null || components.has(manualType))
  ) {
    return 1;
  }
  return null; // types incompatibles : jamais un doublon
}

// Repère, pour chaque fiche manuelle active, le produit WooCommerce actif
// dont elle est très probablement l'ancienne copie.
// - manualProducts / wooProducts : fiches locales ;
// - retourne Map(fiche manuelle (objet) → { wooId, wooName, wooProductId,
//   score, confidence: 'high' | 'possible' }).
// Règles : tous les mots « modèle » de la fiche manuelle (bianca, baya+…)
// doivent figurer dans le nom du site, les types doivent être compatibles
// et le public identique (enfant/junior/mariage…).
const DUPLICATE_HIGH_SCORE = 4;

function findManualDuplicates(manualProducts, wooProducts) {
  const result = new Map();
  const woo = (Array.isArray(wooProducts) ? wooProducts : [])
    .filter(item => item && item.active !== false && Number(item.woocommerceId))
    .map(item => ({ product: item, info: analyseName(item.name) }));
  if (!woo.length) return result;

  const frequency = new Map();
  for (const item of woo) {
    for (const token of new Set(item.info.tokens)) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }
  }
  // Un nom de modèle est rare dans le catalogue ; un mot présent dans plus
  // de 3 % des fiches (au moins 12) est descriptif.
  const maxFrequency = Math.max(12, Math.round(woo.length * 0.03));

  for (const manual of Array.isArray(manualProducts) ? manualProducts : []) {
    if (!manual || manual.active === false || manual.notDuplicateOfWoo === true) continue;
    const info = analyseName(manual.name);
    const models = [...new Set(info.tokens)].filter(token => isModelToken(token, frequency, maxFrequency));
    if (!models.length) continue;

    let best = null;
    for (const candidate of woo) {
      const wooTokens = new Set(candidate.info.tokens);
      if (!models.every(token => wooTokens.has(token))) continue;

      const compatibility = typeCompatibility(info.mainType, candidate.info.mainType);
      if (compatibility === null) continue;
      if (numbersConflict(info, candidate.info)) continue;

      let score = compatibility;
      for (const qualifier of candidate.info.qualifiers) {
        score += info.qualifiers.has(qualifier) ? 2 : -2;
      }
      for (const qualifier of info.qualifiers) {
        if (!candidate.info.qualifiers.has(qualifier)) score -= 2;
      }
      const manualTokens = new Set(info.tokens);
      for (const token of wooTokens) {
        if (!manualTokens.has(token) && isModelToken(token, frequency, maxFrequency)) score -= 1;
      }
      if (score < 1) continue;

      const extra = candidate.info.tokens.length - info.tokens.length;
      if (
        !best ||
        score > best.score ||
        (score === best.score && Math.abs(extra) < Math.abs(best.extra)) ||
        (score === best.score && Math.abs(extra) === Math.abs(best.extra) &&
          Number(candidate.product.woocommerceId) < Number(best.product.woocommerceId))
      ) {
        best = { product: candidate.product, score, extra };
      }
    }

    if (best) {
      result.set(manual, {
        wooId: Number(best.product.woocommerceId),
        wooName: text(best.product.name),
        wooProductId: text(best.product.id),
        score: best.score,
        // « high » : même type de meuble, même public, aucun autre mot
        // modèle (ex. « Chambre Bianca » / « Chambre à Coucher Bianca »).
        // « possible » : rapprochement plus faible (élément d'un ensemble,
        // public différent…), à vérifier par l'équipe.
        confidence: best.score >= DUPLICATE_HIGH_SCORE ? 'high' : 'possible'
      });
    }
  }

  return result;
}

module.exports = {
  foldProductName,
  productNameTokens,
  priceNumber,
  priceText,
  parsePriceInput,
  normalizePriceInput,
  siteDateMs,
  effectivePromoPrice,
  mapWooVariation,
  mapWooVariations,
  summarizeVariationPrices,
  variationContextLines,
  WOO_OVERRIDABLE_FIELDS,
  WOO_SITE_OVERRIDE_FIELDS,
  sanitizeOverrides,
  recordProductOverrides,
  siteManagedChanges,
  applyAdminVisibility,
  adminTombstone,
  resolveSiteOverrides,
  findManualDuplicates
};
