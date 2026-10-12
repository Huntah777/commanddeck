import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Picking up a new deploy without clearing the PWA.

   A Home Screen app is resumed, not reloaded, so the browser's own
   service-worker update check almost never runs — and the page already open
   kept running the old JS whatever the worker did. The app now compares the
   HTML the server serves with the HTML it is running (see the registration
   script at the bottom of index.html) and reloads into a newer one when that
   costs nothing.

   A "deploy" here is the server answering `/` with different bytes. Service
   workers are blocked for most of this: requests the worker makes bypass
   page.route, and the point is the page's own logic. The worker-takeover
   path has its own block at the end. */

const HTML = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const AT   = new Date('2026-08-20T09:00:00');

const STATE = (over = {}) => ({
  habits: [{ id: 'h-1', name: 'Quran', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1 }],
  tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view: 'today', selectedDate: '2026-08-20' },
  ...over,
});

/* The site, as the server would serve it. `mark` is what a given "deploy"
   leaves on window so a test can tell which one it is looking at. */
async function serveSite(page) {
  const site = {
    mark: 'A', requests: 0, offline: false,
    respond: null,   // (n) => ({ status, contentType, body }) — overrides the normal page
  };
  await page.route(u => new URL(u).pathname === '/', route => {
    site.requests++;
    if (site.offline) return route.abort('internetdisconnected');
    if (site.respond) return route.fulfill(site.respond(site.requests));
    return route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: HTML.replace('</body>', `<script>window.__deploy = ${JSON.stringify(site.mark)};</script></body>`),
    });
  });
  return site;
}

