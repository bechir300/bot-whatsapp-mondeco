// ============================================================
// MONDECO — dossier des données (products.json, uploads…)
// lib/data-dir.js
//
// V6.46 — Une seule règle pour tous les modules : DATA_DIR, sinon le volume
// Railway (RAILWAY_VOLUME_MOUNT_PATH), sinon le dossier de l'application
// (même règle que server.js et Admin.js).
// ============================================================

'use strict';

const path = require('path');

const APP_DIR = path.join(__dirname, '..');

function resolveDataDir(env = process.env, appDir = APP_DIR) {
  return String(
    env.DATA_DIR ||
    env.RAILWAY_VOLUME_MOUNT_PATH ||
    appDir
  ).trim();
}

module.exports = { APP_DIR, resolveDataDir };
