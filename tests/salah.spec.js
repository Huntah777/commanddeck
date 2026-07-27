import { test, expect } from '@playwright/test';

/* Prayer times end-to-end: the monthly timetable fetch, what the UI says about
   it, per-prayer offsets, and the rule that a location is only committed to
   synced state once it has actually produced times. */

const pad = (n) => String(n).padStart(2, '0');
const TIMES = { Fajr: '03:12', Sunrise: '04:55', Dhuhr: '13:05', Asr: '17:20', Maghrib: '21:15', Isha: '22:40' };

/* A month of Aladhan's /calendar response, all days identical. */
function calendarBody(year, month) {
  const days = new Date(year, month, 0).getDate();
  return {
    code: 200,
    data: Array.from({ length: days }, (_, i) => ({
      timings: Object.fromEntries(Object.entries(TIMES).map(([k, v]) => [k, `${v} (BST)`])),
      date: { gregorian: { date: `${pad(i + 1)}-${pad(month)}-${year}` } },
    })),
  };
}

function mockAladhan(page) {
  const api = { calls: 0, fail: false };
  page.route('**api.aladhan.com/**', async (route) => {
    api.calls++;
    if (api.fail) return route.abort('failed');
    const now = new Date();
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calendarBody(now.getFullYear(), now.getMonth() + 1)),
    });
  });
  return api;
}

/* Seed a device-local location so the hook fetches without geolocation, while
   leaving the synced ui.salahLoc empty. */
async function seed(page, { ui = {}, deviceLoc = { lat: 51.5074, lon: -0.1278 } } = {}) {
  await page.addInitScript(([state, loc]) => {
    localStorage.setItem('madinah_v1', JSON.stringify(state));
    if (loc) localStorage.setItem('madinah_salah_loc', JSON.stringify(loc));
  }, [{ habits: [], tasks: [], blocks: [], logs: {}, ui }, deviceLoc]);
}

const strip = (page) => page.locator('div.border-b').filter({ hasText: 'SALAH' }).first();

test.describe('prayer times', () => {
  /* sw.js proxies api.aladhan.com itself (network-first, cache fallback), and
     service-worker requests bypass page.route — so without this the mock is
     silently skipped and these assert against the live API. */
  test.use({ serviceWorkers: 'block' });

  test('times load from the monthly timetable and confirm they updated', async ({ page }) => {
    const api = mockAladhan(page);
    await seed(page);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await expect(strip(page)).toContainText('03:12', { timeout: 10_000 });
    await expect(strip(page)).toContainText('13:05');
    // The whole point of the status line: say it actually worked.
    await expect(strip(page)).toContainText('updated');
    await expect(strip(page)).not.toContainText('fetching');
    expect(api.calls).toBe(1);
  });

  test('one request covers the month — changing day needs no network', async ({ page }) => {
    const api = mockAladhan(page);
    await seed(page);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    await expect(strip(page)).toContainText('03:12', { timeout: 10_000 });

    const before = api.calls;
    await page.locator('button').filter({ hasText: /^‹$/ }).first().click();
    await expect(strip(page)).toContainText('03:12');
    await page.waitForTimeout(1_000);
    expect(api.calls).toBe(before); // still covered by the cached month
  });

  test('caching a timetable does not wipe the saved location', async ({ page }) => {
    // The month cache and the saved location share a key prefix; pruning by
    // that prefix deleted the location on every successful fetch.
    mockAladhan(page);
    await seed(page);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    await expect(strip(page)).toContainText('03:12', { timeout: 10_000 });

    expect(await page.evaluate(() => localStorage.getItem('madinah_salah_loc'))).toBeTruthy();
    // And today's timetable is left where notification scheduling reads it.
    expect(await page.evaluate(() => localStorage.getItem('madinah_today_salah'))).toContain('03:12');
  });

  test('a per-prayer offset shifts the displayed time', async ({ page }) => {
    mockAladhan(page);
    await seed(page, { ui: { salahOffsets: { Dhuhr: 5 } } });
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    // Dhuhr 13:05 + 5 = 13:10; the others are untouched.
    await expect(strip(page)).toContainText('13:10', { timeout: 10_000 });
    await expect(strip(page)).toContainText('03:12');
    await expect(strip(page)).not.toContainText('13:05');
  });

  test('a failed fetch ends in a definite error with a way to retry', async ({ page }) => {
    // fetch() has no timeout of its own — a request that never settles used to
    // leave "fetching…" on screen indefinitely with nothing to act on.
    const api = mockAladhan(page);
    api.fail = true;
    await seed(page);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await expect(strip(page).locator('button', { hasText: 'RETRY' })).toBeVisible({ timeout: 15_000 });
    await expect(strip(page)).not.toContainText('fetching');

    api.fail = false;
    await strip(page).locator('button', { hasText: 'RETRY' }).click();
    await expect(strip(page)).toContainText('03:12', { timeout: 10_000 });
  });

  test('a cached timetable still shows when the network is down', async ({ page }) => {
    const api = mockAladhan(page);
    await seed(page);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    await expect(strip(page)).toContainText('03:12', { timeout: 10_000 });

    // Force a revalidation against a dead network on the next load.
    api.fail = true;
    await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('madinah_salah_cal_')) {
          const v = JSON.parse(localStorage.getItem(k));
          localStorage.setItem(k, JSON.stringify({ ...v, at: 0 })); // stale
        }
      }
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    // Times stay on screen, flagged as offline rather than silently trusted.
    await expect(strip(page)).toContainText('03:12', { timeout: 15_000 });
    await expect(strip(page)).toContainText('offline', { timeout: 15_000 });
  });

  test('a location is only synced once it has produced prayer times', async ({ page }) => {
    // Committing up front pushed an unverified coordinate to every device and
    // to the Cron Worker, which builds notifications from it.
    const api = mockAladhan(page);
    api.fail = true;
    await seed(page);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    const syncedLoc = () => page.evaluate(
      () => JSON.parse(localStorage.getItem('madinah_v1') || '{}')?.ui?.salahLoc ?? null
    );

    await strip(page).locator('button', { hasText: 'MANUAL' }).click({ timeout: 15_000 });
    await strip(page).locator('input[type="number"]').nth(0).fill('21.4225');
    await strip(page).locator('input[type="number"]').nth(1).fill('39.8262');
    await strip(page).locator('button', { hasText: 'SET' }).click();

    await page.waitForTimeout(3_000);
    expect(await syncedLoc()).toBeNull();                       // fetch failed → not committed
    await expect(strip(page).locator('button', { hasText: 'SET' })).toBeVisible(); // still correctable

    api.fail = false;
    await strip(page).locator('button', { hasText: 'SET' }).click();
    await expect.poll(syncedLoc, { timeout: 15_000 }).toMatchObject({ lat: 21.4225, lon: 39.8262 });
  });
});
