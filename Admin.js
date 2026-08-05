// ============================================================
// MONDECO - ADMINISTRATION
// Admin.js
// Stockage persistant Railway + Produits + Instructions
// + Test IA image + Personnalisation visuelle
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

const APP_DIR = __dirname;

const DATA_DIR = (
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  APP_DIR
).trim();

const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const INSTRUCTIONS_PATH = path.join(DATA_DIR, 'instructions.json');
const CUSTOMIZATIONS_PATH = path.join(
  DATA_DIR,
  'customization-requests.json'
);

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CUSTOMIZATIONS_DIR = path.join(
  DATA_DIR,
  'customizations'
);

const LEGACY_PRODUCTS_PATH = path.join(
  APP_DIR,
  'products.json'
);

const LEGACY_INSTRUCTIONS_PATH = path.join(
  APP_DIR,
  'instructions.json'
);

const LEGACY_CUSTOMIZATIONS_PATH = path.join(
  APP_DIR,
  'customization-requests.json'
);

const LEGACY_UPLOADS_DIR = path.join(
  APP_DIR,
  'uploads'
);

const LEGACY_CUSTOMIZATIONS_DIR = path.join(
  APP_DIR,
  'customizations'
);

const LEGACY_BUSINESS_INFO_PATH = path.join(
  APP_DIR,
  'business-info.txt'
);

const ADMIN_HTML_PATH = path.join(
  APP_DIR,
  'Admin.html'
);

const ADMIN_PASSWORD = (
  process.env.ADMIN_PASSWORD ||
  'mondeco2026'
).trim();

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

fs.mkdirSync(UPLOADS_DIR, {
  recursive: true
});

fs.mkdirSync(CUSTOMIZATIONS_DIR, {
  recursive: true
});

router.use(
  express.json({
    limit: '5mb'
  })
);

// ============================================================
// STOCKAGE PERSISTANT
// ============================================================

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function fileExistsWithContent(filePath) {
  try {
    return (
      fs.existsSync(filePath) &&
      fs.statSync(filePath).size > 0
    );
  } catch {
    return false;
  }
}

function copyFileIfTargetMissing(
  source,
  target,
  label
) {
  try {
    if (samePath(source, target)) {
      return false;
    }

    if (!fileExistsWithContent(source)) {
      return false;
    }

    if (fileExistsWithContent(target)) {
      return false;
    }

    fs.mkdirSync(
      path.dirname(target),
      {
        recursive: true
      }
    );

    fs.copyFileSync(
      source,
      target
    );

    console.log(
      `✅ Migration ${label} vers ${target}`
    );

    return true;
  } catch (error) {
    console.warn(
      `⚠️ Migration ${label} impossible : ${error.message}`
    );

    return false;
  }
}

function copyMissingFiles(
  sourceDir,
  targetDir,
  label
) {
  try {
    if (samePath(sourceDir, targetDir)) {
      return 0;
    }

    if (!fs.existsSync(sourceDir)) {
      return 0;
    }

    fs.mkdirSync(
      targetDir,
      {
        recursive: true
      }
    );

    let copied = 0;

    const entries = fs.readdirSync(
      sourceDir,
      {
        withFileTypes: true
      }
    );

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const source = path.join(
        sourceDir,
        entry.name
      );

      const target = path.join(
        targetDir,
        entry.name
      );

      if (fs.existsSync(target)) {
        continue;
      }

      fs.copyFileSync(
        source,
        target
      );

      copied += 1;
    }

    if (copied > 0) {
      console.log(
        `✅ ${copied} fichier(s) ${label} migré(s)`
      );
    }

    return copied;
  } catch (error) {
    console.warn(
      `⚠️ Migration ${label} impossible : ${error.message}`
    );

    return 0;
  }
}

function migrateLegacyData() {
  if (samePath(DATA_DIR, APP_DIR)) {
    return;
  }

  copyFileIfTargetMissing(
    LEGACY_PRODUCTS_PATH,
    PRODUCTS_PATH,
    'products.json'
  );

  copyFileIfTargetMissing(
    LEGACY_INSTRUCTIONS_PATH,
    INSTRUCTIONS_PATH,
    'instructions.json'
  );

  copyFileIfTargetMissing(
    LEGACY_CUSTOMIZATIONS_PATH,
    CUSTOMIZATIONS_PATH,
    'customization-requests.json'
  );

  copyMissingFiles(
    LEGACY_UPLOADS_DIR,
    UPLOADS_DIR,
    'images produits'
  );

  copyMissingFiles(
    LEGACY_CUSTOMIZATIONS_DIR,
    CUSTOMIZATIONS_DIR,
    'images personnalisations'
  );
}

function writeJsonAtomic(
  filePath,
  data
) {
  const tempPath =
    `${filePath}.tmp`;

  const backupPath =
    `${filePath}.bak`;

  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true
    }
  );

  if (fileExistsWithContent(filePath)) {
    try {
      fs.copyFileSync(
        filePath,
        backupPath
      );
    } catch (error) {
      console.warn(
        `⚠️ Sauvegarde .bak impossible : ${error.message}`
      );
    }
  }

  fs.writeFileSync(
    tempPath,
    JSON.stringify(
      data,
      null,
      2
    ),
    'utf8'
  );

  fs.renameSync(
    tempPath,
    filePath
  );
}

function readJsonArray(
  filePath,
  label
) {
  const backupPath =
    `${filePath}.bak`;

  function read(candidate) {
    if (!fileExistsWithContent(candidate)) {
      return null;
    }

    const content =
      fs.readFileSync(
        candidate,
        'utf8'
      );

    const parsed =
      JSON.parse(content);

    return Array.isArray(parsed)
      ? parsed
      : [];
  }

  try {
    const data = read(filePath);

    return data === null
      ? []
      : data;
  } catch (error) {
    console.error(
      `❌ Lecture ${label} impossible : ${error.message}`
    );

    try {
      const backup =
        read(backupPath);

      if (backup !== null) {
        console.warn(
          `⚠️ ${label} chargé depuis ${path.basename(
            backupPath
          )}`
        );

        return backup;
      }
    } catch (backupError) {
      console.error(
        `❌ Backup ${label} invalide : ${backupError.message}`
      );
    }

    return [];
  }
}

function storageIsWritable() {
  const testFile = path.join(
    DATA_DIR,
    `.write-test-${process.pid}-${Date.now()}`
  );

  try {
    fs.writeFileSync(
      testFile,
      'ok',
      'utf8'
    );

    fs.unlinkSync(testFile);

    return true;
  } catch {
    return false;
  }
}

migrateLegacyData();

