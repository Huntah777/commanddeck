import { test, expect } from '@playwright/test';

/* End-to-end natural-language capture. The parse itself is unit-tested in
   parse.spec.js; what matters here is the contract between the input box
   and the endpoint:

     - the task exists locally before the network is touched, so capture
       never blocks and never depends on the parse arriving;
     - a field the user set by hand is never overwritten by the parser;
     - the filing is shown, with its reasoning, and can be undone.

   /api/parse is mocked throughout — these assert the client's behaviour,
   not the model's. */

const boot = async (page) => {
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

/* A synced device with one demoted person registered.

   The state endpoint is a stateful echo rather than a fixed body: the app
   treats an empty `habits` from the server as a first run and replaces
   local state with a fresh seed, and a PUT whose reply doesn't look like
   a real one gets applied over the state that was just captured. Both
   would quietly undo the thing under test. */
async function seed(page, extra = {}) {
  const STATE = {
    habits: [{ id: 'h-1', title: 'Fajr', pillar: 'deen', days: [0, 1, 2, 3, 4, 5, 6], created: 1 }],
    tasks: [], blocks: [], logs: {},
    lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
    people: [{ id: 'pp-mgr', name: 'Dave', aliases: ['manager'], weight: 2 }],
    /* The Tasks view, not Today — Today lists only what's due today, and
       a parsed due date would filter the task straight off the screen. */
    ui: { view: 'tasks' },
    ...extra,
  };
  await page.addInitScript((state) => {
    localStorage.setItem('madinah_token', 'test-token');
    localStorage.setItem('madinah_v1', JSON.stringify(state));
  }, STATE);

  let stored = STATE, version = 1;
  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'PUT') {
      stored = { ...stored, ...JSON.parse(route.request().postData() || '{}') };
      version++;
      return route.fulfill({
        status: 200, headers: { 'Content-Type': 'application/json', ETag: `"v${version}"` },
        body: JSON.stringify({ ok: true, updated_at: version, data: stored }),
      });
    }
    await route.fulfill({
      status: 200, headers: { 'Content-Type': 'application/json', ETag: `"v${version}"` },
      body: JSON.stringify(stored),
    });
  });
}

/* Mock /api/parse. `hold` delays the reply so the pre-parse state is
   observable; `fail` makes the endpoint unavailable. */
function mockParse(page, reply, opts = {}) {
  const api = { calls: 0, lastBody: null, release: null };
  const gate = opts.hold ? new Promise(res => { api.release = res; }) : null;
  page.route('**/api/parse', async (route) => {
    api.calls++;
    try { api.lastBody = JSON.parse(route.request().postData() || '{}'); } catch {}
    if (gate) await gate;
    if (opts.fail) return route.fulfill({ status: 500, body: '{}' });
    await route.fulfill({
      status: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reply),
    });
  });
  return api;
}

const capture = async (page, text) => {
  const box = page.getByPlaceholder('Capture a task…').first();
  await box.fill(text);
  await box.press('Enter');
};

const tasks = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}').tasks || []);

const FILED = {
  title: 'Send Dave the deck', due: '2026-07-31', quadrant: 'delegate',
  listId: 'l-inbox', personId: 'pp-mgr', personName: 'Dave',
  why: ['Dave · weight 2', 'not important', 'due in 2d'], source: 'ai',
};

