// ============================================================
// MONDECO - PANNEAU D'ADMINISTRATION
// Fichier : Admin.js
//
// Fonctionnalités :
// - Authentification admin
// - Catalogue produits
// - Upload obligatoire d'une image produit
// - Modification / suppression produits
// - Instructions IA séparées
// - Import instructions
// - Import business-info.txt
// - Discussion de test
// - Statistiques
//
// Dépendances :
// npm install express multer
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
const multer = require('multer');

const router = express.Router();

// ============================================================
// CONFIGURATION GÉNÉRALE
// ============================================================

const DATA_DIR =
  (process.env.DATA_DIR || __dirname).trim();

const PRODUCTS_PATH =
  path.join(
    DATA_DIR,
    'products.json'
  );

const INSTRUCTIONS_JSON_PATH =
  path.join(
    DATA_DIR,
    'instructions.json'
  );

const UPLOADS_DIR =
  path.join(
    DATA_DIR,
    'uploads'
  );

// Ancien fichier MONDECO
const LEGACY_BUSINESS_INFO_PATH =
  path.join(
    __dirname,
    'business-info.txt'
  );

// Admin.html reste dans le dossier principal
const ADMIN_HTML_PATH =
  path.join(
    __dirname,
    'Admin.html'
  );

// ============================================================
// INITIALISER DOSSIERS
// ============================================================

try {

  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true
    }
  );

  fs.mkdirSync(
    UPLOADS_DIR,
    {
      recursive: true
    }
  );

  console.log(
    '✅ DATA_DIR Admin :',
    DATA_DIR
  );

  console.log(
    '✅ UPLOADS_DIR :',
    UPLOADS_DIR
  );

} catch (error) {

  console.error(
    '❌ Impossible de créer les dossiers Admin :',
    error
  );
}

// ============================================================
// MOT DE PASSE ADMIN
// ============================================================
//
// Si ADMIN_PASSWORD existe dans Railway,
// il est utilisé.
//
// Sinon :
// mondeco2026
// ============================================================

const ADMIN_PASSWORD =
  (
    process.env.ADMIN_PASSWORD ||
    'mondeco2026'
  ).trim();

if (!process.env.ADMIN_PASSWORD) {

  console.warn(
    '⚠️ ADMIN_PASSWORD non défini dans Railway.'
  );

  console.warn(
    '⚠️ Mot de passe par défaut utilisé : mondeco2026'
  );
}

// ============================================================
// EXPRESS JSON
// ============================================================
//
// Fonctionne pour les instructions.
//
// Multer prendra automatiquement en charge
// multipart/form-data pour les produits.
// ============================================================

router.use(
  express.json({
    limit: '5mb'
  })
);

// ============================================================
// SESSIONS ADMIN
// ============================================================

const validSessions =
  new Map();

const SESSION_DURATION =
  24 * 60 * 60 * 1000;

// ============================================================
// COOKIES
// ============================================================

function parseCookies(
  header = ''
) {

  const cookies = {};

  header
    .split(';')
    .forEach(pair => {

      const index =
        pair.indexOf('=');

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
          decodeURIComponent(
            rawValue
          );

      } catch {

        cookies[key] =
          rawValue;
      }

    });

  return cookies;
}

// ============================================================
// NETTOYAGE SESSIONS
// ============================================================

function cleanExpiredSessions() {

  const now =
    Date.now();

  for (
    const [token, expiresAt]
    of validSessions.entries()
  ) {

    if (
      expiresAt <= now
    ) {

      validSessions.delete(
        token
      );
    }
  }
}

// ============================================================
// VÉRIFIER SESSION
// ============================================================

