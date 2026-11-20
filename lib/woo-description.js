// ============================================================
// MONDECO — descriptions produits WooCommerce
// lib/woo-description.js
//
// V6.45 — Les fiches du site mondeco.tn sont écrites avec WPBakery : la
// description longue est un bloc [vc_raw_html] dont le contenu est du HTML
// encodé en URL puis en base64. L'ancien convertisseur (htmlToPlainText)
// ne savait pas le lire : la composition (« 1 lit + 1 dressing + 1 coiffeuse
// + 2 tables de nuit + 1 pouf de lit ») et les dimensions par élément
// n'arrivaient jamais jusqu'à l'IA.
//
// Ce module décode ces blocs, extrait le tableau « Caractéristiques »
// (lignes libellé / valeur) et produit une description courte en texte
// brut. Aucune dépendance, aucune écriture : fonctions pures.
// ============================================================

'use strict';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  times: '×', divide: '÷', deg: '°', euro: '€', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', shy: '', zwnj: '', zwj: '',
  thinsp: ' ', ensp: ' ', emsp: ' ', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', plusmn: '±', oslash: 'ø', Oslash: 'Ø',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', atilde: 'ã',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Auml: 'Ä',
  ccedil: 'ç', Ccedil: 'Ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', Icirc: 'Î', Iuml: 'Ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', ouml: 'ö', Ocirc: 'Ô', Ouml: 'Ö',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü',
  yuml: 'ÿ', oelig: 'œ', OElig: 'Œ', aelig: 'æ', AElig: 'Æ'
};

// Décode les entités HTML (&#215; &#038; &#8211; &amp; &nbsp; …) en une
// seule passe. Les entités inconnues sont laissées telles quelles.
function decodeHtmlEntities(value) {
  return String(value ?? '').replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi,
    (match, code) => {
      if (code[0] === '#') {
        const point = code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
        if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff) return match;
        if (point === 0xa0) return ' ';
        try {
          return String.fromCodePoint(point);
        } catch {
          return match;
        }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code)
        ? NAMED_ENTITIES[code]
        : match;
    }
  );
}

// Texte d'une ligne (nom, catégorie, option d'attribut) : entités décodées,
// balises et espaces superflus retirés.
function cleanInlineText(value) {
  return decodeHtmlEntities(
    String(value ?? '').replace(/<[^>]*>/g, ' ')
  )
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// decodeURIComponent tolérant : une séquence %XX invalide (contenu collé à
// la main dans WPBakery) ne doit pas faire perdre tout le bloc.
function lenientUriDecode(value) {
  const text = String(value ?? '');
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(?:%[0-9a-f]{2})+/gi, sequence => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        const bytes = Buffer.from(
          sequence.split('%').filter(Boolean).map(hex => parseInt(hex, 16))
        );
        return bytes.toString('utf8');
      }
    });
  }
}

// Contenu d'un bloc [vc_raw_html] : base64 (éventuellement coupé par des
// <p>/<br> ajoutés par WordPress, et « = » encodé en &#61;) d'un HTML
// encodé en URL. Retourne '' si le bloc n'est pas décodable.
function decodeVcRawHtmlPayload(payload) {
  const base64 = decodeHtmlEntities(
    String(payload ?? '').replace(/<[^>]*>/g, '')
  ).replace(/\s+/g, '');

  if (!base64 || !/^[A-Za-z0-9+/=_-]+$/.test(base64)) {
    return '';
  }

  let decoded = '';
  try {
    decoded = Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    return '';
  }

  const html = lenientUriDecode(decoded);
  // Un contenu binaire (base64 invalide) contient des caractères de
  // contrôle : on l'ignore plutôt que d'envoyer du bruit à l'IA.
  if (!html.trim() || /[\u0000-\u0008\u000e-\u001f�]/.test(html)) {
    return '';
  }
  return html;
}

const VC_RAW_HTML_RE = /\[vc_raw_html[^\]]*\]([\s\S]*?)\[\/vc_raw_html\]/gi;

// HTML de tous les blocs [vc_raw_html] d'une description, concaténés.
function decodeVcRawHtml(description) {
  const parts = [];
  for (const match of String(description ?? '').matchAll(VC_RAW_HTML_RE)) {
    const html = decodeVcRawHtmlPayload(match[1]);
    if (html) parts.push(html);
  }
  return parts.join('\n');
}

// Retire les shortcodes WPBakery restants ([vc_row], [/vc_column_text]…).
function stripVcShortcodes(text) {
  return String(text ?? '').replace(/\[\/?vc_[a-z0-9_]*(?:\s[^\]]*)?\]/gi, ' ');
}

