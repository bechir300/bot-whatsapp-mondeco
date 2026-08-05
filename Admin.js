// ============================================================
// MONDECO - PANNEAU D'ADMINISTRATION
// Fichier : Admin.js
//
// Gère :
// - Authentification administrateur
// - Catalogue produits
// - Instructions du bot
// - Test de l'IA
// - Statistiques
//
// Dans server.js :
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
// CONFIGURATION
// ============================================================

// Admin.html est à la RACINE du projet.
// PAS dans /public.
const ADMIN_HTML_PATH = path.join(
  __dirname,
  'Admin.html'
);

// business-info.txt fourni dans le dépôt GitHub
const DEFAULT_BUSINESS_INFO_PATH = path.join(
  __dirname,
  'business-info.txt'
);

// ------------------------------------------------------------
// Stockage
//
// Si DATA_DIR est défini dans Railway, par exemple:
//
// DATA_DIR=/data
//
// les modifications peuvent être enregistrées dans un Volume
// Railway.
//
// Sinon, les fichiers sont enregistrés dans le dossier courant.
// Ils pourront être perdus lors d'un redéploiement Railway.
// ------------------------------------------------------------

const DATA_DIR = (
  process.env.DATA_DIR ||
  __dirname
).trim();

const PRODUCTS_PATH = path.join(
  DATA_DIR,
  'products.json'
);

const INSTRUCTIONS_PATH = path.join(
  DATA_DIR,
  'business-info.txt'
);

// ============================================================
// MOT DE PASSE ADMIN
// ============================================================

// IMPORTANT :
// Définir ADMIN_PASSWORD dans Railway > Variables.
//
// Exemple :
// ADMIN_PASSWORD = ton_mot_de_passe
//
// Aucun mot de passe sensible n'est écrit dans GitHub.
const ADMIN_PASSWORD = (
  process.env.ADMIN_PASSWORD ||
  ''
).trim();

if (!ADMIN_PASSWORD) {
  console.warn('');
  console.warn('========================================');
  console.warn('⚠️ ADMIN_PASSWORD NON CONFIGURÉ');
  console.warn('→ Ajouter ADMIN_PASSWORD dans Railway > Variables');
  console.warn('→ La connexion admin restera bloquée tant que cette variable est absente.');
  console.warn('========================================');
  console.warn('');
}

// ============================================================
// INITIALISATION DU STOCKAGE
// ============================================================

function initializeStorage() {
  try {
    fs.mkdirSync(
      DATA_DIR,
      { recursive: true }
    );

    // --------------------------------------------------------
    // products.json
    // --------------------------------------------------------

    if (!fs.existsSync(PRODUCTS_PATH)) {
      fs.writeFileSync(
        PRODUCTS_PATH,
        JSON.stringify([], null, 2),
        'utf8'
      );

      console.log(
        '✅ products.json initialisé'
      );
    }

    // --------------------------------------------------------
    // business-info.txt
    //
    // Si on utilise /data avec un Volume Railway,
    // on copie automatiquement le business-info.txt
    // du dépôt lors de la première utilisation.
    // --------------------------------------------------------

    if (!fs.existsSync(INSTRUCTIONS_PATH)) {
      if (
        fs.existsSync(DEFAULT_BUSINESS_INFO_PATH) &&
        DEFAULT_BUSINESS_INFO_PATH !== INSTRUCTIONS_PATH
      ) {
        const originalContent =
          fs.readFileSync(
            DEFAULT_BUSINESS_INFO_PATH,
            'utf8'
          );

        fs.writeFileSync(
          INSTRUCTIONS_PATH,
          originalContent,
          'utf8'
        );

        console.log(
          '✅ business-info.txt copié vers DATA_DIR'
        );
      } else {
        fs.writeFileSync(
          INSTRUCTIONS_PATH,
          '',
          'utf8'
        );

        console.log(
          '✅ business-info.txt initialisé'
        );
      }
    }

    console.log(
      `📁 Admin DATA_DIR : ${DATA_DIR}`
    );
  } catch (error) {
    console.error(
      '❌ Erreur initialisation stockage Admin :',
      error
    );
  }
}

