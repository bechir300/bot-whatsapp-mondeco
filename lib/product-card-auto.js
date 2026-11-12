// ============================================================
// MONDECO — fiche produit envoyée automatiquement par l'IA
// lib/product-card-auto.js
//
// Quand l'IA répond à propos d'UN produit précis du catalogue (son nom
// apparaît dans la réponse et son prix est connu), la fiche produit
// (photo, prix, bouton « Voir le produit ») est envoyée juste après la
// réponse texte. Option désactivée par défaut (Paramètres).
//
// Prudence : jamais si plusieurs produits sont cités (le client compare),
// jamais deux fois la même fiche au même client en 24 h, au plus
// MAX_CARDS_PER_DAY fiches par client et par jour.
// ============================================================

const { decodeHtmlEntities } = require('./woo-description');
const { tokenize, STRONG_TYPES, WEAK_TYPES } = require('./product-resolver');

const RESEND_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_CARDS_PER_DAY = 3;
const MIN_NAME_LENGTH = 4;

// V6.46 — entités HTML décodées avant comparaison : « Bouclette &amp;
// Design » (nom enregistré) = « Bouclette & Design » (réponse de l'IA).
// V6.46 — « Baya+ » ≠ « Baya » : un « + » après le nom fait partie du nom,
// même séparé par une espace (« Baya + ») ; avant, « Salon Baya+ » devenait
// « salon baya » et la fiche du Salon Baya à 2200 DT partait après une
// réponse sur le Baya+ à 2800 DT.
function fold(value) {
  return ` ${decodeHtmlEntities(String(value ?? ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])\s*\+/g, '$1plus')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim()} `;
}

function hasPrice(product) {
  return Boolean(String(product?.promoPrice ?? '').trim() || String(product?.price ?? '').trim());
}

// V6.46 — Ancienne fiche manuelle repérée comme doublon certain d'une fiche
// du site : jamais de fiche automatique (prix périmé, ex. Bianca 2800 DT).
function isCertainDuplicate(product) {
  return Boolean(Number(product?.duplicateOfWooId)) && String(product?.duplicateConfidence || '').trim() !== 'possible';
}

function isOutOfStock(product) {
  return String(product?.availability || '').trim().toLowerCase() === 'out_of_stock';
}

function cardCandidate(product) {
  return Boolean(product) && product.active !== false && hasPrice(product) && !isCertainDuplicate(product);
}

function productIdentity(product) {
  return String(product?.id ?? product?.woocommerceId ?? '');
}

// V6.46 — Réponses qui ne parlent pas d'UN produit choisi : question de
// choix entre plusieurs modèles, question de clarification, transfert,
// réponse remplacée par le garde-fou.
const NO_CARD_KINDS = new Set(['disambiguation', 'clarification', 'handoff', 'guarded']);

// V6.46 — Nom tel qu'il peut être écrit dans la réponse : « Salon Baya+ »
// aussi écrit « Salon Baya Plus » (le mot « plus » seul n'est jamais plié,
// c'est aussi un adverbe).
function citedName(text, product) {
  const name = fold(product?.name);
  if (text.includes(name)) return name;
  const spelled = name.replace(/([a-z0-9])plus /g, '$1 plus ');
  return spelled !== name && text.includes(spelled) ? spelled : '';
}

// Produit nommé dans la réponse : { product (null si en rupture), name, id },
// 'several' si plusieurs produits différents sont cités, ou null.
function namedProduct(text, products) {
  const matches = [];
  for (const product of Array.isArray(products) ? products : []) {
    if (!cardCandidate(product)) continue;
    if (fold(product.name).trim().length < MIN_NAME_LENGTH) continue;
    const name = citedName(text, product);
    // V6.46 — Produit en rupture : reconnu (cité avec un autre → aucune
    // fiche) mais jamais proposé en fiche.
    if (name) matches.push({ product: isOutOfStock(product) ? null : product, name, id: productIdentity(product) });
  }
  if (!matches.length) return null;
  // « Salon Fiorie » et « Salon Fiorie XL » : garder le nom le plus long
  // quand les autres en font partie ; sinon plusieurs produits → aucun.
  // V6.46 — Deux produits différents au même nom : ambigu → aucun.
  matches.sort((a, b) => b.name.length - a.name.length);
  const [best, ...others] = matches;
  if (others.some(other => !best.name.includes(other.name) || (other.name === best.name && other.id !== best.id))) return 'several';
  return best;
}

