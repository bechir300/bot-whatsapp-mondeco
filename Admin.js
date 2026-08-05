// ============================================================
// MONDECO - PANNEAU D'ADMINISTRATION
// Fichier : Admin.js
//
// Gère :
// - Authentification
// - Catalogue produits
// - Instructions IA séparées
// - Import ancien business-info.txt
// - Import plusieurs instructions
// - Discussion de test
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

const DATA_DIR = process.env.DATA_DIR || __dirname;

const PRODUCTS_PATH = path.join(
  DATA_DIR,
  'products.json'
);

const INSTRUCTIONS_JSON_PATH = path.join(
  DATA_DIR,
  'instructions.json'
);

// Ancien fichier utilisé avant les instructions séparées
const LEGACY_BUSINESS_INFO_PATH = path.join(
  __dirname,
  'business-info.txt'
);

// Admin.html est directement à la racine du projet
const ADMIN_HTML_PATH = path.join(
  __dirname,
  'Admin.html'
);

// ============================================================
// MOT DE PASSE ADMIN
// ============================================================

// Si ADMIN_PASSWORD est défini dans Railway,
// sa valeur sera utilisée.
//
// Sinon : mondeco2026

const ADMIN_PASSWORD =
  (process.env.ADMIN_PASSWORD || 'mondeco2026').trim();

if (!process.env.ADMIN_PASSWORD) {
  console.warn(
    '⚠️ ADMIN_PASSWORD non défini dans Railway.'
  );

  console.warn(
    '⚠️ Mot de passe par défaut utilisé : mondeco2026'
  );
}

// ============================================================
// BODY JSON
// ============================================================

router.use(
  express.json({
    limit: '5mb'
  })
);

// ============================================================
// SESSIONS
// ============================================================

const validSessions = new Map();

const SESSION_DURATION =
  24 * 60 * 60 * 1000;

// ============================================================
// COOKIES
// ============================================================

function parseCookies(header = '') {
  const cookies = {};

  header.split(';').forEach(pair => {
    const index = pair.indexOf('=');

    if (index === -1) {
      return;
    }

    const key = pair
      .slice(0, index)
      .trim();

    const rawValue = pair
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
// SESSIONS
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

function requireAuth(req, res, next) {
  const cookies = parseCookies(
    req.headers.cookie || ''
  );

  const token =
    cookies.mondeco_admin_session;

  if (isValidSession(token)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res
      .status(401)
      .json({
        error: 'Non authentifié'
      });
  }

  return res.redirect('/admin/login');
}

// ============================================================
// PRODUITS
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

    const data = JSON.parse(content);

    return Array.isArray(data)
      ? data
      : [];

  } catch (error) {
    console.error(
      '❌ Erreur lecture products.json :',
      error
    );

    return [];
  }
}

function saveProducts(products) {
  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true
    }
  );

  const tempPath =
    `${PRODUCTS_PATH}.tmp`;

  fs.writeFileSync(
    tempPath,
    JSON.stringify(
      products,
      null,
      2
    ),
    'utf8'
  );

  fs.renameSync(
    tempPath,
    PRODUCTS_PATH
  );
}

// ============================================================
// INSTRUCTIONS STRUCTURÉES
// ============================================================

function structuredInstructionsStoreExists() {
  return fs.existsSync(
    INSTRUCTIONS_JSON_PATH
  );
}

function loadInstructions() {
  try {
    if (
      !fs.existsSync(
        INSTRUCTIONS_JSON_PATH
      )
    ) {
      return [];
    }

    const content = fs.readFileSync(
      INSTRUCTIONS_JSON_PATH,
      'utf8'
    );

    if (!content.trim()) {
      return [];
    }

    const data = JSON.parse(content);

    return Array.isArray(data)
      ? data
      : [];

  } catch (error) {
    console.error(
      '❌ Erreur lecture instructions.json :',
      error
    );

    return [];
  }
}

function saveInstructions(instructions) {
  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true
    }
  );

  const tempPath =
    `${INSTRUCTIONS_JSON_PATH}.tmp`;

  fs.writeFileSync(
    tempPath,
    JSON.stringify(
      instructions,
      null,
      2
    ),
    'utf8'
  );

  fs.renameSync(
    tempPath,
    INSTRUCTIONS_JSON_PATH
  );
}

