'use strict';
// Charge Admin.js dans un répertoire de données temporaire : les tests ne
// touchent jamais aux fichiers réels et les timers du module sont unref().
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATA_DIR || !process.env.DATA_DIR.includes('mondeco-test-')) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-test-'));
}
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Test-Password-123456';

const admin = require('../Admin');

module.exports = admin._internals;
