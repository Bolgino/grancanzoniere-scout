const CACHE_NAME = "canzoniere-dynamic-v8";

// File dell'app (sempre aggiornati quando c'è rete)
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./music-utils.js",
  "./song-doctor.js",
  "./ui.js",
  "./chords.js",
  "./tags.js",
  "./qr.js",
  "./tuner.js",
  "./manifest.json",
  "./icona.ico",
];
// Librerie esterne con la versione nel link: non cambiano mai, si salvano una volta e poi si usano dal telefono.
// Senza il motore Firebase salvato l'app non partiva offline (prima veniva escluso dalla cache).
const LIBS = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js",
  "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js",
];
const VERSIONED_HOSTS = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "www.gstatic.com", "fonts.gstatic.com", "fonts.googleapis.com"];
// Chiamate al database e al login: sempre in rete (offline ci pensa Firestore con i dati salvati sul telefono)
const NETWORK_ONLY = ["firestore.googleapis.com", "identitytoolkit.googleapis.com", "securetoken.googleapis.com", "script.google.com", "firebaseinstallations.googleapis.com"];

async function cacheAll(urls) {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(urls.map(async (u) => {
    const res = await fetch(u, { mode: u.startsWith("http") ? "cors" : "same-origin", cache: "reload" }).catch(() => fetch(u, { mode: "no-cors" }));
    if (!res || (!res.ok && res.type !== "opaque")) throw new Error("download " + u);
    await cache.put(u, res);
  }));
  return { ok: results.filter(r => r.status === "fulfilled").length, total: urls.length };
}

// 1. INSTALLAZIONE: salva app e librerie (se una non si scarica non blocca le altre)
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(cacheAll([...APP_FILES, ...LIBS]));
});

// 2. ATTIVAZIONE: pulizia vecchie cache
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))));
  return self.clients.claim();
});

// 3. FETCH
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (NETWORK_ONLY.includes(url.hostname)) return;

  // Librerie esterne versionate: prima la copia sul telefono, altrimenti la rete (e la salvo)
  if (VERSIONED_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // File dell'app: prima la rete (così gli aggiornamenti arrivano subito), offline la copia salvata
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match(req, { ignoreSearch: true })))
    );
  }
});

// 4. "Scarica tutto per l'uso offline" e controllo dello stato, chiesti dall'app
self.addEventListener("message", (e) => {
  const port = e.ports && e.ports[0];
  const reply = (msg) => (port ? port.postMessage(msg) : e.source && e.source.postMessage(msg));
  if (e.data && e.data.type === "precache") {
    e.waitUntil(cacheAll([...APP_FILES, ...LIBS, ...(e.data.urls || [])]).then(reply));
  } else if (e.data && e.data.type === "status") {
    e.waitUntil(caches.open(CACHE_NAME).then(async (c) => {
      const keys = (await c.keys()).map((r) => r.url);
      const libs = LIBS.filter((u) => keys.includes(u)).length;
      const fonts = keys.some((u) => u.includes("bootstrap-icons") && /woff2?/.test(u));
      reply({ libs, libsTotal: LIBS.length, fonts, files: keys.length });
    }));
  }
});