async function boot(page, state = STATE()) {
  const site = await serveSite(page);
  await page.clock.install({ time: AT });
  await page.addInitScript((s) => { localStorage.setItem('madinah_v1', JSON.stringify(s)); }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  // The page knows which version it is running once it has fingerprinted itself.
  await page.waitForFunction(() => !!window.CDUpdates?.build, { timeout: 10_000 });
  await page.evaluate(() => { window.__alive = true; });   // gone after a reload
  return site;
}

const deployed = (page) => page.evaluate(() => window.__deploy);
const alive    = (page) => page.evaluate(() => window.__alive === true);
const pill     = (page) => page.getByTestId('update-pill');
const check    = (page) => page.evaluate(() => window.CDUpdates.check());
const reloadedInto = (page, mark) => page.waitForFunction((m) => window.__deploy === m, mark, { timeout: 10_000 });

test.use({ serviceWorkers: 'block' });

test.describe('noticing a new deploy', () => {
  test('an unchanged page is left alone', async ({ page }) => {
    await boot(page);
    expect(await check(page)).toBe(false);
    await expect(pill(page)).toHaveCount(0);
    expect(await alive(page)).toBe(true);
  });

  test('a new deploy reloads the app into it', async ({ page }) => {
    const site = await boot(page);
    expect(await deployed(page)).toBe('A');

    site.mark = 'B';
    await check(page);                    // nothing in use, so nothing to wait for
    await reloadedInto(page, 'B');
    expect(await alive(page)).toBe(false);   // a genuine reload, not a re-render
  });

  test('coming back to the foreground is what triggers the check', async ({ page }) => {
    const site = await boot(page);
    site.mark = 'B';

    // Resumed after a while: the throttle has passed, and the app becomes visible.
    await page.clock.fastForward(61_000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await reloadedInto(page, 'B');
  });

  test('and so does simply leaving it open', async ({ page }) => {
    const site = await boot(page);
    site.mark = 'B';
    await page.clock.fastForward(31 * 60_000);
    await reloadedInto(page, 'B');
  });

  test('coming back repeatedly inside a minute checks once', async ({ page }) => {
    const site = await boot(page);
    await page.clock.fastForward(61_000);
    const before = site.requests;
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await page.waitForFunction(() => window.CDUpdates.lastChecked && !window.CDUpdates.checking);
    expect(site.requests - before).toBe(1);
  });
});

test.describe('only reloading when it costs nothing', () => {
  test('not while text is being typed — the pill waits instead, and a tap on it goes', async ({ page }) => {
    const site = await boot(page);
    await page.evaluate(() => {
      const i = document.createElement('input'); i.id = 'draft'; document.body.appendChild(i); i.focus();
    });

    site.mark = 'B';
    expect(await check(page)).toBe(true);
    await expect(pill(page)).toBeVisible();

    await page.clock.fastForward(20_000);                 // plenty of polls
    expect(await alive(page)).toBe(true);                 // still here
    expect(await deployed(page)).toBe('A');

    await page.evaluate(() => document.getElementById('draft').blur());
    await page.clock.fastForward(4_000);                  // the next poll finds it safe
    await reloadedInto(page, 'B');
  });

  test('tapping the pill reloads even mid-typing', async ({ page }) => {
    const site = await boot(page);
    await page.evaluate(() => {
      const i = document.createElement('input'); document.body.appendChild(i); i.focus();
    });
    site.mark = 'B';
    await check(page);
    await pill(page).click();
    await reloadedInto(page, 'B');
  });

  test('not with a sheet open', async ({ page }) => {
    const site = await boot(page, STATE({ ui: { view: 'habits', selectedDate: '2026-08-20' } }));
    await page.getByRole('button', { name: 'New habit' }).click();
    await expect(page.locator('[data-modal]')).toBeVisible();
    await page.evaluate(() => document.activeElement?.blur());   // not typing — the sheet alone is what holds it

    site.mark = 'B';
    expect(await check(page)).toBe(true);
    await page.clock.fastForward(20_000);
    expect(await alive(page)).toBe(true);
    await expect(pill(page)).toBeVisible();

    await page.locator('[data-modal]').getByRole('button', { name: 'Close' }).first().click();
    await expect(page.locator('[data-modal]')).toHaveCount(0);
    await page.clock.fastForward(10_000);                 // and quiet long enough since that tap
    await reloadedInto(page, 'B');
  });

  test('not within a few seconds of a tap', async ({ page }) => {
    const site = await boot(page);
    await page.mouse.click(5, 5);

    site.mark = 'B';
    await check(page);
    await page.clock.fastForward(5_000);
    expect(await alive(page)).toBe(true);                 // 5s since the tap: still too soon

    await page.clock.fastForward(5_000);                  // 10s: quiet long enough
    await reloadedInto(page, 'B');
  });

  test('a loop is worse than a stale screen: automatic reloads are rationed', async ({ page }) => {
    const site = await boot(page);
    // Three automatic reloads already in the last ten minutes.
    await page.evaluate(() => {
      const t = Date.now();
      sessionStorage.setItem('cd_update_reloads', JSON.stringify([t - 90_000, t - 60_000, t - 30_000]));
    });

    site.mark = 'B';
    expect(await check(page)).toBe(true);
    await page.clock.fastForward(20_000);
    expect(await alive(page)).toBe(true);                 // nothing automatic
    await expect(pill(page)).toBeVisible();

    await pill(page).click();                             // a person asking is never rationed
    await reloadedInto(page, 'B');
  });
});

test.describe('not mistaking something else for a new version', () => {
  /* What comes back from `/` is not always the app: an auth gateway's login
     page, an error page, a captive portal. Each is a 200 or a 5xx that
     differs from the running page, and none is a deploy. */
  const cases = {
    'a login page from a gateway': () => ({ status: 200, contentType: 'text/html', body: '<html><body><form>Sign in</form></body></html>' }),
    'a server error':              () => ({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }),
    'something that is not HTML':  () => ({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  };
  for (const [name, respond] of Object.entries(cases)) {
    test(name, async ({ page }) => {
      const site = await boot(page);
      site.respond = respond;
      expect(await check(page)).toBe(false);
      await expect(pill(page)).toHaveCount(0);
      expect(await alive(page)).toBe(true);
    });
  }

  test('a page whose bytes change on every request is not a deploy', async ({ page }) => {
    // Something injecting a nonce or a timestamp would otherwise reload forever.
    const site = await boot(page);
    site.respond = (n) => ({ status: 200, contentType: 'text/html', body: HTML.replace('</body>', `<!-- ${n} --></body>`) });
    expect(await check(page)).toBe(false);
    await expect(pill(page)).toHaveCount(0);
    expect(await alive(page)).toBe(true);
  });

  test('offline is not a deploy either, and the next check works again', async ({ page }) => {
    const site = await boot(page);
    site.offline = true;
    expect(await check(page)).toBe(false);
    expect(await alive(page)).toBe(true);
    await expect(pill(page)).toHaveCount(0);

    site.offline = false; site.mark = 'B';
    await check(page);
    await reloadedInto(page, 'B');
  });
});

test.describe('the Admin → System card', () => {
  const openCard = async (page) => {
    await page.getByTestId('admin-nav').getByRole('button', { name: 'System' }).click();
    await expect(page.getByTestId('check-updates')).toBeVisible();
  };

  test('says so when you are up to date', async ({ page }) => {
    await boot(page, STATE({ ui: { view: 'admin', selectedDate: '2026-08-20' } }));
    await openCard(page);
    await page.getByTestId('check-updates').click();
    await expect(page.getByTestId('update-msg')).toContainText('latest version');
    expect(await alive(page)).toBe(true);
  });

  test('reloads straight away when there is a newer one — you asked', async ({ page }) => {
    const site = await boot(page, STATE({ ui: { view: 'admin', selectedDate: '2026-08-20' } }));
    await openCard(page);
    site.mark = 'B';
    await page.getByTestId('check-updates').click();
    await expect(page.getByTestId('update-msg')).toContainText('new version');
    await page.clock.fastForward(1_000);
    await reloadedInto(page, 'B');
  });
});

test.describe('a new service worker taking over', () => {
  /* sw.js changing means the browser installs a new worker, which skips
     waiting and claims the page — and the page it claims is still running the
     old JS, so that is a reason to reload whether or not index.html changed.
     The browser does the swapping; what is ours is what the page does when it
     is told, so the event is raised by hand. Needs the real worker present, so
     this block lets it run. */
  test.use({ serviceWorkers: 'allow' });

  const load = async (page) => {
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  };
  const takeOver = (page) => page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));

  test('an unchanged deploy is not mistaken for a new one — the worker\'s cached copy is the baseline', async ({ page }) => {
    /* With a worker, "what am I running" is read back from Cache Storage, and
       "what is served" from the network. If those two ever disagreed about the
       same file — encoding, a stray byte — every check would read as a new
       version and the app would reload at every opportunity. */
    await load(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15_000 });
    await page.reload();                                  // now served through the worker
    await page.waitForFunction(() => !!window.CDUpdates?.build, { timeout: 10_000 });
    await page.evaluate(() => { window.__alive = true; });

    const fromCache = await page.evaluate(async () =>
      !!(await caches.match(location.origin + location.pathname + location.search)));
    expect(fromCache).toBe(true);

    expect(await page.evaluate(() => window.CDUpdates.check())).toBe(false);
    await expect(pill(page)).toHaveCount(0);
    expect(await alive(page)).toBe(true);
  });

  test('the very first install claiming the page is not an update', async ({ page }) => {
    await load(page);                                     // nothing controls it yet
    await page.evaluate(() => { window.__alive = true; });
    await takeOver(page);
    await page.waitForTimeout(1_000);
    expect(await alive(page)).toBe(true);
    await expect(pill(page)).toHaveCount(0);
  });

  test('a new worker taking over a page that already had one reloads it', async ({ page }) => {
    await load(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15_000 });
    await page.reload();                                  // now it starts out controlled
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.evaluate(() => { window.__alive = true; });

    await takeOver(page);
    await page.waitForFunction(() => !window.__alive, { timeout: 15_000 });
  });
});
