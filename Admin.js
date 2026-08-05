// ============================================================
// Admin.js — Panneau d'administration MONDECO
//
// Gère :
// - Authentification simple
// - Catalogue produits
// - Instructions du bot
// - Discussion de test IA
// - Statistiques
//
// Intégration dans server.js :
//
// const {
//   adminRouter,
//   getBusinessContext,
//   setChatHandler
// } = require('./Admin');
//
// app.use('/admin', adminRouter);
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

// ============================================================
// STOCKAGE DES DONNÉES
// ============================================================
//
// Sur Railway, le disque local peut être effacé lors d'un
// redéploiement.
//
// Si un Volume Railway est utilisé, définir par exemple:
//
// DATA_DIR=/data
//
// Sinon les fichiers sont stockés dans le dossier du projet.
// ============================================================

const DATA_DIR = process.env.DATA_DIR || __dirname;

const PRODUCTS_PATH = path.join(
  DATA_DIR,
  'products.json'
);

const INSTRUCTIONS_PATH = path.join(
  DATA_DIR,
  'business-info.txt'
);

// ============================================================
// FICHIER ADMIN HTML
// ============================================================
//
// IMPORTANT : Admin.html est directement à la racine du projet.
//
// Structure actuelle:
//
// /app/
//   server.js
//   Admin.js
//   Admin.html
//   business-info.txt
//
// Il ne faut donc PAS chercher:
// /app/public/Admin.html
// ============================================================

const ADMIN_HTML_PATH = path.join(
  __dirname,
  'Admin.html'
);

// ============================================================
// MOT DE PASSE ADMIN
// ============================================================
//
// Si ADMIN_PASSWORD existe dans Railway,
// il sera utilisé.
//
// Sinon :
// mondeco2026
// ============================================================

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  'mondeco2026';

if (!process.env.ADMIN_PASSWORD) {
  console.warn(
    '⚠️ ADMIN_PASSWORD non défini — mot de passe par défaut utilisé : mondeco2026'
  );

  console.warn(
    '⚠️ Il est recommandé de définir ADMIN_PASSWORD dans Railway.'
  );
}

// ============================================================
// SESSIONS EN MÉMOIRE
// ============================================================
//
// Suffisant pour un seul administrateur / une instance Railway.
// ============================================================

const validSessions = new Set();

// ============================================================
// COOKIES
// ============================================================

function parseCookies(header) {
  const out = {};

  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');

    if (idx === -1) {
      return;
    }

    const key = pair
      .slice(0, idx)
      .trim();

    const value = pair
      .slice(idx + 1)
      .trim();

    try {
      out[key] = decodeURIComponent(value);
    } catch (error) {
      out[key] = value;
    }
  });

  return out;
}

// ============================================================
// AUTHENTIFICATION
// ============================================================

function requireAuth(req, res, next) {
  const cookies = parseCookies(
    req.headers.cookie || ''
  );

  const token =
    cookies['mondeco_admin_session'];

  if (
    token &&
    validSessions.has(token)
  ) {
    return next();
  }

  // Pour les appels API
  if (req.path.startsWith('/api/')) {
    return res
      .status(401)
      .json({
        error: 'Non authentifié'
      });
  }

  // Pour la page HTML
  return res.redirect('/admin/login');
}

// ============================================================
// CHARGEMENT DES PRODUITS
// ============================================================

function loadProducts() {
  try {
    if (!fs.existsSync(PRODUCTS_PATH)) {
      return [];
    }

    const content = fs.readFileSync(
      PRODUCTS_PATH,
      'utf8'
    );

    if (!content.trim()) {
      return [];
    }

    const products = JSON.parse(content);

    if (!Array.isArray(products)) {
      return [];
    }

    return products;
  } catch (error) {
    console.error(
      '❌ Erreur lecture products.json :',
      error.message
    );

    return [];
  }
}

// ============================================================
// SAUVEGARDE DES PRODUITS
// ============================================================

function saveProducts(products) {
  try {
    fs.mkdirSync(
      DATA_DIR,
      {
        recursive: true
      }
    );

    fs.writeFileSync(
      PRODUCTS_PATH,
      JSON.stringify(
        products,
        null,
        2
      ),
      'utf8'
    );
  } catch (error) {
    console.error(
      '❌ Erreur sauvegarde products.json :',
      error
    );

    throw error;
  }
}

// ============================================================
// CHARGEMENT DES INSTRUCTIONS
// ============================================================

function loadInstructions() {
  try {
    return fs.readFileSync(
      INSTRUCTIONS_PATH,
      'utf8'
    );
  } catch (error) {
    console.warn(
      '⚠️ business-info.txt introuvable ou vide :',
      error.message
    );

    return '';
  }
}