// ============================================================
// ANCIEN BUSINESS-INFO.TXT
// ============================================================

function loadLegacyBusinessInfo() {
  try {
    if (
      !fs.existsSync(
        LEGACY_BUSINESS_INFO_PATH
      )
    ) {
      return '';
    }

    return fs.readFileSync(
      LEGACY_BUSINESS_INFO_PATH,
      'utf8'
    );

  } catch (error) {
    console.error(
      '❌ Erreur lecture business-info.txt :',
      error
    );

    return '';
  }
}

// ============================================================
// NETTOYAGE TITRE INSTRUCTION
// ============================================================

function cleanInstructionTitle(text) {
  return String(text || '')
    .replace(
      /^[\s\-–—•*#\d.)]+/,
      ''
    )
    .trim();
}

// ============================================================
// TRANSFORMER UN TEXTE EN PLUSIEURS INSTRUCTIONS
// ============================================================

function parseInstructionBlocks(text) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!normalized) {
    return [];
  }

  const blocks = normalized
    .split(/\n\s*\n+/)
    .map(block => block.trim())
    .filter(Boolean);

  return blocks
    .map(block => {
      const lines = block
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        return null;
      }

      let title =
        cleanInstructionTitle(
          lines[0]
        );

      let content = lines
        .slice(1)
        .join('\n')
        .trim();

      // Si le bloc ne contient qu'une seule ligne
      if (!content) {
        const colonIndex =
          title.indexOf(':');

        if (
          colonIndex > 5 &&
          colonIndex < 100
        ) {
          content = title
            .slice(colonIndex + 1)
            .trim();

          title = title
            .slice(0, colonIndex)
            .trim();
        } else {
          content = title;
        }
      }

      if (!title) {
        title =
          content.slice(0, 80);
      }

      // Limite uniquement le titre visuel
      if (title.length > 120) {
        title =
          title.slice(0, 117) +
          '...';
      }

      return {
        title,
        content
      };
    })
    .filter(Boolean);
}

// ============================================================
// EMPÊCHER LES DOUBLONS À L'IMPORT
// ============================================================

function instructionFingerprint(
  title,
  content
) {
  return crypto
    .createHash('sha256')
    .update(
      `${String(title).trim().toLowerCase()}|${String(content).trim().toLowerCase()}`
    )
    .digest('hex');
}

// ============================================================
// CONTEXTE ENVOYÉ À GROQ
// ============================================================

function getBusinessContext() {
  const products =
    loadProducts();

  const instructions =
    loadInstructions();

  let instructionsBlock = '';

  // ----------------------------------------------------------
  // Si instructions.json existe :
  // utiliser UNIQUEMENT les instructions actives.
  //
  // Cela permet de désactiver une règle sans qu'elle revienne
  // depuis business-info.txt.
  // ----------------------------------------------------------

  if (
    structuredInstructionsStoreExists()
  ) {
    const activeInstructions =
      instructions.filter(
        instruction =>
          instruction.active !== false
      );

    if (
      activeInstructions.length > 0
    ) {
      instructionsBlock =
        'INSTRUCTIONS OBLIGATOIRES MONDECO :\n\n' +

        activeInstructions
          .map(
            (instruction, index) =>
              `${index + 1}. ${instruction.title}\n${instruction.content}`
          )
          .join('\n\n');
    }

  } else {

    // --------------------------------------------------------
    // Compatibilité ancienne version
    // --------------------------------------------------------

    const legacy =
      loadLegacyBusinessInfo();

    if (legacy.trim()) {
      instructionsBlock =
        legacy.trim();
    }
  }

  // ==========================================================
  // PRODUITS
  // ==========================================================

  let productsBlock = '';

  if (products.length > 0) {
    productsBlock =
      '\n\nCATALOGUE PRODUITS MONDECO :\n' +

      products
        .map(product => {
          const name =
            String(
              product.name || ''
            ).trim();

          const category =
            String(
              product.category || ''
            ).trim();

          const price =
            product.price !== undefined &&
            product.price !== null
              ? String(product.price).trim()
              : '';

          const description =
            String(
              product.description || ''
            ).trim();

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
            categoryText +
            priceText +
            descriptionText
          );
        })
        .join('\n');
  }

  return (
    `${instructionsBlock}` +
    `${productsBlock}`
  ).trim();
}

// ============================================================
// LOGIN
// ============================================================

