// Préchargement de TEST uniquement (node -r) : provoque, à la demande du
// test, une promesse rejetée sans gestionnaire (fichier
// MONDECO_TEST_REJECT_FILE) puis une exception non rattrapée (fichier
// MONDECO_TEST_CRASH_FILE) dans le vrai serveur, pour vérifier que les
// gestionnaires de server.js envoient l'alerte ALERT_WEBHOOK_URL.
const fs = require('fs');

const rejectFile = process.env.MONDECO_TEST_REJECT_FILE;
const crashFile = process.env.MONDECO_TEST_CRASH_FILE;
let rejected = false;

const timer = setInterval(() => {
  if (!rejected && rejectFile && fs.existsSync(rejectFile)) {
    rejected = true;
    Promise.reject(new Error('MONDECO_TEST_REJECTION'));
  }
  if (crashFile && fs.existsSync(crashFile)) {
    clearInterval(timer);
    throw new Error('MONDECO_TEST_CRASH');
  }
}, 100);
timer.unref();
