// MONDECO - Pins GPS des showrooms (WhatsApp)
const SHOWROOMS = {
  soukra: {
    name: 'MONDECO La Soukra',
    address: 'Amir Centre, Sidi Fredj, La Soukra, Ariana',
    lat: 36.8813587, lng: 10.2534021
  },
  ezzahra: {
    name: 'MONDECO Ezzahra',
    address: 'Bretelles GP1, Ezzahra, Ben Arous',
    lat: 36.7380131, lng: 10.2953162
  },
  nabeul: {
    name: 'MONDECO Nabeul',
    address: "Blvd l'environnement, Nabeul, Cap Bon",
    lat: 36.4572654, lng: 10.7489865
  },
  sousse: {
    name: 'MONDECO Sousse',
    address: 'GP1, Route de Tunis km 6.5, Akouda, Sousse',
    lat: 35.8746405, lng: 10.5825765
  },
  sfax: {
    name: 'MONDECO Sfax',
    address: 'Route de Tunis, km 4.5, Sfax',
    lat: 34.7833329, lng: 10.757553
  }
};

function norm(t) {
  return String(t || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function resolveShowroom(text) {
  const s = norm(text);
  for (const id of Object.keys(SHOWROOMS)) {
    if (s.includes(id)) return id;
  }
  return null;
}

function buildPayload(to, id) {
  const r = SHOWROOMS[id];
  if (!r) throw new Error('Showroom inconnu : ' + id);
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'location',
    location: {
      latitude: r.lat,
      longitude: r.lng,
      name: r.name,
      address: r.address
    }
  };
}

function createLocationSender(cfg) {
  const url = 'https://graph.facebook.com/' + cfg.apiVersion +
    '/' + cfg.phoneNumberId + '/messages';
  return async function sendShowroomLocation(to, id) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildPayload(to, id))
    });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      throw new Error(
        (data.error && data.error.message) ||
        'Envoi localisation impossible (' + response.status + ').'
      );
    }
    return data;
  };
}

module.exports = {
  SHOWROOMS, resolveShowroom, buildPayload, createLocationSender
};