function isValidSession(
  token
) {

  if (!token) {
    return false;
  }

  cleanExpiredSessions();

  const expiresAt =
    validSessions.get(
      token
    );

  if (!expiresAt) {
    return false;
  }

  if (
    expiresAt <= Date.now()
  ) {

    validSessions.delete(
      token
    );

    return false;
  }

  return true;
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function requireAuth(
  req,
  res,
  next
) {

  const cookies =
    parseCookies(
      req.headers.cookie || ''
    );

  const token =
    cookies
      .mondeco_admin_session;

  if (
    isValidSession(
      token
    )
  ) {

    return next();
  }

  // API
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

  // HTML
  return res.redirect(
    '/admin/login'
  );
}

// ============================================================
// MULTER - UPLOAD IMAGES
// ============================================================

const imageStorage =
  multer.diskStorage({

    destination:
      (
        req,
        file,
        callback
      ) => {

        callback(
          null,
          UPLOADS_DIR
        );
      },

    filename:
      (
        req,
        file,
        callback
      ) => {

        let extension =
          path
            .extname(
              file.originalname
            )
            .toLowerCase();

        // Sécurité supplémentaire
        if (
          ![
            '.jpg',
            '.jpeg',
            '.png',
            '.webp'
          ].includes(
            extension
          )
        ) {

          switch (
            file.mimetype
          ) {

            case 'image/jpeg':
              extension =
                '.jpg';
              break;

            case 'image/png':
              extension =
                '.png';
              break;

            case 'image/webp':
              extension =
                '.webp';
              break;

            default:
              extension =
                '';
          }
        }

        const filename =
          `product-${Date.now()}-${crypto.randomUUID()}${extension}`;

        callback(
          null,
          filename
        );
      }
  });

// ============================================================
// FILTRE IMAGE
// ============================================================

function productImageFilter(
  req,
  file,
  callback
) {

  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/webp'
  ];

  if (
    !allowedTypes.includes(
      file.mimetype
    )
  ) {

    return callback(
      new Error(
        'Format image non accepté. Utilisez JPG, PNG ou WEBP.'
      ),
      false
    );
  }

  callback(
    null,
    true
  );
}

const productImageUpload =
  multer({

    storage:
      imageStorage,

    fileFilter:
      productImageFilter,

    limits: {

      // Maximum 8 Mo
      fileSize:
        8 * 1024 * 1024
    }
  });

// ============================================================
// WRAPPER MULTER
// ============================================================
//
// Permet d'avoir de vrais messages d'erreur JSON
// au lieu d'une erreur Express générique.
// ============================================================

function uploadSingleProductImage(
  req,
  res,
  next
) {

  productImageUpload
    .single('image')(
      req,
      res,
      error => {

        if (!error) {

          return next();
        }

        console.error(
          '❌ Erreur upload image :',
          error.message
        );

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
                  'La photo dépasse la taille maximale de 8 Mo.'
              });
          }

          return res
            .status(400)
            .json({
              error:
                `Erreur upload : ${error.message}`
            });
        }

        return res
          .status(400)
          .json({
            error:
              error.message ||
              'Image non valide.'
          });
      }
    );
}

// ============================================================
// SUPPRIMER UN FICHIER SANS FAIRE CRASHER LE SERVEUR
// ============================================================

function deleteFileIfExists(
  filePath
) {

  try {

    if (
      filePath &&
      fs.existsSync(
        filePath
      )
    ) {

      fs.unlinkSync(
        filePath
      );
    }

  } catch (error) {

    console.warn(
      '⚠️ Impossible de supprimer le fichier :',
      error.message
    );
  }
}

// ============================================================
// RETROUVER LE FICHIER LOCAL DEPUIS product.image
// ============================================================

function getLocalImagePath(
  product
) {

  if (!product) {
    return null;
  }

  // Nouvelle structure
  if (
    product.imageFilename
  ) {

    return path.join(
      UPLOADS_DIR,
      path.basename(
        product.imageFilename
      )
    );
  }

  // Compatibilité avec image = /admin/uploads/xxx.jpg
  if (
    product.image &&
    String(product.image)
      .includes(
        '/admin/uploads/'
      )
  ) {

    const filename =
      path.basename(
        String(
          product.image
        )
      );

    return path.join(
      UPLOADS_DIR,
      filename
    );
  }

  return null;
}

