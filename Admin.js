// ============================================================
// MONDECO - PANNEAU D'ADMINISTRATION
// Fichier : Admin.js
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const router = express.Router();

// ============================================================
// CONFIGURATION
// ============================================================

const DATA_DIR = (process.env.DATA_DIR || __dirname).trim();
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const INSTRUCTIONS_JSON_PATH = path.join(DATA_DIR, 'instructions.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CUSTOMIZATIONS_PATH = path.join(DATA_DIR, 'customization-requests.json');
const CUSTOMIZATION_IMAGES_DIR = path.join(DATA_DIR, 'customizations');
const LEGACY_BUSINESS_INFO_PATH = path.join(__dirname, 'business-info.txt');
const ADMIN_HTML_PATH = path.join(__dirname, 'Admin.html');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(CUSTOMIZATION_IMAGES_DIR, { recursive: true });

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'mondeco2026').trim();

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️ ADMIN_PASSWORD non défini. Mot de passe par défaut utilisé.');
}

router.use(express.json({ limit: '5mb' }));

// ============================================================
// SESSIONS ADMIN
// ============================================================

const validSessions = new Map();
const SESSION_DURATION = 24 * 60 * 60 * 1000;

function parseCookies(header = '') {
  const cookies = {};

  header.split(';').forEach(pair => {
    const index = pair.indexOf('=');
    if (index === -1) return;

    const key = pair.slice(0, index).trim();
    const rawValue = pair.slice(index + 1).trim();

    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  });

  return cookies;
}

function cleanExpiredSessions() {
  const now = Date.now();

  for (const [token, expiresAt] of validSessions.entries()) {
    if (expiresAt <= now) {
      validSessions.delete(token);
    }
  }
}

function isValidSession(token) {
  if (!token) return false;

  cleanExpiredSessions();

  const expiresAt = validSessions.get(token);
  if (!expiresAt) return false;

  if (expiresAt <= Date.now()) {
    validSessions.delete(token);
    return false;
  }

  return true;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.mondeco_admin_session;

  if (isValidSession(token)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }

  return res.redirect('/admin/login');
}

// ============================================================
// HELPERS
// ============================================================

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') return value;

  const normalized = String(value).trim().toLowerCase();
  return !['false', '0', 'no', 'non', 'off'].includes(normalized);
}

function safeString(value) {
  return String(value ?? '').trim();
}

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn('⚠️ Impossible de supprimer le fichier :', error.message);
  }
}

function getLocalImagePath(product) {
  if (!product) return null;

  if (product.imageFilename) {
    return path.join(UPLOADS_DIR, path.basename(product.imageFilename));
  }

  if (product.image && String(product.image).includes('/admin/uploads/')) {
    return path.join(UPLOADS_DIR, path.basename(String(product.image)));
  }

  return null;
}


function mimeTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();

  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function extensionFromMimeType(mimetype) {
  if (mimetype === 'image/png') return '.png';
  if (mimetype === 'image/webp') return '.webp';
  return '.jpg';
}

function loadCustomizations() {
  try {
    if (!fs.existsSync(CUSTOMIZATIONS_PATH)) return [];

    const content = fs.readFileSync(CUSTOMIZATIONS_PATH, 'utf8');
    if (!content.trim()) return [];

    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('❌ Erreur lecture customization-requests.json :', error);
    return [];
  }
}

