// Vérifie la syntaxe de chaque bloc <script> inline d'Admin.html.
// Une erreur de syntaxe dans ce fichier casse tout le centre de pilotage
// sans qu'aucun test serveur ne la détecte.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '..', 'Admin.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

let failures = 0;
blocks.forEach((code, index) => {
  try {
    new vm.Script(code, { filename: `Admin.html#script${index}` });
  } catch (error) {
    failures += 1;
    console.error(`❌ Admin.html script #${index} : ${error.message}`);
  }
});

if (failures) process.exit(1);
console.log(`✅ Admin.html : ${blocks.length} bloc(s) <script> valides.`);
