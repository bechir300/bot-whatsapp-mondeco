// V6.46 — Charge de VRAIES fonctions de production (Admin.js, server.js)
// dans un bac à sable vm, sans exécuter le module (Admin.js démarre des
// minuteries et des migrations au chargement). Les tests de la racine
// (test_*.js) testaient des copies collées de ces fonctions, qui avaient
// déjà divergé du code réel : une régression passait inaperçue.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const sourceCache = new Map();

function readSource(file) {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  if (!sourceCache.has(full)) sourceCache.set(full, fs.readFileSync(full, 'utf8'));
  return sourceCache.get(full);
}

// Index juste après la fin d'une chaîne '…' ou "…" commençant en `i`.
function skipQuoted(source, i) {
  const quote = source[i];
  i++;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') i++;
    i++;
  }
  return i + 1;
}

// Index juste après la fin d'un gabarit `…${…}…` commençant en `i`.
function skipTemplate(source, i) {
  i++;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') { i += 2; continue; }
    if (char === '`') return i + 1;
    if (char === '$' && source[i + 1] === '{') {
      i = skipBlock(source, i + 1) + 1;
      continue;
    }
    i++;
  }
  throw new Error('Gabarit non terminé');
}

// Index de l'accolade fermante du bloc ouvert en `i` (source[i] === '{'),
// en sautant chaînes, gabarits et commentaires.
function skipBlock(source, i) {
  let depth = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      i = source.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (char === '\'' || char === '"') { i = skipQuoted(source, i); continue; }
    if (char === '`') { i = skipTemplate(source, i); continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return i;
    i++;
  }
  throw new Error('Bloc non terminé');
}

// Texte complet de `function name(...) { ... }` (déclaration de premier
// niveau, en début de ligne).
function extractFunction(source, name) {
  const match = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  if (!match) throw new Error(`Fonction introuvable : ${name}`);
  const start = match.index;
  // Fin de la liste des paramètres (valeurs par défaut comprises).
  let i = source.indexOf('(', start);
  let parens = 0;
  for (; i < source.length; i++) {
    const char = source[i];
    if (char === '\'' || char === '"') { i = skipQuoted(source, i) - 1; continue; }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue; }
    if (char === '{') { i = skipBlock(source, i); continue; }
    if (char === '(') parens++;
    if (char === ')' && --parens === 0) break;
  }
  const bodyStart = source.indexOf('{', i);
  return source.slice(start, skipBlock(source, bodyStart) + 1);
}

// Objet { nom: fonction } des fonctions demandées, évaluées ensemble (elles
// peuvent s'appeler entre elles). `globals` : dépendances simulées.
function loadFunctions(file, names, globals = {}) {
  const source = readSource(file);
  // Map / Set / Date… de l'hôte : `instanceof Map` fonctionne avec les
  // objets créés par le test.
  const context = vm.createContext({ console, Map, Set, Date, Math, Number, String, Boolean, Object, JSON, ...globals });
  vm.runInContext(names.map(name => extractFunction(source, name)).join('\n\n'), context, { filename: file });
  const out = {};
  for (const name of names) {
    out[name] = vm.runInContext(name, context);
    if (typeof out[name] !== 'function') throw new Error(`${name} n'est pas une fonction`);
  }
  return out;
}

module.exports = { extractFunction, loadFunctions, readSource };