console.log(
  '💾 Stockage MONDECO :',
  {
    dataDir: DATA_DIR,
    persistentConfigured:
      DATA_DIR !== APP_DIR,
    writable:
      storageIsWritable()
  }
);

if (
  DATA_DIR === APP_DIR &&
  process.env.RAILWAY_ENVIRONMENT_NAME
) {
  console.warn(
    '⚠️ Railway détecté sans stockage persistant. ' +
    'Montez un Volume sur /data puis ajoutez DATA_DIR=/data.'
  );
}

// ============================================================
// HELPERS
// ============================================================

function safeString(value) {
  return String(
    value ?? ''
  ).trim();
}

function parseBoolean(
  value,
  defaultValue = false
) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return defaultValue;
  }

  if (
    typeof value === 'boolean'
  ) {
    return value;
  }

  return ![
    'false',
    '0',
    'no',
    'non',
    'off'
  ].includes(
    String(value)
      .trim()
      .toLowerCase()
  );
}

function deleteFileIfExists(
  filePath
) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn(
      `⚠️ Suppression fichier impossible : ${error.message}`
    );
  }
}

function mimeTypeFromPath(
  filePath
) {
  const ext =
    path.extname(
      filePath || ''
    ).toLowerCase();

  if (ext === '.png') {
    return 'image/png';
  }

  if (ext === '.webp') {
    return 'image/webp';
  }

  return 'image/jpeg';
}

function extensionFromMimeType(
  mimetype
) {
  if (
    mimetype === 'image/png'
  ) {
    return '.png';
  }

  if (
    mimetype === 'image/webp'
  ) {
    return '.webp';
  }

  return '.jpg';
}

function getLocalProductImagePath(
  product
) {
  if (!product) {
    return null;
  }

  if (product.imageFilename) {
    return path.join(
      UPLOADS_DIR,
      path.basename(
        product.imageFilename
      )
    );
  }

  if (
    safeString(
      product.image
    ).includes(
      '/admin/uploads/'
    )
  ) {
    return path.join(
      UPLOADS_DIR,
      path.basename(
        product.image
      )
    );
  }

  return null;
}

// ============================================================
// DONNÉES
// ============================================================

function loadProducts() {
  return readJsonArray(
    PRODUCTS_PATH,
    'products.json'
  );
}

function saveProducts(
  products
) {
  writeJsonAtomic(
    PRODUCTS_PATH,
    products
  );
}

function loadInstructions() {
  return readJsonArray(
    INSTRUCTIONS_PATH,
    'instructions.json'
  );
}

function saveInstructions(
  instructions
) {
  writeJsonAtomic(
    INSTRUCTIONS_PATH,
    instructions
  );
}

function loadCustomizations() {
  return readJsonArray(
    CUSTOMIZATIONS_PATH,
    'customization-requests.json'
  );
}

function saveCustomizations(
  items
) {
  writeJsonAtomic(
    CUSTOMIZATIONS_PATH,
    items
  );
}

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
  } catch {
    return '';
  }
}

function structuredInstructionsStoreExists() {
  return fs.existsSync(
    INSTRUCTIONS_PATH
  );
}

// ============================================================
// CONTEXTE IA
// ============================================================

function availabilityLabel(
  value
) {
  const labels = {
    in_stock:
      'En stock',

    on_order:
      'Sur commande',

    out_of_stock:
      'Rupture',

    clearance:
      'Déstockage',

    unknown:
      'À confirmer'
  };

  return (
    labels[value] ||
    safeString(value) ||
    'À confirmer'
  );
}

function productToContext(
  product
) {
  const lines = [];

  lines.push(
    `Produit : ${safeString(
      product.name
    )}`
  );

  if (product.category) {
    lines.push(
      `Catégorie : ${safeString(
        product.category
      )}`
    );
  }

  if (product.price) {
    lines.push(
      `Prix normal : ${safeString(
        product.price
      )} TND`
    );
  }

  if (product.promoPrice) {
    lines.push(
      `Prix promotionnel : ${safeString(
        product.promoPrice
      )} TND`
    );
  }

  if (product.availability) {
    lines.push(
      `Disponibilité : ${availabilityLabel(
        product.availability
      )}`
    );
  }

  if (product.dimensions) {
    lines.push(
      `Dimensions : ${safeString(
        product.dimensions
      )}`
    );
  }

  if (product.composition) {
    lines.push(
      `Composition : ${safeString(
        product.composition
      )}`
    );
  }

  if (product.colors) {
    lines.push(
      `Couleurs disponibles : ${safeString(
        product.colors
      )}`
    );
  }

  if (product.showrooms) {
    lines.push(
      `Showrooms : ${safeString(
        product.showrooms
      )}`
    );
  }

  if (product.productUrl) {
    lines.push(
      `Lien produit : ${safeString(
        product.productUrl
      )}`
    );
  }

  if (product.categoryUrl) {
    lines.push(
      `Lien catégorie : ${safeString(
        product.categoryUrl
      )}`
    );
  }

  const customizations = [];

  if (
    product.customizableColor === true
  ) {
    customizations.push(
      'couleur'
    );
  }

  if (
    product.customizableFabric === true
  ) {
    customizations.push(
      'tissu'
    );
  }

  if (
    product.customizableDimensions === true
  ) {
    customizations.push(
      'dimensions'
    );
  }

  if (
    product.customizableCorner === true
  ) {
    customizations.push(
      'coin/orientation'
    );
  }

  if (
    customizations.length
  ) {
    lines.push(
      `Personnalisation possible : ${customizations.join(
        ', '
      )}`
    );
  }

  if (product.description) {
    lines.push(
      `Description : ${safeString(
        product.description
      )}`
    );
  }

  return lines.join('\n');
}

function getBusinessContext() {
  let instructionsText = '';

  if (
    structuredInstructionsStoreExists()
  ) {
    const activeInstructions =
      loadInstructions().filter(
        item =>
          item.active !== false
      );

    instructionsText =
      activeInstructions
        .map(
          (
            item,
            index
          ) => {
            return (
              `${index + 1}. ${safeString(
                item.title
              )}\n` +
              safeString(
                item.content
              )
            );
          }
        )
        .join('\n\n');
  } else {
    instructionsText =
      loadLegacyBusinessInfo()
        .trim();
  }

  const activeProducts =
    loadProducts().filter(
      product =>
        product.active !== false
    );

  const productsText =
    activeProducts
      .map(
        (
          product,
          index
        ) => {
          return (
            `--- PRODUIT ${index + 1} ---\n` +
            productToContext(
              product
            )
          );
        }
      )
      .join('\n\n');

  return [
    instructionsText
      ? (
        'INSTRUCTIONS MONDECO\n\n' +
        instructionsText
      )
      : '',

    productsText
      ? (
        'CATALOGUE PRODUITS MONDECO\n\n' +
        productsText
      )
      : ''
  ]
    .filter(Boolean)
    .join(
      '\n\n==================================================\n\n'
    );
}