initializeStorage();

// ============================================================
// SESSIONS ADMIN
// ============================================================

// Map :
// token => timestamp expiration
const validSessions = new Map();

// Durée de session : 24 heures
const SESSION_DURATION =
  24 * 60 * 60 * 1000;

// ============================================================
// COOKIES
// ============================================================

function parseCookies(header) {
  const cookies = {};

  if (!header) {
    return cookies;
  }

  header
    .split(';')
    .forEach(pair => {
      const index = pair.indexOf('=');

      if (index === -1) {
        return;
      }

      const key =
        pair
          .slice(0, index)
          .trim();

      const rawValue =
        pair
          .slice(index + 1)
          .trim();

      try {
        cookies[key] =
          decodeURIComponent(rawValue);
      } catch {
        cookies[key] = rawValue;
      }
    });

  return cookies;
}

// ============================================================
// NETTOYAGE DES SESSIONS
// ============================================================

function cleanExpiredSessions() {
  const now = Date.now();

  for (
    const [token, expiresAt]
    of validSessions.entries()
  ) {
    if (expiresAt <= now) {
      validSessions.delete(token);
    }
  }
}

// ============================================================
// VALIDATION SESSION
// ============================================================

function isValidSession(token) {
  if (!token) {
    return false;
  }

  cleanExpiredSessions();

  const expiresAt =
    validSessions.get(token);

  if (!expiresAt) {
    return false;
  }

  if (expiresAt <= Date.now()) {
    validSessions.delete(token);
    return false;
  }

  return true;
}

// ============================================================
// COMPARAISON SÉCURISÉE DU MOT DE PASSE
// ============================================================

function safeCompare(valueA, valueB) {
  const a = Buffer.from(
    String(valueA || '')
  );

  const b = Buffer.from(
    String(valueB || '')
  );

  if (a.length !== b.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      a,
      b
    );
  } catch {
    return false;
  }
}

// ============================================================
// MIDDLEWARE AUTHENTIFICATION
// ============================================================

function requireAuth(req, res, next) {
  const cookies =
    parseCookies(
      req.headers.cookie || ''
    );

  const token =
    cookies.mondeco_admin_session;

  if (isValidSession(token)) {
    return next();
  }

  // Pour les API :
  // renvoyer JSON 401
  if (req.path.startsWith('/api/')) {
    return res
      .status(401)
      .json({
        error: 'Non authentifié'
      });
  }

  // Pour le dashboard :
  // redirection vers login
  return res.redirect(
    '/admin/login'
  );
}

// ============================================================
// EXPRESS JSON
// ============================================================

router.use(
  express.json({
    limit: '2mb'
  })
);

// ============================================================
// PRODUITS
// ============================================================

function loadProducts() {
  try {
    if (!fs.existsSync(PRODUCTS_PATH)) {
      return [];
    }

    const content =
      fs.readFileSync(
        PRODUCTS_PATH,
        'utf8'
      );

    if (!content.trim()) {
      return [];
    }

    const parsed =
      JSON.parse(content);

    if (!Array.isArray(parsed)) {
      console.warn(
        '⚠️ products.json ne contient pas un tableau.'
      );

      return [];
    }

    return parsed;
  } catch (error) {
    console.error(
      '❌ Erreur lecture products.json :',
      error.message
    );

    return [];
  }
}

// ============================================================
// SAUVEGARDE PRODUITS
// ============================================================

function saveProducts(products) {
  try {
    fs.mkdirSync(
      DATA_DIR,
      { recursive: true }
    );

    const temporaryPath =
      `${PRODUCTS_PATH}.tmp`;

    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(
        products,
        null,
        2
      ),
      'utf8'
    );

    fs.renameSync(
      temporaryPath,
      PRODUCTS_PATH
    );

    return true;
  } catch (error) {
    console.error(
      '❌ Erreur sauvegarde products.json :',
      error
    );

    throw new Error(
      'Impossible de sauvegarder le catalogue.'
    );
  }
}

