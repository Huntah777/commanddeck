import { test, expect } from '@playwright/test';

/* Reconnecting background push, from the Alerts card.

   What is being protected is honesty about a chain the user cannot see.
   Push fails silently — the browser goes on reporting a healthy
   subscription long after the row behind it is gone, and from inside the
   app "delivering fine" and "dead for weeks" are both just an absence of
   notifications. So the card has to show BOTH ends, repair BOTH ends,
   and never claim a reconnect worked on the strength of its own POST
   returning 200.

   One thing to know when reading these: the app ALREADY re-subscribes and
   re-registers on every launch (syncPushSchedule), so most broken states
   heal themselves before they can be looked at. That is why several
   fixtures below deliberately jam that path — with a failing POST, or by
   seeding the fingerprint cache that makes it stand down — so the state
   under test survives long enough to assert on. */

const ENDPOINT = 'https://push.example/send/abcdefghijklmnopqrstuvwxyz012345';
const SUB_ID   = ENDPOINT.slice(-32);

/* One habit, deliberately: the app reads an empty habits array from the
   server as a first run and replaces local state with a fresh seed,
   which would land this on the Today tab instead of Admin. */
const STATE = {
  habits: [{ id: 'h-1', name: 'Fajr', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1 }],
  tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view: 'admin', notif: true, timezone: 'Europe/London' },
};

/* Stand in for the whole Push API. Real push needs a live push service,
   which no test browser has — but every decision under test is made from
   what these calls return, so faking them exercises the actual logic
   rather than around it. */
async function fakePush(page, { subscribed = true, subscribeFails = null } = {}) {
  await page.addInitScript(([endpoint, subscribed, subscribeFails]) => {
    window.__push = { unsubscribed: 0, subscribed: 0 };

    const makeSub = (ep) => ({
      endpoint: ep,
      options: {},                       // no applicationServerKey → counts as a match
      toJSON: () => ({ endpoint: ep, keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => { window.__push.unsubscribed++; current = null; return true; },
    });

    let current = subscribed ? makeSub(endpoint) : null;

    const reg = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async () => {
          if (subscribeFails) throw new Error(subscribeFails);
          window.__push.subscribed++;
          current = makeSub(endpoint);
          return current;
        },
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(reg), controller: null, register: async () => reg, addEventListener() {} },
    });
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
  }, [ENDPOINT, subscribed, subscribeFails]);
}

/* The server side: one row, or none. */
function fakeServer(page, { registered = true, scheduled = 4, updatedAt = Date.now(), postStatus = 200 } = {}) {
  const api = { gets: 0, posts: 0, deletes: 0, lastPost: null, lastDelete: null };
  let row = registered ? { registered: true, scheduled, delivered: 1, updatedAt, nextFireAt: 0, planDay: '2026-07-29' } : null;

  page.route('**/api/push**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      api.gets++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row || { registered: false }) });
    }
    if (req.method() === 'POST') {
      api.posts++;
      try { api.lastPost = JSON.parse(req.postData() || '{}'); } catch {}
      if (postStatus >= 400) return route.fulfill({ status: postStatus, contentType: 'application/json', body: '{"error":"no"}' });
      /* A POST is what makes the server know about a device — so the next
         GET must reflect it, or reading the result back proves nothing. */
      row = { registered: true, scheduled, delivered: 0, updatedAt: Date.now(), nextFireAt: 0, planDay: '2026-07-29' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (req.method() === 'DELETE') {
      api.deletes++;
      try { api.lastDelete = JSON.parse(req.postData() || '{}'); } catch {}
      row = null;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 405, body: '' });
  });
  return api;
}

/* `settled` seeds the fingerprint cache the routine re-registration
   checks, so it stands down and leaves the state as the fixture set it —
   which is what a second launch inside six hours actually looks like. */
async function boot(page, { state = STATE, settled = false } = {}) {
  await page.addInitScript(([s, settled, subId]) => {
    localStorage.setItem('madinah_token', 'test-token');
    if (!localStorage.getItem('madinah_v1')) localStorage.setItem('madinah_v1', JSON.stringify(s));
    if (settled) localStorage.setItem(`push_fp_${subId}`, JSON.stringify({ fp: '', at: Date.now() }));
  }, [state, settled, SUB_ID]);

  await page.route('**/api/state', route => route.fulfill({
    status: 200, headers: { 'Content-Type': 'application/json', ETag: '"v1"' }, body: JSON.stringify(state),
  }));
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  await page.getByTestId('admin-nav').getByRole('button', { name: 'Alerts' }).click();
}

const health    = (page) => page.getByTestId('push-health');
const msg       = (page) => page.getByTestId('push-msg');
const reconnect = (page) => page.getByTestId('push-reconnect');

