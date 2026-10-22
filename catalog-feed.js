// MONDECO - Feed catalogue Meta + images produits publiques (lecture seule)
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.mondeco.tn';
const IMAGE_RE = /^product-[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i;

function clean(v) {
  return String(v == null ? '' : v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function csv(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}
function money(v) {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) + ' TND' : '';
}
function loadActiveProducts() {
  const raw = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.filter(p => p && p.active !== false);
}
function buildFeed() {
  const header = ['id', 'title', 'description', 'availability', 'condition',
    'price', 'sale_price', 'link', 'image_link', 'brand', 'product_type'];
  const rows = [header.join(',')];
  for (const p of loadActiveProducts()) {
    const price = money(p.price);
    const file = path.basename(String(p.imageFilename || p.image || ''));
    const ext = /^https:\/\//i.test(String(p.image || '')) ? String(p.image).trim() : '';
    if (!price || !p.id || (!ext && !IMAGE_RE.test(file))) continue;
    let sale = money(p.promoPrice);
    if (sale && Number(sale.split(' ')[0]) >= Number(price.split(' ')[0])) sale = '';
    const title = clean(p.name).slice(0, 150) || 'Produit MONDECO';
    const desc = (clean(p.description) || clean(p.composition) || title).slice(0, 5000);
    const full = p.dimensions ? desc + ' Dimensions : ' + clean(p.dimensions) + '.' : desc;
    const avail = String(p.availability || 'in_stock').replace(/_/g, ' ').toLowerCase();
    rows.push([
      p.id, title, full,
      avail === 'out of stock' ? 'out of stock' : 'in stock',
      'new', price, sale,
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
