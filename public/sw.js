// Love Better service worker: works offline (last-seen version of the app)
// and shows push notifications.
const CACHE = "lb-v5";
const SHELL = ["/", "/index.html", "/app.js", "/places-core.js", "/manifest.webmanifest", "/icon-192.png", "/logo-mark.png", "/favicon-32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first, so updates show up straight away; cache when offline.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("/"))));
});

// Unread count for the red badge on the app icon (kept in a tiny cache entry).
async function bumpBadge() {
  if (!self.navigator.setAppBadge) return;
  const c = await caches.open("lb-badge");
  const r = await c.match("/badge-count");
  const n = (r ? Number(await r.text()) : 0) + 1;
  await c.put("/badge-count", new Response(String(n)));
  await self.navigator.setAppBadge(n).catch(() => {});
}

self.addEventListener("push", e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { body: e.data && e.data.text() }; }
  e.waitUntil(Promise.all([m.badge ? bumpBadge() : null, self.registration.showNotification(m.title || "Love Better", {
    body: m.body || "", tag: m.tag, renotify: !!m.tag, icon: "/icon-192.png", badge: "/badge.png", data: { url: m.url || "/" },
  })]));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  const tab = url.hash.replace("#", "");
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (new URL(c.url).origin === url.origin) { c.postMessage({ type: "open", tab }); return c.focus(); }
    return self.clients.openWindow(url.href);
  }));
});