function saveCustomizations(items) {
  const temporaryPath = `${CUSTOMIZATIONS_PATH}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(items, null, 2),
    'utf8'
  );

  fs.renameSync(temporaryPath, CUSTOMIZATIONS_PATH);
}

function buildCustomizationCapabilities(product) {
  if (!product) return [];

  const capabilities = [];

  if (product.customizableColor === true) capabilities.push('couleur');
  if (product.customizableFabric === true) capabilities.push('tissu');
  if (product.customizableDimensions === true) capabilities.push('dimensions');
  if (product.customizableCorner === true) capabilities.push('coin/orientation');

  return capabilities;
}

// ============================================================
// MULTER - IMAGES PRODUITS
// ============================================================

const allowedImageMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

function imageFilter(req, file, callback) {
  if (!allowedImageMimeTypes.includes(file.mimetype)) {
    return callback(
      new Error('Format image non accepté. Utilisez JPG, PNG ou WEBP.'),
      false
    );
  }

  callback(null, true);
}

const productImageStorage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, UPLOADS_DIR);
  },

  filename: (req, file, callback) => {
    let extension = path.extname(file.originalname).toLowerCase();

    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) {
      extension =
        file.mimetype === 'image/png'
          ? '.png'
          : file.mimetype === 'image/webp'
            ? '.webp'
            : '.jpg';
    }

    callback(
      null,
      `product-${Date.now()}-${crypto.randomUUID()}${extension}`
    );
  }
});

const productImageUpload = multer({
  storage: productImageStorage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 8 * 1024 * 1024
  }
});

function uploadSingleProductImage(req, res, next) {
  productImageUpload.single('image')(req, res, error => {
    if (!error) return next();

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'La photo produit dépasse la taille maximale de 8 Mo.'
      });
    }

    return res.status(400).json({
      error: error.message || 'Image produit non valide.'
    });
  });
}

// ============================================================
// MULTER - IMAGE DISCUSSION DE TEST
// Stockée uniquement en mémoire, jamais sauvegardée sur disque.
// 3 Mo maximum pour rester sous la limite Base64 de l'API vision.
// ============================================================

const testImageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFilter,
  limits: {
    fileSize: 3 * 1024 * 1024
  }
});

function uploadSingleTestImage(req, res, next) {
  testImageUpload.single('image')(req, res, error => {
    if (!error) return next();

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'L’image de test est trop lourde. Maximum 3 Mo après compression.'
      });
    }

    return res.status(400).json({
      error: error.message || 'Image de test non valide.'
    });
  });
}


// ============================================================
// MULTER - IMAGE PERSONNALISATION
// Optionnelle si un produit avec photo est sélectionné.
// ============================================================

const customizationImageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFilter,
  limits: {
    fileSize: 8 * 1024 * 1024
  }
});

function uploadSingleCustomizationImage(req, res, next) {
  customizationImageUpload.single('referenceImage')(req, res, error => {
    if (!error) return next();

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'L’image de référence dépasse 8 Mo.'
      });
    }

    return res.status(400).json({
      error: error.message || 'Image de personnalisation non valide.'
    });
  });
}

// ============================================================
// PRODUITS - STOCKAGE
// ============================================================

function loadProducts() {
  try {
    if (!fs.existsSync(PRODUCTS_PATH)) return [];

    const content = fs.readFileSync(PRODUCTS_PATH, 'utf8');
    if (!content.trim()) return [];

    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('❌ Erreur lecture products.json :', error);
    return [];
  }
}

function saveProducts(products) {
  const temporaryPath = `${PRODUCTS_PATH}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(products, null, 2),
    'utf8'
  );

  fs.renameSync(temporaryPath, PRODUCTS_PATH);
}

// ============================================================
// INSTRUCTIONS - STOCKAGE
// ============================================================

function structuredInstructionsStoreExists() {
  return fs.existsSync(INSTRUCTIONS_JSON_PATH);
}

function loadInstructions() {
  try {
    if (!fs.existsSync(INSTRUCTIONS_JSON_PATH)) return [];

    const content = fs.readFileSync(INSTRUCTIONS_JSON_PATH, 'utf8');
    if (!content.trim()) return [];

    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('❌ Erreur lecture instructions.json :', error);
    return [];
  }
}