// ============================================================
// SAUVEGARDE DES INSTRUCTIONS
// ============================================================

function saveInstructions(text) {
  try {
    fs.mkdirSync(
      DATA_DIR,
      {
        recursive: true
      }
    );

    fs.writeFileSync(
      INSTRUCTIONS_PATH,
      text,
      'utf8'
    );
  } catch (error) {
    console.error(
      '❌ Erreur sauvegarde business-info.txt :',
      error
    );

    throw error;
  }
}

// ============================================================
// CONTEXTE COMPLET POUR L'IA
// ============================================================
//
// Combine:
//
// business-info.txt
// +
// catalogue products.json
//
// Ce texte est envoyé à Groq depuis server.js.
// ============================================================

function getBusinessContext() {
  const instructions =
    loadInstructions();

  const products =
    loadProducts();

  let productsBlock = '';

  if (products.length > 0) {
    productsBlock =
      '\n\nCATALOGUE PRODUITS DISPONIBLES :\n' +
      products
        .map(product => {
          const prix =
            product.price
              ? ` — ${product.price} TND`
              : '';

          const category =
            product.category
              ? ` (${product.category})`
              : '';

          const description =
            product.description || '';

          return (
            `- ${product.name}` +
            `${category}` +
            `${prix} : ` +
            `${description}`
          );
        })
        .join('\n');
  }

  return `${instructions}${productsBlock}`;
}

// ============================================================
// PARSER JSON
// ============================================================

router.use(
  express.json({
    limit: '2mb'
  })
);

// ============================================================
// PAGE LOGIN
// ============================================================

router.get(
  '/login',
  (req, res) => {
    res
      .status(200)
      .send(
        renderLoginPage()
      );
  }
);

// ============================================================
// CONNEXION ADMIN
// ============================================================

router.post(
  '/login',
  (req, res) => {
    try {
      const {
        password
      } = req.body || {};

      if (password === ADMIN_PASSWORD) {
        const token =
          crypto.randomUUID();

        validSessions.add(token);

        const isProduction =
          process.env.NODE_ENV === 'production' ||
          Boolean(
            process.env.RAILWAY_ENVIRONMENT_NAME
          );

        let cookie =
          `mondeco_admin_session=${token}; ` +
          `HttpOnly; ` +
          `Path=/; ` +
          `Max-Age=86400; ` +
          `SameSite=Lax`;

        if (isProduction) {
          cookie += '; Secure';
        }

        res.setHeader(
          'Set-Cookie',
          cookie
        );

        console.log(
          '✅ Connexion admin réussie'
        );

        return res.json({
          success: true
        });
      }

      console.log(
        '❌ Mot de passe admin incorrect'
      );

      return res
        .status(401)
        .json({
          success: false,
          error: 'Mot de passe incorrect'
        });
    } catch (error) {
      console.error(
        '❌ Erreur connexion Admin :',
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            'Erreur pendant la connexion'
        });
    }
  }
);

// ============================================================
// DÉCONNEXION ADMIN
// ============================================================

router.post(
  '/logout',
  (req, res) => {
    const cookies =
      parseCookies(
        req.headers.cookie || ''
      );

    const token =
      cookies[
        'mondeco_admin_session'
      ];

    if (token) {
      validSessions.delete(token);
    }

    let cookie =
      'mondeco_admin_session=; ' +
      'HttpOnly; ' +
      'Path=/; ' +
      'Max-Age=0; ' +
      'SameSite=Lax';

    if (
      process.env.NODE_ENV === 'production' ||
      process.env.RAILWAY_ENVIRONMENT_NAME
    ) {
      cookie += '; Secure';
    }

    res.setHeader(
      'Set-Cookie',
      cookie
    );

    res.json({
      success: true
    });
  }
);

// ============================================================
// DASHBOARD ADMIN
// ============================================================
//
// CORRECTION IMPORTANTE:
//
// Ancien code:
//
// path.join(__dirname, 'public', 'Admin.html')
//
// Nouveau:
//
// path.join(__dirname, 'Admin.html')
//
// Car Admin.html est directement à la racine du projet.
// ============================================================

router.get(
  '/',
  requireAuth,
  (req, res) => {
    console.log(
      '📄 Tentative ouverture Admin.html :',
      ADMIN_HTML_PATH
    );

    if (!fs.existsSync(ADMIN_HTML_PATH)) {
      console.error(
        '❌ Admin.html introuvable :',
        ADMIN_HTML_PATH
      );

      return res
        .status(500)
        .send(`
          <h1>Erreur Admin MONDECO</h1>

          <p>
            Le fichier Admin.html est introuvable.
          </p>

          <p>
            Chemin recherché :
          </p>

          <pre>${ADMIN_HTML_PATH}</pre>

          <p>
            Vérifiez que Admin.html est bien présent
            à côté de Admin.js dans GitHub.
          </p>
        `);
    }

    return res.sendFile(
      ADMIN_HTML_PATH
    );
  }
);

