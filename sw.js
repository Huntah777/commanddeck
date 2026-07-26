/* Bump on every deploy: the shell is served cache-first, so a stale cache name
   keeps serving the previous index.html indefinitely. */
const CACHE = 'commanddeck-v7';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/command-deck-icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/vendor/react.min.js',
  '/vendor/react-dom.min.js',
  '/vendor/babel.min.js',
  '/vendor/tailwind.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls — never intercept, let them reach the network
  if (url.pathname.startsWith('/api/')) return;

  // Google Fonts — stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then((resp) => { cache.put(request, resp.clone()); return resp; })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Prayer times API — network-first, cache as fallback
  if (url.hostname === 'api.aladhan.com') {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          caches.open(CACHE).then((c) => c.put(request, resp.clone()));
          return resp;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Everything else (app shell, vendor, Tailwind CDN) — cache-first
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((resp) => {
          caches.open(CACHE).then((c) => c.put(request, resp.clone()));
          return resp;
        })
    )
  );
});

// Notification scheduler — page posts SCHEDULE_NOTIFICATIONS with a timetable;
// the SW uses setTimeout to fire each one at the right moment.
const pendingTimers = new Map();

/* The same notification can arrive twice — once from the in-page timer below
   and once as a server push — since both fire around the same instant while
   the app is open. Same tag means the second replaces the first visually, but
   `renotify` makes it buzz again. Remember what we've just shown and let the
   first one win. */
const recentlyShown = new Map();
const DEDUPE_MS = 5 * 60_000;

function alreadyShown(tag) {
  const now = Date.now();
  for (const [k, t] of recentlyShown) if (now - t > DEDUPE_MS) recentlyShown.delete(k);
  if (recentlyShown.has(tag)) return true;
  recentlyShown.set(tag, now);
  return false;
}

function swNotify(title, body, tag, renotify) {
  return self.registration.showNotification(title, {
    body:     body || '',
    icon:     '/icons/icon-192.png',
    badge:    '/icons/icon-192.png',
    tag:      tag || 'commanddeck',
    renotify: !!renotify,
    vibrate:  [200, 100, 200],
  });
}

self.addEventListener('message', (event) => {
  /* Immediate notification from the page (e.g. Pomodoro complete) */
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    swNotify(event.data.title, event.data.body, event.data.tag, true);
    return;
  }

  if (event.data?.type !== 'SCHEDULE_NOTIFICATIONS') return;

  pendingTimers.forEach(t => clearTimeout(t));
  pendingTimers.clear();

  const now = Date.now();
  (event.data.notifications || []).forEach(({ id, title, body, fireAt }) => {
    const delay = fireAt - now;
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      if (alreadyShown(id)) { pendingTimers.delete(id); return; }
      swNotify(title, body, id, false);
      /* For salah notifications: also signal open pages to play adhan tone */
      if (id.startsWith('salah-')) {
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(list => list.forEach(c => c.postMessage({ type: 'PLAY_ADHAN', tag: id })));
      }
      pendingTimers.delete(id);
    }, delay);
    pendingTimers.set(id, timer);
  });
});

// Push notifications — content arrives encrypted (RFC 8291), decrypted automatically by the browser
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch {}

    const title = data.title || 'Command Deck';
    const tag   = data.tag || 'commanddeck';
    if (alreadyShown(tag)) return;

    await self.registration.showNotification(title, {
      body:     data.body || '',
      icon:     '/icons/icon-192.png',
      badge:    '/icons/icon-192.png',
      tag,
      renotify: true,
      vibrate:  [200, 100, 200],
      data:     { isSalah: !!data.isSalah },
    });

    /* If this is a prayer-time push, also play the adhan in any open page */
    if (data.isSalah) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'PLAY_ADHAN', tag: data.tag || null }));
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((list) => {
      if (list.length) return list[0].focus();
      /* notification.data carries { isSalah }, not a URL — passing it to
         openWindow navigated to "[object Object]". */
      return clients.openWindow('/');
    })
  );
});