// ============================================================
// PRODUITS - LECTURE
// ============================================================

function loadProducts() {

  try {

    if (
      !fs.existsSync(
        PRODUCTS_PATH
      )
    ) {

      return [];
    }

    const content =
      fs.readFileSync(
        PRODUCTS_PATH,
        'utf8'
      );

    if (
      !content.trim()
    ) {

      return [];
    }

    const parsed =
      JSON.parse(
        content
      );

    if (
      !Array.isArray(
        parsed
      )
    ) {

      console.warn(
        '⚠️ products.json ne contient pas un tableau.'
      );

      return [];
    }

    return parsed;

  } catch (error) {

    console.error(
      '❌ Erreur lecture products.json :',
      error
    );

    return [];
  }
}

// ============================================================
// PRODUITS - SAUVEGARDE
// ============================================================

function saveProducts(
  products
) {

  try {

    fs.mkdirSync(
      DATA_DIR,
      {
        recursive: true
      }
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
// INSTRUCTIONS
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

    const content =
      fs.readFileSync(
        INSTRUCTIONS_JSON_PATH,
        'utf8'
      );

    if (
      !content.trim()
    ) {

      return [];
    }

    const parsed =
      JSON.parse(
        content
      );

    if (
      !Array.isArray(
        parsed
      )
    ) {

      return [];
    }

    return parsed;

  } catch (error) {

    console.error(
      '❌ Erreur lecture instructions.json :',
      error
    );

    return [];
  }
}

// ============================================================
// SAUVEGARDE INSTRUCTIONS
// ============================================================

function saveInstructions(
  instructions
) {

  try {

    fs.mkdirSync(
      DATA_DIR,
      {
        recursive: true
      }
    );

    const temporaryPath =
      `${INSTRUCTIONS_JSON_PATH}.tmp`;

    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(
        instructions,
        null,
        2
      ),
      'utf8'
    );

    fs.renameSync(
      temporaryPath,
      INSTRUCTIONS_JSON_PATH
    );

  } catch (error) {

    console.error(
      '❌ Erreur sauvegarde instructions.json :',
      error
    );

    throw new Error(
      'Impossible de sauvegarder les instructions.'
    );
  }
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
// PARSER ANCIENNES INSTRUCTIONS
// ============================================================

function cleanInstructionTitle(
  text
) {

  return String(
    text ||
    ''
  )
    .replace(
      /^[\s\-–—•*#\d.)]+/,
      ''
    )
    .trim();
}

function parseInstructionBlocks(
  text
) {

  const normalized =
    String(
      text ||
      ''
    )
      .replace(
        /\r\n/g,
        '\n'
      )
      .replace(
        /\r/g,
        '\n'
      )
      .trim();

  if (!normalized) {

    return [];
  }

  const blocks =
    normalized
      .split(
        /\n\s*\n+/
      )
      .map(
        block =>
          block.trim()
      )
      .filter(
        Boolean
      );

  return blocks
    .map(block => {

      const lines =
        block
          .split('\n')
          .map(
            line =>
              line.trim()
          )
          .filter(
            Boolean
          );

      if (
        lines.length === 0
      ) {

        return null;
      }

      let title =
        cleanInstructionTitle(
          lines[0]
        );

      let content =
        lines
          .slice(1)
          .join('\n')
          .trim();

      // Une seule ligne
      if (!content) {

        const colonIndex =
          title.indexOf(
            ':'
          );

        if (
          colonIndex > 5 &&
          colonIndex < 100
        ) {

          content =
            title
              .slice(
                colonIndex + 1
              )
              .trim();

          title =
            title
              .slice(
                0,
                colonIndex
              )
              .trim();

        } else {

          content =
            title;
        }
      }

      if (!title) {

        title =
          content.slice(
            0,
            80
          );
      }

      if (
        title.length > 120
      ) {

        title =
          title.slice(
            0,
            117
          ) +
          '...';
      }

      return {
        title,
        content
      };

    })
    .filter(
      Boolean
    );
}

// ============================================================
// FINGERPRINT INSTRUCTIONS
// ============================================================

function instructionFingerprint(
  title,
  content
) {

  return crypto
    .createHash(
      'sha256'
    )
    .update(
      `${String(title).trim().toLowerCase()}|${String(content).trim().toLowerCase()}`
    )
    .digest(
      'hex'
    );
}

// ============================================================
// CONTEXTE BUSINESS POUR GROQ
// ============================================================

function getBusinessContext() {

  const products =
    loadProducts();

  const instructions =
    loadInstructions();

  let instructionsBlock =
    '';

  // ==========================================================
  // NOUVELLES INSTRUCTIONS
  // ==========================================================

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
            (
              instruction,
              index
            ) =>
              `${index + 1}. ${instruction.title}\n${instruction.content}`
          )
          .join(
            '\n\n'
          );
    }

  } else {

    // ========================================================
    // ANCIEN SYSTÈME
    // ========================================================

    const legacy =
      loadLegacyBusinessInfo();

    if (
      legacy.trim()
    ) {

      instructionsBlock =
        legacy.trim();
    }
  }

  // ==========================================================
  // CATALOGUE PRODUITS
  // ==========================================================

  let productsBlock =
    '';

  if (
    products.length > 0
  ) {

    productsBlock =
      '\n\nCATALOGUE PRODUITS MONDECO :\n' +

      products
        .map(product => {

          const name =
            String(
              product.name ||
              ''
            ).trim();

          const category =
            String(
              product.category ||
              ''
            ).trim();

          const price =
            product.price !==
              undefined &&
            product.price !==
              null
              ? String(
                  product.price
                ).trim()
              : '';

          const description =
            String(
              product.description ||
              ''
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
        .join(
          '\n'
        );
  }

  return (
    instructionsBlock +
    productsBlock
  ).trim();
}

// ============================================================
// PAGE LOGIN
// ============================================================

router.get(
  '/login',
  (
    req,
    res
  ) => {

    const cookies =
      parseCookies(
        req.headers.cookie ||
        ''
      );

    if (
      isValidSession(
        cookies
          .mondeco_admin_session
      )
    ) {

      return res.redirect(
        '/admin'
      );
    }

    return res
      .status(200)
      .type('html')
      .send(
        renderLoginPage()
      );
  }
);

// ============================================================
// LOGIN
// ============================================================

router.post(
  '/login',
  (
    req,
    res
  ) => {

    try {

      const password =
        String(
          req.body
            ?.password ||
          ''
        );

      if (
        password !==
        ADMIN_PASSWORD
      ) {

        return res
          .status(401)
          .json({
            success:
              false,

            error:
              'Mot de passe incorrect'
          });
      }

      const token =
        crypto
          .randomBytes(
            32
          )
          .toString(
            'hex'
          );

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

      if (
        isProduction
      ) {

        cookie +=
          '; Secure';
      }

      res.setHeader(
        'Set-Cookie',
        cookie
      );

      console.log(
        '✅ Connexion admin réussie'
      );

      return res.json({
        success:
          true
      });

    } catch (error) {

      console.error(
        '❌ Erreur connexion admin :',
        error
      );

      return res
        .status(500)
        .json({
          success:
            false,

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
  (
    req,
    res
  ) => {

    const cookies =
      parseCookies(
        req.headers.cookie ||
        ''
      );

    const token =
      cookies
        .mondeco_admin_session;

    if (token) {

      validSessions.delete(
        token
      );
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

      cookie +=
        '; Secure';
    }

    res.setHeader(
      'Set-Cookie',
      cookie
    );

    return res.json({
      success:
        true
    });
  }
);

// ============================================================
// DASHBOARD ADMIN
// ============================================================

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
// SERVIR LES IMAGES PRODUITS
// ============================================================
//
// Exemple :
// /admin/uploads/product-xxxxx.jpg
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
        req.params.filename
      );

    const imagePath =
      path.join(
        UPLOADS_DIR,
        filename
      );

    if (
      !fs.existsSync(
        imagePath
      )
    ) {

      return res
        .status(404)
        .send(
          'Image introuvable'
        );
    }

    return res.sendFile(
      imagePath
    );
  }
);

// ============================================================
// API PRODUITS - LISTE
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
// API PRODUITS - AJOUT
//
// IMAGE OBLIGATOIRE
// ============================================================

router.post(
  '/api/products',
  requireAuth,
  uploadSingleProductImage,
  (
    req,
    res
  ) => {

    try {

      const {
        name,
        description,
        price,
        category
      } =
        req.body ||
        {};

      const cleanName =
        String(
          name ||
          ''
        ).trim();

      // ======================================================
      // NOM OBLIGATOIRE
      // ======================================================

      if (!cleanName) {

        if (
          req.file
        ) {

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

      // ======================================================
      // IMAGE OBLIGATOIRE
      // ======================================================

      if (
        !req.file
      ) {

        return res
          .status(400)
          .json({
            error:
              'La photo du produit est obligatoire.'
          });
      }

      const products =
        loadProducts();

      const now =
        new Date()
          .toISOString();

      const product = {

        id:
          crypto.randomUUID(),

        name:
          cleanName,

        description:
          String(
            description ||
            ''
          ).trim(),

        price:
          price !==
            undefined &&
          price !==
            null
            ? String(
                price
              ).trim()
            : '',

        category:
          String(
            category ||
            ''
          ).trim(),

        // URL utilisée par Admin.html
        image:
          `/admin/uploads/${req.file.filename}`,

        // Nom fichier utile pour suppression
        imageFilename:
          req.file.filename,

        createdAt:
          now,

        updatedAt:
          now
      };

      try {

        products.push(
          product
        );

        saveProducts(
          products
        );

      } catch (error) {

        // Si sauvegarde JSON échoue,
        // supprimer l'image créée.
        deleteFileIfExists(
          req.file.path
        );

        throw error;
      }

      console.log(
        `✅ Produit ajouté : ${product.name}`
      );

      console.log(
        `🖼️ Image : ${product.imageFilename}`
      );

      return res
        .status(201)
        .json(
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
            'Impossible d’ajouter le produit.'
        });
    }
  }
);

// ============================================================
// API PRODUITS - MODIFICATION
//
// Nouvelle image FACULTATIVE si l'ancienne existe.
//
// Si une nouvelle image est choisie :
// - sauvegarder nouvelle image
// - remplacer ancienne URL
// - supprimer ancien fichier
// ============================================================

router.put(
  '/api/products/:id',
  requireAuth,
  uploadSingleProductImage,
  (
    req,
    res
  ) => {

    let newUploadedFilePath =
      req.file
        ?.path ||
      null;

    try {

      const products =
        loadProducts();

      const index =
        products.findIndex(
          product =>
            product.id ===
            req.params.id
        );

      if (
        index === -1
      ) {

        if (
          newUploadedFilePath
        ) {

          deleteFileIfExists(
            newUploadedFilePath
          );
        }

        return res
          .status(404)
          .json({
            error:
              'Produit introuvable.'
          });
      }

      const currentProduct =
        products[index];

      const {
        name,
        description,
        price,
        category
      } =
        req.body ||
        {};

      // ======================================================
      // NOM
      // ======================================================

      if (
        name !==
          undefined &&
        !String(
          name
        ).trim()
      ) {

        if (
          newUploadedFilePath
        ) {

          deleteFileIfExists(
            newUploadedFilePath
          );
        }

        return res
          .status(400)
          .json({
            error:
              'Le nom du produit ne peut pas être vide.'
          });
      }

      // ======================================================
      // SI ANCIEN PRODUIT SANS IMAGE
      // UNE IMAGE DEVIENT OBLIGATOIRE
      // ======================================================

      if (
        !currentProduct.image &&
        !req.file
      ) {

        return res
          .status(400)
          .json({
            error:
              'Ce produit n’a pas encore de photo. Ajoutez obligatoirement une image.'
          });
      }

      const oldImagePath =
        getLocalImagePath(
          currentProduct
        );

      let newImage =
        currentProduct.image ||
        '';

      let newImageFilename =
        currentProduct
          .imageFilename ||
        '';

      // ======================================================
      // NOUVELLE IMAGE
      // ======================================================

      if (
        req.file
      ) {

        newImage =
          `/admin/uploads/${req.file.filename}`;

        newImageFilename =
          req.file.filename;
      }

      const updatedProduct = {

        ...currentProduct,

        name:
          name !== undefined
            ? String(
                name
              ).trim()
            : currentProduct.name,

        description:
          description !==
            undefined
            ? String(
                description
              ).trim()
            : currentProduct
                .description,

        price:
          price !== undefined &&
          price !== null
            ? String(
                price
              ).trim()
            : currentProduct
                .price,

        category:
          category !==
            undefined
            ? String(
                category
              ).trim()
            : currentProduct
                .category,

        image:
          newImage,

        imageFilename:
          newImageFilename,

        updatedAt:
          new Date()
            .toISOString()
      };

      products[index] =
        updatedProduct;

      // ======================================================
      // SAUVEGARDER D'ABORD LE JSON
      // ======================================================

      try {

        saveProducts(
          products
        );

      } catch (error) {

        // La nouvelle image n'est pas encore
        // référencée correctement -> suppression
        if (
          req.file
        ) {

          deleteFileIfExists(
            req.file.path
          );
        }

        throw error;
      }

      // ======================================================
      // APRÈS SAUVEGARDE :
      // SUPPRIMER L'ANCIENNE IMAGE
      // ======================================================

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

      console.log(
        `✅ Produit modifié : ${updatedProduct.name}`
      );

      return res.json(
        updatedProduct
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
            'Impossible de modifier le produit.'
        });
    }
  }
);

// ============================================================
// API PRODUITS - SUPPRESSION
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

      const filtered =
        products.filter(
          item =>
            item.id !==
            req.params.id
        );

      // ======================================================
      // D'ABORD SAUVEGARDER LE CATALOGUE
      // ======================================================

      saveProducts(
        filtered
      );

      // ======================================================
      // ENSUITE SUPPRIMER LA PHOTO
      // ======================================================

      const imagePath =
        getLocalImagePath(
          product
        );

      if (
        imagePath
      ) {

        deleteFileIfExists(
          imagePath
        );
      }

      console.log(
        `🗑️ Produit supprimé : ${product.name}`
      );

      return res.json({
        success:
          true
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
            'Impossible de supprimer le produit.'
        });
    }
  }
);