router.get(
  '/login',
  (req, res) => {
    const cookies = parseCookies(
      req.headers.cookie || ''
    );

    if (
      isValidSession(
        cookies.mondeco_admin_session
      )
    ) {
      return res.redirect('/admin');
    }

    return res
      .status(200)
      .type('html')
      .send(
        renderLoginPage()
      );
  }
);

router.post(
  '/login',
  (req, res) => {
    try {
      const password =
        String(
          req.body?.password || ''
        );

      if (
        password !== ADMIN_PASSWORD
      ) {
        return res
          .status(401)
          .json({
            success: false,
            error:
              'Mot de passe incorrect'
          });
      }

      const token =
        crypto
          .randomBytes(32)
          .toString('hex');

      validSessions.set(
        token,
        Date.now() +
          SESSION_DURATION
      );

      const isProduction =
        process.env.NODE_ENV ===
          'production' ||
        Boolean(
          process.env
            .RAILWAY_ENVIRONMENT_NAME
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
            'Erreur serveur'
        });
    }
  }
);

// ============================================================
// LOGOUT
// ============================================================

router.post(
  '/logout',
  (req, res) => {
    const cookies = parseCookies(
      req.headers.cookie || ''
    );

    const token =
      cookies.mondeco_admin_session;

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
      process.env.NODE_ENV ===
        'production' ||
      process.env
        .RAILWAY_ENVIRONMENT_NAME
    ) {
      cookie += '; Secure';
    }

    res.setHeader(
      'Set-Cookie',
      cookie
    );

    return res.json({
      success: true
    });
  }
);

// ============================================================
// DASHBOARD
// ============================================================

router.get(
  '/',
  requireAuth,
  (req, res) => {
    if (
      !fs.existsSync(
        ADMIN_HTML_PATH
      )
    ) {
      console.error(
        '❌ Admin.html introuvable :',
        ADMIN_HTML_PATH
      );

      return res
        .status(500)
        .send(
          'Admin.html introuvable.'
        );
    }

    return res.sendFile(
      ADMIN_HTML_PATH
    );
  }
);

// ============================================================
// API PRODUITS
// ============================================================

// Liste
router.get(
  '/api/products',
  requireAuth,
  (req, res) => {
    return res.json(
      loadProducts()
    );
  }
);

// Ajouter
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

      const now =
        new Date().toISOString();

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
          now,

        updatedAt:
          now
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
            'Impossible d’ajouter le produit'
        });
    }
  }
);

// Modifier
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
            : products[index]
                .description,

        price:
          price !== undefined &&
          price !== null
            ? String(price).trim()
            : products[index].price,

        category:
          category !== undefined
            ? String(category).trim()
            : products[index]
                .category,

        image:
          image !== undefined
            ? String(image).trim()
            : products[index].image,

        updatedAt:
          new Date().toISOString()
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
            'Impossible de modifier le produit'
        });
    }
  }
);

// Supprimer
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
            'Impossible de supprimer le produit'
        });
    }
  }
);

// ============================================================
// API INSTRUCTIONS
// ============================================================

// Liste
router.get(
  '/api/instructions',
  requireAuth,
  (req, res) => {
    return res.json(
      loadInstructions()
    );
  }
);

// Ajouter
router.post(
  '/api/instructions',
  requireAuth,
  (req, res) => {
    try {
      const {
        title,
        content,
        active
      } = req.body || {};

      const cleanTitle =
        String(
          title || ''
        ).trim();

      const cleanContent =
        String(
          content || ''
        ).trim();

      if (!cleanTitle) {
        return res
          .status(400)
          .json({
            error:
              'Le titre est obligatoire'
          });
      }

      if (!cleanContent) {
        return res
          .status(400)
          .json({
            error:
              'L’instruction est obligatoire'
          });
      }

      const instructions =
        loadInstructions();

      const now =
        new Date().toISOString();

      const instruction = {
        id:
          crypto.randomUUID(),

        title:
          cleanTitle,

        content:
          cleanContent,

        active:
          active !== false,

        createdAt:
          now,

        updatedAt:
          now
      };

      instructions.push(
        instruction
      );

      saveInstructions(
        instructions
      );

      return res.json(
        instruction
      );

    } catch (error) {
      console.error(
        '❌ Erreur ajout instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’ajouter l’instruction'
        });
    }
  }
);