test.describe('natural-language capture', () => {
  test('the task exists before the parse comes back', async ({ page }) => {
    // Capture is a foreground interaction. If it waited on the network it
    // would fail on a train, and the parse is only ever an enhancement.
    const api = mockParse(page, FILED, { hold: true });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect(page.getByText('dave needs the deck by friday')).toBeVisible();
    expect((await tasks(page))[0].title).toBe('dave needs the deck by friday');

    api.release();
    await expect(page.getByTestId('parse-receipt')).toBeVisible({ timeout: 10_000 });
  });

  test('the parse files the task and shows what it decided', async ({ page }) => {
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');

    await expect.poll(async () => (await tasks(page))[0], { timeout: 10_000 })
      .toMatchObject({ title: 'Send Dave the deck', due: '2026-07-31', quadrant: 'delegate', personId: 'pp-mgr' });

    const receipt = page.getByTestId('parse-receipt');
    await expect(receipt).toContainText('Delegate');   // the quadrant's own label
    await expect(receipt).toContainText('Dave');
    await expect(receipt).toContainText('due in 2d');  // and why
  });

  test('undo restores exactly what was captured', async ({ page }) => {
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect(page.getByTestId('parse-receipt')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('parse-receipt').getByText('UNDO').click();

    await expect.poll(async () => (await tasks(page))[0], { timeout: 5_000 })
      .toMatchObject({ title: 'dave needs the deck by friday', quadrant: 'plan', personId: null });
  });

  test('a hand-set quadrant is never overwritten by the parser', async ({ page }) => {
    // Stated beats inferred. Touching any field opts that capture out.
    const api = mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    const box = page.getByPlaceholder('Capture a task…').first();
    await box.fill('dave needs the deck by friday');
    await page.locator('select').filter({ hasText: 'Eliminate' }).first().selectOption('do');
    await box.press('Enter');

    await page.waitForTimeout(1_500);
    expect(api.calls).toBe(0);
    expect((await tasks(page))[0]).toMatchObject({ quadrant: 'do', title: 'dave needs the deck by friday' });
  });

  test('a failed parse leaves the task exactly as captured', async ({ page }) => {
    mockParse(page, null, { fail: true });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await page.waitForTimeout(1_500);

    expect((await tasks(page))[0]).toMatchObject({ title: 'dave needs the deck by friday', quadrant: 'plan' });
    await expect(page.getByTestId('parse-receipt')).toHaveCount(0);
  });

  test('capture works with no sync configured and never calls the endpoint', async ({ page }) => {
    // No token means no server, so there is nothing to authenticate with
    // and no reason to try.
    const api = mockParse(page, FILED);
    await page.addInitScript(() => localStorage.setItem('madinah_v1', JSON.stringify({
      habits: [], tasks: [], blocks: [], logs: {},
      lists: [{ id: 'l-inbox', name: 'Inbox' }], ui: { view: 'tasks' },
    })));
    await page.goto('/');
    await boot(page);

    await capture(page, 'buy milk');
    await page.waitForTimeout(1_000);
    expect(api.calls).toBe(0);
    expect((await tasks(page))[0].title).toBe('buy milk');
  });

  test('the endpoint is sent the people table and the device\'s own today', async ({ page }) => {
    // Weights are policy and live on the client; the date has to be the
    // user's local one, or every relative phrase resolves off by a day.
    const api = mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(() => api.lastBody, { timeout: 10_000 }).toBeTruthy();

    expect(api.lastBody.text).toBe('dave needs the deck by friday');
    expect(api.lastBody.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(api.lastBody.people).toContainEqual(expect.objectContaining({ name: 'Dave', weight: 2 }));
  });

  test('the request is authenticated', async ({ page }) => {
    // An unauthenticated parse endpoint on a public domain is a free LLM
    // billed to this account.
    let auth = null;
    await page.route('**/api/parse', async (route) => {
      auth = route.request().headers()['authorization'];
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FILED) });
    });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(() => auth, { timeout: 10_000 }).toBe('Bearer test-token');
  });

  test('a re-filed task is remembered as a correction', async ({ page }) => {
    // Re-filing is the only correction signal there is — it is what makes
    // the weights self-tuning, so the parser's own choice has to survive
    // alongside the one the user made.
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(async () => (await tasks(page))[0]?.aiQuadrant, { timeout: 10_000 }).toBe('delegate');

    await page.getByText('Send Dave the deck').click();
    await page.locator('select').filter({ hasText: 'Delegate' }).first().selectOption('do');
    await page.getByRole('button', { name: /save/i }).first().click();

    const t = (await tasks(page))[0];
    expect(t.quadrant).toBe('do');
    expect(t.aiQuadrant).toBe('delegate'); // the disagreement is still legible
  });
});
