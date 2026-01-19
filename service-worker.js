const CACHE_NAME = "canzoniere-dynamic-v99"; // Cambiato nome per forzare l'aggiornamento un'ultima volta
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./music-utils.js",
  "./manifest.json",
  "./icona.ico",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
];

// 1. INSTALLAZIONE: Caching iniziale delle risorse statiche vitali
self.addEventListener("install", (e) => {
  self.skipWaiting(); // Forza l'attivazione immediata del nuovo SW
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// 2. ATTIVAZIONE: Pulizia vecchie cache
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Prende il controllo immediato della pagina
});

// 3. FETCH: STRATEGIA NETWORK-FIRST (Con fallback alla cache)
self.addEventListener("fetch", (e) => {
  // Ignora le chiamate a Firebase/Google (le gestisce Firestore SDK)
  if (e.request.url.includes("firestore") || 
      e.request.url.includes("googleapis") || 
      e.request.url.includes("firebase")) {
    return; 
  }

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // Se la rete risponde bene, clona la risposta e aggiorna la cache
        // ma SOLO se è una richiesta valida e di tipo http/https (no chrome-extension, etc)
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, responseToCache);
        });

        return response;
      })
      .catch(() => {
        // Se siamo OFFLINE o la rete fallisce, restituisci dalla cache
        return caches.match(e.request);
      })
  );
});