// ============================================================
// AUTHENTIFICATION ADMIN
// ============================================================

const sessions =
  new Map();

const SESSION_DURATION =
  24 *
  60 *
  60 *
  1000;

function parseCookies(
  header = ''
) {
  const cookies = {};

  for (
    const part
    of header.split(';')
  ) {
    const index =
      part.indexOf('=');

    if (
      index === -1
    ) {
      continue;
    }

    const key =
      part
        .slice(
          0,
          index
        )
        .trim();

    const value =
      part
        .slice(
          index + 1
        )
        .trim();

    if (!key) {
      continue;
    }

    try {
      cookies[key] =
        decodeURIComponent(
          value
        );
    } catch {
      cookies[key] =
        value;
    }
  }

  return cookies;
}

function cleanupSessions() {
  const now =
    Date.now();

  for (
    const [
      token,
      expiresAt
    ]
    of sessions.entries()
  ) {
    if (
      expiresAt <= now
    ) {
      sessions.delete(
        token
      );
    }
  }
}

function getSessionToken(
  req
) {
  return (
    parseCookies(
      req.headers.cookie || ''
    )
      .mondeco_admin_session ||
    ''
  );
}

function isAuthenticated(
  req
) {
  cleanupSessions();

  const token =
    getSessionToken(req);

  if (!token) {
    return false;
  }

  const expiresAt =
    sessions.get(token);

  if (
    !expiresAt ||
    expiresAt <= Date.now()
  ) {
    sessions.delete(
      token
    );

    return false;
  }

  return true;
}

function requireAuth(
  req,
  res,
  next
) {
  if (
    isAuthenticated(req)
  ) {
    return next();
  }

  if (
    req.path.startsWith(
      '/api/'
    )
  ) {
    return res
      .status(401)
      .json({
        error:
          'Non authentifié'
      });
  }

  return res.redirect(
    '/admin/login'
  );
}

function secureCookie(
  req
) {
  const forwardedProto =
    safeString(
      req.headers[
        'x-forwarded-proto'
      ]
    );

  return (
    forwardedProto === 'https' ||
    Boolean(
      process.env
        .RAILWAY_ENVIRONMENT_NAME
    )
  );
}

// ============================================================
// PAGE LOGIN
// ============================================================

