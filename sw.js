/* Bump on every deploy: the shell is served cache-first, so a stale cache name
   keeps serving the previous index.html indefinitely. */
const CACHE = 'commanddeck-v8';

/* Written by the page, read by this worker. The SW cannot see localStorage,
   but it needs the sync token to re-register a rotated push subscription while
   the app is closed — see the pushsubscriptionchange handler. Survives cache
   version bumps (see `activate`); same origin-scoped exposure as localStorage. */
const AUTH_CACHE = 'commanddeck-auth';
const TOKEN_URL  = '/__sync_token';

/* Must match index.html's copy and the Cron Worker's private key. */
const VAPID_PUBLIC_KEY = 'BFbFmnxVUcx5X_6pUxHKVv-n8aX78p73b8vbe8WCLqLPSmq9ydXMWdBtKjjDCceMju1CerMDVsRWkzJiM6jrvYo';

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
        /* AUTH_CACHE is not a version of the shell — deleting it on every
           deploy would drop the token and silently break push re-registration
           for any device that isn't opened again afterwards. */
        keys.filter((k) => k !== CACHE && k !== AUTH_CACHE).map((k) => caches.delete(k))
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

    /* Consuming a push without showing anything breaks the userVisibleOnly
       promise: browsers respond by posting their own "site was updated in the
       background" notice, and repeat offenders lose push permission entirely.
       So a duplicate is still shown — same tag replaces the visible one, with
       renotify off so it doesn't buzz a second time. */
    const seen = alreadyShown(tag);

    await self.registration.showNotification(title, {
      body:     data.body || '',
      icon:     '/icons/icon-192.png',
      badge:    '/icons/icon-192.png',
      tag,
      renotify: !seen,
      vibrate:  seen ? [] : [200, 100, 200],
      silent:   seen,
      data:     { isSalah: !!data.isSalah },
    });

    /* If this is a prayer-time push, also play the adhan in any open page */
    if (!seen && data.isSalah) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'PLAY_ADHAN', tag: data.tag || null }));
    }
  })());
});

/* ── Push subscription lifecycle ──────────────────────────────────
   Browsers rotate a push subscription whenever they feel like it (storage
   pressure, permission churn, their own expiry policy). The old endpoint then
   starts returning 410, the Cron Worker drops the row, and the device receives
   nothing more.

   Without this handler the only thing that re-registers is opening the app —
   so a home-screen PWA that just sits there goes quiet indefinitely, which is
   exactly when notifications matter most. Re-subscribing here is what keeps a
   rarely-opened install alive. */

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function syncToken() {
  try {
    const res = await (await caches.open(AUTH_CACHE)).match(TOKEN_URL);
    return res ? await res.text() : null;
  } catch { return null; }
}

async function pushApi(method, body, token) {
  return fetch('/api/push', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const token = await syncToken();
    if (!token) return; // sync not configured — nothing to register with

    /* Some browsers hand over the replacement; others expect us to create it. */
    let sub = event.newSubscription;
    if (!sub) {
      try {
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY),
        });
      } catch { return; }
    }

    /* An empty schedule is only a bootstrap — the Cron Worker overwrites it
       with the server-derived plan on its next tick (see functions/api/push.js). */
    try {
      await pushApi('POST', { id: sub.endpoint.slice(-32), subscription: sub.toJSON(), schedule: [] }, token);
    } catch { /* best effort — the app re-registers on next open */ }

    /* Retire the dead row now rather than letting every tick waste a send on
       it until the 30-day sweep. */
    const old = event.oldSubscription;
    if (old?.endpoint) {
      try { await pushApi('DELETE', { id: old.endpoint.slice(-32) }, token); } catch {}
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
