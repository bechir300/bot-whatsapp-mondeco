// ============================================================
// MONDECO — messages WhatsApp interactifs
// lib/whatsapp-interactive.js
//
// Construit les messages « interactive » de l'API WhatsApp Cloud et lit
// les réponses des clients :
// - fiche produit : photo, nom, prix, dimensions, bouton « Voir le
//   produit » (lien du site) ou boutons de réponse s'il n'y a pas de lien ;
// - question à boutons : un texte et 1 à 3 boutons de réponse ;
// - un clic du client sur un bouton ou dans une liste arrive comme un
//   message texte normal (titre du bouton), traité comme les autres.
//
// Limites WhatsApp : corps 1024 caractères, en-tête et pied 60, titre de
// bouton 20, 3 boutons de réponse au plus.
// ============================================================

const LIMITS = { body: 1024, header: 60, footer: 60, button: 20, buttons: 3, id: 256 };
const FOOTER = 'MONDECO';

function text(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function oneLine(value) {
  return text(value).replace(/\s+/g, ' ');
}

function cut(value, max) {
  const clean = text(value);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}

function formatPrice(value) {
  const clean = oneLine(value);
  if (!clean) return '';
  return /dt|tnd|dinar/i.test(clean) ? clean : `${clean} DT`;
}

// Texte de la fiche produit (corps du message).
function productCardBody(product = {}, { intro = '' } = {}) {
  const lines = [];
  if (oneLine(intro)) lines.push(text(intro), '');
  lines.push(`*${oneLine(product.name) || 'Produit MONDECO'}*`);

  const price = formatPrice(product.price);
  const promo = formatPrice(product.promoPrice);
  if (promo && price && promo !== price) {
    lines.push(`💰 ${promo} au lieu de ~${price}~`);
  } else if (promo || price) {
    lines.push(`💰 ${promo || price}`);
  }
  if (oneLine(product.dimensions)) lines.push(`📐 ${oneLine(product.dimensions)}`);
  if (oneLine(product.colors)) lines.push(`🎨 ${oneLine(product.colors)}`);
  if (oneLine(product.availability)) lines.push(`📦 ${oneLine(product.availability)}`);
  return cut(lines.join('\n'), LIMITS.body);
}

// Fiche produit. `hasImage` : une photo sera jointe en en-tête (identifiant
// de média ajouté au moment de l'envoi). Renvoie { interactive, logText }.
function buildProductCard(product = {}, { hasImage = false, intro = '' } = {}) {
  const name = oneLine(product.name);
  if (!name) throw new Error('Produit introuvable ou sans nom.');

  const body = productCardBody(product, { intro });
  const header = hasImage
    ? { type: 'image', image: {} }
    : { type: 'text', text: cut(name, LIMITS.header) };
  const url = isHttpsUrl(product.productUrl) ? String(product.productUrl) : '';

  const interactive = url
    ? {
        type: 'cta_url',
        header,
        body: { text: body },
        footer: { text: FOOTER },
        action: {
          name: 'cta_url',
          parameters: { display_text: 'Voir le produit', url }
        }
      }
    : {
        type: 'button',
        header,
        body: { text: body },
        footer: { text: FOOTER },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'product_interest', title: 'Ça m’intéresse' } },
            { type: 'reply', reply: { id: 'product_showroom', title: 'Le voir en showroom' } },
            { type: 'reply', reply: { id: 'product_other', title: 'Autres modèles' } }
          ]
        }
      };

  // Historique interne : sans les marqueurs de mise en forme WhatsApp.
  const plainBody = body.replace(/\*([^*\n]+)\*/g, '$1').replace(/~([^~\n]+)~/g, '$1');
  const logText = `🛋️ Fiche produit\n${plainBody}${url ? `\n🔗 Voir le produit : ${url}` : '\n[Ça m’intéresse] [Le voir en showroom] [Autres modèles]'}`;
  return { interactive, logText };
}

// Question à boutons de réponse.
function buildReplyButtons(bodyText, labels = []) {
  const body = text(bodyText);
  if (!body) throw new Error('Écrivez la question à envoyer avec les boutons.');
  if (body.length > LIMITS.body) throw new Error(`Texte trop long pour un message à boutons (${LIMITS.body} caractères maximum).`);

  const titles = (Array.isArray(labels) ? labels : [])
    .map(oneLine)
    .filter(Boolean);
  if (!titles.length) throw new Error('Ajoutez au moins un bouton.');
  if (titles.length > LIMITS.buttons) throw new Error(`${LIMITS.buttons} boutons au maximum.`);
  const tooLong = titles.find(title => title.length > LIMITS.button);
  if (tooLong) throw new Error(`Bouton « ${tooLong} » trop long (${LIMITS.button} caractères maximum).`);
  const lower = titles.map(title => title.toLowerCase());
  if (new Set(lower).size !== lower.length) throw new Error('Deux boutons ont le même texte.');

  return {
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: titles.map((title, index) => ({
          type: 'reply',
          reply: { id: `btn_${index + 1}`, title }
        }))
      }
    },
    logText: `${body}\n${titles.map(title => `[${title}]`).join(' ')}`
  };
}

// Réponse d'un client à un message interactif ou à un bouton de modèle.
// Renvoie { text, id, kind } ou null si ce n'en est pas une.
function parseInteractiveReply(message = {}) {
  if (message?.type === 'interactive') {
    const interactive = message.interactive || {};
    const reply = interactive.button_reply || interactive.list_reply;
    if (!reply) return null;
    const title = oneLine(reply.title);
    const description = oneLine(reply.description);
    const value = description && interactive.list_reply ? `${title} — ${description}` : title;
    if (!value) return null;
    return {
      text: value,
      id: cut(reply.id, LIMITS.id),
      kind: interactive.button_reply ? 'button_reply' : 'list_reply'
    };
  }
  if (message?.type === 'button') {
    const value = oneLine(message.button?.text || message.button?.payload);
    if (!value) return null;
    return { text: value, id: cut(message.button?.payload, LIMITS.id), kind: 'template_button' };
  }
  return null;
}

// Transforme une réponse à bouton en message texte, pour que tout le
// traitement existant (journal, IA, transfert, notifications) s'applique.
function interactiveReplyAsTextMessage(message = {}) {
  const reply = parseInteractiveReply(message);
  if (!reply) return message;
  return {
    ...message,
    type: 'text',
    text: { body: reply.text },
    interactive_reply: reply
  };
}

module.exports = {
  LIMITS,
  buildProductCard,
  buildReplyButtons,
  parseInteractiveReply,
  interactiveReplyAsTextMessage,
  productCardBody
};