// ============================================================
// API : LISTER LES PRODUITS
// ============================================================

router.get(
  '/api/products',
  requireAuth,
  (req, res) => {
    res.json(
      loadProducts()
    );
  }
);

// ============================================================
// API : AJOUTER UN PRODUIT
// ============================================================

router.post(
  '/api/products',
  requireAuth,
  (req, res) => {
    try {
      const {
        name,
        description,
        price,
        category,
        image
      } = req.body || {};

      if (
        !name ||
        !String(name).trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              'Le nom du produit est requis'
          });
      }

      const products =
        loadProducts();

      const product = {
        id:
          crypto.randomUUID(),

        name:
          String(name).trim(),

        description:
          String(
            description || ''
          ).trim(),

        price:
          price || '',

        category:
          String(
            category || ''
          ).trim(),

        image:
          String(
            image || ''
          ).trim(),

        createdAt:
          new Date()
            .toISOString()
      };

      products.push(product);

      saveProducts(products);

      return res.json(
        product
      );
    } catch (error) {
      console.error(
        '❌ Erreur ajout produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’ajouter le produit'
        });
    }
  }
);

// ============================================================
// API : MODIFIER UN PRODUIT
// ============================================================

router.put(
  '/api/products/:id',
  requireAuth,
  (req, res) => {
    try {
      const products =
        loadProducts();

      const idx =
        products.findIndex(
          product =>
            product.id ===
            req.params.id
        );

      if (idx === -1) {
        return res
          .status(404)
          .json({
            error:
              'Produit introuvable'
          });
      }

      const {
        name,
        description,
        price,
        category,
        image
      } = req.body || {};

      products[idx] = {
        ...products[idx],

        name:
          name !== undefined
            ? String(name).trim()
            : products[idx].name,

        description:
          description !== undefined
            ? String(description).trim()
            : products[idx].description,

        price:
          price !== undefined
            ? price
            : products[idx].price,

        category:
          category !== undefined
            ? String(category).trim()
            : products[idx].category,

        image:
          image !== undefined
            ? String(image).trim()
            : products[idx].image
      };

      saveProducts(products);

      return res.json(
        products[idx]
      );
    } catch (error) {
      console.error(
        '❌ Erreur modification produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de modifier le produit'
        });
    }
  }
);

// ============================================================
// API : SUPPRIMER UN PRODUIT
// ============================================================

router.delete(
  '/api/products/:id',
  requireAuth,
  (req, res) => {
    try {
      const products =
        loadProducts();

      const exists =
        products.some(
          product =>
            product.id ===
            req.params.id
        );

      if (!exists) {
        return res
          .status(404)
          .json({
            error:
              'Produit introuvable'
          });
      }

      const filtered =
        products.filter(
          product =>
            product.id !==
            req.params.id
        );

      saveProducts(filtered);

      return res.json({
        success: true
      });
    } catch (error) {
      console.error(
        '❌ Erreur suppression produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer le produit'
        });
    }
  }
);

// ============================================================
// API : CHARGER LES INSTRUCTIONS
// ============================================================

router.get(
  '/api/instructions',
  requireAuth,
  (req, res) => {
    res.json({
      text:
        loadInstructions()
    });
  }
);

// ============================================================
// API : SAUVEGARDER LES INSTRUCTIONS
// ============================================================

router.post(
  '/api/instructions',
  requireAuth,
  (req, res) => {
    try {
      const {
        text
      } = req.body || {};

      saveInstructions(
        text || ''
      );

      return res.json({
        success: true
      });
    } catch (error) {
      console.error(
        '❌ Erreur sauvegarde instructions :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de sauvegarder les instructions'
        });
    }
  }
);

// ============================================================
// HANDLER DE CHAT
// ============================================================
//
// server.js appelle:
//
// setChatHandler(generateReply);
// ============================================================

let chatHandler = null;

function setChatHandler(fn) {
  chatHandler = fn;

  console.log(
    '✅ Discussion test Admin connectée à generateReply()'
  );
}

// ============================================================
// API : DISCUSSION TEST
// ============================================================

router.post(
  '/api/test-chat',
  requireAuth,
  async (req, res) => {
    if (!chatHandler) {
      return res
        .status(500)
        .json({
          error:
            'Le bot n’est pas encore connecté à l’interface de test.'
        });
    }

    const {
      message
    } = req.body || {};

    if (
      !message ||
      !String(message).trim()
    ) {
      return res
        .status(400)
        .json({
          error:
            'Message vide'
        });
    }

    try {
      const reply =
        await chatHandler(
          'admin-test-session',
          String(message).trim()
        );

      return res.json({
        reply
      });
    } catch (error) {
      console.error(
        '❌ Erreur test IA depuis Admin :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Erreur pendant la génération de la réponse'
        });
    }
  }
);

