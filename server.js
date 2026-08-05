// Bot WhatsApp + IA via l'API officielle WhatsApp Cloud (Meta) + Groq (IA)
// Lancer avec : node server.js
console.log('>>> VERSION TEST 12345 <<<');
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// --- DIAGNOSTIC RENFORCÉ AU DÉMARRAGE ---
console.log('========================================');
console.log('🔍 DIAGNOSTIC VARIABLES D\'ENVIRONNEMENT');
console.log('========================================');
console.log('NODE_ENV:', process.env.NODE_ENV || '(non défini)');
console.log('RAILWAY_ENVIRONMENT:', process.env.RAILWAY_ENVIRONMENT_NAME || '(absent — pas sur Railway ?)');
console.log('RAILWAY_SERVICE_NAME:', process.env.RAILWAY_SERVICE_NAME || '(absent)');
console.log('Nombre total de variables env chargées:', Object.keys(process.env).length);

const groqRelatedKeys = Object.keys(process.env).filter(k => k.toUpperCase().includes('GROQ'));
console.log('Clés contenant "GROQ" trouvées:', groqRelatedKeys.length ? groqRelatedKeys : '(AUCUNE)');

console.log('---');
console.log('VERIFY_TOKEN      :', VERIFY_TOKEN ? `OK (longueur ${VERIFY_TOKEN.length})` : '❌ MANQUANT');
console.log('WHATSAPP_TOKEN    :', WHATSAPP_TOKEN ? `OK (longueur ${WHATSAPP_TOKEN.length})` : '❌ MANQUANT');
console.log('PHONE_NUMBER_ID   :', PHONE_NUMBER_ID ? `OK (${PHONE_NUMBER_ID})` : '❌ MANQUANT');
console.log('GROQ_API_KEY      :', GROQ_API_KEY ? `OK (longueur ${GROQ_API_KEY.length}, début: ${GROQ_API_KEY.substring(0,8)}, fin: ${GROQ_API_KEY.slice(-6)})` : '❌ MANQUANT');
console.log('========================================');

if (!GROQ_API_KEY) {
  console.error('🚨 ARRÊT VOLONTAIRE : GROQ_API_KEY est absente de process.env.');
  console.error('   → Si RAILWAY_ENVIRONMENT_NAME est absent ci-dessus, ce process ne tourne peut-être pas sur Railway (build local, mauvais service, etc).');
  console.error('   → Si les autres variables (VERIFY_TOKEN etc) sont OK mais pas GROQ_API_KEY, vérifie qu\'elle est bien attachée au MÊME service et au MÊME environnement dans Railway.');
  console.error('   → Vérifie aussi qu\'un fichier .env n\'est pas committé dans le repo GitHub et ne vient pas écraser cette valeur.');
  // On ne fait PAS process.exit(1) ici pour l'instant, pour pouvoir observer /debug-env en HTTP si besoin.
  // Décommente la ligne suivante une fois le diagnostic terminé, pour empêcher tout démarrage silencieux sans clé :
  // process.exit(1);
}

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

const conversationHistory = {};

// --- IA via Groq (compatible format OpenAI) ---
async function generateReply(userId, userText) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY manquante — impossible d\'appeler Groq. Vérifie les variables Railway.');
  }

  const businessInfo = loadBusinessInfo();
  if (!conversationHistory[userId]) conversationHistory[userId] = [];

  const historyMessages = conversationHistory[userId].slice(-6);

  const systemPrompt = `Tu es l'assistant WhatsApp officiel de cette entreprise. Réponds toujours en français, de façon claire, amicale et concise (2-4 phrases max sauf si le client demande plus de détails).

INFORMATIONS SUR L'ENTREPRISE :
${businessInfo}

Réponds directement, sans préambule ni "Voici ma réponse :".`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userText }
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      temperature: 0.7
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Erreur Groq :', data);
    throw new Error(data.error?.message || 'Erreur IA');
  }

  const reply = data.choices[0].message.content.trim();

  conversationHistory[userId].push({ role: 'user', content: userText });
  conversationHistory[userId].push({ role: 'assistant', content: reply });

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
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;
    if (message.type !== 'text') return;

    const from = message.from;
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

// --- Route de debug temporaire (à SUPPRIMER une fois le problème résolu) ---
// Permet de vérifier depuis un navigateur si Railway injecte bien la clé,
// sans jamais exposer la valeur complète de la clé.
app.get('/debug-env', (req, res) => {
  res.json({
    railway_environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
    railway_service: process.env.RAILWAY_SERVICE_NAME || null,
    total_env_vars: Object.keys(process.env).length,
    groq_related_keys: Object.keys(process.env).filter(k => k.toUpperCase().includes('GROQ')),
    groq_key_present: !!GROQ_API_KEY,
    groq_key_length: GROQ_API_KEY ? GROQ_API_KEY.length : null,
    groq_key_preview: GROQ_API_KEY ? `${GROQ_API_KEY.substring(0,8)}...${GROQ_API_KEY.slice(-6)}` : null,
    verify_token_present: !!VERIFY_TOKEN,
    whatsapp_token_present: !!WHATSAPP_TOKEN,
    phone_number_id_present: !!PHONE_NUMBER_ID
  });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