function saveInstructions(instructions) {
  const temporaryPath = `${INSTRUCTIONS_JSON_PATH}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(instructions, null, 2),
    'utf8'
  );

  fs.renameSync(temporaryPath, INSTRUCTIONS_JSON_PATH);
}

function loadLegacyBusinessInfo() {
  try {
    if (!fs.existsSync(LEGACY_BUSINESS_INFO_PATH)) return '';
    return fs.readFileSync(LEGACY_BUSINESS_INFO_PATH, 'utf8');
  } catch (error) {
    console.error('❌ Erreur lecture business-info.txt :', error);
    return '';
  }
}

function cleanInstructionTitle(text) {
  return String(text || '')
    .replace(/^[\s\-–—•*#\d.)]+/, '')
    .trim();
}

function parseInstructionBlocks(text) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!normalized) return [];

  return normalized
    .split(/\n\s*\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const lines = block
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      if (!lines.length) return null;

      let title = cleanInstructionTitle(lines[0]);
      let content = lines.slice(1).join('\n').trim();

      if (!content) {
        const colonIndex = title.indexOf(':');

        if (colonIndex > 5 && colonIndex < 100) {
          content = title.slice(colonIndex + 1).trim();
          title = title.slice(0, colonIndex).trim();
        } else {
          content = title;
        }
      }

      if (!title) title = content.slice(0, 80);
      if (title.length > 120) title = `${title.slice(0, 117)}...`;

      return { title, content };
    })
    .filter(Boolean);
}

function instructionFingerprint(title, content) {
  return crypto
    .createHash('sha256')
    .update(
      `${String(title).trim().toLowerCase()}|${String(content)
        .trim()
        .toLowerCase()}`
    )
    .digest('hex');
}

// ============================================================
// CONTEXTE MONDECO POUR L'IA
// ============================================================

function availabilityLabel(value) {
  const labels = {
    in_stock: 'En stock',
    made_to_order: 'Sur commande',
    out_of_stock: 'Rupture de stock',
    clearance: 'Déstockage'
  };

  return labels[value] || safeString(value) || 'Non précisée';
}

function getBusinessContext() {
  const instructions = loadInstructions();
  const allProducts = loadProducts();
  const products = allProducts.filter(product => product.active !== false);

  let instructionsBlock = '';

  if (structuredInstructionsStoreExists()) {
    const activeInstructions = instructions.filter(
      instruction => instruction.active !== false
    );

    if (activeInstructions.length) {
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
    const legacy = loadLegacyBusinessInfo();
    if (legacy.trim()) instructionsBlock = legacy.trim();
  }

  let productsBlock = '';

  if (products.length) {
    productsBlock =
      'CATALOGUE PRODUITS MONDECO ACTIFS :\n\n' +
      products
        .map(product => {
          const parts = [];

          parts.push(`Nom : ${safeString(product.name)}`);

          if (product.category) {
            parts.push(`Catégorie : ${safeString(product.category)}`);
          }

          if (product.price) {
            parts.push(`Prix : ${safeString(product.price)} TND`);
          }

          if (product.promoPrice) {
            parts.push(`Prix promotionnel : ${safeString(product.promoPrice)} TND`);
          }

          parts.push(`Disponibilité : ${availabilityLabel(product.availability)}`);

          if (product.dimensions) {
            parts.push(`Dimensions : ${safeString(product.dimensions)}`);
          }

          if (product.composition) {
            parts.push(`Composition : ${safeString(product.composition)}`);
          }

          if (product.colors) {
            parts.push(`Couleurs : ${safeString(product.colors)}`);
          }

          if (product.showrooms) {
            parts.push(`Showrooms : ${safeString(product.showrooms)}`);
          }

          if (product.productUrl) {
            parts.push(`Lien produit : ${safeString(product.productUrl)}`);
          }

          if (product.categoryUrl) {
            parts.push(`Lien catégorie : ${safeString(product.categoryUrl)}`);
          }

          if (product.description) {
            parts.push(`Description : ${safeString(product.description)}`);
          }

          const customizationCapabilities = buildCustomizationCapabilities(product);

          if (customizationCapabilities.length) {
            parts.push(
              `Personnalisation possible : ${customizationCapabilities.join(', ')}`
            );
          } else {
            parts.push('Personnalisation : non confirmée dans le catalogue');
          }

          return `- ${parts.join(' | ')}`;
        })
        .join('\n');
  }

  return [instructionsBlock, productsBlock].filter(Boolean).join('\n\n').trim();
}

// ============================================================
// LOGIN / LOGOUT
// ============================================================

router.get('/login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');

  if (isValidSession(cookies.mondeco_admin_session)) {
    return res.redirect('/admin');
  }

  return res.status(200).type('html').send(renderLoginPage());
});

router.post('/login', (req, res) => {
  try {
    const password = String(req.body?.password || '');

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        success: false,
        error: 'Mot de passe incorrect'
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    validSessions.set(token, Date.now() + SESSION_DURATION);

    const isProduction =
      process.env.NODE_ENV === 'production' ||
      Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);

    let cookie =
      `mondeco_admin_session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`;

    if (isProduction) cookie += '; Secure';

    res.setHeader('Set-Cookie', cookie);
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur connexion admin :', error);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

router.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.mondeco_admin_session;

  if (token) validSessions.delete(token);

  let cookie =
    'mondeco_admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';

  if (
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT_NAME
  ) {
    cookie += '; Secure';
  }

  res.setHeader('Set-Cookie', cookie);
  return res.json({ success: true });
});

// ============================================================
// DASHBOARD
// ============================================================

router.get('/', requireAuth, (req, res) => {
  if (!fs.existsSync(ADMIN_HTML_PATH)) {
    return res.status(500).send('Admin.html introuvable.');
  }

  return res.sendFile(ADMIN_HTML_PATH);
});

// ============================================================
// IMAGES PRODUITS
// ============================================================

router.get('/uploads/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const imagePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).send('Image introuvable');
  }

  return res.sendFile(imagePath);
});


router.get('/customizations/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const imagePath = path.join(CUSTOMIZATION_IMAGES_DIR, filename);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).send('Simulation introuvable');
  }

  return res.sendFile(imagePath);
});

// ============================================================
// API PRODUITS
// ============================================================

router.get('/api/products', requireAuth, (req, res) => {
  return res.json(loadProducts());
});

router.post(
  '/api/products',
  requireAuth,
  uploadSingleProductImage,
  (req, res) => {
    try {
      const name = safeString(req.body?.name);
      const category = safeString(req.body?.category);

      if (!name) {
        if (req.file) deleteFileIfExists(req.file.path);
        return res.status(400).json({ error: 'Le nom du produit est obligatoire.' });
      }

      if (!category) {
        if (req.file) deleteFileIfExists(req.file.path);
        return res.status(400).json({ error: 'La catégorie est obligatoire.' });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'La photo du produit est obligatoire.'
        });
      }

      const products = loadProducts();
      const now = new Date().toISOString();

      const product = {
        id: crypto.randomUUID(),
        name,
        category,
        price: safeString(req.body?.price),
        promoPrice: safeString(req.body?.promoPrice),
        availability: safeString(req.body?.availability) || 'in_stock',
        dimensions: safeString(req.body?.dimensions),
        composition: safeString(req.body?.composition),
        colors: safeString(req.body?.colors),
        showrooms: safeString(req.body?.showrooms),
        productUrl: safeString(req.body?.productUrl),
        categoryUrl: safeString(req.body?.categoryUrl),
        description: safeString(req.body?.description),
        customizableColor: parseBoolean(req.body?.customizableColor, false),
        customizableFabric: parseBoolean(req.body?.customizableFabric, false),
        customizableDimensions: parseBoolean(req.body?.customizableDimensions, false),
        customizableCorner: parseBoolean(req.body?.customizableCorner, false),
        active: parseBoolean(req.body?.active, true),
        image: `/admin/uploads/${req.file.filename}`,
        imageFilename: req.file.filename,
        createdAt: now,
        updatedAt: now
      };

      try {
        products.push(product);
        saveProducts(products);
      } catch (error) {
        deleteFileIfExists(req.file.path);
        throw error;
      }

      return res.status(201).json(product);
    } catch (error) {
      console.error('❌ Erreur ajout produit :', error);
      return res.status(500).json({
        error: error.message || 'Impossible d’ajouter le produit.'
      });
    }
  }
);

router.put(
  '/api/products/:id',
  requireAuth,
  uploadSingleProductImage,
  (req, res) => {
    try {
      const products = loadProducts();
      const index = products.findIndex(product => product.id === req.params.id);

      if (index === -1) {
        if (req.file) deleteFileIfExists(req.file.path);
        return res.status(404).json({ error: 'Produit introuvable.' });
      }

      const currentProduct = products[index];

      const name =
        req.body?.name !== undefined
          ? safeString(req.body.name)
          : safeString(currentProduct.name);

      const category =
        req.body?.category !== undefined
          ? safeString(req.body.category)
          : safeString(currentProduct.category);

      if (!name) {
        if (req.file) deleteFileIfExists(req.file.path);
        return res.status(400).json({ error: 'Le nom du produit est obligatoire.' });
      }

      if (!category) {
        if (req.file) deleteFileIfExists(req.file.path);
        return res.status(400).json({ error: 'La catégorie est obligatoire.' });
      }

      if (!currentProduct.image && !req.file) {
        return res.status(400).json({
          error: 'Ce produit n’a pas encore de photo. Ajoutez obligatoirement une image.'
        });
      }

      const oldImagePath = getLocalImagePath(currentProduct);

      const updatedProduct = {
        ...currentProduct,
        name,
        category,
        price:
          req.body?.price !== undefined
            ? safeString(req.body.price)
            : safeString(currentProduct.price),
        promoPrice:
          req.body?.promoPrice !== undefined
            ? safeString(req.body.promoPrice)
            : safeString(currentProduct.promoPrice),
        availability:
          req.body?.availability !== undefined
            ? safeString(req.body.availability) || 'in_stock'
            : safeString(currentProduct.availability) || 'in_stock',
        dimensions:
          req.body?.dimensions !== undefined
            ? safeString(req.body.dimensions)
            : safeString(currentProduct.dimensions),
        composition:
          req.body?.composition !== undefined
            ? safeString(req.body.composition)
            : safeString(currentProduct.composition),
        colors:
          req.body?.colors !== undefined
            ? safeString(req.body.colors)
            : safeString(currentProduct.colors),
        showrooms:
          req.body?.showrooms !== undefined
            ? safeString(req.body.showrooms)
            : safeString(currentProduct.showrooms),
        productUrl:
          req.body?.productUrl !== undefined
            ? safeString(req.body.productUrl)
            : safeString(currentProduct.productUrl),
        categoryUrl:
          req.body?.categoryUrl !== undefined
            ? safeString(req.body.categoryUrl)
            : safeString(currentProduct.categoryUrl),
        description:
          req.body?.description !== undefined
            ? safeString(req.body.description)
            : safeString(currentProduct.description),
        customizableColor:
          req.body?.customizableColor !== undefined
            ? parseBoolean(req.body.customizableColor, false)
            : currentProduct.customizableColor === true,
        customizableFabric:
          req.body?.customizableFabric !== undefined
            ? parseBoolean(req.body.customizableFabric, false)
            : currentProduct.customizableFabric === true,
        customizableDimensions:
          req.body?.customizableDimensions !== undefined
            ? parseBoolean(req.body.customizableDimensions, false)
            : currentProduct.customizableDimensions === true,
        customizableCorner:
          req.body?.customizableCorner !== undefined
            ? parseBoolean(req.body.customizableCorner, false)
            : currentProduct.customizableCorner === true,
        active:
          req.body?.active !== undefined
            ? parseBoolean(req.body.active, true)
            : currentProduct.active !== false,
        updatedAt: new Date().toISOString()
      };

      if (req.file) {
        updatedProduct.image = `/admin/uploads/${req.file.filename}`;
        updatedProduct.imageFilename = req.file.filename;
      }

      products[index] = updatedProduct;

      try {
        saveProducts(products);
      } catch (error) {
        if (req.file) deleteFileIfExists(req.file.path);
        throw error;
      }

      if (req.file && oldImagePath && oldImagePath !== req.file.path) {
        deleteFileIfExists(oldImagePath);
      }

      return res.json(updatedProduct);
    } catch (error) {
      console.error('❌ Erreur modification produit :', error);
      return res.status(500).json({
        error: error.message || 'Impossible de modifier le produit.'
      });
    }
  }
);

router.delete('/api/products/:id', requireAuth, (req, res) => {
  try {
    const products = loadProducts();
    const product = products.find(item => item.id === req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Produit introuvable.' });
    }

    const filtered = products.filter(item => item.id !== req.params.id);
    saveProducts(filtered);

    const imagePath = getLocalImagePath(product);
    if (imagePath) deleteFileIfExists(imagePath);

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur suppression produit :', error);
    return res.status(500).json({ error: 'Impossible de supprimer le produit.' });
  }
});

// ============================================================
// API INSTRUCTIONS
// ============================================================

router.get('/api/instructions', requireAuth, (req, res) => {
  return res.json(loadInstructions());
});

router.post('/api/instructions', requireAuth, (req, res) => {
  try {
    const title = safeString(req.body?.title);
    const content = safeString(req.body?.content);

    if (!title) {
      return res.status(400).json({ error: 'Le titre est obligatoire.' });
    }

    if (!content) {
      return res.status(400).json({ error: 'L’instruction est obligatoire.' });
    }

    const instructions = loadInstructions();
    const now = new Date().toISOString();

    const instruction = {
      id: crypto.randomUUID(),
      title,
      content,
      active: req.body?.active !== false,
      createdAt: now,
      updatedAt: now
    };

    instructions.push(instruction);
    saveInstructions(instructions);

    return res.status(201).json(instruction);
  } catch (error) {
    console.error('❌ Erreur ajout instruction :', error);
    return res.status(500).json({ error: 'Impossible d’ajouter l’instruction.' });
  }
});

router.put('/api/instructions/:id', requireAuth, (req, res) => {
  try {
    const instructions = loadInstructions();
    const index = instructions.findIndex(
      instruction => instruction.id === req.params.id
    );

    if (index === -1) {
      return res.status(404).json({ error: 'Instruction introuvable.' });
    }

    const title =
      req.body?.title !== undefined
        ? safeString(req.body.title)
        : instructions[index].title;

    const content =
      req.body?.content !== undefined
        ? safeString(req.body.content)
        : instructions[index].content;

    if (!title) {
      return res.status(400).json({ error: 'Le titre ne peut pas être vide.' });
    }

    if (!content) {
      return res.status(400).json({ error: 'L’instruction ne peut pas être vide.' });
    }

    instructions[index] = {
      ...instructions[index],
      title,
      content,
      active:
        req.body?.active !== undefined
          ? Boolean(req.body.active)
          : instructions[index].active,
      updatedAt: new Date().toISOString()
    };

    saveInstructions(instructions);
    return res.json(instructions[index]);
  } catch (error) {
    console.error('❌ Erreur modification instruction :', error);
    return res.status(500).json({ error: 'Impossible de modifier l’instruction.' });
  }
});

router.delete('/api/instructions/:id', requireAuth, (req, res) => {
  try {
    const instructions = loadInstructions();
    const exists = instructions.some(
      instruction => instruction.id === req.params.id
    );

    if (!exists) {
      return res.status(404).json({ error: 'Instruction introuvable.' });
    }

    saveInstructions(
      instructions.filter(instruction => instruction.id !== req.params.id)
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur suppression instruction :', error);
    return res.status(500).json({ error: 'Impossible de supprimer l’instruction.' });
  }
});

router.post('/api/instructions/import', requireAuth, (req, res) => {
  try {
    const text = safeString(req.body?.text);

    if (!text) {
      return res.status(400).json({ error: 'Aucune instruction à importer.' });
    }

    const parsed = parseInstructionBlocks(text);
    const instructions = loadInstructions();
    const existingFingerprints = new Set(
      instructions.map(instruction =>
        instructionFingerprint(instruction.title, instruction.content)
      )
    );

    let imported = 0;
    let duplicates = 0;
    const now = new Date().toISOString();

    for (const item of parsed) {
      const fingerprint = instructionFingerprint(item.title, item.content);

      if (existingFingerprints.has(fingerprint)) {
        duplicates++;
        continue;
      }

      instructions.push({
        id: crypto.randomUUID(),
        title: item.title,
        content: item.content,
        active: true,
        createdAt: now,
        updatedAt: now
      });

      existingFingerprints.add(fingerprint);
      imported++;
    }

    saveInstructions(instructions);

    return res.json({
      success: true,
      imported,
      duplicates,
      total: instructions.length
    });
  } catch (error) {
    console.error('❌ Erreur import instructions :', error);
    return res.status(500).json({ error: 'Impossible d’importer les instructions.' });
  }
});

router.post('/api/instructions/import-legacy', requireAuth, (req, res) => {
  try {
    const legacyText = loadLegacyBusinessInfo().trim();

    if (!legacyText) {
      return res.status(404).json({
        error: 'business-info.txt est vide ou introuvable.'
      });
    }

    const parsed = parseInstructionBlocks(legacyText);
    const instructions = loadInstructions();
    const existingFingerprints = new Set(
      instructions.map(instruction =>
        instructionFingerprint(instruction.title, instruction.content)
      )
    );

    let imported = 0;
    let duplicates = 0;
    const now = new Date().toISOString();

    for (const item of parsed) {
      const fingerprint = instructionFingerprint(item.title, item.content);

      if (existingFingerprints.has(fingerprint)) {
        duplicates++;
        continue;
      }

      instructions.push({
        id: crypto.randomUUID(),
        title: item.title,
        content: item.content,
        active: true,
        source: 'business-info.txt',
        createdAt: now,
        updatedAt: now
      });

      existingFingerprints.add(fingerprint);
      imported++;
    }

    saveInstructions(instructions);

    return res.json({
      success: true,
      imported,
      duplicates,
      total: instructions.length
    });
  } catch (error) {
    console.error('❌ Erreur import business-info :', error);
    return res.status(500).json({ error: 'Impossible d’importer business-info.txt.' });
  }
});

// ============================================================
// DISCUSSION DE TEST : TEXTE + IMAGE
// ============================================================

let chatHandler = null;
let imageChatHandler = null;

function setChatHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error('setChatHandler attend une fonction.');
  }

  chatHandler = fn;
}

function setImageChatHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error('setImageChatHandler attend une fonction.');
  }

  imageChatHandler = fn;
}

router.post('/api/test-chat', requireAuth, async (req, res) => {
  try {
    if (!chatHandler) {
      return res.status(503).json({ error: 'Le bot IA n’est pas encore connecté.' });
    }

    const message = safeString(req.body?.message);

    if (!message) {
      return res.status(400).json({ error: 'Message vide.' });
    }

    const reply = await chatHandler('admin-test-session', message);
    return res.json({ reply });
  } catch (error) {
    console.error('❌ Erreur discussion test texte :', error);
    return res.status(500).json({
      error: error.message || 'Erreur pendant la génération de la réponse.'
    });
  }
});

router.post(
  '/api/test-chat-image',
  requireAuth,
  uploadSingleTestImage,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Ajoutez une image à analyser.' });
      }

      const mode = safeString(req.body?.mode) || 'analysis';
      const message =
        safeString(req.body?.message) ||
        'Analyse cette image et explique ce que tu vois.';

      // Simulation du comportement WhatsApp réel :
      // une image client ne reçoit pas de réponse automatique.
      if (mode === 'whatsapp') {
        return res.json({
          reply:
            'Simulation WhatsApp : image reçue. Aucune réponse automatique ne serait envoyée au client ; la conversation doit être reprise par un commercial.',
          action: 'commercial_required'
        });
      }

      if (!imageChatHandler) {
        return res.status(503).json({
          error: 'L’analyse d’image IA n’est pas encore connectée.'
        });
      }

      const reply = await imageChatHandler(
        'admin-test-session',
        message,
        {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname,
          size: req.file.size
        }
      );

      return res.json({ reply, action: 'vision_analysis' });
    } catch (error) {
      console.error('❌ Erreur discussion test image :', error);
      return res.status(500).json({
        error: error.message || 'Erreur pendant l’analyse de l’image.'
      });
    }
  }
);


// ============================================================
// PERSONNALISATION / SIMULATION VISUELLE
// ============================================================

let customizationHandler = null;

function setCustomizationHandler(fn) {
  if (typeof fn !== 'function') {
    throw new Error('setCustomizationHandler attend une fonction.');
  }

  customizationHandler = fn;
}

function buildCustomizationWarnings(product, request) {
  const warnings = [];

  if (!product) {
    warnings.push(
      'Produit non lié au catalogue : identification, prix et faisabilité à confirmer.'
    );

    return warnings;
  }

  if (request.color && product.customizableColor !== true) {
    warnings.push('Le changement de couleur n’est pas confirmé comme option catalogue.');
  }

  if (request.fabric && product.customizableFabric !== true) {
    warnings.push('Le changement de tissu n’est pas confirmé comme option catalogue.');
  }

  if (request.dimensions && product.customizableDimensions !== true) {
    warnings.push('Le changement de dimensions doit être validé par un commercial.');
  }

  if (request.corner && product.customizableCorner !== true) {
    warnings.push('Le changement de coin/orientation doit être validé par un commercial.');
  }

  return warnings;
}

router.get('/api/customizations', requireAuth, (req, res) => {
  const items = loadCustomizations().sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );

  return res.json(items);
});

router.post(
  '/api/customizations/generate',
  requireAuth,
  uploadSingleCustomizationImage,
  async (req, res) => {
    try {
      if (!customizationHandler) {
        return res.status(503).json({
          error: 'Le moteur de simulation visuelle n’est pas encore connecté.'
        });
      }

      const products = loadProducts();
      const productId = safeString(req.body?.productId);
      const product = productId
        ? products.find(item => item.id === productId)
        : null;

      if (productId && !product) {
        return res.status(404).json({
          error: 'Produit sélectionné introuvable.'
        });
      }

      const request = {
        customerName: safeString(req.body?.customerName),
        customerPhone: safeString(req.body?.customerPhone),
        color: safeString(req.body?.color),
        fabric: safeString(req.body?.fabric),
        dimensions: safeString(req.body?.dimensions),
        corner: safeString(req.body?.corner),
        notes: safeString(req.body?.notes)
      };

      const hasModification = Boolean(
        request.color ||
        request.fabric ||
        request.dimensions ||
        request.corner ||
        request.notes
      );

      if (!hasModification) {
        return res.status(400).json({
          error: 'Indiquez au moins une modification à simuler.'
        });
      }

      let sourceImage = null;
      let sourceImageUrl = '';

      if (req.file) {
        sourceImage = {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname || 'reference.jpg'
        };
      } else if (product) {
        const localImagePath = getLocalImagePath(product);

        if (!localImagePath || !fs.existsSync(localImagePath)) {
          return res.status(400).json({
            error:
              'La photo du produit est introuvable. Ajoutez une image de référence.'
          });
        }

        sourceImage = {
          buffer: fs.readFileSync(localImagePath),
          mimetype: mimeTypeFromPath(localImagePath),
          originalname: path.basename(localImagePath)
        };

        sourceImageUrl = safeString(product.image);
      }

      if (!sourceImage) {
        return res.status(400).json({
          error:
            'Sélectionnez un produit avec photo ou ajoutez une image de référence.'
        });
      }

      const warnings = buildCustomizationWarnings(product, request);

      const parseOutputDimension = (value, fallback) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(256, Math.min(1920, Math.round(parsed)));
      };

      const outputWidth = parseOutputDimension(
        req.body?.outputWidth,
        1024
      );

      const outputHeight = parseOutputDimension(
        req.body?.outputHeight,
        768
      );

      const simulation = await customizationHandler({
        product,
        request,
        sourceImage,
        outputWidth,
        outputHeight
      });

      if (!simulation?.imageBuffer) {
        throw new Error('Le moteur image n’a retourné aucune simulation.');
      }

      const now = new Date();
      const id = crypto.randomUUID();

      if (req.file) {
        const sourceExtension = extensionFromMimeType(sourceImage.mimetype);
        const sourceFilename = `custom-source-${Date.now()}-${id}${sourceExtension}`;
        const sourcePath = path.join(CUSTOMIZATION_IMAGES_DIR, sourceFilename);

        fs.writeFileSync(sourcePath, sourceImage.buffer);
        sourceImageUrl = `/admin/customizations/${sourceFilename}`;
      }

      const resultExtension = extensionFromMimeType(
        simulation.mimeType || 'image/jpeg'
      );

      const resultFilename =
        `custom-result-${Date.now()}-${id}${resultExtension}`;

      const resultPath =
        path.join(CUSTOMIZATION_IMAGES_DIR, resultFilename);

      fs.writeFileSync(resultPath, simulation.imageBuffer);

      const item = {
        id,
        productId: product?.id || '',
        productName: safeString(product?.name) || 'Image libre',
        customerName: request.customerName,
        customerPhone: request.customerPhone,
        request,
        warnings,
        analysis: safeString(simulation.analysis),
        sourceImage: sourceImageUrl,
        resultImage: `/admin/customizations/${resultFilename}`,
        resultFilename,
        sourceFilename:
          req.file && sourceImageUrl
            ? path.basename(sourceImageUrl)
            : '',
        status: 'simulation_generated',
        requiresCommercialValidation: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };

      const items = loadCustomizations();
      items.push(item);
      saveCustomizations(items);

      return res.status(201).json(item);
    } catch (error) {
      console.error('❌ Erreur génération personnalisation :', error);

      return res.status(500).json({
        error:
          error.message ||
          'Impossible de générer la simulation visuelle.'
      });
    }
  }
);

router.put('/api/customizations/:id/status', requireAuth, (req, res) => {
  try {
    const allowedStatuses = [
      'simulation_generated',
      'awaiting_validation',
      'approved',
      'sent_to_client',
      'rejected'
    ];

    const status = safeString(req.body?.status);

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Statut non valide.' });
    }

    const items = loadCustomizations();
    const index = items.findIndex(item => item.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({ error: 'Demande introuvable.' });
    }

    items[index] = {
      ...items[index],
      status,
      updatedAt: new Date().toISOString()
    };

    saveCustomizations(items);

    return res.json(items[index]);
  } catch (error) {
    console.error('❌ Erreur statut personnalisation :', error);
    return res.status(500).json({
      error: 'Impossible de modifier le statut.'
    });
  }
});

router.delete('/api/customizations/:id', requireAuth, (req, res) => {
  try {
    const items = loadCustomizations();
    const item = items.find(entry => entry.id === req.params.id);

    if (!item) {
      return res.status(404).json({ error: 'Demande introuvable.' });
    }

    const filtered = items.filter(entry => entry.id !== req.params.id);
    saveCustomizations(filtered);

    if (item.resultFilename) {
      deleteFileIfExists(
        path.join(CUSTOMIZATION_IMAGES_DIR, path.basename(item.resultFilename))
      );
    }

    if (item.sourceFilename) {
      deleteFileIfExists(
        path.join(CUSTOMIZATION_IMAGES_DIR, path.basename(item.sourceFilename))
      );
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Erreur suppression personnalisation :', error);
    return res.status(500).json({
      error: 'Impossible de supprimer la demande.'
    });
  }
});

// ============================================================
// STATS
// ============================================================

router.get('/api/stats', requireAuth, (req, res) => {
  const products = loadProducts();
  const instructions = loadInstructions();

  return res.json({
    productCount: products.length,
    activeProductCount: products.filter(product => product.active !== false).length,
    productsWithImages: products.filter(product => Boolean(product.image)).length,
    customizationCount: loadCustomizations().length,
    instructionsCount: instructions.length,
    activeInstructionsCount: instructions.filter(
      instruction => instruction.active !== false
    ).length,
    structuredInstructions: structuredInstructionsStoreExists(),
    legacyBusinessInfoAvailable: Boolean(loadLegacyBusinessInfo().trim())
  });
});

// ============================================================
// LOGIN HTML
// ============================================================

function renderLoginPage() {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mondeco — Administration</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#1F1B16;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#F7F4EF;border-radius:12px;padding:48px 40px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.wordmark{font-family:'Fraunces',serif;font-size:30px;font-weight:600;color:#1F1B16}
.subtitle{color:#7A7266;font-size:14px;margin-top:4px;margin-bottom:32px}
label{display:block;font-size:13px;font-weight:500;color:#4A4438;margin-bottom:6px}
input{width:100%;padding:12px 14px;border:1.5px solid #E4DED2;border-radius:8px;font-size:15px;background:#fff;color:#1F1B16}
input:focus{outline:none;border-color:#B5541F}
button{width:100%;margin-top:20px;padding:13px;border:none;border-radius:8px;background:#B5541F;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#9C4718}button:disabled{opacity:.6}.error{color:#B5541F;font-size:13px;margin-top:12px;display:none}
</style>
</head>
<body>
<div class="card">
  <div class="wordmark">Mondeco</div>
  <div class="subtitle">Administration du bot WhatsApp</div>
  <form id="loginForm">
    <label for="password">Mot de passe</label>
    <input type="password" id="password" autocomplete="current-password" autofocus required>
    <button id="loginButton" type="submit">Se connecter</button>
    <div class="error" id="error"></div>
  </form>
</div>
<script>
const form=document.getElementById('loginForm');
const button=document.getElementById('loginButton');
const errorBox=document.getElementById('error');
form.addEventListener('submit',async event=>{
  event.preventDefault();
  errorBox.style.display='none';
  button.disabled=true;
  button.textContent='Connexion...';
  try{
    const password=document.getElementById('password').value;
    const response=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
    const data=await response.json();
    if(response.ok&&data.success){window.location.href='/admin';return;}
    errorBox.textContent=data.error||'Mot de passe incorrect';
    errorBox.style.display='block';
  }catch(error){
    errorBox.textContent='Impossible de contacter le serveur.';
    errorBox.style.display='block';
  }finally{
    button.disabled=false;
    button.textContent='Se connecter';
  }
});
</script>
</body>
</html>`;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  adminRouter: router,
  getBusinessContext,
  setChatHandler,
  setImageChatHandler,
  setCustomizationHandler
};
