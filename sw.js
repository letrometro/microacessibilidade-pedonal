/* Service worker — funcionamento offline da app Microacessibilidades.
   Sempre que alterares o index.html, sync.js ou os ícones, incrementa a versão
   do CACHE (ex.: v1 -> v2) para forçar a atualização nos dispositivos já
   instalados. */
const CACHE = "acessibilidade-pedonal-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./sync.js",
  "./vendor/supabase.js",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./icons/logo.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // não interfere com chamadas de sincronização (POST/PATCH)

  // App-shell (mesma origem): cache-first, com atualização em segundo plano.
  if (new URL(req.url).origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => cached || caches.match("./index.html"));
        return cached || network;
      })
    );
  }
  // Pedidos a outras origens (ex.: API de sincronização) seguem direto para a rede.
});
