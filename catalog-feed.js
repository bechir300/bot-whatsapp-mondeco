// MONDECO - Feed catalogue Meta + images produits publiques (lecture seule)
const fs = require('fs');
const path = require('path');
const { decodeHtmlEntities } = require('./lib/woo-description');
const {
  effectivePromoPrice,
  parsePriceInput,
  priceNumber,
  siteDateMs
} = require('./lib/woo-catalog');

// V6.45 — Même dossier de données qu'Admin.js et server.js (avant :
// '/data' codé en dur si DATA_DIR n'était pas défini).
// V6.46 — règle partagée (lib/data-dir.js).
const DATA_DIR = require('./lib/data-dir').resolveDataDir();
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.mondeco.tn';
const IMAGE_RE = /^product-[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i;

// V6.46 — Identifiant des articles du flux : l'identifiant WooCommerce
// (celui que le pixel PixelYourSite de mondeco.tn envoie dans content_ids),
// sinon l'identifiant local stable de la fiche manuelle. CATALOG_FEED_ID :
// « woocommerce » (défaut), « sku » (pixel réglé sur le SKU) ou « local »
// (ancien comportement : identifiants locaux).
const FEED_ID_MODE = String(process.env.CATALOG_FEED_ID || 'woocommerce').trim().toLowerCase();

function clean(v) {
  // V6.45 — toutes les entités HTML (&#215;, &#8211;…), pas seulement &amp;.
  return decodeHtmlEntities(String(v == null ? '' : v).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function csv(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}
// V6.46 — Prix d'une fiche synchronisée : nombre décimal du site
// (« 2570 », « 104.5 ») ; prix saisi à la main : « 4 190 », « 4190 DT »,
// « 4.190 » (milliers) compris (avant : ligne absente du flux ou 4,19 TND).
function money(v, { manual = false } = {}) {
  const n = manual ? parsePriceInput(v) : priceNumber(v);
  return n !== null && Number.isFinite(n) && n > 0 ? n.toFixed(2) + ' TND' : '';
}
function amount(text) {
  return Number(String(text).split(' ')[0]);
}
// V6.46 — Disponibilités Meta : « available for order » pour « Sur
// commande » (avant : « in stock »). « À confirmer », « Déstockage » et les
// fiches sans disponibilité restent « in stock » (comportement inchangé).
function feedAvailability(value) {
  const code = String(value || '').trim().toLowerCase();
  if (code === 'out_of_stock') return 'out of stock';
  if (code === 'on_order') return 'available for order';
  return 'in stock';
}
// V6.46 — Période d'une promotion programmée sur le site (ISO 8601,
// « début/fin »), pour que Meta n'affiche pas la promotion hors période.
function isoMinute(ms) {
  return new Date(ms).toISOString().slice(0, 16) + '+00:00';
}
function saleEffectiveDate(p, now = Date.now()) {
  const start = siteDateMs(p.promoStartsAt);
  const end = siteDateMs(p.promoEndsAt);
  if (!Number.isFinite(end)) return '';
  const from = Number.isFinite(start) ? start : Math.min(now, end);
  return isoMinute(from) + '/' + isoMinute(end);
}
function feedId(p) {
  if (FEED_ID_MODE !== 'local' && Number(p.woocommerceId) > 0) {
    if (FEED_ID_MODE === 'sku' && clean(p.woocommerceSku)) return clean(p.woocommerceSku);
    return String(Number(p.woocommerceId));
  }
  return String(p.id || '');
}
function readProductsFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : Object.values(raw);
}
function loadActiveProducts() {
  let list;
  try {
    list = readProductsFile(PRODUCTS_PATH);
  } catch (error) {
    // V6.46 — comme Admin.js : copie de secours si le fichier est illisible.
    const backup = `${PRODUCTS_PATH}.bak`;
    if (!fs.existsSync(backup)) throw error;
    list = readProductsFile(backup);
  }
  // V6.45 — une fiche manuelle repérée comme doublon certain d'un produit
  // du site (souvent avec un prix périmé) n'est pas publiée : le produit du
  // site l'est déjà.
  return list.filter(p =>
    p && p.active !== false &&
    !(Number(p.duplicateOfWooId) && p.duplicateConfidence !== 'possible'));
}
function buildFeed(now = Date.now()) {
  const header = ['id', 'title', 'description', 'availability', 'condition',
    'price', 'sale_price', 'sale_price_effective_date', 'link', 'image_link',
    'brand', 'product_type'];
  const rows = [header.join(',')];
  const seen = new Set();
  for (const p of loadActiveProducts()) {
    const manual = String(p.syncSource || '') !== 'woocommerce';
    const price = money(p.price, { manual });
    const id = feedId(p);
    const file = path.basename(String(p.imageFilename || p.image || ''));
    const ext = /^https:\/\//i.test(String(p.image || '')) ? String(p.image).trim() : '';
    if (!price || !id || (!ext && !IMAGE_RE.test(file))) continue;
    // V6.46 — un identifiant n'apparaît qu'une fois dans le flux.
    if (seen.has(id)) continue;
    seen.add(id);
    // V6.46 — promotion en vigueur seulement (dates du site, < prix normal).
    let sale = money(effectivePromoPrice(p, now), { manual: manual || Boolean(p.overrides?.promoPrice) });
    if (sale && amount(sale) >= amount(price)) sale = '';
    const title = clean(p.name).slice(0, 150) || 'Produit MONDECO';
    const desc = (clean(p.description) || clean(p.composition) || title).slice(0, 5000);
    const full = p.dimensions ? desc + ' Dimensions : ' + clean(p.dimensions) + '.' : desc;
    rows.push([
      id, title, full,
      feedAvailability(p.availability),
      'new', price, sale,
      sale ? saleEffectiveDate(p, now) : '',
      clean(p.productUrl) || 'https://mondeco.tn/',
      ext || (BASE_URL + '/public/products/' + encodeURIComponent(file)),
      'MONDECO', clean(p.category)
    ].map(csv).join(','));
  }
  return rows.join('\n') + '\n';
}

module.exports = function mountCatalogFeed(app) {
  app.get('/public/products/:file', (req, res) => {
    const file = path.basename(String(req.params.file || ''));
    if (!IMAGE_RE.test(file)) return res.status(404).end();
    const full = path.join(UPLOADS_DIR, file);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(full);
  });
  app.get('/catalog-feed.csv', (req, res) => {
    try {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(buildFeed());
    } catch (e) {
      console.error('catalog-feed:', e.message);
      res.status(500).send('feed error');
    }
  });
  console.log('Catalogue : feed /catalog-feed.csv + /public/products actifs');
};
module.exports.buildFeed = buildFeed;
module.exports.feedAvailability = feedAvailability;
module.exports.money = money;
