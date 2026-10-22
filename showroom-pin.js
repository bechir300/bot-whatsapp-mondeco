// MONDECO - Pin showroom automatique (en plus de la reponse IA)
const fs = require('fs');
const loc = require('./location-showrooms');

const OFF_FLAG = '/data/showroom-pin.off';
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const sent = new Map();

const CITIES = {
  soukra: ['soukra', 'سكرة', 'السكرة'],
  ezzahra: ['ezzahra', 'ez zahra', 'ez-zahra', 'الزهراء'],
  nabeul: ['nabeul', 'نابل'],
  sousse: ['sousse', 'akouda', 'سوسة', 'اكودة'],
  sfax: ['sfax', 'صفاقس']
};

const PLACE = new RegExp(
  '(adresse|localisation|emplacement|itineraire|maps|gps|address|' +
  'location|\\bou\\s+(etes|est|se\\s+trouve|sont|se\\s+situe)|' +
  '(vous\\s+etes|etes[- ]vous)\\s+ou\\b|وين|فين|العنوان|عنوان|موقع|لوكاسيون)'
);
const PRICE = /(prix|tarif|combien|price|\bdt\b|tnd|dinar|بشحال|قداش|شحال)/;

function norm(t) {
  return String(t || '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u064B-\u065F\u0640]/g, '');
}

function detectShowroom(text) {
  const t = norm(text);
  if (!t || !PLACE.test(t) || PRICE.test(t)) return null;
  const hits = Object.keys(CITIES).filter(id =>
    CITIES[id].some(a => t.includes(norm(a))));
  return hits.length === 1 ? hits[0] : null;
}

async function maybeSendPin(o) {
  if (fs.existsSync(OFF_FLAG)) return false;
  const id = detectShowroom(o.text);
  if (!id) return false;
  const key = o.to + ':' + id;
  if (Date.now() - (sent.get(key) || 0) < COOLDOWN_MS) return false;
  sent.set(key, Date.now());
  try {
    const send = loc.createLocationSender({
      apiVersion: o.apiVersion,
      phoneNumberId: o.phoneNumberId,
      token: o.token
    });
    await send(o.to, id);
    console.log('📍 Pin showroom envoye :', id, '->', o.to);
    return true;
  } catch (e) {
    sent.delete(key);
    throw e;
  }
}

module.exports = { detectShowroom, maybeSendPin };