// Description complète en HTML lisible : chaque [vc_raw_html] est remplacé
// par son HTML décodé (vide s'il est illisible), puis les autres
// shortcodes WPBakery sont retirés.
function expandWooDescriptionHtml(description) {
  const expanded = String(description ?? '').replace(
    VC_RAW_HTML_RE,
    (match, payload) => `\n${decodeVcRawHtmlPayload(payload)}\n`
  );
  return stripVcShortcodes(expanded);
}

// HTML → texte brut. Avec { keepLines: true }, les éléments de bloc
// deviennent des retours à la ligne (utile pour lire des libellés).
function htmlToText(html, options = {}) {
  let source = String(html ?? '');
  // Jamais de base64 brut dans le texte : les blocs [vc_raw_html] encore
  // présents sont décodés (ou retirés s'ils sont illisibles).
  if (/\[vc_raw_html/i.test(source)) {
    source = expandWooDescriptionHtml(source);
  }

  let text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|h[1-6]|li|ul|ol|tr|table|tbody|thead|dt|dd|dl|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' \n')
    .replace(/<[^>]*>/g, ' ');

  text = decodeHtmlEntities(stripVcShortcodes(text))
    .replace(/[   ]/g, ' ');

  if (options.keepLines) {
    return text
      .split('\n')
      .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  return text.replace(/\s+/g, ' ').trim();
}

// Raccourcit un texte à maxLength caractères, de préférence en fin de
// phrase puis à un espace, avec « … ».
function compactText(value, maxLength = 1200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const max = Math.max(20, Number(maxLength) || 1200);
  if (text.length <= max) return text;

  const slice = text.slice(0, max - 1);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? ')
  );
  if (sentenceEnd >= max * 0.6) {
    return `${slice.slice(0, sentenceEnd + 1).trim()} …`;
  }
  const space = slice.lastIndexOf(' ');
  return `${(space >= max * 0.6 ? slice.slice(0, space) : slice).trim()} …`;
}

// ------------------------------------------------------------
// Caractéristiques (lignes libellé / valeur)
// ------------------------------------------------------------

const MAX_SPECS = 24;
const MAX_SPEC_LABEL = 60;
const MAX_SPEC_VALUE = 200;

// Libellés jamais repris comme caractéristiques : prix, stock, livraison ou
// paiement écrits dans la description peuvent être périmés, la seule source
// fiable étant les champs WooCommerce (prix, stock).
const EXCLUDED_SPEC_LABEL_RE =
  /prix|tarif|promo|remise|solde|r[ée]duction|disponibilit|stock|livraison|d[ée]lai|paiement|facilit|mensualit|garantie|contact|whatsapp|t[ée]l[ée]phone|commande/i;

function cleanSpecLabel(value) {
  return cleanInlineText(value)
    .replace(/\s*:+\s*$/, '')
    .replace(/^[\s•·\-–—✔✅☑️📏📐]+/u, '')
    .trim();
}

function cleanSpecValue(value) {
  return htmlToText(value)
    .replace(/^[:\s]+/, '')
    .trim();
}

function addSpec(specs, label, value) {
  const key = cleanSpecLabel(label);
  const text = cleanSpecValue(value);
  if (!key || !text) return;
  if (key.length > MAX_SPEC_LABEL) return;
  if (EXCLUDED_SPEC_LABEL_RE.test(key)) return;
  if (Object.keys(specs).length >= MAX_SPECS) return;
  if (Object.prototype.hasOwnProperty.call(specs, key)) return;
  specs[key] = text.length > MAX_SPEC_VALUE
    ? compactText(text, MAX_SPEC_VALUE)
    : text;
}

// Contenu (innerHTML) de l'élément <tag> dont la balise ouvrante se termine
// à openEnd, en tenant compte des éléments imbriqués du même nom.
function innerHtmlFrom(html, openEnd, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let match;
  while ((match = re.exec(html))) {
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return html.slice(openEnd, match.index);
    } else if (!/\/>$/.test(match[0])) {
      depth += 1;
    }
  }
  return html.slice(openEnd);
}