// ============================================================
// INSTRUCTIONS DU BOT
// ============================================================

function loadInstructions() {
  try {
    if (!fs.existsSync(INSTRUCTIONS_PATH)) {
      return '';
    }

    return fs.readFileSync(
      INSTRUCTIONS_PATH,
      'utf8'
    );
  } catch (error) {
    console.error(
      '❌ Erreur lecture business-info.txt :',
      error.message
    );

    return '';
  }
}

// ============================================================
// SAUVEGARDE INSTRUCTIONS
// ============================================================

function saveInstructions(text) {
  try {
    fs.mkdirSync(
      DATA_DIR,
      { recursive: true }
    );

    const temporaryPath =
      `${INSTRUCTIONS_PATH}.tmp`;

    fs.writeFileSync(
      temporaryPath,
      String(text || ''),
      'utf8'
    );

    fs.renameSync(
      temporaryPath,
      INSTRUCTIONS_PATH
    );

    return true;
  } catch (error) {
    console.error(
      '❌ Erreur sauvegarde business-info.txt :',
      error
    );

    throw new Error(
      'Impossible de sauvegarder les instructions.'
    );
  }
}

// ============================================================
// CONTEXTE COMPLET POUR L'IA
// ============================================================

function getBusinessContext() {
  const instructions =
    loadInstructions();

  const products =
    loadProducts();

  let productsBlock = '';

  if (products.length > 0) {
    productsBlock =
      '\n\nCATALOGUE PRODUITS DISPONIBLES :\n';

    productsBlock += products
      .map(product => {
        const name =
          String(
            product.name || ''
          ).trim();

        const category =
          String(
            product.category || ''
          ).trim();

        const description =
          String(
            product.description || ''
          ).trim();

        const price =
          product.price !== undefined &&
          product.price !== null
            ? String(product.price).trim()
            : '';

        const categoryText =
          category
            ? ` (${category})`
            : '';

        const priceText =
          price
            ? ` — ${price} TND`
            : '';

        const descriptionText =
          description
            ? ` : ${description}`
            : '';

        return (
          `- ${name}` +
          `${categoryText}` +
          `${priceText}` +
          `${descriptionText}`
        );
      })
      .join('\n');
  }

  return (
    `${instructions}` +
    `${productsBlock}`
  ).trim();
}

// ============================================================
// PAGE LOGIN
// ============================================================

router.get(
  '/login',
  (req, res) => {
    // Si déjà connecté, aller directement au dashboard
    const cookies =
      parseCookies(
        req.headers.cookie || ''
      );

    if (
      isValidSession(
        cookies.mondeco_admin_session
      )
    ) {
      return res.redirect('/admin');
    }

    res
      .status(200)
      .type('html')
      .send(
        renderLoginPage()
      );
  }
);

// ============================================================
// CONNEXION
// ============================================================

router.post(
  '/login',
  (req, res) => {
    try {
      // ------------------------------------------------------
      // Mot de passe non configuré
      // ------------------------------------------------------

      if (!ADMIN_PASSWORD) {
        console.error(
          '❌ Tentative connexion admin mais ADMIN_PASSWORD absent.'
        );

        return res
          .status(503)
          .json({
            success: false,
            error:
              'Le mot de passe administrateur n’est pas encore configuré dans Railway.'
          });
      }

      const password =
        String(
          req.body?.password || ''
        );

      // ------------------------------------------------------
      // Mauvais mot de passe
      // ------------------------------------------------------

      if (
        !safeCompare(
          password,
          ADMIN_PASSWORD
        )
      ) {
        console.warn(
          '⚠️ Tentative de connexion admin refusée.'
        );

        return res
          .status(401)
          .json({
            success: false,
            error:
              'Mot de passe incorrect'
          });
      }

      // ------------------------------------------------------
      // Authentification OK
      // ------------------------------------------------------

      const token =
        crypto.randomBytes(32)
          .toString('hex');

      const expiresAt =
        Date.now() +
        SESSION_DURATION;

      validSessions.set(
        token,
        expiresAt
      );

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
        '✅ Connexion administrateur réussie'
      );

      return res.json({
        success: true
      });
    } catch (error) {
      console.error(
        '❌ Erreur connexion admin :',
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            'Erreur serveur pendant la connexion.'
        });
    }
  }
);