// Modifier
router.put(
  '/api/instructions/:id',
  requireAuth,
  (req, res) => {
    try {
      const instructions =
        loadInstructions();

      const index =
        instructions.findIndex(
          instruction =>
            instruction.id ===
            req.params.id
        );

      if (index === -1) {
        return res
          .status(404)
          .json({
            error:
              'Instruction introuvable'
          });
      }

      const {
        title,
        content,
        active
      } = req.body || {};

      if (
        title !== undefined &&
        !String(title).trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              'Le titre ne peut pas être vide'
          });
      }

      if (
        content !== undefined &&
        !String(content).trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              'L’instruction ne peut pas être vide'
          });
      }

      instructions[index] = {
        ...instructions[index],

        title:
          title !== undefined
            ? String(title).trim()
            : instructions[index]
                .title,

        content:
          content !== undefined
            ? String(content).trim()
            : instructions[index]
                .content,

        active:
          active !== undefined
            ? Boolean(active)
            : instructions[index]
                .active,

        updatedAt:
          new Date().toISOString()
      };

      saveInstructions(
        instructions
      );

      return res.json(
        instructions[index]
      );

    } catch (error) {
      console.error(
        '❌ Erreur modification instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de modifier l’instruction'
        });
    }
  }
);

// Supprimer
router.delete(
  '/api/instructions/:id',
  requireAuth,
  (req, res) => {
    try {
      const instructions =
        loadInstructions();

      const exists =
        instructions.some(
          instruction =>
            instruction.id ===
            req.params.id
        );

      if (!exists) {
        return res
          .status(404)
          .json({
            error:
              'Instruction introuvable'
          });
      }

      const filtered =
        instructions.filter(
          instruction =>
            instruction.id !==
            req.params.id
        );

      saveInstructions(
        filtered
      );

      return res.json({
        success: true
      });

    } catch (error) {
      console.error(
        '❌ Erreur suppression instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer l’instruction'
        });
    }
  }
);

// ============================================================
// IMPORTER PLUSIEURS INSTRUCTIONS
// ============================================================

router.post(
  '/api/instructions/import',
  requireAuth,
  (req, res) => {
    try {
      const text =
        String(
          req.body?.text || ''
        ).trim();

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              'Aucune instruction à importer.'
          });
      }

      const parsed =
        parseInstructionBlocks(
          text
        );

      if (parsed.length === 0) {
        return res
          .status(400)
          .json({
            error:
              'Aucune instruction valide trouvée.'
          });
      }

      const instructions =
        loadInstructions();

      const existingFingerprints =
        new Set(
          instructions.map(
            instruction =>
              instructionFingerprint(
                instruction.title,
                instruction.content
              )
          )
        );

      let imported = 0;
      let duplicates = 0;

      const now =
        new Date().toISOString();

      for (const parsedItem of parsed) {
        const fingerprint =
          instructionFingerprint(
            parsedItem.title,
            parsedItem.content
          );

        if (
          existingFingerprints.has(
            fingerprint
          )
        ) {
          duplicates++;
          continue;
        }

        instructions.push({
          id:
            crypto.randomUUID(),

          title:
            parsedItem.title,

          content:
            parsedItem.content,

          active:
            true,

          createdAt:
            now,

          updatedAt:
            now
        });

        existingFingerprints.add(
          fingerprint
        );

        imported++;
      }

      saveInstructions(
        instructions
      );

      return res.json({
        success: true,
        imported,
        duplicates,
        total:
          instructions.length
      });

    } catch (error) {
      console.error(
        '❌ Erreur import instructions :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’importer les instructions'
        });
    }
  }
);

// ============================================================
// IMPORTER L'ANCIEN BUSINESS-INFO.TXT
// ============================================================

