// admin.js — Panneau d'administration Mondeco
// Gère : authentification simple, catalogue produits, instructions du bot (system prompt)
//
// Intégration dans server.js :
//   const { adminRouter, getBusinessContext } = require('./admin');
//   app.use('/admin', adminRouter);
//   // puis dans generateReply(), remplacer loadBusinessInfo() par getBusinessContext()

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

// --- Où stocker les données ---
// IMPORTANT : sur Railway, le disque est effacé à chaque redéploiement sauf si un
// Volume est monté. Définis la variable d'env DATA_DIR pour pointer vers le volume
// (ex: DATA_DIR=/data). En local / sans volume, ça retombe sur le dossier du projet.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const INSTRUCTIONS_PATH = path.join(DATA_DIR, 'business-info.txt');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mondeco2026';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD non défini — mot de passe par défaut utilisé. À changer sur Railway.');
}

// --- Sessions en mémoire (suffisant pour un seul admin / une seule instance) ---
const validSessions = new Set();

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies['mondeco_admin_session'];
  if (token && validSessions.has(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non authentifié' });
  return res.redirect('/admin/login');
}

function parseCookies(header) {
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// --- Stockage produits ---
function loadProducts() {
  try {
    return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveProducts(products) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

// --- Stockage instructions générales ---
function loadInstructions() {
  try {
    return fs.readFileSync(INSTRUCTIONS_PATH, 'utf8');
  } catch (e) {
    return '';
  }
}

function saveInstructions(text) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INSTRUCTIONS_PATH, text);
}

// --- Construit le contexte complet envoyé à l'IA (instructions + catalogue produits) ---
function getBusinessContext() {
  const instructions = loadInstructions();
  const products = loadProducts();

  let productsBlock = '';
  if (products.length > 0) {
    productsBlock = '\n\nCATALOGUE PRODUITS DISPONIBLES :\n' + products.map(p => {
      const prix = p.price ? ` — ${p.price} TND` : '';
      const cat = p.category ? ` (${p.category})` : '';
      return `- ${p.name}${cat}${prix} : ${p.description || ''}`;
    }).join('\n');
  }

  return `${instructions}${productsBlock}`;
}

// --- Middleware pour parser le body des formulaires JSON ---
router.use(express.json());

// --- Page de login ---
router.get('/login', (req, res) => {
  res.send(renderLoginPage());
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomUUID();
    validSessions.add(token);
    res.setHeader('Set-Cookie', `mondeco_admin_session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
});

router.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  validSessions.delete(cookies['mondeco_admin_session']);
  res.setHeader('Set-Cookie', 'mondeco_admin_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ success: true });
});

// --- Dashboard (protégé) ---
router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin.html'));
});

// --- API Produits (protégée) ---
router.get('/api/products', requireAuth, (req, res) => {
  res.json(loadProducts());
});

router.post('/api/products', requireAuth, (req, res) => {
  const { name, description, price, category, image } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Le nom du produit est requis' });
  }
  const products = loadProducts();
  const product = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: (description || '').trim(),
    price: price || '',
    category: (category || '').trim(),
    image: (image || '').trim(),
    createdAt: new Date().toISOString()
  };
  products.push(product);
  saveProducts(products);
  res.json(product);
});

router.put('/api/products/:id', requireAuth, (req, res) => {
  const products = loadProducts();
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Produit introuvable' });
  const { name, description, price, category, image } = req.body;
  products[idx] = {
    ...products[idx],
    name: name?.trim() ?? products[idx].name,
    description: description?.trim() ?? products[idx].description,
    price: price ?? products[idx].price,
    category: category?.trim() ?? products[idx].category,
    image: image?.trim() ?? products[idx].image
  };
  saveProducts(products);
  res.json(products[idx]);
});

router.delete('/api/products/:id', requireAuth, (req, res) => {
  const products = loadProducts();
  const filtered = products.filter(p => p.id !== req.params.id);
  saveProducts(filtered);
  res.json({ success: true });
});

// --- API Instructions (protégée) ---
router.get('/api/instructions', requireAuth, (req, res) => {
  res.json({ text: loadInstructions() });
});

router.post('/api/instructions', requireAuth, (req, res) => {
  const { text } = req.body;
  saveInstructions(text || '');
  res.json({ success: true });
});

// --- Handler de chat branché depuis server.js (voir setChatHandler plus bas) ---
let chatHandler = null;
function setChatHandler(fn) {
  chatHandler = fn;
}

// --- API Discussion de test (protégée) ---
router.post('/api/test-chat', requireAuth, async (req, res) => {
  if (!chatHandler) {
    return res.status(500).json({ error: 'Le bot n\'est pas encore connecté à l\'interface de test.' });
  }
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message vide' });
  }
  try {
    const reply = await chatHandler('admin-test-session', message.trim());
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur pendant la génération de la réponse' });
  }
});

// --- API Stats pour la page Accueil (protégée) ---
router.get('/api/stats', requireAuth, (req, res) => {
  const products = loadProducts();
  const instructions = loadInstructions();
  res.json({
    productCount: products.length,
    instructionsConfigured: instructions.trim().length > 0,
    instructionsLength: instructions.trim().length
  });
});

function renderLoginPage() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mondeco — Administration</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', sans-serif;
    background: #1F1B16;
    background-image: radial-gradient(circle at 20% 20%, #2A241C 0%, #1F1B16 60%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #F7F4EF;
    border-radius: 12px;
    padding: 48px 40px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  .wordmark { font-family: 'Fraunces', serif; font-size: 28px; font-weight: 600; color: #1F1B16; }
  .subtitle { color: #7A7266; font-size: 14px; margin-top: 4px; margin-bottom: 32px; }
  label { display: block; font-size: 13px; font-weight: 500; color: #4A4438; margin-bottom: 6px; }
  input {
    width: 100%; padding: 12px 14px; border: 1.5px solid #E4DED2; border-radius: 8px;
    font-size: 15px; font-family: 'Inter', sans-serif; background: #fff; color: #1F1B16;
  }
  input:focus { outline: none; border-color: #B5541F; }
  button {
    width: 100%; margin-top: 20px; padding: 13px; border: none; border-radius: 8px;
    background: #B5541F; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
    font-family: 'Inter', sans-serif;
  }
  button:hover { background: #9C4718; }
  .error { color: #B5541F; font-size: 13px; margin-top: 12px; display: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">Mondeco</div>
    <div class="subtitle">Administration du bot WhatsApp</div>
    <form id="loginForm">
      <label for="password">Mot de passe</label>
      <input type="password" id="password" name="password" autofocus required>
      <button type="submit">Se connecter</button>
      <div class="error" id="error">Mot de passe incorrect</div>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (data.success) {
        window.location.href = '/admin';
      } else {
        document.getElementById('error').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

module.exports = { adminRouter: router, getBusinessContext, setChatHandler };