// ============================================================
// DÉCONNEXION
// ============================================================

router.post(
  '/logout',
  (req, res) => {
    const cookies =
      parseCookies(
        req.headers.cookie || ''
      );

    const token =
      cookies.mondeco_admin_session;

    if (token) {
      validSessions.delete(token);
    }

    const isProduction =
      process.env.NODE_ENV === 'production' ||
      Boolean(
        process.env.RAILWAY_ENVIRONMENT_NAME
      );

    let cookie =
      'mondeco_admin_session=; ' +
      'HttpOnly; ' +
      'Path=/; ' +
      'Max-Age=0; ' +
      'SameSite=Lax';

    if (isProduction) {
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

router.get(
  '/',
  requireAuth,
  (req, res) => {
    // IMPORTANT :
    //
    // Ton fichier est :
    // /app/Admin.html
    //
    // et NON :
    // /app/public/admin.html

    if (!fs.existsSync(ADMIN_HTML_PATH)) {
      console.error(
        `❌ Admin.html introuvable : ${ADMIN_HTML_PATH}`
      );

      return res
        .status(500)
        .send(`
          <h1>Erreur Mondeco Admin</h1>
          <p>Le fichier Admin.html est introuvable sur le serveur.</p>
          <p>Chemin attendu : ${ADMIN_HTML_PATH}</p>
        `);
    }

    return res.sendFile(
      ADMIN_HTML_PATH,
      error => {
        if (error) {
          console.error(
            '❌ Erreur envoi Admin.html :',
            error
          );

          if (!res.headersSent) {
            res
              .status(500)
              .json({
                error:
                  'Impossible de charger Admin.html'
              });
          }
        }
      }
    );
  }
);

// ============================================================
// API - LISTE PRODUITS
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
// API - AJOUTER PRODUIT
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

      const cleanName =
        String(name || '').trim();

      if (!cleanName) {
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
          cleanName,

        description:
          String(
            description || ''
          ).trim(),

        price:
          price !== undefined &&
          price !== null
            ? String(price).trim()
            : '',

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
            .toISOString(),

        updatedAt:
          new Date()
            .toISOString()
      };

      products.push(
        product
      );

      saveProducts(
        products
      );

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
            error.message ||
            'Impossible d’ajouter le produit'
        });
    }
  }
);

// ============================================================
// API - MODIFIER PRODUIT
// ============================================================

router.put(
  '/api/products/:id',
  requireAuth,
  (req, res) => {
    try {
      const products =
        loadProducts();

      const index =
        products.findIndex(
          product =>
            product.id ===
            req.params.id
        );

      if (index === -1) {
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

      // Le nom ne doit jamais devenir vide.
      if (
        name !== undefined &&
        !String(name).trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              'Le nom du produit ne peut pas être vide'
          });
      }

      products[index] = {
        ...products[index],

        name:
          name !== undefined
            ? String(name).trim()
            : products[index].name,

        description:
          description !== undefined
            ? String(description).trim()
            : products[index].description,

        price:
          price !== undefined &&
          price !== null
            ? String(price).trim()
            : products[index].price,

        category:
          category !== undefined
            ? String(category).trim()
            : products[index].category,

        image:
          image !== undefined
            ? String(image).trim()
            : products[index].image,

        updatedAt:
          new Date()
            .toISOString()
      };

      saveProducts(
        products
      );

      return res.json(
        products[index]
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
            error.message ||
            'Impossible de modifier le produit'
        });
    }
  }
);

// ============================================================
// API - SUPPRIMER PRODUIT
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

      saveProducts(
        filtered
      );

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
            error.message ||
            'Impossible de supprimer le produit'
        });
    }
  }
);