// Le nom complet ou un mot « modèle » du produit (bianca, fiorie…) est cité.
function replyMentionsProduct(text, product) {
  const name = fold(product?.name);
  if (name.trim().length >= MIN_NAME_LENGTH && citedName(text, product)) return true;
  const replyWords = new Set(tokenize(text));
  const nameWords = tokenize(product?.name);
  const modelWords = nameWords.filter(word => !STRONG_TYPES.has(word) && !WEAK_TYPES.has(word));
  return (modelWords.length ? modelWords : nameWords).some(word => replyWords.has(word));
}

// Produit unique cité dans la réponse de l'IA, ou null.
// V6.46 — `options.kind` : nature de la réponse (question de choix,
// clarification, transfert → aucune fiche) ; `options.product` : produit
// identifié pour CE tour (lib/product-resolver.js) — la fiche suit ce
// produit, jamais une recherche par nom dans tout le catalogue (avant :
// fiche de l'ancienne copie « Chambre Bianca » à 2800 DT après une réponse
// à 6590/7200 DT, fiche « Salon Baya GM » après « Lequel vous intéresse ? »).
// V6.46 — Réponse IA sans produit identifié pour ce tour (plusieurs
// produits possibles, aucun) : aucune fiche. Avant, la recherche par nom
// dans tout le catalogue envoyait la fiche « Salon Baya » (2200 DT) après
// « Le Salon Baya Plus est à 2800 DT ». La recherche par nom ne sert plus
// qu'aux réponses sans tour connu.
function findProductForCard(reply, products = [], options = {}) {
  const text = fold(reply);
  if (text.trim().length < 3 || /commercial required/.test(text)) return null;
  const kind = String(options?.kind || '');
  if (NO_CARD_KINDS.has(kind)) return null;
  if (kind === 'ai' && !options?.product) return null;

  const named = namedProduct(text, products);
  const resolved = options?.product || null;
  if (resolved) {
    if (!cardCandidate(resolved) || isOutOfStock(resolved)) return null;
    if (named === 'several') return null;
    // La réponse cite nommément un AUTRE produit : aucune fiche.
    if (named && named.id !== productIdentity(resolved)) return null;
    return replyMentionsProduct(text, resolved) ? resolved : null;
  }
  if (!named || named === 'several') return null;
  return named.product || null;
}

// Décide d'envoyer la fiche compte tenu de l'historique du client
// (state.productCards = [{ id, at }]).
function productCardAllowed(state = {}, productId, now = Date.now()) {
  const history = Array.isArray(state?.productCards) ? state.productCards : [];
  const recent = history.filter(item => now - Date.parse(item?.at || '') < RESEND_DELAY_MS);
  if (recent.some(item => String(item.id) === String(productId))) return false;
  return recent.length < MAX_CARDS_PER_DAY;
}

function recordProductCard(state = {}, productId, now = Date.now()) {
  const history = Array.isArray(state?.productCards) ? state.productCards : [];
  const kept = history.filter(item => now - Date.parse(item?.at || '') < RESEND_DELAY_MS);
  return [...kept, { id: String(productId), at: new Date(now).toISOString() }].slice(-10);
}

// Type d'image d'après ses premiers octets (WhatsApp n'accepte que JPEG/PNG).
function imageMimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

module.exports = {
  RESEND_DELAY_MS,
  MAX_CARDS_PER_DAY,
  findProductForCard,
  productCardAllowed,
  recordProductCard,
  imageMimeFromBuffer
};
