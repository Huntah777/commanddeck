import { test, expect } from '@playwright/test';

/* The review card in the Stats view. /api/coach is mocked throughout —
   the digest arithmetic and the spend guard are unit-tested in
   coach.spec.js; what matters here is that the client never decides
   whether a paid call is allowed, and that a refusal reads as
   information rather than as an error. */

const REVIEW = {
  headline: 'Habits held at 71% but the last week slipped to 43%.',
  failing: [
    { area: 'Fajr', evidence: '4/7 in the last week, down from 19/21', why: 'the anchor of the whole day' },
    { area: 'Overdue tasks', evidence: '6 open past their date', why: 'they stop being real deadlines' },
  ],
  actions: [
    { action: 'Set Fajr reminder 15 minutes earlier', because: 'the misses cluster on weekdays' },
    { action: 'Clear or re-date the 6 overdue tasks', because: 'oldest is from 1 July' },
  ],
  working: { area: 'Focus sessions', evidence: '18 sessions, 450 minutes this month' },
  note: 'Fajr slipped in week 4 — check whether the earlier reminder held.',
};

async function seed(page, { coach = null, token = 'test-token' } = {}) {
  const STATE = {
    habits: [{ id: 'h-1', title: 'Fajr', pillar: 'deen', days: [0, 1, 2, 3, 4, 5, 6], created: 1 }],
    tasks: [], blocks: [], logs: {}, people: [],
    lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
    coach,
    ui: { view: 'stats' },
  };
  await page.addInitScript(([state, token]) => {
    if (token) localStorage.setItem('madinah_token', token);
    localStorage.setItem('madinah_v1', JSON.stringify(state));
  }, [STATE, token]);

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
  return { setStored: (patch) => { stored = { ...stored, ...patch }; version++; } };
}

function mockCoach(page, reply, opts = {}) {
  const api = { calls: 0, lastBody: null, lastAuth: null, release: null };
  const gate = opts.hold ? new Promise(res => { api.release = res; }) : null;
  page.route('**/api/coach', async (route) => {
    api.calls++;
    api.lastAuth = route.request().headers()['authorization'];
    try { api.lastBody = JSON.parse(route.request().postData() || '{}'); } catch {}
    if (gate) await gate;
    await route.fulfill({
      status: opts.status || 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reply),
    });
  });
  return api;
}

const boot = async (page) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const card = (page) => page.locator('div.card').filter({ hasText: "What you're failing on" });
const runButton = (page) => card(page).getByRole('button', { name: /Run review|Refresh|Thinking/ });

test.describe('review card', () => {
  test('a stored review renders its verdict, evidence and actions', async ({ page }) => {
    await seed(page, { coach: { at: Date.now() - 2 * 86_400_000, review: REVIEW, runs: [], notes: [] } });
    await boot(page);

    const review = page.getByTestId('coach-review');
    await expect(review).toContainText('slipped to 43%');
    await expect(review).toContainText('Fajr');
    await expect(review).toContainText('4/7 in the last week');       // evidence, not just a claim
    await expect(review).toContainText('Set Fajr reminder 15 minutes earlier');
    await expect(review).toContainText('Focus sessions');             // the thing going well
  });

  test('it names the model that wrote it and when', async ({ page }) => {
    await seed(page, { coach: { at: Date.now() - 2 * 86_400_000, review: REVIEW, runs: [], notes: [] } });
    await boot(page);
    await expect(page.getByTestId('coach-review')).toContainText('claude opus 5');
    await expect(page.getByTestId('coach-review')).toContainText('2d ago');
  });

  test('with no review yet it explains what the thing does', async ({ page }) => {
    await seed(page);
    await boot(page);
    await expect(card(page)).toContainText('No review yet');
    await expect(page.getByTestId('coach-review')).toHaveCount(0);
  });

  test('without sync there is nothing to run and no button offered', async ({ page }) => {
    await seed(page, { token: null });
    await boot(page);
    await expect(card(page)).toContainText('Connect sync');
    await expect(runButton(page)).toHaveCount(0);
  });
});

