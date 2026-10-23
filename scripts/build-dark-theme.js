#!/usr/bin/env node
// ============================================================
// MONDECO — génération du mode sombre de Admin.html
// scripts/build-dark-theme.js
//
// Admin.html contient plusieurs milliers de règles CSS avec des couleurs
// écrites en dur. Ce script lit toutes ces règles et produit, pour chacune,
// son équivalent sombre préfixé par html[data-theme="dark"] :
// - fonds clairs → surfaces sombres chaudes (teinte noyer) ;
// - textes foncés → textes clairs, en gardant la teinte (un vert reste vert,
//   un ambre reste ambre) ;
// - fonds foncés neutres (boutons « actifs » noirs) → clairs, et leur texte
//   blanc → foncé ;
// - couleurs vives (boutons rouges, verts WhatsApp) : inchangées.
// Les règles @media sont conservées. Le résultat est écrit entre les
// marqueurs DARK-THEME:START / DARK-THEME:END de Admin.html.
//
// À relancer après une modification importante du CSS : npm run build:dark
// ============================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'Admin.html');
const START = '/* DARK-THEME:START (généré par scripts/build-dark-theme.js, ne pas modifier à la main) */';
const END = '/* DARK-THEME:END */';
const PREFIX = 'html[data-theme="dark"]';

// ---------- couleurs ----------

const NAMED = { white: [255, 255, 255], black: [0, 0, 0] };

function parseColor(token) {
  const t = token.toLowerCase();
  if (NAMED[t]) return { rgb: NAMED[t], a: 1 };
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { rgb, a };
  }
  m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: [m[1], m[2], m[3]].map(Number), a };
  }
  return null;
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l, l, l].map(v => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = t => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
}

function format({ rgb, a }) {
  const hex = '#' + rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  return a >= 1 ? hex : `rgba(${rgb.join(',')},${Math.round(a * 1000) / 1000})`;
}

const WARM_HUE = 28;

// Fond : clair → sombre chaud ; foncé neutre → clair ; vif → inchangé.
function darkBackground(color) {
  const [h, s, l] = rgbToHsl(color.rgb);
  if (s > 0.45 && l > 0.25 && l < 0.75) return color; // couleur vive (bouton)
  if (l >= 0.55) {
    const hue = s < 0.12 ? WARM_HUE : h;
    const sat = s < 0.12 ? 0.16 : Math.min(s, 0.45) * 0.55;
    const nl = 0.085 + (1 - l) * 0.42; // blanc → 8,5 %, sable → ~13 %
    return { rgb: hslToRgb([hue, sat, nl]), a: color.a };
  }
  if (l < 0.22 && s < 0.25) {
    // fond « actif » noir/encre → sable clair
    return { rgb: hslToRgb([WARM_HUE, 0.28, 0.86 - l * 0.4]), a: color.a };
  }
  return { rgb: hslToRgb([h, s * 0.8, Math.max(0.16, 1 - l - 0.12)]), a: color.a };
}

// Texte : foncé → clair (même teinte) ; blanc → foncé seulement si le fond
// de la même règle était foncé et neutre (il devient clair).
function darkText(color, invertLight) {
  const [h, s, l] = rgbToHsl(color.rgb);
  if (l < 0.6) {
    const nl = Math.min(0.93, Math.max(0.68, 1 - l * 0.75));
    return { rgb: hslToRgb([h, s < 0.12 ? 0.18 : Math.min(1, s * 0.85), nl]), a: color.a };
  }
  if (invertLight && l > 0.85) return { rgb: hslToRgb([WARM_HUE, 0.2, 0.12]), a: color.a };
  return color;
}

function darkBorder(color) {
  const [h, s, l] = rgbToHsl(color.rgb);
  if (s > 0.45 && l > 0.25 && l < 0.75) return color;
  if (l >= 0.5) return { rgb: hslToRgb([s < 0.12 ? WARM_HUE : h, s < 0.12 ? 0.14 : s * 0.5, 0.22 + (1 - l) * 0.3]), a: color.a };
  return color;
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
const HAS_COLOR = new RegExp(COLOR_TOKEN.source);

function mapValue(value, fn) {
  return value.replace(COLOR_TOKEN, token => {
    const parsed = parseColor(token);
    return parsed ? format(fn(parsed)) : token;
  });
}

// ---------- CSS ----------

// Découpe un bloc CSS en règles, en gardant @media / @supports.
function parseBlocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (/^@(media|supports)/.test(head)) out.push({ at: head, children: parseBlocks(body) });
    else if (!head.startsWith('@')) out.push({ selector: head, body });
    i = j;
  }
  return out;
}

