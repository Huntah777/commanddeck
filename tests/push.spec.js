import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Playwright runs from the project root (where the config lives). */
const sw  = readFileSync(join(process.cwd(), 'sw.js'), 'utf8');
const app = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

/* The page and the service worker have to agree on where the sync token
   lives, and the SW has to re-register a rotated subscription. Both are
   invisible when broken — the app looks fine and notifications just stop. */

test.describe('push registration', () => {
  test('the service worker handles subscription rotation', () => {
    // Without this, a rotated subscription 410s, the Cron Worker drops the
    // row, and a home-screen PWA goes silent until someone opens it.
    expect(sw).toContain('pushsubscriptionchange');
  });

  test('the auth cache survives a shell cache version bump', () => {
    // `activate` deletes every cache that isn't the current shell; dropping
    // the token there would break re-registration on the next deploy.
    const activate = sw.slice(sw.indexOf("addEventListener('activate'"), sw.indexOf("addEventListener('fetch'"));
    expect(activate).toContain('AUTH_CACHE');
  });

  test('page and service worker agree on the token location and VAPID key', () => {
    const swAuth  = sw.match(/AUTH_CACHE\s*=\s*'([^']+)'/)?.[1];
    const swUrl   = sw.match(/TOKEN_URL\s*=\s*'([^']+)'/)?.[1];
    const appAuth = app.match(/SW_AUTH_CACHE\s*=\s*'([^']+)'/)?.[1];
    const appUrl  = app.match(/SW_TOKEN_URL\s*=\s*'([^']+)'/)?.[1];
    expect(swAuth).toBeTruthy();
    expect(swAuth).toBe(appAuth);
    expect(swUrl).toBeTruthy();
    expect(swUrl).toBe(appUrl);

    const keys = [...sw.matchAll(/VAPID_PUBLIC_KEY\s*=\s*'([^']+)'/g)].map(m => m[1]);
    const appKey = app.match(/VAPID_PUBLIC_KEY\s*=\s*'([^']+)'/)?.[1];
    expect(keys[0]).toBe(appKey);
  });

  test('the service worker parses and activates', async ({ page }) => {
    // A syntax error in sw.js fails silently: the page works, and every
    // background notification stops.
    await page.goto('/');
    await expect.poll(async () => page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active?.state ?? 'none';
    }), { timeout: 10_000 }).toBe('activated');
  });

  test('the token is mirrored into the cache the service worker reads', async ({ page }) => {
    await page.route('**/api/state', (route) => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
      body: JSON.stringify({ habits: [], ui: {} }),
    }));
    await page.addInitScript(() => localStorage.setItem('madinah_token', 'test-token'));
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await expect.poll(async () => page.evaluate(async () => {
      const res = await (await caches.open('commanddeck-auth')).match('/__sync_token');
      return res ? res.text() : null;
    }), { timeout: 10_000 }).toBe('test-token');
  });
});