router.post(
  '/api/instructions/import-legacy',
  requireAuth,
  (req, res) => {
    try {
      const legacyText =
        loadLegacyBusinessInfo()
          .trim();

      if (!legacyText) {
        return res
          .status(404)
          .json({
            error:
              'business-info.txt est vide ou introuvable.'
          });
      }

      const parsed =
        parseInstructionBlocks(
          legacyText
        );

      if (parsed.length === 0) {
        return res
          .status(400)
          .json({
            error:
              'Aucune instruction trouvée dans business-info.txt.'
          });
      }

      const instructions =
        loadInstructions();

      const existingFingerprints =
        new Set(
          instructions.map(
            instruction =>
              instructionFingerprint(
                instruction.title,
                instruction.content
              )
          )
        );

      let imported = 0;
      let duplicates = 0;

      const now =
        new Date().toISOString();

      for (const parsedItem of parsed) {
        const fingerprint =
          instructionFingerprint(
            parsedItem.title,
            parsedItem.content
          );

        if (
          existingFingerprints.has(
            fingerprint
          )
        ) {
          duplicates++;
          continue;
        }

        instructions.push({
          id:
            crypto.randomUUID(),

          title:
            parsedItem.title,

          content:
            parsedItem.content,

          active:
            true,

          source:
            'business-info.txt',

          createdAt:
            now,

          updatedAt:
            now
        });

        existingFingerprints.add(
          fingerprint
        );

        imported++;
      }

      saveInstructions(
        instructions
      );

      return res.json({
        success: true,
        imported,
        duplicates,
        total:
          instructions.length
      });

    } catch (error) {
      console.error(
        '❌ Erreur import business-info.txt :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’importer business-info.txt'
        });
    }
  }
);

// ============================================================
// CHAT TEST
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
    '✅ Discussion de test Admin connectée'
  );
}

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
              'Le bot IA n’est pas encore connecté.'
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
        '❌ Erreur test IA :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Erreur pendant la génération'
        });
    }
  }
);

// ============================================================
// STATS
// ============================================================

router.get(
  '/api/stats',
  requireAuth,
  (req, res) => {
    const products =
      loadProducts();

    const instructions =
      loadInstructions();

    const activeInstructions =
      instructions.filter(
        instruction =>
          instruction.active !== false
      );

    return res.json({
      productCount:
        products.length,

      instructionsCount:
        instructions.length,

      activeInstructionsCount:
        activeInstructions.length,

      structuredInstructions:
        structuredInstructionsStoreExists(),

      legacyBusinessInfoAvailable:
        Boolean(
          loadLegacyBusinessInfo()
            .trim()
        )
    });
  }
);

// ============================================================
// LOGIN HTML
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

<title>Mondeco — Administration</title>

<style>

@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap');

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: 'Inter', sans-serif;
  background: #1F1B16;
  background-image:
    radial-gradient(
      circle at 20% 20%,
      #2A241C 0%,
      #1F1B16 60%
    );

  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  padding: 20px;
}

.card {
  background: #F7F4EF;

  border-radius: 12px;

  padding: 48px 40px;

  width: 100%;
  max-width: 400px;

  box-shadow:
    0 20px 60px
    rgba(0,0,0,0.4);
}

.wordmark {
  font-family: 'Fraunces', serif;
  font-size: 30px;
  font-weight: 600;
  color: #1F1B16;
}

.subtitle {
  color: #7A7266;
  font-size: 14px;
  margin-top: 4px;
  margin-bottom: 32px;
}

label {
  display: block;

  font-size: 13px;
  font-weight: 500;

  color: #4A4438;

  margin-bottom: 6px;
}

input {
  width: 100%;

  padding: 12px 14px;

  border:
    1.5px solid #E4DED2;

  border-radius: 8px;

  font-size: 15px;

  background: #fff;

  color: #1F1B16;
}

input:focus {
  outline: none;
  border-color: #B5541F;
}

button {
  width: 100%;

  margin-top: 20px;

  padding: 13px;

  border: none;

  border-radius: 8px;

  background: #B5541F;

  color: #fff;

  font-size: 15px;
  font-weight: 600;

  cursor: pointer;
}

button:hover {
  background: #9C4718;
}

button:disabled {
  opacity: .6;
}

.error {
  color: #B5541F;

  font-size: 13px;

  margin-top: 12px;

  display: none;
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
    ></div>

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
  async event => {

    event.preventDefault();

    errorBox.style.display =
      'none';

    button.disabled = true;
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
            method: 'POST',

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

      const data =
        await response.json();

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
        'Mot de passe incorrect';

      errorBox.style.display =
        'block';

    } catch (error) {

      errorBox.textContent =
        'Impossible de contacter le serveur.';

      errorBox.style.display =
        'block';

    } finally {

      button.disabled = false;

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
// EXPORT
// ============================================================

module.exports = {
  adminRouter: router,
  getBusinessContext,
  setChatHandler
};