// ============================================================
// API - LIRE INSTRUCTIONS
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
// API - SAUVEGARDER INSTRUCTIONS
// ============================================================

router.post(
  '/api/instructions',
  requireAuth,
  (req, res) => {
    try {
      const text =
        String(
          req.body?.text || ''
        );

      saveInstructions(
        text
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
            error.message ||
            'Impossible de sauvegarder les instructions'
        });
    }
  }
);

// ============================================================
// CHAT HANDLER
// ============================================================

let chatHandler = null;

function setChatHandler(fn) {
  if (
    typeof fn !== 'function'
  ) {
    throw new Error(
      'setChatHandler attend une fonction.'
    );
  }

  chatHandler = fn;

  console.log(
    '✅ Chat IA connecté au panneau Admin'
  );
}

// ============================================================
// API - DISCUSSION TEST IA
// ============================================================

router.post(
  '/api/test-chat',
  requireAuth,
  async (req, res) => {
    try {
      if (!chatHandler) {
        return res
          .status(503)
          .json({
            error:
              'Le bot IA n’est pas encore connecté à l’interface de test.'
          });
      }

      const message =
        String(
          req.body?.message || ''
        ).trim();

      if (!message) {
        return res
          .status(400)
          .json({
            error:
              'Message vide'
          });
      }

      const reply =
        await chatHandler(
          'admin-test-session',
          message
        );

      return res.json({
        reply
      });
    } catch (error) {
      console.error(
        '❌ Erreur discussion test :',
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
// API - STATISTIQUES
// ============================================================

router.get(
  '/api/stats',
  requireAuth,
  (req, res) => {
    try {
      const products =
        loadProducts();

      const instructions =
        loadInstructions();

      const cleanInstructions =
        instructions.trim();

      res.json({
        productCount:
          products.length,

        instructionsConfigured:
          cleanInstructions.length > 0,

        instructionsLength:
          cleanInstructions.length,

        dataDirectory:
          DATA_DIR,

        adminHtmlAvailable:
          fs.existsSync(
            ADMIN_HTML_PATH
          )
      });
    } catch (error) {
      console.error(
        '❌ Erreur stats admin :',
        error
      );

      res
        .status(500)
        .json({
          error:
            'Impossible de charger les statistiques'
        });
    }
  }
);

// ============================================================
// PAGE LOGIN HTML
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
    box-sizing: border-box;
    margin: 0;
    padding: 0;
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
      420px;

    box-shadow:
      0 20px 60px
      rgba(
        0,
        0,
        0,
        0.4
      );
  }

  .wordmark {
    font-family:
      'Fraunces',
      serif;

    font-size:
      34px;

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
      5px;

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
      7px;
  }

  input {
    width:
      100%;

    padding:
      13px 14px;

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
      0.6;

    cursor:
      not-allowed;
  }

  .error {
    color:
      #B5541F;

    font-size:
      13px;

    line-height:
      1.45;

    margin-top:
      12px;

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
      id="loginButton"
      type="submit"
    >
      Se connecter
    </button>

    <div
      class="error"
      id="error"
    >
    </div>

  </form>

</div>

<script>

const form =
  document.getElementById(
    'loginForm'
  );

const passwordInput =
  document.getElementById(
    'password'
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
  async event => {

    event.preventDefault();

    errorBox.style.display =
      'none';

    errorBox.textContent =
      '';

    button.disabled =
      true;

    button.textContent =
      'Connexion...';

    try {

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
                password:
                  passwordInput.value
              })
          }
        );

      let data = {};

      try {
        data =
          await response.json();
      } catch {
        data = {};
      }

      if (
        response.ok &&
        data.success
      ) {

        window.location.href =
          '/admin';

        return;
      }

      errorBox.textContent =
        data.error ||
        'Connexion impossible.';

      errorBox.style.display =
        'block';

    } catch (error) {

      errorBox.textContent =
        'Impossible de contacter le serveur.';

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
