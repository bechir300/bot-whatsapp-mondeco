// Service worker minimal — requis par Chrome/Android pour proposer
// l'installation de la PWA MONDECO. Ne fait aucune mise en cache pour
// l'instant, sert uniquement à satisfaire la condition d'installabilité.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Pas d'interception : laisse toutes les requêtes passer normalement.
});