// ============================================================
// API INSTRUCTIONS - LISTE
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
// API INSTRUCTIONS - AJOUT
// ============================================================

router.post(
  '/api/instructions',
  requireAuth,
  (
    req,
    res
  ) => {

    try {

      const {
        title,
        content,
        active
      } =
        req.body ||
        {};

      const cleanTitle =
        String(
          title ||
          ''
        ).trim();

      const cleanContent =
        String(
          content ||
          ''
        ).trim();

      if (
        !cleanTitle
      ) {

        return res
          .status(400)
          .json({
            error:
              'Le titre est obligatoire.'
          });
      }

      if (
        !cleanContent
      ) {

        return res
          .status(400)
          .json({
            error:
              'L’instruction est obligatoire.'
          });
      }

      const instructions =
        loadInstructions();

      const now =
        new Date()
          .toISOString();

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

      return res
        .status(201)
        .json(
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
            'Impossible d’ajouter l’instruction.'
        });
    }
  }
);

// ============================================================
// API INSTRUCTIONS - MODIFICATION
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
        instructions.findIndex(
          instruction =>
            instruction.id ===
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

      const {
        title,
        content,
        active
      } =
        req.body ||
        {};

      if (
        title !==
          undefined &&
        !String(
          title
        ).trim()
      ) {

        return res
          .status(400)
          .json({
            error:
              'Le titre ne peut pas être vide.'
          });
      }

      if (
        content !==
          undefined &&
        !String(
          content
        ).trim()
      ) {

        return res
          .status(400)
          .json({
            error:
              'L’instruction ne peut pas être vide.'
          });
      }

      instructions[index] = {

        ...instructions[index],

        title:
          title !== undefined
            ? String(
                title
              ).trim()
            : instructions[index]
                .title,

        content:
          content !== undefined
            ? String(
                content
              ).trim()
            : instructions[index]
                .content,

        active:
          active !== undefined
            ? Boolean(
                active
              )
            : instructions[index]
                .active,

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
        '❌ Erreur modification instruction :',
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
// API INSTRUCTIONS - SUPPRESSION
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
          instruction =>
            instruction.id ===
            req.params.id
        );

      if (
        !exists
      ) {

        return res
          .status(404)
          .json({
            error:
              'Instruction introuvable.'
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
        success:
          true
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
            'Impossible de supprimer l’instruction.'
        });
    }
  }
);

