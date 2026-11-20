// ============================================================
// MONDECO — photo d'un produit pour un envoi WhatsApp ou une simulation
// lib/product-image.js
//
// V6.46 — Les fiches synchronisées avec mondeco.tn n'ont pas de fichier
// local (image = URL https du site, imageFilename vide) : la fiche produit
// envoyée par l'IA partait donc toujours sans photo, et la simulation de
// personnalisation refusait ces produits (« photo introuvable »). Ordre :
// 1. fichier local (photo téléversée dans l'Admin) ;
// 2. sinon l'image https du produit, téléchargée (15 s, 10 Mo au plus).
// Seuls les formats demandés sont acceptés (WhatsApp : JPEG ou PNG ; le
// WebP du site n'est pas converti côté serveur, la fiche part alors avec un
// titre texte comme avant).
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readResponseBufferWithLimit } = require('./http');
const { imageMimeFromBuffer } = require('./product-card-auto');

const REMOTE_IMAGE_TIMEOUT_MS = 15000;
const REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const WHATSAPP_IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png']);

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

// Image https du produit (celle affichée dans l'Admin). Une photo
// téléversée dans l'Admin (/admin/uploads/…) n'est jamais remplacée par
// l'image du site.
function remoteImageUrl(product) {
  const value = String(product?.image ?? '').trim();
  if (!/^https:\/\//i.test(value)) return '';
  try {
    return new URL(value).toString();
  } catch {
    return '';
  }
}

function asImage(buffer, allowed, source) {
  const mimetype = imageMimeFromBuffer(buffer);
  if (!mimetype || !allowed.includes(mimetype)) return null;
  return {
    buffer,
    mimetype,
    originalname: `produit.${EXTENSIONS[mimetype] || 'jpg'}`,
    size: buffer.length,
    source
  };
}

// Retourne { buffer, mimetype, originalname, size, source: 'local' |
// 'remote' } ou null (pas de photo, format refusé, site injoignable).
// options.localPath : chemin local déjà résolu (getLocalProductImagePath).
async function loadProductImage(product, options = {}) {
  const allowed = Array.isArray(options.allowedMimes) && options.allowedMimes.length
    ? options.allowedMimes
    : WHATSAPP_IMAGE_MIMES;

  const localPath = options.localPath ? String(options.localPath) : '';
  if (localPath && fs.existsSync(localPath)) {
    try {
      const local = asImage(fs.readFileSync(localPath), allowed, 'local');
      if (local) {
        local.originalname = path.basename(localPath) || local.originalname;
        return local;
      }
    } catch {
      // Fichier illisible : on tente l'image du site.
    }
  }

  const url = remoteImageUrl(product);
  if (!url) return null;

  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(Number(options.timeoutMs) || REMOTE_IMAGE_TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!response?.ok) {
    try { await response?.body?.cancel(); } catch {}
    return null;
  }
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.startsWith('image/')) {
    try { await response.body?.cancel(); } catch {}
    return null;
  }
  const buffer = await readResponseBufferWithLimit(
    response,
    Number(options.maxBytes) || REMOTE_IMAGE_MAX_BYTES
  );
  return asImage(buffer, allowed, 'remote');
}

module.exports = {
  REMOTE_IMAGE_MAX_BYTES,
  WHATSAPP_IMAGE_MIMES,
  loadProductImage,
  remoteImageUrl
};
