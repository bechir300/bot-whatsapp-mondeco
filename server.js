// Bot WhatsApp + IA via l'API officielle WhatsApp Cloud (Meta)
// Pas de Chromium local — Meta héberge la connexion WhatsApp.
// Lancer avec : node server.js

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const BUSINESS_INFO_PATH = path.join(__dirname, 'business-info.txt');
const HISTORY_PATH = path.join(__dirname, 'conversation-log.json');

function loadBusinessInfo() {
  try {
    return fs.readFileSync(BUSINESS_INFO_PATH, 'utf8');
  } catch (e) {
    return '';
  }
}

function logConversation(entry) {
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (e) {}
  log.push(entry);
  if (log.length > 200) log = log.slice(-200);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(log, null, 2));
}

// --- IA (Gemini) ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const conversationHistory = {};

async function generateReply(userId, userText) {
  const businessInfo = loadBusinessInfo();
  if (!conversationHistory[userId]) conversationHistory[userId] = [];

  const historyText = conversationHistory[userId]
    .slice(-6)
    .map(h => `${h.role}: ${h.text}`)
    .join('\n');

  const prompt = `Tu es l'assistant WhatsApp officiel de cette entreprise. Réponds toujours en français, de façon claire, amicale et concise (2-4 phrases max sauf si le client demande plus de détails).

INFORMATIONS SUR L'ENTREPRISE :
${businessInfo}

HISTORIQUE RÉCENT DE LA CONVERSATION :
${historyText}

NOUVEAU MESSAGE DU CLIENT :
${userText}

Réponds directement, sans préambule ni "Voici ma réponse :".`;

  const result = await model.generateContent(prompt);
  const reply = result.response.text().trim();

  conversationHistory[userId].push({ role: 'Client', text: userText });
  conversationHistory[userId].push({ role: 'Assistant', text: reply });

  return reply;
}

// --- Envoyer un message via l'API WhatsApp Cloud ---
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Erreur envoi WhatsApp :', data);
  }
  return data;
}

// --- Vérification du webhook (étape obligatoire demandée par Meta) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié avec succès par Meta');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Échec de vérification du webhook');
    res.sendStatus(403);
  }
});

// --- Réception des messages WhatsApp ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Répondre immédiatement à Meta (obligatoire, sinon Meta réessaie)

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return; // Pas un message entrant (peut être un statut de livraison, etc.)
    if (message.type !== 'text') return; // On ne gère que le texte pour l'instant

    const from = message.from; // numéro du client
    const userText = message.text.body;

    console.log(`📩 Message reçu de ${from} : ${userText}`);

    const reply = await generateReply(from, userText);
    await sendWhatsAppMessage(from, reply);

    logConversation({
      contact: from,
      incoming: userText,
      reply,
      time: new Date().toISOString()
    });

    console.log(`✅ Réponse envoyée à ${from} : ${reply}`);
  } catch (error) {
    console.error('Erreur traitement message :', error);
  }
});

app.get('/', (req, res) => {
  res.send('Bot WhatsApp actif. Le webhook est sur /webhook.');
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  console.log(`Webhook à configurer dans Meta : [ton-url-publique]/webhook`);
});