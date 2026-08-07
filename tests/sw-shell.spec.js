import { test, expect } from '@playwright/test';

/* The service worker used to serve the app shell cache-first: once a page
   load succeeded, every future navigation was answered straight out of
   Cache Storage, and the network was never asked again.

   That is a real bug for a deployment sitting behind an auth gateway (this
   one sits behind Keycloak). A request that never reaches the network can
   never be challenged for an expired session — the SW just keeps
   re-serving the last successfully-authenticated shell forever, whose API
   calls then fail silently against the network, and the screen stays
   blank. The only fix used to be uninstalling and reinstalling the PWA,
   which clears the cache and forces one genuine network request.

   The shell now has to be network-first, falling back to the cache only
   when the network request itself fails — so an expired session still
   reaches the gateway and gets redirected to login, while a genuinely
   offline launch still works. */

const booted = async (page) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) throw new Error('service worker did not activate');
  });
};

test.describe('the app shell reaches the network on every load', () => {
  test('a stale cached shell does not win over a live one', async ({ page }) => {
    await booted(page);

    /* Poison every shell cache (not the auth cache) with a marker no real
       deploy would ever contain — standing in for "the cookie expired and
       this device would otherwise be stuck replaying the old shell". */
    await page.evaluate(async () => {
      const marker = () => new Response('STALE-SHELL-MARKER', { headers: { 'Content-Type': 'text/html' } });
      for (const key of await caches.keys()) {
        if (key === 'commanddeck-auth') continue;
        const cache = await caches.open(key);
        await cache.put('/', marker());
        await cache.put('/index.html', marker());
      }
    });

    await page.reload();
    expect(await page.content()).not.toContain('STALE-SHELL-MARKER');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  });

  test('a genuinely offline launch still falls back to the cache', async ({ page, context }) => {
    // Offline support is the reason the shell is cached at all — the fix
    // above must not cost it.
    await booted(page);

    await context.setOffline(true);
    try {
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    } finally {
      await context.setOffline(false);
    }
  });
});