test.describe('showing where the chain is broken', () => {
  test('a working registration says so, from both ends', async ({ page }) => {
    await fakePush(page);
    fakeServer(page, { scheduled: 6 });
    await boot(page);

    await expect(health(page)).toContainText('subscribed');
    await expect(health(page)).toContainText('holds 6 alerts for today');
  });

  test('a device that cannot subscribe is named as the broken link', async ({ page }) => {
    /* "Notifications aren't working" is not actionable. "This device has
       no subscription" is. */
    await fakePush(page, { subscribed: false, subscribeFails: 'denied by the push service' });
    fakeServer(page, { registered: false });
    await boot(page);

    await expect(health(page)).toContainText('no subscription');
  });

  test('a registration the server has lost is not reported as healthy', async ({ page }) => {
    // POST jammed, so nothing can quietly paper over it before we look.
    await fakePush(page);
    fakeServer(page, { registered: false, postStatus: 500 });
    await boot(page);
    await expect(health(page)).toContainText("doesn't have this device");
  });

  test('a long-unconfirmed registration is called out before the cleanup eats it', async ({ page }) => {
    /* The Cron Worker bumps updated_at on every successful send and drops
       the row entirely at 30 days. Weeks of silence is already a fault,
       and it is the one thing the browser side cannot possibly know. */
    await fakePush(page);
    fakeServer(page, { updatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000, postStatus: 500 });
    await boot(page);
    await expect(health(page)).toContainText('probably dead');
  });

  test('an unreachable server is not treated as a lost registration', async ({ page }) => {
    /* Offline is not the same as deregistered. Rebuilding the
       subscription on a failed lookup would churn it every network blip. */
    await fakePush(page);
    await page.route('**/api/push**', route =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'nope' }));
    await boot(page, { settled: true });

    await expect(health(page)).toContainText("couldn't be reached", { timeout: 10_000 });
    expect(await page.evaluate(() => window.__push.unsubscribed)).toBe(0);
    expect(await page.evaluate(() => window.__push.subscribed)).toBe(0);
  });
});

test.describe('reconnecting', () => {
  test('it rebuilds both ends, retiring the old registration first', async ({ page }) => {
    /* Leaving the old row behind would have the Cron Worker retrying a
       dead subscription every minute until the 30-day cleanup. */
    await fakePush(page);
    const api = fakeServer(page);
    await boot(page, { settled: true });

    await reconnect(page).click();
    await expect(msg(page)).toBeVisible({ timeout: 10_000 });

    expect(api.deletes).toBe(1);
    expect(api.lastDelete.id).toBe(SUB_ID);
    expect(await page.evaluate(() => window.__push.unsubscribed)).toBe(1);
    expect(await page.evaluate(() => window.__push.subscribed)).toBe(1);
    expect(api.lastPost.id).toBe(SUB_ID);
    expect(api.lastPost.subscription.endpoint).toBe(ENDPOINT);
  });

  test('it re-posts a real schedule, not an empty one', async ({ page }) => {
    // Registering with nothing planned is a device that receives nothing
    // until something else happens to trigger a resync.
    await fakePush(page);
    const api = fakeServer(page);
    await boot(page, { settled: true });

    await reconnect(page).click();
    await expect(msg(page)).toBeVisible({ timeout: 10_000 });
    expect(Array.isArray(api.lastPost.schedule)).toBe(true);
  });

  test('the result is read back from the server, not assumed from the POST', async ({ page }) => {
    /* The whole point of the feature is not trusting either end on its
       own — so success has to be confirmed by asking. */
    await fakePush(page);
    const api = fakeServer(page, { scheduled: 9 });
    await boot(page, { settled: true });
    const before = api.gets;

    await reconnect(page).click();
    await expect(msg(page)).toContainText('9 alerts planned for today', { timeout: 10_000 });
    expect(api.gets).toBeGreaterThan(before);
  });

  test('it registers even when the routine path has stood down', async ({ page }) => {
    /* The fingerprint cache makes the routine re-registration skip
       redundant writes, which is exactly the state a user is in when they
       press this: the app has been opened, decided nothing needed saying,
       and notifications still are not arriving. Reconnect posts directly
       rather than through that path, so the cache cannot silence it. */
    await fakePush(page);
    const api = fakeServer(page);
    await boot(page, { settled: true });
    expect(api.posts).toBe(0);          // the routine path stood down, as intended

    await reconnect(page).click();
    await expect(msg(page)).toBeVisible({ timeout: 10_000 });
    expect(api.posts).toBe(1);
  });

  test('a browser that refuses a new subscription says so instead of claiming success', async ({ page }) => {
    await fakePush(page, { subscribeFails: 'push service unavailable' });
    fakeServer(page);
    await boot(page, { settled: true });

    await reconnect(page).click();
    await expect(msg(page)).toContainText('refused', { timeout: 10_000 });
    await expect(msg(page)).toContainText('push service unavailable');
  });

  test('a server that refuses the registration is not reported as reconnected', async ({ page }) => {
    await fakePush(page);
    fakeServer(page, { postStatus: 503 });
    await boot(page, { settled: true });

    await reconnect(page).click();
    await expect(msg(page)).toContainText('refused the registration', { timeout: 10_000 });
    await expect(msg(page)).toContainText('503');
  });
});

test.describe('repairing without being asked', () => {
  test('a subscription the server has lost is re-registered on sight', async ({ page }) => {
    /* The one case that is both unambiguous and completely invisible: the
       device holds a live subscription and the server holds nothing.
       Waiting for the user to notice means waiting for them to notice
       silence. `settled` means the routine path has stood down, so this
       repair is the only thing that can fix it. */
    await fakePush(page);
    const api = fakeServer(page, { registered: false });
    await boot(page, { settled: true });

    await expect(msg(page)).toContainText('the server had lost it', { timeout: 10_000 });
    expect(api.posts).toBeGreaterThan(0);
    await expect(health(page)).toContainText('holds');
  });

  test('it does not fire when the server is simply healthy', async ({ page }) => {
    await fakePush(page);
    const api = fakeServer(page);
    await boot(page, { settled: true });

    await expect(health(page)).toContainText('holds 4 alerts for today');
    expect(api.posts).toBe(0);
    expect(await page.evaluate(() => window.__push.unsubscribed)).toBe(0);
  });
});
