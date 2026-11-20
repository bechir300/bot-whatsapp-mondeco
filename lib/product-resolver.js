// ============================================================
// MONDECO — résolution déterministe du produit de la conversation
// lib/product-resolver.js
//
// V6.45 — Cas réel (novembre 2026) : un client venu de la pub « Chambre à
// coucher Bianca · Chambre complète » a reçu « Chambre à coucher Bianca
// (lit + 2 tables de nuit) 2800 dt ». La recherche catalogue par sac de
// mots (sous-chaînes, sans poids, départage par position dans le fichier)
// ne transmettait même pas la fiche Bianca au modèle, qui a comblé le vide
// avec un autre produit.
//
// Ce module identifie, SANS IA, le produit dont parle le client à partir :
// - du titre de la publicité (productHint/headline, découpé sur « | »,
//   « — », « · ») ;
// - du message actuel et des derniers messages du client ;
// - du produit déjà identifié dans la conversation (state.activeProduct).
// Il renvoie { status: 'resolved' | 'ambiguous' | 'hidden' | 'none',
// product, candidates, source }. V6.46 — 'hidden' : le produit désigné est
// une fiche du site masquée ou « supprimée » dans l'Admin mais toujours
// publiée sur mondeco.tn (ou son ancienne copie manuelle) : transfert à
// l'équipe, jamais un produit voisin à sa place (« Pouf Chambre Luxe
// Bianca 350 DT » pour la chambre complète). Mots entiers uniquement, poids IDF (un nom de
// modèle rare comme « bianca » compte plus que « chambre »), mots de type
// (chambre, lit, pouf, pack…) pour distinguer « Chambre à coucher Bianca »
// de « Lit Bianca + 2 chevets », « Chambre Enfant Bianca Junior » ou
// « Pack Mariage Bianca ».
// ============================================================

'use strict';

// ------------------------------------------------------------
// Normalisation
// ------------------------------------------------------------

// V6.45 — Pliage de l'arabe AVANT la décomposition NFD : sans cela, NFD
// sépare la hamza/madda de sa lettre (« أنيق » devenait « ا نيق »).
const ARABIC_LETTER_FOLD = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
  'ؤ': 'و', 'ئ': 'ي', 'ى': 'ي', 'ة': 'ه'
};
// Harakat, tatweel, marques coraniques.
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

function foldArabic(value) {
  return String(value ?? '')
    .replace(/[أإآٱؤئىة]/g, char => ARABIC_LETTER_FOLD[char] || char)
    .replace(ARABIC_MARKS, '');
}

function toLatinDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 0x06F0));
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const n = parseInt(code, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

// Vocabulaire tunisien / arabe -> mots du catalogue (texte déjà plié).
// Préfixes autorisés : و (et), ب (avec), ل, ف, puis l'article ال.
const AR_PREFIX = '(?:[وبلف])?(?:ال)?';
const AR_BOUNDARY_START = '(?<![\\p{L}\\p{N}])';
const AR_BOUNDARY_END = '(?![\\p{L}\\p{N}])';
function arabicWordPattern(body) {
  return new RegExp(`${AR_BOUNDARY_START}${AR_PREFIX}(?:${body})${AR_BOUNDARY_END}`, 'gu');
}
const ARABIC_SYNONYMS = [
  // « بيت نوم » / « بيت النوم » (chambre à coucher).
  [new RegExp(`${AR_BOUNDARY_START}${AR_PREFIX}(?:بيت|بيوت)\\s+(?:ال)?نوم${AR_BOUNDARY_END}`, 'gu'), ' chambre coucher '],
  [arabicWordPattern('شومبر|شومبره|شمبر|شمبره|شمبرا|شومبرا'), ' chambre '],
  [arabicWordPattern('صاله|صالون|صالونات'), ' salon '],
  [arabicWordPattern('طاوله|طاولات'), ' table '],
  [arabicWordPattern('كومبلي|كامله|كامل'), ' complete '],
  [arabicWordPattern('فرش|سرير'), ' lit '],
  [arabicWordPattern('كومودينو|كوموضينو|كومدينو'), ' chevet '],
  [arabicWordPattern('دريسينغ|دريسنغ|دريسين|دريسينج'), ' dressing '],
  [arabicWordPattern('خزانه|دولاب|اارموار|ارموار'), ' armoire '],
  [arabicWordPattern('كوافوز|كوافيز|كوافوزه|كوافيزه'), ' coiffeuse '],
  [arabicWordPattern('بوف'), ' pouf '],
  [arabicWordPattern('فوتاي|فوتوي|فوطاي'), ' fauteuil '],
  [arabicWordPattern('بيرو'), ' bureau '],
  [arabicWordPattern('صغار|اطفال|اولاد'), ' enfant '],
  [arabicWordPattern('كنابي|كنبه|كنابه'), ' canape '],
  [arabicWordPattern('ماتلا|ماطلا|ماتلاس'), ' matelas '],
  [arabicWordPattern('كراسي|كرسي|شيزات'), ' chaise ']
];

// Synonymes français / arabizi (texte déjà en minuscules sans accents).
const LATIN_SYNONYMS = [
  [/\btables?\s+(?:de\s+)?(?:nuit|chevet)\b/g, ' chevet '],
  [/\bchevets?\b/g, ' chevet '],
  [/\b(?:adultes?|parentale?s?|parents)\b/g, ' coucher '],
  [/\b(?:juniors?|kids?|enfants?)\b/g, ' enfant '],
  [/\b(?:completes?|complets?|kaml[ae]?|kamla)\b/g, ' complete '],
  [/\b(?:chombr[ae]|chambr[ae]|chamb)\b/g, ' chambre '],
  [/\bbit\s+n[o]u?m\b/g, ' chambre coucher '],
  [/\bcanapes?\b/g, ' canape ']
];

function normalizeText(value) {
  let text = foldArabic(decodeEntities(toLatinDigits(value)));
  for (const [pattern, replacement] of ARABIC_SYNONYMS) {
    text = text.replace(pattern, replacement);
  }
  text = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  for (const [pattern, replacement] of LATIN_SYNONYMS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------
// Vocabulaire
// ------------------------------------------------------------

const STOP_WORDS = new Set((
  // Français courant
  'a au aux avec c ca ce cet cette ces d de des du en et est etes il ils elle elles j je l la le les leur ' +
  'm ma me mes moi mon n ne ni nos notre nous on ou par pas plus pour qu que quel quelle quels quelles ' +
  'qui quoi s sa sans se ses si son sur t ta te tes toi ton tu un une vos votre vous y ' +
  'est sont suis ai as avez avons ont etre avoir fait faire peut peux pouvez puis veux voudrais voulais ' +
  'aimerais souhaite souhaiterais cherche besoin interesse interessee interesses svp stp sil plait merci ' +
  'bonjour bonsoir salut salam slm cc hello hi hey ok okay oui non bien tres aussi encore alors donc mais ' +
  'deja combien comment quand ou pourquoi coute coutent cout prix tarif tarifs montant budget promo promotion ' +
  'offre offres remise solde soldes dispo disponible disponibles disponibilite stock dimension dimensions ' +
  'mesure mesures taille tailles info infos information informations renseignement renseignements detail ' +
  'details modele modeles model models produit produits article articles photo photos image images video ' +
  'livraison livrer livrez gratuite gratuit paiement credit facilite showroom showrooms magasin adresse ' +
  'mondeco tn com www https http tunisie tunis tunisien tunisienne dt tnd dinar dinars cm mm x ' +
  'nouveau nouvelle neuf neuve meilleur meilleure chez the this that more about get can please tell me ' +
  'pub publicite annonce reel sponsorise disponible commande commander acheter achat prendre veut ' +
  'chose choses ici voici voila celui celle ceux celles lequel laquelle autre autres meme tout tous toute toutes ' +
  'beaucoup possible existe existent couleur couleurs sujet obtenir temps delai reflechir envoyer envoyez ' +
  'sfax sousse soukra ezzahra nabeul ariana bizerte monastir mahdia gabes kairouan ben arous manouba ' +
  'whatsapp messenger instagram facebook inbox message messages commentaire commentaires comment on of to ' +
  'for is it an and in what price available ' +
  'premier premiere deuxieme second seconde troisieme dernier derniere maries mariee mariees marier ' +
  // Arabizi (tounsi en lettres latines)
  '9adech b9adech 9adeh b9adeh bkadech kadech chhal soum s3ar ya3tik aychek nheb n7eb nhebou 3andkom famma ' +
  'chnowa chnoua chniya ' +
  // Arabe / tounsi (texte plié : ة->ه, ى->ي, أ->ا)
  'في من علي الي عن مع او ما هل و يا هذا هذه هاذا هاذي هذي هاد اللي الي كان كي باش نحب نحبو نحبك ' +
  'عندكم عندك فما فماش برشا شويه يعطيك عيشك السلام عليكم سلام مرحبا اهلا اهلين صباح مساء الخير ' +
  'من فضلك متاع متاعكم متاعو بقداش بقداه قداش قداه السوم سوم الثمن ثمن السعر سعر الاسعار اسعار ' +
  'شنوه شنيه شنو شني كيفاش وقتاش وين فين العنوان عنوان المعرض معرض التوصيل توصيل الديليفري ' +
  'المعلومات معلومات مزيد المزيد حول يمكنني الحصول اريد نعرف نشوف تفاصيل التفاصيل ابعثلي ابعثلنا ' +
  'موجود موجوده متوفر متوفره دينار د ت'
).split(/\s+/).filter(Boolean));

// Mots de type de meuble. Poids fort : distinguent des produits différents
// (un pouf n'est pas une chambre). Poids faible : simple précision.
const STRONG_TYPES = new Set((
  'chambre enfant pack mariage bureau pouf fauteuil coiffeuse lit salon canape table chevet dressing ' +
  'armoire chaise matelas buffet miroir console commode etagere bibliotheque banc tabouret sommier ' +
  'vaisselier bahut cuisine tapis lampe banquette bebe ado fille garcon'
).split(' '));
const WEAK_TYPES = new Set((
  'coucher coffre niche coiffure manger basse sejour salle angle tv meuble rangement tete panoramique ' +
  'relax place entree jardin porte chaussure tiroir etageres element coin'
).split(' '));

// Couleurs, matières, adjectifs marketing : ne désignent jamais un modèle.
const DESCRIPTOR_WORDS = new Set((
  'blanc blanche noir noire gris grise beige bleu bleue rose jaune vert verte rouge marron taupe creme ' +
  'dore doree argent argente naturel naturelle bois metal metallique velours tissu cuir simili marbre verre ' +
  'chene noyer laque mat brillant luxe luxury moderne design contemporain classique elegant elegante premium ' +
  'rond ronde carre carree rectangulaire ovale murale mural led extensible pliable pliante convertible double ' +
  'simple grand grande petit petite xl confort orthopedique capitonne capitonnee scandinave industriel vintage ' +
  'complete set ensemble serie collection edition royal prestige haut bas sweet decoration mobilier mobiliers ' +
  'soutien ferme sante organique medical iso places pieces piece portes ' +
  // Mots courants présents dans des noms de produits, jamais des noms de
  // modèles (« au bout de combien… », « c'est cher », « garantie 7 ans »).
  'dos bout cher garantie ans top new pillow ressort ensache equilibre mecanisme forme modulable modulaire ' +
  'confortable eco accoudoir meridienne basculant basculante manteau fume bouclette coulissant coulissante ' +
  'plume glamour pied velour durable transparente hexagonal pouffe lampadaire roulant roulante roulette ' +
  'visiteur ergo reglable hauteur coussin decoratif deco starter vip bronze cozy golden esprit maison nacre ' +
  'square vitrine destockage bubble extension douceur relaxant bande etoile amour clic clac arc ciel ' +
  'authentique anti tache integre pratique evidence bicolore doux sain espace securite effet travertin ' +
  'pivotant tendresse studio crystal mdf capacite format glow softy lune laquee signature espoir noblesse ' +
  'tunisia mobilia indu soleil dame mirale'
).split(' '));

// « salon » et « canapé » désignent souvent le même meuble en Tunisie.
const TYPE_EQUIVALENTS = {
  salon: ['canape'],
  canape: ['salon']
};

// V6.45 — Un équivalent ne compte que si le produit ne porte pas déjà ce
// type lui-même : pour « Salon Lara avec canapé » (salon + canapé), le seul
// mot « salon » du client ne satisfait pas aussi « canapé » ; sinon ce nom
// long passe pour un nom complet et l'emporte sur « Salon modulaire Lara ».
function typeSatisfied(token, has, ownTypes = null) {
  if (has(token)) return true;
  return (TYPE_EQUIVALENTS[token] || []).some(other =>
    has(other) && !(Array.isArray(ownTypes) && ownTypes.includes(other))
  );
}

// V6.46 — Mots invariables terminés par « s » : « matelas » devenait
// « matela » et n'était plus reconnu comme type de meuble (STRONG_TYPES),
// « tapis » → « tapi », « bois » / « gris » → « boi » / « gri » (pris pour
// des noms de modèle au lieu de matière / couleur).
const INVARIABLE_S_WORDS = new Set([
  'matelas', 'tapis', 'bois', 'gris', 'velours', 'repos', 'bras', 'chassis', 'relais', 'lilas'
]);

function singular(token) {
  if (INVARIABLE_S_WORDS.has(token)) return token;
  if (token.length > 4 && token.endsWith('eaux')) return token.slice(0, -1);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function isStop(token) {
  return STOP_WORDS.has(token);
}

function typeWeight(token) {
  if (STRONG_TYPES.has(token)) return 'strong';
  if (WEAK_TYPES.has(token)) return 'weak';
  return '';
}

function containsArabic(value) {
  return /[؀-ۿ]/.test(String(value ?? ''));
}

// Mots utiles d'un texte : sans mots vides ni nombres, au singulier.
function tokenize(value) {
  const out = [];
  for (const raw of normalizeText(value).split(' ')) {
    if (!raw || isStop(raw)) continue;
    if (/\d/.test(raw)) continue;
    const token = singular(raw);
    if (!token || isStop(token)) continue;
    if (token.length < 2 && !containsArabic(token)) continue;
    out.push(token);
  }
  return out;
}

// Translittération arabe -> latin (recherche tolérante des noms de modèles
// écrits en arabe : « بيانكا » -> « bianka » ≈ « bianca »).
const AR_TO_LATIN = {
  'ا': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh',
  'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'ch', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a',
  'غ': 'gh', 'ف': 'f', 'ق': 'k', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'a', 'و': 'o',
  'ي': 'i', 'ء': '', 'پ': 'p', 'ڤ': 'v', 'گ': 'g', 'چ': 'ch'
};
function transliterateArabic(token) {
  return String(token ?? '').split('').map(char => AR_TO_LATIN[char] ?? char).join('').replace(/[^a-z]/g, '');
}
// Forme « relâchée » commune aux deux écritures (voyelles et consonnes
// proches confondues), comparée avec une distance d'édition ≤ 1.
function loosen(word) {
  return String(word ?? '')
    .replace(/ph/g, 'f')
    .replace(/ou/g, 'u')
    .replace(/[ckq]/g, 'k')
    .replace(/p/g, 'b')
    .replace(/v/g, 'f')
    .replace(/[eiy]/g, 'i')
    .replace(/[ow]/g, 'u')
    .replace(/(.)\1+/g, '$1')
    .replace(/^a(?=[ui])/, '');
}

function editDistance(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return row[right.length];
}

// ------------------------------------------------------------
// Index des produits actifs
// ------------------------------------------------------------

function safeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function isWooProduct(product) {
  return safeText(product?.syncSource) === 'woocommerce' || Boolean(safeText(product?.woocommerceId));
}

// V6.46 — Fiche du site masquée / supprimée dans l'Admin mais toujours en
// vente sur mondeco.tn (même règle que lib/woo-catalog.js).
function isHiddenPublishedSiteProduct(product) {
  return Boolean(product) &&
    product.active === false &&
    product.hiddenByAdmin === true &&
    isWooProduct(product) &&
    safeText(product.woocommerceStatus) === 'publish' &&
    !product.wooMissingAt;
}

function productKey(product) {
  return safeText(product?.id) || safeText(product?.woocommerceId) || safeText(product?.name);
}

// Nom d'affichage : le suffixe SEO après « – » est retiré s'il ne contient
// pas le nom du modèle (« Chambre Enfant Bianca Junior – Moderne Bois… »).
function displayProductName(product, modelTokens = null) {
  const name = decodeEntities(safeText(product?.name)).replace(/\s+/g, ' ').trim();
  const parts = name.split(/\s+[–—]\s+/);
  if (parts.length < 2) return name;
  const head = parts[0];
  const headTokens = new Set(tokenize(head));
  const models = Array.isArray(modelTokens) ? modelTokens : tokenize(name).filter(t => !typeWeight(t) && !DESCRIPTOR_WORDS.has(t));
  if (headTokens.size >= 2 && models.some(token => headTokens.has(token))) return head;
  return name;
}

// V6.45 — Nom court : avant le suffixe SEO ou publicitaire (« – … »,
// « | Déstockage »).
function shortProductName(name) {
  return decodeEntities(safeText(name)).split(/\s+[–—]\s+|\s*\|\s*/)[0];
}

// Mots jamais retenus comme nom de modèle de repli (couleurs, matières,
// tailles, mots marketing génériques) : seuls les noms propres utilisés
// comme modèles (royal, golden, lune, glow…) peuvent servir.
const FALLBACK_MODEL_EXCLUDED = new Set((
  'blanc blanche noir noire gris grise beige bleu bleue rose jaune vert verte rouge marron taupe creme ' +
  'dore doree argent argente naturel naturelle bois metal metallique velours tissu cuir simili marbre verre ' +
  'chene noyer laque laquee mat brillant moderne design contemporain classique elegant elegante ' +
  'rond ronde carre carree rectangulaire ovale murale mural led extensible pliable pliante convertible double ' +
  'simple grand grande petit petite xl confort orthopedique capitonne capitonnee scandinave industriel vintage ' +
  'complete set ensemble serie collection edition haut bas decoration mobilier mobiliers places pieces piece portes ' +
  'dos bout cher garantie ans top new pied velour durable transparente hexagonal reglable hauteur coussin ' +
  'decoratif deco maison vitrine destockage extension bande anti tache integre pratique bicolore doux sain ' +
  'espace securite effet pivotant mdf capacite format modulable modulaire confortable accoudoir meridienne ' +
  'basculant basculante coulissant coulissante roulant roulante roulette ressort ensache mecanisme forme'
).split(' '));

const indexCache = new WeakMap();

function buildProductIndex(products) {
  if (products && typeof products === 'object' && products.__productIndex === true) return products;
  if (Array.isArray(products) && indexCache.has(products)) return indexCache.get(products);

  const named = (Array.isArray(products) ? products : [])
    .filter(product => product && typeof product === 'object' && safeText(product.name));
  const list = named.filter(product => product.active !== false);
  // V6.46 — Fiches du site masquées mais publiées : gardées dans l'index,
  // bloquées (résultat « hidden »), avec leurs doublons certains. Avant,
  // retirées de l'index, elles laissaient le produit voisin suivant
  // (« Pouf Chambre Luxe Bianca ») devenir « la chambre Bianca ».
  const hiddenSite = named.filter(isHiddenPublishedSiteProduct);
  const hiddenWooIds = new Set(hiddenSite.map(product => safeText(product.woocommerceId)).filter(Boolean));
  const hiddenNameKeys = new Set(hiddenSite.map(product => tokenize(product.name).sort().join(' ')));
  const blocked = new Set(hiddenSite);

  // V6.45 — Le produit du site (WooCommerce) prime sur un doublon local :
  // un produit marqué duplicateOfWooId (paquet catalogue) ou portant
  // exactement le même nom qu'un produit WooCommerce actif est ignoré.
  const wooNameKeys = new Set(list.filter(isWooProduct).map(product => tokenize(product.name).sort().join(' ')));
  // V6.45 — Un doublon seulement « possible » (élément d'un ensemble, ex.
  // « Lit Bianca + 2 chevets » face à « Chambre à Coucher Bianca ») reste
  // dans l'index, comme dans le contexte IA (Admin.productToContext le
  // garde avec son prix) : sinon la pub « Lit BIANCA + 2 Chevets » ne
  // trouvait plus que des ensembles qui contredisent « lit » et « chevet ».
  const kept = list.filter(product => {
    if (isWooProduct(product)) return true;
    const duplicateOf = safeText(product.duplicateOfWooId);
    const nameKey = tokenize(product.name).sort().join(' ');
    // V6.46 — Doublon certain écarté même si la fiche du site est masquée
    // dans l'Admin (comme le flux Meta, catalog-feed.js) : sinon l'ancienne
    // copie manuelle et son prix périmé redevenaient « le » produit. Fiche
    // du site masquée mais publiée : le doublon reste, bloqué comme elle.
    if (duplicateOf && safeText(product.duplicateConfidence) !== 'possible') {
      if (!hiddenWooIds.has(duplicateOf)) return false;
      blocked.add(product);
      return true;
    }
    if (wooNameKeys.has(nameKey)) return false;
    if (hiddenNameKeys.has(nameKey)) blocked.add(product);
    return true;
  });
  kept.push(...hiddenSite);

  const items = kept.map((product, position) => {
    const tokens = [...new Set(tokenize(product.name))];
    return { product, position, tokens, key: productKey(product), woo: isWooProduct(product), blocked: blocked.has(product) };
  });

  const df = new Map();
  for (const item of items) {
    for (const token of item.tokens) df.set(token, (df.get(token) || 0) + 1);
  }
  const total = Math.max(1, items.length);
  const modelDfMax = Math.max(12, Math.ceil(total * 0.03));

  const byKey = new Map();
  const vocabulary = new Set();
  for (const item of items) {
    item.types = item.tokens.filter(token => typeWeight(token));
    item.models = item.tokens.filter(token =>
      !typeWeight(token) &&
      !DESCRIPTOR_WORDS.has(token) &&
      token.length >= 3 &&
      (df.get(token) || 0) <= modelDfMax
    );
    if (!item.models.length) {
      // V6.45 — Nom sans mot de modèle reconnu (« Pack Mariage Golden »,
      // « Salon Royal | Déstockage », « Table LUNE ») : de vrais noms de
      // modèles MONDECO figurent dans DESCRIPTOR_WORDS. Les mots rares du
      // nom court (avant « – » / « | ») servent alors de nom de modèle ;
      // sinon le produit ne pouvait jamais être identifié.
      const fallback = words => item.tokens.filter(token =>
        words.has(token) &&
        !typeWeight(token) &&
        token.length >= 3 &&
        !FALLBACK_MODEL_EXCLUDED.has(token) &&
        (df.get(token) || 0) <= modelDfMax
      );
      item.models = fallback(new Set(tokenize(shortProductName(item.product.name))));
      // « Etagère Métallique – INDUS » : un seul mot après le tiret.
      const segments = decodeEntities(safeText(item.product.name)).split(/\s+[–—]\s+|\s*\|\s*/).slice(1);
      for (const segment of segments) {
        if (item.models.length) break;
        const words = tokenize(segment);
        if (words.length === 1) item.models = fallback(new Set(words));
      }
    }
    item.descriptors = item.tokens.filter(token => !item.types.includes(token) && !item.models.includes(token));
    item.primaryType = item.types.find(token => STRONG_TYPES.has(token)) || item.types[0] || '';
    item.displayName = displayProductName(item.product, item.models);
    for (const token of item.tokens) vocabulary.add(token);
    for (const key of [safeText(item.product.id), safeText(item.product.woocommerceId)].filter(Boolean)) {
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }

  const index = {
    __productIndex: true,
    items,
    df,
    total,
    vocabulary,
    byKey,
    idf(token) {
      return Math.log(1 + total / Math.max(1, df.get(token) || 1));
    }
  };
  if (Array.isArray(products)) indexCache.set(products, index);
  return index;
}

function findIndexedProduct(index, idOrProduct) {
  if (!idOrProduct) return null;
  const key = typeof idOrProduct === 'object'
    ? safeText(idOrProduct.id) || safeText(idOrProduct.woocommerceId)
    : safeText(idOrProduct);
  return key ? index.byKey.get(key) || null : null;
}

// ------------------------------------------------------------
// Correspondance texte -> produits
// ------------------------------------------------------------

// Analyse mise en cache par index (le titre et le texte d'une même pub sont
// analysés plusieurs fois par message).
function analyzeText(value, index) {
  const key = String(value ?? '');
  if (!index.analysisCache) index.analysisCache = new Map();
  if (index.analysisCache.has(key)) return index.analysisCache.get(key);
  const analysis = analyzeTextUncached(key, index);
  if (index.analysisCache.size > 500) index.analysisCache.clear();
  index.analysisCache.set(key, analysis);
  return analysis;
}

function analyzeTextUncached(value, index) {
  const tokens = new Set(tokenize(value));
  const latinFuzzy = new Map();
  // Tolérance : mots arabes translittérés, et noms latins de 6+ lettres mal
  // orthographiés, uniquement vers les noms de modèles, à la plus petite
  // distance trouvée (« ديانا » trouve Diana, jamais Dina si Diana existe).
  for (const token of tokens) {
    const arabic = containsArabic(token);
    if (!arabic && (token.length < 6 || index.vocabulary.has(token) || typeWeight(token) || DESCRIPTOR_WORDS.has(token))) continue;
    const latin = arabic ? transliterateArabic(token) : token;
    if (latin.length < 3) continue;
    const loose = loosen(latin);
    let best = Infinity;
    const matches = [];
    for (const word of index.vocabulary) {
      if (typeWeight(word) || DESCRIPTOR_WORDS.has(word) || word.length < 3) continue;
      if (Math.abs(word.length - latin.length) > 2) continue;
      const distance = Math.min(editDistance(latin, word), editDistance(loose, loosen(word)));
      const allowed = word.length >= 5 ? 1 : 0;
      if (distance > allowed) continue;
      if (distance < best) {
        best = distance;
        matches.length = 0;
      }
      if (distance === best) matches.push(word);
    }
    for (const word of matches) latinFuzzy.set(word, token);
  }
  return {
    tokens,
    has(token) {
      return tokens.has(token) || latinFuzzy.has(token);
    },
    types: [...tokens].filter(token => typeWeight(token)),
    modelLike: [...tokens].filter(token => !typeWeight(token) && !DESCRIPTOR_WORDS.has(token))
  };
}

function mergeAnalyses(...analyses) {
  const parts = analyses.filter(Boolean);
  return {
    tokens: new Set(parts.flatMap(part => [...part.tokens])),
    has(token) {
      return parts.some(part => part.has(token));
    },
    types: [...new Set(parts.flatMap(part => part.types))],
    modelLike: [...new Set(parts.flatMap(part => part.modelLike))]
  };
}

function scoreItem(item, text, index) {
  const matchedModels = item.models.filter(token => text.has(token));
  if (!matchedModels.length) return null;
  const has = token => text.has(token);
  const matchedTypes = item.types.filter(token => typeSatisfied(token, has, item.types));
  const matchedDescriptors = item.descriptors.filter(token => text.has(token));
  const productHas = token => item.types.includes(token);
  const extraStrong = text.types.filter(token => STRONG_TYPES.has(token) && !typeSatisfied(token, productHas));
  const extraWeak = text.types.filter(token => WEAK_TYPES.has(token) && !productHas(token));

  let penalty = 0;
  for (const token of item.types) {
    if (typeSatisfied(token, has, item.types)) continue;
    if (token === 'coucher' && text.has('chambre')) penalty += 0.5;
    else penalty += STRONG_TYPES.has(token) ? 2 : 0.5;
  }
  penalty += item.models.filter(token => !text.has(token)).length;
  penalty += Math.min(1.5, 0.5 * item.descriptors.filter(token => !text.has(token)).length);
  penalty += extraWeak.length;

  const score =
    matchedModels.reduce((sum, token) => sum + 2 + index.idf(token), 0) +
    1.5 * matchedTypes.length +
    0.5 * matchedDescriptors.length -
    penalty;

  const full =
    item.models.every(token => text.has(token)) &&
    item.types.every(token => typeSatisfied(token, has, item.types)) &&
    extraStrong.length === 0;

  return { item, score, full, matchedModels, matchedTypes, extraStrong, extraWeak };
}

const RESOLVE_MARGIN = 1.5;
const MAX_CANDIDATES = 3;

function productPriceValue(product) {
  const promo = Number(String(product?.promoPrice ?? '').replace(/[^\d.]/g, ''));
  const price = Number(String(product?.price ?? product?.priceFrom ?? '').replace(/[^\d.]/g, ''));
  return (Number.isFinite(promo) && promo > 0 ? promo : 0) || (Number.isFinite(price) ? price : 0);
}

function compareScored(a, b) {
  return (
    b.score - a.score ||
    Number(b.item.woo) - Number(a.item.woo) ||
    productPriceValue(b.item.product) - productPriceValue(a.item.product) ||
    a.item.position - b.item.position
  );
}

// Liste des candidats « principaux » à proposer au client : ceux qui ne
// contredisent pas son texte et citent le plus de mots du modèle, puis les
// ensembles (prix le plus élevé) avant les accessoires.
function mainCandidates(scored) {
  if (!scored.length) return [];
  const consistent = scored.filter(entry => entry.extraStrong.length === 0);
  const pool = consistent.length ? consistent : scored;
  const bestModels = Math.max(...pool.map(entry => entry.matchedModels.length));
  const bestTypes = Math.max(...pool.filter(entry => entry.matchedModels.length === bestModels).map(entry => entry.matchedTypes.length));
  return pool
    .filter(entry => entry.matchedModels.length === bestModels && entry.matchedTypes.length === bestTypes)
    .sort((a, b) =>
      Number(b.item.woo) - Number(a.item.woo) ||
      productPriceValue(b.item.product) - productPriceValue(a.item.product) ||
      b.score - a.score ||
      a.item.position - b.item.position
    )
    .slice(0, MAX_CANDIDATES)
    .map(entry => entry.item);
}

// V6.45 — Un produit local (créé à la main, absent du site) ne l'emporte
// pas sur la fiche du site qui porte le même modèle et dont tous les types
// principaux sont cités : « Chambre Bianca » (fiche manuelle, 2800 dt)
// cède la place à « Chambre à Coucher Bianca » (site, 6590 dt). Un produit
// local d'un autre type (« Lit Bianca + 2 chevets » pour « lit bianca »)
// reste choisi.
function preferSiteProduct(entry, consistent, text) {
  if (!entry || entry.item.woo) return entry.item;
  const models = entry.matchedModels;
  const siteEntries = consistent.filter(other =>
    other !== entry &&
    other.item.woo &&
    models.every(token => other.item.models.includes(token)) &&
    other.item.types.every(token => !STRONG_TYPES.has(token) || typeSatisfied(token, value => text.has(value), other.item.types))
  );
  return siteEntries.length === 1 ? siteEntries[0].item : entry.item;
}

// Résultat brut pour un texte donné.
function matchText(index, text, { restrictTo = null } = {}) {
  const allowed = restrictTo ? new Set(restrictTo.map(item => item.key)) : null;
  const scored = [];
  for (const item of index.items) {
    if (allowed && !allowed.has(item.key)) continue;
    const entry = scoreItem(item, text, index);
    if (entry) scored.push(entry);
  }
  if (!scored.length) return { status: 'none', candidates: [], all: [] };
  scored.sort(compareScored);

  const consistent = scored.filter(entry => entry.extraStrong.length === 0);
  const all = scored.map(entry => entry.item);

  // 1. Nom complet cité (tous les mots du modèle et du type) : le plus long
  //    l'emporte ; deux noms complets identiques restent ambigus.
  const fulls = consistent.filter(entry => entry.full);
  if (fulls.length) {
    fulls.sort((a, b) => (b.item.models.length + b.item.types.length) - (a.item.models.length + a.item.types.length) || compareScored(a, b));
    const [first, second] = fulls;
    const size = entry => entry.item.models.length + entry.item.types.length;
    if (!second || size(first) > size(second)) {
      // V6.45 — « salon lara » : « Salon modulaire Lara » est le seul nom
      // complet, mais le client n'a pas dit « modulaire » et d'autres
      // salons Lara existent (avec canapé, avec pouf, de coin…). Si le
      // nom retenu porte un mot non cité et qu'un autre produit du même
      // modèle et du même type principal correspond, on demande lequel.
      // Même règle si un autre produit ne s'en distingue que par des mots
      // descriptifs (« Salon Royal » / « Déstockage meuble Salon Royal »).
      const has = token => text.has(token);
      const uncited = first.item.descriptors.filter(token => !text.has(token));
      const onlyDescriptorsMissing = entry =>
        entry.item.models.every(token => text.has(token)) &&
        entry.item.types.every(token => typeSatisfied(token, has, entry.item.types) || !STRONG_TYPES.has(token));
      // Un voisin doit porter tous les mots cités que porte le nom retenu
      // (« lit … avec coffre » exclut le lit sans coffre).
      const viaEquivalent = (item, token) =>
        (TYPE_EQUIVALENTS[token] || []).some(other => item.types.includes(other));
      const literal = [...text.tokens].filter(token => first.item.tokens.includes(token));
      const equivalent = [...text.tokens].filter(token => !first.item.tokens.includes(token) && viaEquivalent(first.item, token));
      const carries = item =>
        literal.every(token => item.tokens.includes(token)) &&
        equivalent.every(token => item.tokens.includes(token) || viaEquivalent(item, token));
      const siblings = first.item.woo
        ? consistent.filter(entry =>
          entry !== first &&
          entry.item.woo &&
          first.matchedModels.every(token => entry.matchedModels.includes(token)) &&
          entry.item.primaryType &&
          typeSatisfied(entry.item.primaryType, has, entry.item.types) &&
          carries(entry.item) &&
          (uncited.length > 0 || onlyDescriptorsMissing(entry))
        )
        : [];
      if (!siblings.length) {
        const item = preferSiteProduct(first, consistent, text);
        return { status: 'resolved', item, candidates: [item], all, via: item === first.item ? 'full-name' : 'site-preferred' };
      }
      return {
        status: 'ambiguous',
        // Le type cité tel quel (« canapé ») passe avant son équivalent.
        candidates: [first, ...siblings]
          .sort((a, b) => Number(text.has(b.item.primaryType)) - Number(text.has(a.item.primaryType)))
          .slice(0, MAX_CANDIDATES)
          .map(entry => entry.item),
        all,
        via: 'siblings'
      };
    }
    return {
      status: 'ambiguous',
      candidates: fulls.filter(entry => size(entry) === size(first)).slice(0, MAX_CANDIDATES).map(entry => entry.item),
      all
    };
  }

  // 2. Meilleur score sans contradiction, avec au moins un mot de type
  //    commun et une avance nette sur le suivant.
  if (consistent.length) {
    const [top, second] = consistent;
    if (top.matchedTypes.length > 0 && (!second || top.score - second.score >= RESOLVE_MARGIN)) {
      const item = preferSiteProduct(top, consistent, text);
      return { status: 'resolved', item, candidates: [item], all, via: item === top.item ? 'score' : 'site-preferred' };
    }
    // Nom de modèle porté par un seul produit du catalogue (« twister »).
    if (scored.length === 1) {
      return { status: 'resolved', item: top.item, candidates: [top.item], all, via: 'unique-model' };
    }
  }

  return { status: 'ambiguous', candidates: mainCandidates(scored), all };
}

// ------------------------------------------------------------
// Publicité
// ------------------------------------------------------------

// V6.45 — « Table Opale | Image 01 | WhatsApp », « Salon Infinity — le
// confort… », « Chambre à coucher Bianca · Chambre complète » : seul le
// premier segment désigne le produit.
function cleanAdProductHint(value) {
  return safeText(value)
    .split('|')[0]
    .split(/\s+[·•]\s+|\s[—–-]\s/)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

// ------------------------------------------------------------
// Messages courts
// ------------------------------------------------------------

// V6.45 — « le 2ème », « la 2 », « 2e », « التانية » : articles retirés,
// chiffres suivis de « er / ère / e / ème », formes tunisiennes.
const ORDINALS = [
  [/^(?:1|1er|1ere|1e|1em|1eme|un|une|premier|premiere|الاول|الاولي|اول|اولي|لولي|لول|اللول|اللولي)$/, 0],
  [/^(?:2|2e|2em|2eme|2nd|2nde|deux|deuxieme|second|seconde|الثاني|الثانيه|ثاني|ثانيه|لثانيه|التاني|التانيه|تاني|تانيه|لتانيه)$/, 1],
  [/^(?:3|3e|3em|3eme|trois|troisieme|الثالث|الثالثه|ثالث|ثالثه|لثالثه|التالت|التالته|تالت|تالته|لتالته)$/, 2]
];

function ordinalChoice(message) {
  const text = normalizeText(message)
    .replace(/\b(?:c est|cest|svp|stp|merci|plutot|je veux|je prends|choisis|choix|numero|n|no)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:le|la|l|les)\s+/, '');
  for (const [pattern, value] of ORDINALS) {
    if (pattern.test(text)) return value;
  }
  return -1;
}

// Composants usuels d'un ensemble : « la coiffeuse ? » posé sur une chambre
// complète parle peut-être de l'élément de la chambre, pas d'un autre produit.
const SET_COMPONENTS = {
  chambre: ['lit', 'chevet', 'dressing', 'armoire', 'coiffeuse', 'coiffure', 'pouf', 'commode', 'miroir', 'tete', 'matelas', 'sommier', 'bureau', 'chaise', 'etagere', 'niche', 'fauteuil'],
  pack: [...STRONG_TYPES, ...WEAK_TYPES],
  salon: ['canape', 'fauteuil', 'pouf', 'table', 'basse', 'meuble', 'tv', 'angle', 'banquette', 'console'],
  manger: ['table', 'chaise', 'buffet', 'vaisselier', 'console', 'miroir'],
  salle: ['table', 'chaise', 'buffet', 'vaisselier', 'console', 'miroir']
};

function componentTypesOf(item) {
  const set = new Set();
  for (const type of item.types) {
    for (const component of SET_COMPONENTS[type] || []) set.add(component);
  }
  for (const token of tokenize(item.product?.composition)) {
    if (typeWeight(token)) set.add(token);
  }
  return set;
}

// ------------------------------------------------------------
// Résolution complète
// ------------------------------------------------------------

function result(status, { item = null, candidates = [], source = '', via = '' } = {}) {
  // V6.46 — Fiche masquée (ou son doublon) désignée : « hidden », sans
  // produit (aucune fiche, aucun prix, aucune carte) ; parmi plusieurs
  // produits possibles, les fiches masquées sont retirées de la question
  // de choix, et s'il n'en reste qu'un, c'est aussi « hidden » (jamais le
  // voisin à la place de la fiche masquée).
  if (status === 'resolved' && item?.blocked) return hiddenResult(item, source, via);
  if (status === 'ambiguous' && (candidates || []).some(candidate => candidate?.blocked)) {
    const visible = candidates.filter(candidate => !candidate.blocked);
    if (visible.length <= 1) return hiddenResult(candidates.find(candidate => candidate.blocked), source, via);
    candidates = visible;
  }
  return {
    status,
    product: item ? item.product : null,
    productKey: item ? item.key : '',
    displayName: item ? item.displayName : '',
    candidates: (candidates || []).map(candidate => candidate.product),
    candidateKeys: (candidates || []).map(candidate => candidate.key),
    candidateNames: (candidates || []).map(candidate => candidate.displayName),
    source,
    via
  };
}

function hiddenResult(item, source, via) {
  return {
    status: 'hidden',
    product: null,
    productKey: '',
    hiddenProductKey: item ? item.key : '',
    displayName: item ? item.displayName : '',
    candidates: [],
    candidateKeys: [],
    candidateNames: [],
    source,
    via
  };
}

// input : { message, adProductHint, adHeadline, adBody, adHeadlineGeneric,
//           recentCustomerTexts[], lastAssistantText, activeProductId,
//           pendingCandidateIds[] }
function resolveProduct(input = {}, productsOrIndex = []) {
  const index = buildProductIndex(productsOrIndex);
  if (!index.items.length) return result('none', { source: 'empty-catalog' });

  const message = safeText(input.message);
  const msg = analyzeText(message, index);

  const pending = (Array.isArray(input.pendingCandidateIds) ? input.pendingCandidateIds : [])
    .map(id => findIndexedProduct(index, id))
    .filter(Boolean);

  // Réponse « 1 », « la deuxième »… à une question de choix.
  if (pending.length) {
    const choice = ordinalChoice(message);
    if (choice >= 0 && pending[choice]) {
      return result('resolved', { item: pending[choice], source: 'candidates', via: 'ordinal' });
    }
  }

  const stored = findIndexedProduct(index, input.activeProductId);

  const adHintText = cleanAdProductHint(input.adProductHint) || cleanAdProductHint(input.adHeadline);
  // Le texte marketing de la pub n'est utilisé que si le titre est générique.
  const adText = [adHintText, input.adHeadlineGeneric ? safeText(input.adBody) : '']
    .filter(Boolean)
    .join(' ');
  const ad = adText ? analyzeText(adText, index) : null;
  const adMatch = ad ? matchText(index, ad) : { status: 'none', candidates: [], all: [] };

  // 1. Le message seul désigne un produit.
  const fromMessage = matchText(index, msg);
  if (fromMessage.status === 'resolved') {
    return result('resolved', { item: fromMessage.item, source: 'message', via: fromMessage.via });
  }

  if (fromMessage.status === 'ambiguous') {
    const allKeys = new Set(fromMessage.all.map(item => item.key));
    // « BIANCA » envoyé depuis la pub Bianca : la pub ou le produit déjà
    // identifié lève l'ambiguïté.
    if (stored && allKeys.has(stored.key)) {
      return result('resolved', { item: stored, source: 'state', via: 'disambiguated' });
    }
    if (adMatch.status === 'resolved' && allKeys.has(adMatch.item.key)) {
      return result('resolved', { item: adMatch.item, source: 'ad', via: 'disambiguated' });
    }
    if (ad) {
      const union = matchText(index, mergeAnalyses(msg, ad));
      if (union.status === 'resolved' && allKeys.has(union.item.key)) {
        return result('resolved', { item: union.item, source: 'message+ad', via: union.via });
      }
    }
    if (pending.length) {
      const narrowed = matchText(index, msg, { restrictTo: pending });
      if (narrowed.status === 'resolved') {
        return result('resolved', { item: narrowed.item, source: 'candidates', via: narrowed.via });
      }
    }
    return result('ambiguous', { candidates: fromMessage.candidates, source: 'message' });
  }

  // 2. Le message ne cite aucun modèle : produit déjà identifié, question de
  //    choix en cours, puis publicité, puis derniers messages du client.
  if (pending.length && msg.types.length) {
    const shared = pending[0].models.filter(token => pending.every(item => item.models.includes(token)));
    const extra = { tokens: new Set(shared), has: token => shared.includes(token), types: [], modelLike: shared };
    const narrowed = matchText(index, mergeAnalyses(msg, extra), { restrictTo: pending });
    if (narrowed.status === 'resolved') {
      return result('resolved', { item: narrowed.item, source: 'candidates', via: narrowed.via });
    }
  }

  const base =
    stored ? { item: stored, source: 'state' } :
      adMatch.status === 'resolved' ? { item: adMatch.item, source: 'ad' } :
        null;

  if (base) {
    // « et le pouf ? » sur la chambre Bianca : le même modèle, un autre type.
    if (msg.types.length) {
      const context = { tokens: new Set(base.item.models), has: token => base.item.models.includes(token), types: [], modelLike: base.item.models };
      const refined = matchText(index, mergeAnalyses(msg, context));
      if (refined.status === 'resolved' && refined.item.key !== base.item.key) {
        const primary = refined.item.primaryType;
        if (primary && msg.tokens.has(primary)) {
          if (componentTypesOf(base.item).has(primary)) {
            return result('ambiguous', { candidates: [base.item, refined.item], source: `${base.source}+message`, via: 'component' });
          }
          return result('resolved', { item: refined.item, source: 'message+context', via: 'type' });
        }
      }
    }
    return result('resolved', { item: base.item, source: base.source, via: 'context' });
  }

  if (adMatch.status === 'ambiguous') {
    return result('ambiguous', { candidates: adMatch.candidates, source: 'ad' });
  }

  const recent = (Array.isArray(input.recentCustomerTexts) ? input.recentCustomerTexts : [])
    .map(safeText)
    .filter(Boolean)
    .slice(-4)
    .reverse();
  for (const text of recent) {
    const previous = matchText(index, analyzeText(text, index));
    if (previous.status === 'resolved') {
      return result('resolved', { item: previous.item, source: 'history', via: previous.via });
    }
    if (previous.status === 'ambiguous') {
      return result('ambiguous', { candidates: previous.candidates, source: 'history' });
    }
  }

  // V6.36.19 — « Vous parlez de la Table Opale ? » / « Oui » / « Prix » :
  // le dernier message de MONDECO ne compte que s'il désigne UN seul
  // produit et que le client répond brièvement.
  const lastReply = safeText(input.lastAssistantText);
  if (lastReply && message.split(/\s+/).filter(Boolean).length <= 3) {
    const previous = matchText(index, analyzeText(lastReply, index));
    if (previous.status === 'resolved') {
      return result('resolved', { item: previous.item, source: 'assistant', via: previous.via });
    }
  }

  return result('none', { source: 'none' });
}

// Mots du message qui ressemblent à un nom de modèle inconnu du catalogue
// (« Zorglub ») : utile pour transférer plutôt que proposer un voisin.
function unknownModelWords(message, productsOrIndex) {
  const index = buildProductIndex(productsOrIndex);
  return tokenize(message).filter(token =>
    !containsArabic(token) &&
    token.length >= 4 &&
    !typeWeight(token) &&
    !DESCRIPTOR_WORDS.has(token) &&
    !index.vocabulary.has(token)
  );
}

function messageTypeWords(message) {
  return tokenize(message).filter(token => typeWeight(token));
}

module.exports = {
  foldArabic,
  toLatinDigits,
  decodeEntities,
  normalizeText,
  tokenize,
  transliterateArabic,
  editDistance,
  containsArabic,
  buildProductIndex,
  findIndexedProduct,
  resolveProduct,
  cleanAdProductHint,
  displayProductName,
  unknownModelWords,
  messageTypeWords,
  ordinalChoice,
  isWooProduct,
  isHiddenPublishedSiteProduct,
  STOP_WORDS,
  STRONG_TYPES,
  WEAK_TYPES
};