// Éléments déjà sombres dans les deux thèmes (navigation, barre mobile) :
// laissés tels quels.
const SKIP_SELECTOR = /\.(sidebar|nav\b|nav-|brand|logout-btn|desktop-sidebar-toggle|mobile-topbar|mobile-menu-btn|mobile-brand|theme-toggle-btn)|#mondecoDebugPanel/;

const PROPS = /^(color|background|background-color|border|border-color|border-(?:top|right|bottom|left)(?:-color)?|outline-color|fill|stroke|box-shadow)$/i;

function convertRule(rule) {
  if (!rule.selector || /DARK-THEME|^\s*(html|:root)\b/.test(rule.selector)) return '';
  if (/data-theme/.test(rule.selector)) return '';
  const kept = rule.selector.split(',').map(x => x.trim()).filter(x => x && !SKIP_SELECTOR.test(x));
  if (!kept.length) return '';
  rule = { ...rule, selector: kept.join(',') };
  const decls = rule.body.replace(/\/\*[\s\S]*?\*\//g, '').split(';').map(d => d.trim()).filter(Boolean);
  const parsed = decls
    .map(d => {
      const k = d.indexOf(':');
      if (k < 0) return null;
      return { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() };
    })
    .filter(d => d && PROPS.test(d.prop) && HAS_COLOR.test(d.value) && !/var\(/.test(d.value.replace(COLOR_TOKEN, '')));

  if (!parsed.length) return '';
  const bg = parsed.find(d => d.prop === 'background' || d.prop === 'background-color');
  let invertLight = false;
  if (bg) {
    const first = parseColor((bg.value.match(COLOR_TOKEN) || [])[0] || '');
    if (first) {
      const [, s, l] = rgbToHsl(first.rgb);
      invertLight = l < 0.22 && s < 0.25 && first.a > 0.6;
    }
  }

  const out = [];
  for (const { prop, value } of parsed) {
    let mapped;
    if (prop === 'color' || prop === 'fill' || prop === 'stroke') mapped = mapValue(value, c => darkText(c, invertLight));
    else if (prop.startsWith('background')) mapped = mapValue(value, darkBackground);
    else if (prop === 'box-shadow') mapped = mapValue(value, c => ({ rgb: [0, 0, 0], a: Math.min(0.5, c.a * 2) }));
    else mapped = mapValue(value, darkBorder);
    // Même priorité que la règle d'origine (!important conservé tel quel) :
    // la cascade du thème clair est respectée (ex. interrupteur activé).
    if (mapped !== value || prop === 'color') out.push(`${prop}:${mapped}`);
  }
  if (!out.length) return '';

  const selector = rule.selector
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (/^(body|html)\b/.test(s) ? `${PREFIX} ${s.replace(/^html\b/, '')}`.replace(/\s+/g, ' ') : `${PREFIX} ${s}`))
    .join(',');
  return `${selector}{${out.join(';')}}`;
}

function convert(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.children) {
      const inner = convert(block.children);
      if (inner) out.push(`${block.at}{${inner}}`);
    } else {
      const css = convertRule(block);
      if (css) out.push(css);
    }
  }
  return out.join('\n');
}

// Renvoie Admin.html avec le bloc sombre régénéré (sans écrire).
function render(html) {
  const startIndex = html.indexOf(START);
  const endIndex = html.indexOf(END);
  if (startIndex < 0 || endIndex < startIndex) throw new Error('Marqueurs DARK-THEME introuvables dans Admin.html.');
  const source = html.slice(0, startIndex) + html.slice(endIndex + END.length);
  const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const generated = convert(parseBlocks(css));
  return { html: `${html.slice(0, startIndex)}${START}\n${generated}\n${html.slice(endIndex)}`, generated };
}

function build() {
  const html = fs.readFileSync(FILE, 'utf8');
  const { html: next, generated } = render(html);
  if (next !== html) fs.writeFileSync(FILE, next);
  console.log(`✅ Mode sombre : ${generated.split('\n').length} règle(s) générée(s), ${Math.round(generated.length / 1024)} Ko.`);
}

if (require.main === module) build();

module.exports = { parseColor, darkBackground, darkText, darkBorder, convertRule, parseBlocks, render };