// ============================================================
// IMPORT PLUSIEURS INSTRUCTIONS
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
        String(
          req.body
            ?.text ||
          ''
        ).trim();

      if (
        !text
      ) {

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

      if (
        parsed.length === 0
      ) {

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

      let imported =
        0;

      let duplicates =
        0;

      const now =
        new Date()
          .toISOString();

      for (
        const parsedItem
        of parsed
      ) {

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

        success:
          true,

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

      if (
        !legacyText
      ) {

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

      if (
        parsed.length === 0
      ) {

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

      let imported =
        0;

      let duplicates =
        0;

      const now =
        new Date()
          .toISOString();

      for (
        const parsedItem
        of parsed
      ) {

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

        success:
          true,

        imported,

        duplicates,

        total:
          instructions.length
      });

    } catch (error) {

      console.error(
        '❌ Erreur import business-info :',
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
// DISCUSSION DE TEST
// ============================================================

let chatHandler =
  null;

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

  chatHandler =
    fn;

  console.log(
    '✅ Discussion test connectée à generateReply()'
  );
}

// ============================================================
// API DISCUSSION TEST
// ============================================================

router.post(
  '/api/test-chat',
  requireAuth,
  async (
    req,
    res
  ) => {

    try {

      if (
        !chatHandler
      ) {

        return res
          .status(503)
          .json({
            error:
              'Le bot IA n’est pas encore connecté.'
          });
      }

      const message =
        String(
          req.body
            ?.message ||
          ''
        ).trim();

      if (
        !message
      ) {

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
        '❌ Erreur discussion test :',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Erreur pendant la génération de la réponse.'
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
  (
    req,
    res
  ) => {

    const products =
      loadProducts();

    const instructions =
      loadInstructions();

    const activeInstructions =
      instructions.filter(
        instruction =>
          instruction.active !== false
      );

    const productsWithImages =
      products.filter(
        product =>
          Boolean(
            product.image
          )
      ).length;

    return res.json({

      productCount:
        products.length,

      productsWithImages,

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
// PAGE LOGIN
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

@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap');

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
    400px;

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
    30px;

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
}

button:hover {

  background:
    #9C4718;
}

button:disabled {

  opacity:
    0.6;

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

  adminRouter:
    router,

  getBusinessContext,

  setChatHandler
};