// ============================================================
// API : STATISTIQUES
// ============================================================

router.get(
  '/api/stats',
  requireAuth,
  (req, res) => {
    const products =
      loadProducts();

    const instructions =
      loadInstructions();

    res.json({
      productCount:
        products.length,

      instructionsConfigured:
        instructions.trim().length > 0,

      instructionsLength:
        instructions.trim().length
    });
  }
);

// ============================================================
// PAGE HTML LOGIN
// ============================================================

function renderLoginPage() {
  return `
<!DOCTYPE html>

<html lang="fr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
  Mondeco — Administration
</title>

<style>

@import url(
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap'
);

* {
  box-sizing:
    border-box;

  margin:
    0;

  padding:
    0;
}

body {
  font-family:
    'Inter',
    sans-serif;

  background:
    #1F1B16;

  background-image:
    radial-gradient(
      circle at 20% 20%,
      #2A241C 0%,
      #1F1B16 60%
    );

  min-height:
    100vh;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  padding:
    20px;
}

.card {
  background:
    #F7F4EF;

  border-radius:
    12px;

  padding:
    48px 40px;

  width:
    100%;

  max-width:
    380px;

  box-shadow:
    0 20px 60px
    rgba(0,0,0,0.4);
}

.wordmark {
  font-family:
    'Fraunces',
    serif;

  font-size:
    28px;

  font-weight:
    600;

  color:
    #1F1B16;
}

.subtitle {
  color:
    #7A7266;

  font-size:
    14px;

  margin-top:
    4px;

  margin-bottom:
    32px;
}

label {
  display:
    block;

  font-size:
    13px;

  font-weight:
    500;

  color:
    #4A4438;

  margin-bottom:
    6px;
}

input {
  width:
    100%;

  padding:
    12px 14px;

  border:
    1.5px solid
    #E4DED2;

  border-radius:
    8px;

  font-size:
    15px;

  font-family:
    'Inter',
    sans-serif;

  background:
    #fff;

  color:
    #1F1B16;
}

input:focus {
  outline:
    none;

  border-color:
    #B5541F;
}

button {
  width:
    100%;

  margin-top:
    20px;

  padding:
    13px;

  border:
    none;

  border-radius:
    8px;

  background:
    #B5541F;

  color:
    #fff;

  font-size:
    15px;

  font-weight:
    600;

  cursor:
    pointer;

  font-family:
    'Inter',
    sans-serif;
}

button:hover {
  background:
    #9C4718;
}

button:disabled {
  opacity:
    0.65;

  cursor:
    wait;
}

.error {
  color:
    #B5541F;

  font-size:
    13px;

  margin-top:
    12px;

  line-height:
    1.4;

  display:
    none;
}

</style>

</head>

<body>

<div class="card">

  <div class="wordmark">
    Mondeco
  </div>

  <div class="subtitle">
    Administration du bot WhatsApp
  </div>

  <form id="loginForm">

    <label for="password">
      Mot de passe
    </label>

    <input
      type="password"
      id="password"
      name="password"
      autocomplete="current-password"
      autofocus
      required
    >

    <button
      type="submit"
      id="loginButton"
    >
      Se connecter
    </button>

    <div
      class="error"
      id="error"
    >
      Mot de passe incorrect
    </div>

  </form>

</div>

<script>

const form =
  document.getElementById(
    'loginForm'
  );

const button =
  document.getElementById(
    'loginButton'
  );

const errorBox =
  document.getElementById(
    'error'
  );

form.addEventListener(
  'submit',
  async (event) => {

    event.preventDefault();

    errorBox.style.display =
      'none';

    button.disabled =
      true;

    button.textContent =
      'Connexion...';

    try {

      const password =
        document.getElementById(
          'password'
        ).value;

      const response =
        await fetch(
          '/admin/login',
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                password
              })
          }
        );

      let data = {};

      try {
        data =
          await response.json();
      } catch (error) {
        data = {};
      }

      if (
        response.ok &&
        data.success
      ) {

        window.location.href =
          '/admin';

      } else {

        errorBox.textContent =
          data.error ||
          'Mot de passe incorrect';

        errorBox.style.display =
          'block';

      }

    } catch (error) {

      errorBox.textContent =
        'Erreur de connexion au serveur';

      errorBox.style.display =
        'block';

    } finally {

      button.disabled =
        false;

      button.textContent =
        'Se connecter';

    }

  }
);

</script>

</body>

</html>
`;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  adminRouter: router,
  getBusinessContext,
  setChatHandler
};