test.describe('running a review', () => {
  test('the request is authenticated and carries the device\'s own today', async ({ page }) => {
    // An unauthenticated endpoint that bills Opus tokens would be a
    // stranger spending this account's money.
    const api = mockCoach(page, { review: REVIEW, cached: false, at: Date.now() });
    await seed(page);
    await boot(page);
    await runButton(page).click();

    await expect.poll(() => api.lastAuth, { timeout: 10_000 }).toBe('Bearer test-token');
    expect(api.lastBody.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('the button shows it is working and cannot be double-fired', async ({ page }) => {
    // Opus takes ~20s. Without a disabled state an impatient second click
    // is a second bill.
    const api = mockCoach(page, { review: REVIEW, cached: false }, { hold: true });
    await seed(page);
    await boot(page);

    await runButton(page).click();
    await expect(runButton(page)).toContainText('Thinking');
    await expect(runButton(page)).toBeDisabled();

    api.release();
    await expect(runButton(page)).not.toContainText('Thinking', { timeout: 10_000 });
    expect(api.calls).toBe(1);
  });

  test('a fresh review pulls from the server rather than trusting the response', async ({ page }) => {
    // /api/coach writes the review into synced state itself, so the
    // client re-reads rather than rendering its own copy — otherwise
    // this device and the others would disagree.
    const { setStored } = await seed(page);
    mockCoach(page, { review: REVIEW, cached: false, at: Date.now() });
    await boot(page);
    await expect(card(page)).toContainText('No review yet');

    setStored({ coach: { at: Date.now(), review: REVIEW, runs: [Date.now()], notes: [] } });
    await runButton(page).click();

    await expect(page.getByTestId('coach-review')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('coach-review')).toContainText('slipped to 43%');
  });
});

test.describe('spend refusals read as information', () => {
  /* The server owns the limits. The card's job is to say what happened
     in words that tell you what to do, not to surface a raw error. */
  const cases = [
    ['not_due',      /Next review/i],
    ['unchanged',    /Nothing has moved/i],
    ['too_soon',     /in an hour/i],
    ['weekly_limit', /Three reviews used/i],
  ];

  for (const [reason, expected] of cases) {
    test(`"${reason}" is explained, not shown as a failure`, async ({ page }) => {
      await seed(page, { coach: { at: Date.now() - 3600_000, review: REVIEW, runs: [], notes: [] } });
      mockCoach(page, { review: REVIEW, cached: true, reason });
      await boot(page);
      await runButton(page).click();

      await expect(page.getByTestId('coach-msg')).toContainText(expected, { timeout: 10_000 });
      // The previous review stays on screen — a refusal is not a reset.
      await expect(page.getByTestId('coach-review')).toBeVisible();
    });
  }

  test('a missing AI binding says what to do about it', async ({ page }) => {
    await seed(page);
    mockCoach(page, { error: 'not_configured', detail: 'AI binding missing' }, { status: 500 });
    await boot(page);
    await runButton(page).click();
    await expect(page.getByTestId('coach-msg')).toContainText(/Workers AI binding/i, { timeout: 10_000 });
  });

  test('a failed review leaves the previous one intact', async ({ page }) => {
    await seed(page, { coach: { at: Date.now() - 8 * 86_400_000, review: REVIEW, runs: [], notes: [] } });
    mockCoach(page, { error: 'review_failed' }, { status: 502 });
    await boot(page);
    await runButton(page).click();

    await expect(page.getByTestId('coach-msg')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('coach-review')).toContainText('slipped to 43%');
  });

  test('an error the client has no specific copy for still shows the server\'s own words', async ({ page }) => {
    // This was the actual bug: every failure that wasn't 'not_configured'
    // or 'timeout' collapsed into one unhelpful "could not reach the
    // service" string, indistinguishable from a dead network. The
    // server's error and detail must reach the screen, not get thrown
    // away in favour of a catch-all.
    await seed(page);
    mockCoach(page, { error: 'internal_error', detail: 'D1_WRITE_FAILED' }, { status: 500 });
    await boot(page);
    await runButton(page).click();

    const msg = page.getByTestId('coach-msg');
    await expect(msg).toContainText('internal_error', { timeout: 10_000 });
    await expect(msg).toContainText('D1_WRITE_FAILED');
  });

  test('a response with no parseable body at all is reported as a network failure, not silently ignored', async ({ page }) => {
    // The exact failure mode this whole fix targets: an unhandled
    // exception makes Cloudflare return a bare error page instead of
    // JSON. r.json() can't parse it, so the client must still say
    // something rather than leave the button looking like nothing
    // happened.
    await page.route('**/api/coach', route => route.fulfill({ status: 500, contentType: 'text/plain', body: 'internal error' }));
    await seed(page);
    await boot(page);
    await runButton(page).click();
    await expect(page.getByTestId('coach-msg')).toBeVisible({ timeout: 10_000 });
  });
});