// Lignes libellé / valeur d'un HTML : classes « spec-label » / « spec-value »
// (fiches MONDECO), tableaux à deux cellules, listes <dt>/<dd>, et puces
// « <strong>Composition :</strong> … » pour quelques libellés connus.
function extractSpecsFromHtml(html, specs = {}) {
  const source = String(html ?? '');
  if (!source) return specs;

  // Fiches « pack » : plusieurs encadrés titrés (« Caractéristiques de la
  // chambre Bianca », « … du salon Diana »). Les libellés sont alors
  // préfixés par l'élément concerné, pour ne jamais présenter la
  // composition d'un seul élément comme celle de tout le pack.
  const sections = [];
  const titleRe = /<([a-z][a-z0-9]*)\b[^>]*class\s*=\s*["'][^"']*spec-title[^"']*["'][^>]*>/gi;
  let title;
  while ((title = titleRe.exec(source))) {
    const titleEnd = title.index + title[0].length;
    const name = cleanInlineText(innerHtmlFrom(source, titleEnd, title[1]))
      .replace(/^caract[ée]ristiques(\s+techniques)?\s*(de\s+la|de\s+l['’]|du|des|de|d['’])?\s*/i, '')
      .trim();
    if (name) {
      sections.push({
        index: title.index,
        name: name.charAt(0).toUpperCase() + name.slice(1)
      });
    }
  }
  const prefixed = new Set(sections.map(item => item.name.toLowerCase())).size >= 2;
  const sectionPrefix = position => {
    if (!prefixed) return '';
    let current = '';
    for (const section of sections) {
      if (section.index < position) current = section.name;
    }
    return current ? `${current} — ` : '';
  };

  // 1) <span class="mondeco-spec-label">…</span><span class="mondeco-spec-value">…</span>
  const labelRe = /<([a-z][a-z0-9]*)\b[^>]*class\s*=\s*["'][^"']*spec-label[^"']*["'][^>]*>/gi;
  let match;
  while ((match = labelRe.exec(source))) {
    const labelTag = match[1];
    const labelEnd = match.index + match[0].length;
    const labelHtml = innerHtmlFrom(source, labelEnd, labelTag);
    const valueRe = /<([a-z][a-z0-9]*)\b[^>]*class\s*=\s*["'][^"']*spec-value[^"']*["'][^>]*>/gi;
    valueRe.lastIndex = labelEnd + labelHtml.length;
    const valueMatch = valueRe.exec(source);
    if (!valueMatch) continue;
    // La valeur doit suivre le libellé de près (même ligne de tableau).
    if (valueMatch.index - (labelEnd + labelHtml.length) > 400) continue;
    const valueHtml = innerHtmlFrom(
      source,
      valueMatch.index + valueMatch[0].length,
      valueMatch[1]
    );
    const prefix = sectionPrefix(match.index);
    addSpec(specs, prefix ? `${prefix}${cleanSpecLabel(labelHtml)}` : labelHtml, valueHtml);
  }

  // 2) Tableaux : lignes à exactement deux cellules.
  for (const row of source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map(cell => cell[2]);
    if (cells.length === 2) addSpec(specs, cells[0], cells[1]);
  }

  // 3) Listes de définitions.
  for (const pair of source.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    addSpec(specs, pair[1], pair[2]);
  }

  // 4) Puces « <strong>Libellé :</strong> valeur » : seulement pour la
  // composition, les dimensions et la matière (le reste est souvent du
  // texte marketing).
  for (const item of source.matchAll(/<li\b[^>]*>\s*<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>([\s\S]*?)<\/li>/gi)) {
    const label = cleanSpecLabel(item[2]);
    if (/^(composition|dimensions?|mesures?|taille|mati[eè]res?)$/i.test(label)) {
      addSpec(specs, label, item[3]);
    }
  }

  return specs;
}

const COMPOSITION_LABEL_RE = /^composition\b/i;
const DIMENSION_LABEL_RE =
  /dimension|taille|mesure|largeur|longueur|hauteur|profondeur|diam[eè]tre|couchage|encombrement/i;
const DIMENSION_VALUE_RE =
  /\d\s*(?:cm|mm)\b|\d\s*[x×]\s*\d|\b[LPHlph]\s?\d{2,}/;
const NON_DIMENSION_LABEL_RE = /^(mod[eè]le|style|nom du produit|cat[ée]gorie|type|public|utilisation|coloris|couleurs?)$/i;

function isCompositionLabel(label) {
  return COMPOSITION_LABEL_RE.test(String(label ?? ''));
}

// Libellé sans le préfixe d'élément d'un pack (« Salon Diana — Type » → « Type »).
function baseSpecLabel(label) {
  return String(label ?? '').split(' — ').pop().trim();
}

function isDimensionSpec(label, value) {
  const key = String(label ?? '');
  if (isCompositionLabel(key) || NON_DIMENSION_LABEL_RE.test(baseSpecLabel(key))) return false;
  const text = String(value ?? '');
  return (DIMENSION_LABEL_RE.test(key) && /\d/.test(text)) || DIMENSION_VALUE_RE.test(text);
}

// V6.45 — Fiche qui décrit plusieurs ensembles (pack mariage : chambre +
// salon + salle à manger) : libellés préfixés par au moins deux éléments
// (« Chambre Silia — Lit », « Salon Marita — Modèle ») ou au moins deux
// clés « Chambre » / « Salon » / « Salle à manger ».
const SUBSET_KEY_RE = /^(chambre|salon|salle\s+[àa]\s+manger)$/i;

function isMultiSetSpecs(specs) {
  const labels = Object.keys(specs || {});
  const prefixes = new Set(
    labels
      .filter(label => label.includes(' — '))
      .map(label => label.split(' — ')[0].trim().toLowerCase())
  );
  return prefixes.size >= 2 || labels.filter(label => SUBSET_KEY_RE.test(label.trim())).length >= 2;
}

// Composition d'un pack : jamais celle d'un seul ensemble. Construite à
// partir de « Composition du pack — Chambre : … », de la ligne
// « Composition » de chaque ensemble, ou des clés Chambre / Salon / Salle
// à manger quand elles énumèrent les meubles ; sinon vide (le contrôle
// s'appuie alors sur le nom, la description et les caractéristiques).
function packCompositionFromSpecs(specs) {
  const entries = Object.entries(specs || {}).filter(([, value]) => safeTextValue(value));

  const summary = entries
    .filter(([label]) =>
      /^composition\s+(?:compl[eè]te|du\s+pack|globale)\s+—\s+/i.test(label) &&
      !/non\s+inclus|en\s+option/i.test(baseSpecLabel(label))
    )
    .map(([label, value]) => `${baseSpecLabel(label)} : ${value}`);
  if (summary.length >= 2) return summary.join(' ; ');

  const groups = new Map();
  for (const [label, value] of entries) {
    if (!label.includes(' — ')) continue;
    const group = label.split(' — ')[0].trim();
    if (/^composition\s+(?:compl[eè]te|du\s+pack|globale)$/i.test(group)) continue;
    if (!groups.has(group)) groups.set(group, '');
    if (/^composition$/i.test(baseSpecLabel(label))) groups.set(group, value);
  }
  if (groups.size >= 2 && [...groups.values()].every(Boolean)) {
    return [...groups.entries()].map(([group, value]) => `${group} : ${value}`).join(' ; ');
  }

  const subsets = entries.filter(([label]) => SUBSET_KEY_RE.test(label.trim()));
  // « Salma – Lit, dressing, coiffeuse et 2 tables de nuit » : oui ;
  // « Kenza » (nom seul) : non.
  if (subsets.length >= 2 && subsets.every(([, value]) => /\s[–—-]\s|,|\+/.test(value))) {
    return subsets.map(([label, value]) => `${label.trim()} : ${value}`).join(' ; ');
  }
  return '';
}

function safeTextValue(value) {
  return String(value ?? '').trim();
}

// Composition extraite des caractéristiques : seulement un libellé
// exactement « Composition » (ou « Composition du produit »). V6.45 — Avant,
// le premier libellé commençant par « Composition » était pris, d'où
// « Toscana » (« Composition de la chambre Toscana — Modèle ») ou la
// composition du seul salon pour tout un pack mariage.
function compositionFromSpecs(specs, { pack = false } = {}) {
  if (pack || isMultiSetSpecs(specs)) return packCompositionFromSpecs(specs);
  for (const [label, value] of Object.entries(specs || {})) {
    if (/^composition(?:\s+du\s+produit)?$/i.test(String(label).trim()) && value) return value;
  }
  return '';
}

// Fiche « pack » d'après le nom ou la catégorie WooCommerce.
function isWooPackProduct(product) {
  const categories = Array.isArray(product?.categories)
    ? product.categories.map(category => decodeHtmlEntities(category?.name ?? '')).join(' / ')
    : String(product?.category ?? '');
  const name = decodeHtmlEntities(String(product?.name ?? ''));
  return /\bpack\s+mariage\b/i.test(categories) || /^\s*pack\s+(?:mariage|dar|maison)\b/i.test(name);
}

// Dimensions par élément : « Dressing : L260 × P63 × H220 cm ; Tables de
// nuit : 2 unités — L55 × P42 × H48 cm chacune ; … ». Une seule ligne
// « Dimensions » est reprise telle quelle.
function dimensionsFromSpecs(specs, maxLength = 400) {
  const entries = Object.entries(specs || {})
    .filter(([label, value]) => value && isDimensionSpec(label, value));
  if (!entries.length) return '';
  if (entries.length === 1 && /^dimensions?$/i.test(entries[0][0])) {
    return entries[0][1];
  }
  const text = entries
    .map(([label, value]) => `${label} : ${value}`)
    .join(' ; ');
  return text.length > maxLength ? compactText(text, maxLength) : text;
}

// Caractéristiques restantes (matière, style, plateau…) pour le contexte IA :
// sans la composition, les dimensions ni les libellés redondants.
function otherSpecsText(specs, maxLength = 300) {
  const entries = Object.entries(specs || {})
    .filter(([label, value]) =>
      value &&
      !isCompositionLabel(label) &&
      !isDimensionSpec(label, value) &&
      !/^(mod[eè]le|nom du produit|cat[ée]gorie|r[ée]f[ée]rence|sku)$/i.test(baseSpecLabel(label))
    );
  if (!entries.length) return '';
  const text = entries.map(([label, value]) => `${label} : ${value}`).join(' ; ');
  return text.length > maxLength ? compactText(text, maxLength) : text;
}

// Repli : « Composition » / « Dimensions » écrits sur deux lignes de texte
// (libellé puis valeur) ou « Dimensions : L 88 x P 40 x H 186 cm ».
function extractSpecsFromTextLines(text, specs = {}) {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(/^(composition|dimensions?)\s*:\s*(.+)$/i);
    if (inline) {
      addSpec(specs, inline[1], inline[2]);
      continue;
    }
    const label = lines[index].replace(/\s*:+\s*$/, '');
    if (/^(composition|dimensions?)$/i.test(label) && lines[index + 1]) {
      const value = lines[index + 1];
      if (/^dimension/i.test(label) && !DIMENSION_VALUE_RE.test(value)) continue;
      addSpec(specs, label, value);
    }
  }
  return specs;
}

// ------------------------------------------------------------
// Point d'entrée : produit WooCommerce (REST v3) → texte + caractéristiques
// ------------------------------------------------------------

const DEFAULT_DESCRIPTION_MAX = 1200;

function parseWooProductContent(product, options = {}) {
  const descriptionMax = Number(options.descriptionMax) || DEFAULT_DESCRIPTION_MAX;
  const longHtml = expandWooDescriptionHtml(product?.description);
  const shortHtml = expandWooDescriptionHtml(product?.short_description);

  const specs = {};
  extractSpecsFromHtml(longHtml, specs);
  const pack = isWooPackProduct(product);
  if (!compositionFromSpecs(specs, { pack }) || !dimensionsFromSpecs(specs)) {
    const fallback = {};
    extractSpecsFromHtml(shortHtml, fallback);
    extractSpecsFromTextLines(htmlToText(shortHtml, { keepLines: true }), fallback);
    // Le texte de la description longue n'est relu que s'il n'a pas
    // d'encadré « spec-label » (déjà lu ci-dessus, éventuellement par
    // élément de pack).
    if (!/spec-label/i.test(longHtml)) {
      extractSpecsFromTextLines(htmlToText(longHtml, { keepLines: true }), fallback);
    }
    for (const [label, value] of Object.entries(fallback)) {
      const useful =
        (!pack && isCompositionLabel(label) && !compositionFromSpecs(specs)) ||
        (isDimensionSpec(label, value) && !dimensionsFromSpecs(specs));
      if (useful) addSpec(specs, label, value);
    }
  }

  const shortText = htmlToText(shortHtml);
  const longText = htmlToText(longHtml);

  const multiSet = pack || isMultiSetSpecs(specs);
  return {
    description: compactText(shortText || longText, descriptionMax),
    shortText,
    longText,
    specs,
    composition: compositionFromSpecs(specs, { pack }),
    // V6.45 — true : la composition (éventuellement vide) remplace celle
    // enregistrée lors d'une synchronisation précédente.
    multiSet,
    dimensions: dimensionsFromSpecs(specs)
  };
}

module.exports = {
  decodeHtmlEntities,
  cleanInlineText,
  decodeVcRawHtml,
  decodeVcRawHtmlPayload,
  stripVcShortcodes,
  expandWooDescriptionHtml,
  htmlToText,
  compactText,
  extractSpecsFromHtml,
  extractSpecsFromTextLines,
  compositionFromSpecs,
  isMultiSetSpecs,
  isWooPackProduct,
  dimensionsFromSpecs,
  otherSpecsText,
  isDimensionSpec,
  parseWooProductContent
};