function renderLoginPage() {
  return `
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
<title>
Mondeco — Administration
</title>

<style>
*{
  box-sizing:border-box;
}

body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#1f1b16;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:20px;
}

.card{
  background:#f7f4ef;
  width:100%;
  max-width:400px;
  border-radius:14px;
  padding:38px;
  box-shadow:
    0 20px 60px
    rgba(0,0,0,.3);
}

h1{
  margin:0;
  font-family:
    Georgia,
    serif;
  font-size:30px;
}

.sub{
  color:#756d61;
  margin:
    5px 0 28px;
}

label{
  display:block;
  font-size:13px;
  font-weight:700;
  margin-bottom:7px;
}

input{
  width:100%;
  padding:12px;
  border:
    1px solid
    #ddd5c8;
  border-radius:8px;
  font-size:15px;
}

button{
  width:100%;
  padding:12px;
  margin-top:16px;
  border:0;
  border-radius:8px;
  background:#b5541f;
  color:white;
  font-size:15px;
  font-weight:700;
  cursor:pointer;
}

.err{
  display:none;
  color:#b5541f;
  font-size:13px;
  margin-top:12px;
}
</style>
</head>

<body>

<div class="card">

<h1>Mondeco</h1>

<div class="sub">
Administration du bot WhatsApp
</div>

<form id="form">

<label>
Mot de passe
</label>

<input
  id="password"
  type="password"
  required
  autofocus
  autocomplete="current-password"
>

<button id="btn">
Se connecter
</button>

<div
  id="err"
  class="err"
></div>

</form>

</div>

<script>

const form =
  document.getElementById(
    'form'
  );

const btn =
  document.getElementById(
    'btn'
  );

const err =
  document.getElementById(
    'err'
  );

form.addEventListener(
  'submit',
  async event => {

    event.preventDefault();

    err.style.display =
      'none';

    btn.disabled =
      true;

    btn.textContent =
      'Connexion...';

    try {

      const response =
        await fetch(
          '/admin/login',
          {
            method:
              'POST',

            headers:{
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                password:
                  document.getElementById(
                    'password'
                  ).value
              })
          }
        );

      const data =
        await response.json();

      if (
        response.ok &&
        data.success
      ) {
        location.href =
          '/admin';

        return;
      }

      err.textContent =
        data.error ||
        'Mot de passe incorrect';

      err.style.display =
        'block';

    } catch (error) {

      err.textContent =
        'Impossible de contacter le serveur.';

      err.style.display =
        'block';

    } finally {

      btn.disabled =
        false;

      btn.textContent =
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
// ROUTES LOGIN
// ============================================================

router.get(
  '/login',
  (
    req,
    res
  ) => {

    if (
      isAuthenticated(req)
    ) {
      return res.redirect(
        '/admin'
      );
    }

    return res
      .type('html')
      .send(
        renderLoginPage()
      );
  }
);

router.post(
  '/login',
  (
    req,
    res
  ) => {

    const password =
      safeString(
        req.body?.password
      );

    if (
      !password ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res
        .status(401)
        .json({
          error:
            'Mot de passe incorrect.'
        });
    }

    const token =
      crypto
        .randomBytes(32)
        .toString('hex');

    sessions.set(
      token,
      Date.now() +
      SESSION_DURATION
    );

    const cookieParts = [
      `mondeco_admin_session=${encodeURIComponent(
        token
      )}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${Math.floor(
        SESSION_DURATION /
        1000
      )}`
    ];

    if (
      secureCookie(req)
    ) {
      cookieParts.push(
        'Secure'
      );
    }

    res.setHeader(
      'Set-Cookie',
      cookieParts.join(
        '; '
      )
    );

    return res.json({
      success:true
    });
  }
);

router.post(
  '/logout',
  (
    req,
    res
  ) => {

    const token =
      getSessionToken(req);

    if (token) {
      sessions.delete(
        token
      );
    }

    const cookieParts = [
      'mondeco_admin_session=',
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0'
    ];

    if (
      secureCookie(req)
    ) {
      cookieParts.push(
        'Secure'
      );
    }

    res.setHeader(
      'Set-Cookie',
      cookieParts.join(
        '; '
      )
    );

    return res.json({
      success:true
    });
  }
);

router.get(
  '/',
  requireAuth,
  (
    req,
    res
  ) => {

    if (
      !fs.existsSync(
        ADMIN_HTML_PATH
      )
    ) {
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
// MULTER
// ============================================================

const ALLOWED_IMAGE_TYPES =
  new Set([
    'image/jpeg',
    'image/png',
    'image/webp'
  ]);

function imageFileFilter(
  req,
  file,
  callback
) {
  if (
    !ALLOWED_IMAGE_TYPES
      .has(
        file.mimetype
      )
  ) {
    return callback(
      new Error(
        'Format image non accepté. Utilisez JPG, PNG ou WEBP.'
      )
    );
  }

  return callback(
    null,
    true
  );
}

const productStorage =
  multer.diskStorage({

    destination(
      req,
      file,
      callback
    ) {
      callback(
        null,
        UPLOADS_DIR
      );
    },

    filename(
      req,
      file,
      callback
    ) {
      const extension =
        extensionFromMimeType(
          file.mimetype
        );

      callback(
        null,
        `product-${Date.now()}-${crypto.randomUUID()}${extension}`
      );
    }
  });

const productUpload =
  multer({
    storage:
      productStorage,

    limits:{
      fileSize:
        8 *
        1024 *
        1024
    },

    fileFilter:
      imageFileFilter
  });

const memoryUpload =
  multer({
    storage:
      multer.memoryStorage(),

    limits:{
      fileSize:
        8 *
        1024 *
        1024
    },

    fileFilter:
      imageFileFilter
  });

function multerSingle(
  upload,
  fieldName
) {
  return (
    req,
    res,
    next
  ) => {

    upload
      .single(
        fieldName
      )(
        req,
        res,
        error => {

          if (!error) {
            return next();
          }

          if (
            error instanceof
            multer.MulterError
          ) {
            if (
              error.code ===
              'LIMIT_FILE_SIZE'
            ) {
              return res
                .status(400)
                .json({
                  error:
                    'Image trop volumineuse. Maximum 8 Mo.'
                });
            }

            return res
              .status(400)
              .json({
                error:
                  error.message
              });
          }

          return res
            .status(400)
            .json({
              error:
                error.message ||
                'Image invalide.'
            });
        }
      );
  };
}

const uploadProductImage =
  multerSingle(
    productUpload,
    'image'
  );

const uploadTestImage =
  multerSingle(
    memoryUpload,
    'image'
  );

const uploadCustomizationImage =
  multerSingle(
    memoryUpload,
    'referenceImage'
  );

// ============================================================
// SERVIR LES IMAGES
// ============================================================

router.get(
  '/uploads/:filename',
  requireAuth,
  (
    req,
    res
  ) => {

    const filename =
      path.basename(
        req.params.filename ||
        ''
      );

    if (!filename) {
      return res.sendStatus(
        404
      );
    }

    const filePath =
      path.join(
        UPLOADS_DIR,
        filename
      );

    if (
      !fs.existsSync(
        filePath
      )
    ) {
      return res.sendStatus(
        404
      );
    }

    return res.sendFile(
      filePath
    );
  }
);

router.get(
  '/customizations/:filename',
  requireAuth,
  (
    req,
    res
  ) => {

    const filename =
      path.basename(
        req.params.filename ||
        ''
      );

    if (!filename) {
      return res.sendStatus(
        404
      );
    }

    const filePath =
      path.join(
        CUSTOMIZATIONS_DIR,
        filename
      );

    if (
      !fs.existsSync(
        filePath
      )
    ) {
      return res.sendStatus(
        404
      );
    }

    return res.sendFile(
      filePath
    );
  }
);

// ============================================================
// API PRODUITS
// ============================================================

router.get(
  '/api/products',
  requireAuth,
  (
    req,
    res
  ) => {

    return res.json(
      loadProducts()
    );
  }
);

// ============================================================
// AJOUT PRODUIT
// ============================================================

router.post(
  '/api/products',
  requireAuth,
  uploadProductImage,
  (
    req,
    res
  ) => {

    try {

      const name =
        safeString(
          req.body?.name
        );

      const category =
        safeString(
          req.body?.category
        );

      if (!name) {

        if (req.file) {
          deleteFileIfExists(
            req.file.path
          );
        }

        return res
          .status(400)
          .json({
            error:
              'Le nom du produit est obligatoire.'
          });
      }

      if (!category) {

        if (req.file) {
          deleteFileIfExists(
            req.file.path
          );
        }

        return res
          .status(400)
          .json({
            error:
              'La catégorie est obligatoire.'
          });
      }

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              'La photo du produit est obligatoire.'
          });
      }

      const now =
        new Date()
          .toISOString();

      const product = {

        id:
          crypto.randomUUID(),

        name,

        category,

        price:
          safeString(
            req.body?.price
          ),

        promoPrice:
          safeString(
            req.body?.promoPrice
          ),

        availability:
          safeString(
            req.body?.availability
          ) ||
          'unknown',

        dimensions:
          safeString(
            req.body?.dimensions
          ),

        composition:
          safeString(
            req.body?.composition
          ),

        colors:
          safeString(
            req.body?.colors
          ),

        showrooms:
          safeString(
            req.body?.showrooms
          ),

        productUrl:
          safeString(
            req.body?.productUrl
          ),

        categoryUrl:
          safeString(
            req.body?.categoryUrl
          ),

        description:
          safeString(
            req.body?.description
          ),

        customizableColor:
          parseBoolean(
            req.body
              ?.customizableColor,
            false
          ),

        customizableFabric:
          parseBoolean(
            req.body
              ?.customizableFabric,
            false
          ),

        customizableDimensions:
          parseBoolean(
            req.body
              ?.customizableDimensions,
            false
          ),

        customizableCorner:
          parseBoolean(
            req.body
              ?.customizableCorner,
            false
          ),

        active:
          parseBoolean(
            req.body?.active,
            true
          ),

        image:
          `/admin/uploads/${req.file.filename}`,

        imageFilename:
          req.file.filename,

        createdAt:
          now,

        updatedAt:
          now
      };

      const products =
        loadProducts();

      products.push(
        product
      );

      try {

        saveProducts(
          products
        );

      } catch (error) {

        deleteFileIfExists(
          req.file.path
        );

        throw error;
      }

      return res
        .status(201)
        .json(
          product
        );

    } catch (error) {

      console.error(
        '❌ Ajout produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible d’ajouter le produit.'
        });
    }
  }
);

// ============================================================
// MODIFICATION PRODUIT
// ============================================================

router.put(
  '/api/products/:id',
  requireAuth,
  uploadProductImage,
  (
    req,
    res
  ) => {

    try {

      const products =
        loadProducts();

      const index =
        products.findIndex(
          item =>
            item.id ===
            req.params.id
        );

      if (
        index === -1
      ) {

        if (req.file) {
          deleteFileIfExists(
            req.file.path
          );
        }

        return res
          .status(404)
          .json({
            error:
              'Produit introuvable.'
          });
      }

      const current =
        products[index];

      const oldImagePath =
        getLocalProductImagePath(
          current
        );

      const name =
        req.body?.name !==
        undefined

          ? safeString(
              req.body.name
            )

          : safeString(
              current.name
            );

      const category =
        req.body?.category !==
        undefined

          ? safeString(
              req.body.category
            )

          : safeString(
              current.category
            );

      if (!name) {

        if (req.file) {
          deleteFileIfExists(
            req.file.path
          );
        }

        return res
          .status(400)
          .json({
            error:
              'Le nom ne peut pas être vide.'
          });
      }

      if (!category) {

        if (req.file) {
          deleteFileIfExists(
            req.file.path
          );
        }

        return res
          .status(400)
          .json({
            error:
              'La catégorie ne peut pas être vide.'
          });
      }

      if (
        !req.file &&
        !current.image
      ) {
        return res
          .status(400)
          .json({
            error:
              'Ce produit n’a pas de photo. Ajoutez une image.'
          });
      }

      const updated = {

        ...current,

        name,

        category,

        price:
          req.body?.price !==
          undefined

            ? safeString(
                req.body.price
              )

            : safeString(
                current.price
              ),

        promoPrice:
          req.body?.promoPrice !==
          undefined

            ? safeString(
                req.body.promoPrice
              )

            : safeString(
                current.promoPrice
              ),

        availability:
          req.body?.availability !==
          undefined

            ? safeString(
                req.body.availability
              )

            : (
              safeString(
                current.availability
              ) ||
              'unknown'
            ),

        dimensions:
          req.body?.dimensions !==
          undefined

            ? safeString(
                req.body.dimensions
              )

            : safeString(
                current.dimensions
              ),

        composition:
          req.body?.composition !==
          undefined

            ? safeString(
                req.body.composition
              )

            : safeString(
                current.composition
              ),

        colors:
          req.body?.colors !==
          undefined

            ? safeString(
                req.body.colors
              )

            : safeString(
                current.colors
              ),

        showrooms:
          req.body?.showrooms !==
          undefined

            ? safeString(
                req.body.showrooms
              )

            : safeString(
                current.showrooms
              ),

        productUrl:
          req.body?.productUrl !==
          undefined

            ? safeString(
                req.body.productUrl
              )

            : safeString(
                current.productUrl
              ),

        categoryUrl:
          req.body?.categoryUrl !==
          undefined

            ? safeString(
                req.body.categoryUrl
              )

            : safeString(
                current.categoryUrl
              ),

        description:
          req.body?.description !==
          undefined

            ? safeString(
                req.body.description
              )

            : safeString(
                current.description
              ),

        customizableColor:
          req.body
            ?.customizableColor !==
          undefined

            ? parseBoolean(
                req.body
                  .customizableColor,
                false
              )

            : (
              current
                .customizableColor ===
              true
            ),

        customizableFabric:
          req.body
            ?.customizableFabric !==
          undefined

            ? parseBoolean(
                req.body
                  .customizableFabric,
                false
              )

            : (
              current
                .customizableFabric ===
              true
            ),

        customizableDimensions:
          req.body
            ?.customizableDimensions !==
          undefined

            ? parseBoolean(
                req.body
                  .customizableDimensions,
                false
              )

            : (
              current
                .customizableDimensions ===
              true
            ),

        customizableCorner:
          req.body
            ?.customizableCorner !==
          undefined

            ? parseBoolean(
                req.body
                  .customizableCorner,
                false
              )

            : (
              current
                .customizableCorner ===
              true
            ),

        active:
          req.body?.active !==
          undefined

            ? parseBoolean(
                req.body.active,
                true
              )

            : (
              current.active !==
              false
            ),

        updatedAt:
          new Date()
            .toISOString()
      };

      if (req.file) {

        updated.image =
          `/admin/uploads/${req.file.filename}`;

        updated.imageFilename =
          req.file.filename;
      }

      products[index] =
        updated;

      try {

        saveProducts(
          products
        );

      } catch (error) {

        if (req.file) {
          deleteFileIfExists(
            req.file.path
          );
        }

        throw error;
      }

      if (
        req.file &&
        oldImagePath &&
        oldImagePath !==
          req.file.path
      ) {
        deleteFileIfExists(
          oldImagePath
        );
      }

      return res.json(
        updated
      );

    } catch (error) {

      console.error(
        '❌ Modification produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible de modifier le produit.'
        });
    }
  }
);

// ============================================================
// SUPPRESSION PRODUIT
// ============================================================

router.delete(
  '/api/products/:id',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const products =
        loadProducts();

      const product =
        products.find(
          item =>
            item.id ===
            req.params.id
        );

      if (!product) {
        return res
          .status(404)
          .json({
            error:
              'Produit introuvable.'
          });
      }

      saveProducts(
        products.filter(
          item =>
            item.id !==
            req.params.id
        )
      );

      const imagePath =
        getLocalProductImagePath(
          product
        );

      if (imagePath) {
        deleteFileIfExists(
          imagePath
        );
      }

      return res.json({
        success:true
      });

    } catch (error) {

      console.error(
        '❌ Suppression produit :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer le produit.'
        });
    }
  }
);

// ============================================================
// INSTRUCTIONS
// ============================================================

function parseInstructionBlocks(
  text
) {
  return safeString(text)
    .split(
      /\n\s*\n+/
    )
    .map(
      block =>
        block.trim()
    )
    .filter(Boolean)
    .map(
      (
        block,
        index
      ) => {

        const lines =
          block
            .split('\n')
            .map(
              line =>
                line.trim()
            )
            .filter(Boolean);

        const title =
          lines[0] ||
          `Instruction ${index + 1}`;

        const content =
          lines.length > 1

            ? lines
                .slice(1)
                .join('\n')

            : lines[0];

        return {
          title,
          content
        };
      }
    );
}

function instructionFingerprint(
  title,
  content
) {
  return (
    `${safeString(
      title
    ).toLowerCase()}::` +
    safeString(
      content
    ).toLowerCase()
  );
}

// ============================================================
// GET INSTRUCTIONS
// ============================================================

router.get(
  '/api/instructions',
  requireAuth,
  (
    req,
    res
  ) => {

    return res.json(
      loadInstructions()
    );
  }
);

// ============================================================
// AJOUT INSTRUCTION
// ============================================================

router.post(
  '/api/instructions',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const title =
        safeString(
          req.body?.title
        );

      const content =
        safeString(
          req.body?.content
        );

      if (!title) {
        return res
          .status(400)
          .json({
            error:
              'Le titre est obligatoire.'
          });
      }

      if (!content) {
        return res
          .status(400)
          .json({
            error:
              'L’instruction est obligatoire.'
          });
      }

      const now =
        new Date()
          .toISOString();

      const instruction = {

        id:
          crypto.randomUUID(),

        title,

        content,

        active:
          parseBoolean(
            req.body?.active,
            true
          ),

        createdAt:
          now,

        updatedAt:
          now
      };

      const instructions =
        loadInstructions();

      instructions.push(
        instruction
      );

      saveInstructions(
        instructions
      );

      return res
        .status(201)
        .json(
          instruction
        );

    } catch (error) {

      console.error(
        '❌ Ajout instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’ajouter l’instruction.'
        });
    }
  }
);

// ============================================================
// MODIFICATION INSTRUCTION
// ============================================================

router.put(
  '/api/instructions/:id',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const instructions =
        loadInstructions();

      const index =
        instructions
          .findIndex(
            item =>
              item.id ===
              req.params.id
          );

      if (
        index === -1
      ) {
        return res
          .status(404)
          .json({
            error:
              'Instruction introuvable.'
          });
      }

      const current =
        instructions[index];

      const title =
        req.body?.title !==
        undefined

          ? safeString(
              req.body.title
            )

          : safeString(
              current.title
            );

      const content =
        req.body?.content !==
        undefined

          ? safeString(
              req.body.content
            )

          : safeString(
              current.content
            );

      if (!title) {
        return res
          .status(400)
          .json({
            error:
              'Le titre ne peut pas être vide.'
          });
      }

      if (!content) {
        return res
          .status(400)
          .json({
            error:
              'L’instruction ne peut pas être vide.'
          });
      }

      instructions[index] = {

        ...current,

        title,

        content,

        active:
          req.body?.active !==
          undefined

            ? parseBoolean(
                req.body.active,
                true
              )

            : (
              current.active !==
              false
            ),

        updatedAt:
          new Date()
            .toISOString()
      };

      saveInstructions(
        instructions
      );

      return res.json(
        instructions[index]
      );

    } catch (error) {

      console.error(
        '❌ Modification instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de modifier l’instruction.'
        });
    }
  }
);

// ============================================================
// SUPPRESSION INSTRUCTION
// ============================================================

router.delete(
  '/api/instructions/:id',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const instructions =
        loadInstructions();

      const exists =
        instructions.some(
          item =>
            item.id ===
            req.params.id
        );

      if (!exists) {
        return res
          .status(404)
          .json({
            error:
              'Instruction introuvable.'
          });
      }

      saveInstructions(
        instructions.filter(
          item =>
            item.id !==
            req.params.id
        )
      );

      return res.json({
        success:true
      });

    } catch (error) {

      console.error(
        '❌ Suppression instruction :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer l’instruction.'
        });
    }
  }
);

// ============================================================
// IMPORT INSTRUCTIONS
// ============================================================

router.post(
  '/api/instructions/import',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const text =
        safeString(
          req.body?.text
        );

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              'Aucune instruction à importer.'
          });
      }

      const incoming =
        parseInstructionBlocks(
          text
        );

      const instructions =
        loadInstructions();

      const fingerprints =
        new Set(
          instructions.map(
            item =>
              instructionFingerprint(
                item.title,
                item.content
              )
          )
        );

      let imported = 0;
      let duplicates = 0;

      for (
        const item
        of incoming
      ) {

        const fingerprint =
          instructionFingerprint(
            item.title,
            item.content
          );

        if (
          fingerprints
            .has(
              fingerprint
            )
        ) {

          duplicates += 1;

          continue;
        }

        const now =
          new Date()
            .toISOString();

        instructions.push({

          id:
            crypto.randomUUID(),

          title:
            item.title,

          content:
            item.content,

          active:
            true,

          createdAt:
            now,

          updatedAt:
            now
        });

        fingerprints.add(
          fingerprint
        );

        imported += 1;
      }

      saveInstructions(
        instructions
      );

      return res.json({

        success:true,

        imported,

        duplicates,

        total:
          instructions.length
      });

    } catch (error) {

      console.error(
        '❌ Import instructions :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’importer les instructions.'
        });
    }
  }
);

// ============================================================
// IMPORT BUSINESS-INFO.TXT
// ============================================================

router.post(
  '/api/instructions/import-legacy',
  requireAuth,
  (
    req,
    res
  ) => {

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

      const incoming =
        parseInstructionBlocks(
          legacyText
        );

      const instructions =
        loadInstructions();

      const fingerprints =
        new Set(
          instructions.map(
            item =>
              instructionFingerprint(
                item.title,
                item.content
              )
          )
        );

      let imported = 0;
      let duplicates = 0;

      for (
        const item
        of incoming
      ) {

        const fingerprint =
          instructionFingerprint(
            item.title,
            item.content
          );

        if (
          fingerprints
            .has(
              fingerprint
            )
        ) {

          duplicates += 1;

          continue;
        }

        const now =
          new Date()
            .toISOString();

        instructions.push({

          id:
            crypto.randomUUID(),

          title:
            item.title,

          content:
            item.content,

          active:
            true,

          source:
            'business-info.txt',

          createdAt:
            now,

          updatedAt:
            now
        });

        fingerprints.add(
          fingerprint
        );

        imported += 1;
      }

      saveInstructions(
        instructions
      );

      return res.json({

        success:true,

        imported,

        duplicates,

        total:
          instructions.length
      });

    } catch (error) {

      console.error(
        '❌ Import business-info.txt :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible d’importer business-info.txt.'
        });
    }
  }
);

// ============================================================
// DISCUSSION TEST
// ============================================================

let chatHandler = null;
let imageChatHandler = null;

function setChatHandler(
  fn
) {
  if (
    typeof fn !==
    'function'
  ) {
    throw new Error(
      'setChatHandler attend une fonction.'
    );
  }

  chatHandler = fn;
}

function setImageChatHandler(
  fn
) {
  if (
    typeof fn !==
    'function'
  ) {
    throw new Error(
      'setImageChatHandler attend une fonction.'
    );
  }

  imageChatHandler = fn;
}

// ============================================================
// TEST TEXTE
// ============================================================

router.post(
  '/api/test-chat',
  requireAuth,
  async (
    req,
    res
  ) => {

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
        safeString(
          req.body?.message
        );

      if (!message) {
        return res
          .status(400)
          .json({
            error:
              'Message vide.'
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
        '❌ Test chat texte :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Erreur pendant la réponse IA.'
        });
    }
  }
);

// ============================================================
// TEST IMAGE
// ============================================================

router.post(
  '/api/test-chat-image',
  requireAuth,
  uploadTestImage,
  async (
    req,
    res
  ) => {

    try {

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              'Ajoutez une image à analyser.'
          });
      }

      const mode =
        safeString(
          req.body?.mode
        ) ||
        'analysis';

      const message =
        safeString(
          req.body?.message
        ) ||
        'Analyse cette image et explique ce que tu vois.';

      if (
        mode ===
        'whatsapp'
      ) {
        return res.json({

          reply:
            'Simulation WhatsApp : image reçue. Aucune réponse automatique ne serait envoyée au client ; un commercial doit reprendre la conversation.',

          action:
            'commercial_required'
        });
      }

      if (
        !imageChatHandler
      ) {
        return res
          .status(503)
          .json({
            error:
              'L’analyse d’image IA n’est pas encore connectée.'
          });
      }

      const reply =
        await imageChatHandler(

          'admin-test-session',

          message,

          {
            buffer:
              req.file.buffer,

            mimetype:
              req.file.mimetype,

            originalname:
              req.file
                .originalname,

            size:
              req.file.size
          }
        );

      return res.json({

        reply,

        action:
          'vision_analysis'
      });

    } catch (error) {

      console.error(
        '❌ Test chat image :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Erreur pendant l’analyse de l’image.'
        });
    }
  }
);

// ============================================================
// PERSONNALISATION
// ============================================================

let customizationHandler =
  null;

function setCustomizationHandler(
  fn
) {
  if (
    typeof fn !==
    'function'
  ) {
    throw new Error(
      'setCustomizationHandler attend une fonction.'
    );
  }

  customizationHandler =
    fn;
}

function buildCustomizationWarnings(
  product,
  request
) {
  const warnings = [];

  if (!product) {

    warnings.push(
      'Image libre : identification, prix et faisabilité à confirmer par un commercial.'
    );

    return warnings;
  }

  if (
    request.color &&
    product.customizableColor !==
    true
  ) {
    warnings.push(
      'Le changement de couleur n’est pas confirmé comme option catalogue.'
    );
  }

  if (
    request.fabric &&
    product.customizableFabric !==
    true
  ) {
    warnings.push(
      'Le changement de tissu n’est pas confirmé comme option catalogue.'
    );
  }

  if (
    request.dimensions &&
    product.customizableDimensions !==
    true
  ) {
    warnings.push(
      'Le changement de dimensions doit être validé par un commercial.'
    );
  }

  if (
    request.corner &&
    product.customizableCorner !==
    true
  ) {
    warnings.push(
      'Le changement de coin/orientation doit être validé par un commercial.'
    );
  }

  return warnings;
}

// ============================================================
// LISTE PERSONNALISATIONS
// ============================================================

router.get(
  '/api/customizations',
  requireAuth,
  (
    req,
    res
  ) => {

    const items =
      loadCustomizations()
        .sort(
          (
            a,
            b
          ) =>
            new Date(
              b.createdAt ||
              0
            ) -
            new Date(
              a.createdAt ||
              0
            )
        );

    return res.json(
      items
    );
  }
);

// ============================================================
// GÉNÉRER PERSONNALISATION
// ============================================================

router.post(
  '/api/customizations/generate',
  requireAuth,
  uploadCustomizationImage,
  async (
    req,
    res
  ) => {

    try {

      if (
        !customizationHandler
      ) {
        return res
          .status(503)
          .json({
            error:
              'Le moteur de simulation visuelle n’est pas connecté.'
          });
      }

      const products =
        loadProducts();

      const productId =
        safeString(
          req.body?.productId
        );

      const product =
        productId

          ? products.find(
              item =>
                item.id ===
                productId
            )

          : null;

      if (
        productId &&
        !product
      ) {
        return res
          .status(404)
          .json({
            error:
              'Produit sélectionné introuvable.'
          });
      }

      const request = {

        customerName:
          safeString(
            req.body
              ?.customerName
          ),

        customerPhone:
          safeString(
            req.body
              ?.customerPhone
          ),

        color:
          safeString(
            req.body?.color
          ),

        fabric:
          safeString(
            req.body?.fabric
          ),

        dimensions:
          safeString(
            req.body
              ?.dimensions
          ),

        corner:
          safeString(
            req.body?.corner
          ),

        notes:
          safeString(
            req.body?.notes
          )
      };

      const hasModification =
        Boolean(
          request.color ||
          request.fabric ||
          request.dimensions ||
          request.corner ||
          request.notes
        );

      if (
        !hasModification
      ) {
        return res
          .status(400)
          .json({
            error:
              'Indiquez au moins une modification à simuler.'
          });
      }

      let sourceImage =
        null;

      let sourceImageUrl =
        '';

      if (req.file) {

        sourceImage = {

          buffer:
            req.file.buffer,

          mimetype:
            req.file.mimetype,

          originalname:
            req.file
              .originalname ||
            'reference.jpg',

          size:
            req.file.size
        };

      } else if (product) {

        const localPath =
          getLocalProductImagePath(
            product
          );

        if (
          !localPath ||
          !fs.existsSync(
            localPath
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                'La photo du produit est introuvable. Ajoutez une image de référence.'
            });
        }

        sourceImage = {

          buffer:
            fs.readFileSync(
              localPath
            ),

          mimetype:
            mimeTypeFromPath(
              localPath
            ),

          originalname:
            path.basename(
              localPath
            ),

          size:
            fs.statSync(
              localPath
            ).size
        };

        sourceImageUrl =
          safeString(
            product.image
          );
      }

      if (!sourceImage) {
        return res
          .status(400)
          .json({
            error:
              'Sélectionnez un produit avec photo ou ajoutez une image de référence.'
          });
      }

      function outputDimension(
        value,
        fallback
      ) {
        const number =
          Number(value);

        if (
          !Number.isFinite(
            number
          )
        ) {
          return fallback;
        }

        return Math.max(
          256,
          Math.min(
            1920,
            Math.round(
              number
            )
          )
        );
      }

      const simulation =
        await customizationHandler({

          product,

          request,

          sourceImage,

          outputWidth:
            outputDimension(
              req.body
                ?.outputWidth,
              1024
            ),

          outputHeight:
            outputDimension(
              req.body
                ?.outputHeight,
              768
            )
        });

      if (
        !simulation?.imageBuffer
      ) {
        throw new Error(
          'Le moteur image n’a retourné aucune simulation.'
        );
      }

      const id =
        crypto.randomUUID();

      const now =
        new Date()
          .toISOString();

      let sourceFilename =
        '';

      if (req.file) {

        sourceFilename =
          `custom-source-${Date.now()}-${id}` +
          extensionFromMimeType(
            sourceImage.mimetype
          );

        fs.writeFileSync(
          path.join(
            CUSTOMIZATIONS_DIR,
            sourceFilename
          ),
          sourceImage.buffer
        );

        sourceImageUrl =
          `/admin/customizations/${sourceFilename}`;
      }

      const resultFilename =
        `custom-result-${Date.now()}-${id}` +
        extensionFromMimeType(
          simulation.mimeType ||
          'image/jpeg'
        );

      fs.writeFileSync(
        path.join(
          CUSTOMIZATIONS_DIR,
          resultFilename
        ),
        simulation.imageBuffer
      );

      const item = {

        id,

        productId:
          product?.id ||
          '',

        productName:
          safeString(
            product?.name
          ) ||
          'Image libre',

        customerName:
          request
            .customerName,

        customerPhone:
          request
            .customerPhone,

        request,

        warnings:
          buildCustomizationWarnings(
            product,
            request
          ),

        analysis:
          safeString(
            simulation.analysis
          ),

        sourceImage:
          sourceImageUrl,

        sourceFilename,

        resultImage:
          `/admin/customizations/${resultFilename}`,

        resultFilename,

        status:
          'simulation_generated',

        requiresCommercialValidation:
          true,

        createdAt:
          now,

        updatedAt:
          now
      };

      const items =
        loadCustomizations();

      items.push(
        item
      );

      saveCustomizations(
        items
      );

      return res
        .status(201)
        .json(
          item
        );

    } catch (error) {

      console.error(
        '❌ Personnalisation :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Impossible de générer la simulation.'
        });
    }
  }
);

// ============================================================
// MODIFIER STATUT PERSONNALISATION
// ============================================================

router.put(
  '/api/customizations/:id/status',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const allowed =
        new Set([
          'simulation_generated',
          'awaiting_validation',
          'approved',
          'sent_to_client',
          'rejected'
        ]);

      const status =
        safeString(
          req.body?.status
        );

      if (
        !allowed.has(
          status
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Statut non valide.'
          });
      }

      const items =
        loadCustomizations();

      const index =
        items.findIndex(
          item =>
            item.id ===
            req.params.id
        );

      if (
        index === -1
      ) {
        return res
          .status(404)
          .json({
            error:
              'Demande introuvable.'
          });
      }

      items[index] = {

        ...items[index],

        status,

        updatedAt:
          new Date()
            .toISOString()
      };

      saveCustomizations(
        items
      );

      return res.json(
        items[index]
      );

    } catch (error) {

      console.error(
        '❌ Statut personnalisation :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de modifier le statut.'
        });
    }
  }
);

// ============================================================
// SUPPRIMER PERSONNALISATION
// ============================================================

router.delete(
  '/api/customizations/:id',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const items =
        loadCustomizations();

      const item =
        items.find(
          entry =>
            entry.id ===
            req.params.id
        );

      if (!item) {
        return res
          .status(404)
          .json({
            error:
              'Demande introuvable.'
          });
      }

      saveCustomizations(
        items.filter(
          entry =>
            entry.id !==
            req.params.id
        )
      );

      if (
        item.resultFilename
      ) {
        deleteFileIfExists(
          path.join(
            CUSTOMIZATIONS_DIR,
            path.basename(
              item.resultFilename
            )
          )
        );
      }

      if (
        item.sourceFilename
      ) {
        deleteFileIfExists(
          path.join(
            CUSTOMIZATIONS_DIR,
            path.basename(
              item.sourceFilename
            )
          )
        );
      }

      return res.json({
        success:true
      });

    } catch (error) {

      console.error(
        '❌ Suppression personnalisation :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'Impossible de supprimer la demande.'
        });
    }
  }
);

// ============================================================
// ÉTAT STOCKAGE
// ============================================================

router.get(
  '/api/storage-status',
  requireAuth,
  (
    req,
    res
  ) => {

    return res.json({

      dataDir:
        DATA_DIR,

      persistentConfigured:
        DATA_DIR !==
        APP_DIR,

      railwayVolumeMountPath:
        process.env
          .RAILWAY_VOLUME_MOUNT_PATH ||
        null,

      dataDirEnv:
        process.env.DATA_DIR ||
        null,

      writable:
        storageIsWritable(),

      productsFile:
        fs.existsSync(
          PRODUCTS_PATH
        ),

      instructionsFile:
        fs.existsSync(
          INSTRUCTIONS_PATH
        ),

      customizationsFile:
        fs.existsSync(
          CUSTOMIZATIONS_PATH
        ),

      uploadsDirectory:
        fs.existsSync(
          UPLOADS_DIR
        ),

      customizationsDirectory:
        fs.existsSync(
          CUSTOMIZATIONS_DIR
        ),

      recommendedRailwayMountPath:
        '/data',

      recommendedDataDir:
        '/data'
    });
  }
);

// ============================================================
// STATS
// ============================================================

router.get(
  '/api/stats',
  requireAuth,
  (
    req,
    res
  ) => {

    const products =
      loadProducts();

    const instructions =
      loadInstructions();

    const customizations =
      loadCustomizations();

    return res.json({

      productCount:
        products.length,

      activeProductCount:
        products.filter(
          product =>
            product.active !==
            false
        ).length,

      productsWithImages:
        products.filter(
          product =>
            Boolean(
              product.image
            )
        ).length,

      instructionsCount:
        instructions.length,

      activeInstructionsCount:
        instructions.filter(
          instruction =>
            instruction.active !==
            false
        ).length,

      customizationCount:
        customizations.length,

      structuredInstructions:
        structuredInstructionsStoreExists(),

      legacyBusinessInfoAvailable:
        Boolean(
          loadLegacyBusinessInfo()
            .trim()
        ),

      storage:{

        dataDir:
          DATA_DIR,

        persistentConfigured:
          DATA_DIR !==
          APP_DIR,

        writable:
          storageIsWritable()
      }
    });
  }
);

// ============================================================
// EXPORTS
// ============================================================

module.exports = {

  adminRouter:
    router,

  getBusinessContext,

  setChatHandler,

  setImageChatHandler,

  setCustomizationHandler
};
