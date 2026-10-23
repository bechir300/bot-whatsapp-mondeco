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

const RESEND_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_CARDS_PER_DAY = 3;
const MIN_NAME_LENGTH = 4;

function fold(value) {
  return ` ${String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim()} `;
}

function hasPrice(product) {
  return Boolean(String(product?.promoPrice ?? '').trim() || String(product?.price ?? '').trim());
}

// Produit unique cité dans la réponse de l'IA, ou null.
function findProductForCard(reply, products = []) {
  const text = fold(reply);
  if (text.trim().length < 3 || /commercial_required/.test(text)) return null;

  const matches = [];
  for (const product of products) {
    if (!product || product.active === false || !hasPrice(product)) continue;
    const name = fold(product.name);
    if (name.trim().length < MIN_NAME_LENGTH) continue;
    if (text.includes(name)) matches.push({ product, name });
  }
  if (!matches.length) return null;

  // « Salon Fiorie » et « Salon Fiorie XL » : garder le nom le plus long
  // quand les autres en font partie ; sinon plusieurs produits → aucun.
  matches.sort((a, b) => b.name.length - a.name.length);
  const [best, ...others] = matches;
  if (others.some(other => !best.name.includes(other.name))) return null;
  return best.product;
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
