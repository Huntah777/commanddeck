import { test, expect } from '@playwright/test';

/* The Admin tab — what used to be Stats, before it grew into eleven
   unrelated cards in one column. The tests that matter here are the
   ones about not losing anything in the reorganisation: every card that
   existed before must still be reachable, and the old ?view=stats link
   must still land somewhere sensible. */

const DAY = 86_400_000;

const STATE = (over = {}) => ({
  habits: [{ id: 'h-1', name: 'Fajr', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1 }],
  tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788', keywords: [] }],
  ui: { view: 'admin' },
  ...over,
});

const boot = async (page, state = STATE(), url = '/') => {
  await page.addInitScript((s) => localStorage.setItem('madinah_v1', JSON.stringify(s)), state);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const nav     = (page) => page.getByTestId('admin-nav');
const section = (page, name) => nav(page).getByRole('button', { name });

test.describe('finding your way around', () => {
  test('it opens on the numbers', async ({ page }) => {
    await boot(page);
    await expect(page.getByText("The numbers don't lie")).toBeVisible();
    await expect(nav(page)).toBeVisible();
  });

  test('one section is on screen at a time', async ({ page }) => {
    /* The whole point of the change: the theme picker is no longer
       sitting three screens below the habit chart. */
    await boot(page);
    await expect(page.getByText('Background')).toHaveCount(0);

    await section(page, 'Appearance').click();
    await expect(page.getByText('Background').first()).toBeVisible();
    await expect(page.getByText("The numbers don't lie")).toHaveCount(0);
  });

  test('every card that existed before is still reachable', async ({ page }) => {
    await boot(page);
    const expected = [
      ['Setup',      /Configuration/],
      ['Setup',      /Prayer times|Salah/i],
      ['Alerts',     /Notifications/i],
      ['Alerts',     /reminder/i],
      ['Appearance', /Background/],
      ['System',     /Sync/i],
      ['System',     /Backup, restore, reset/],
    ];
    for (const [tab, text] of expected) {
      await section(page, tab).click();
      await expect(page.getByText(text).first()).toBeVisible();
    }
  });

  test('the review card stays with the numbers it reads', async ({ page }) => {
    // It is a reading of the overview, not a preference.
    await boot(page);
    await expect(page.locator('div.card').filter({ hasText: "What you're failing on" })).toBeVisible();
  });

  test('where you were is where you come back to', async ({ page }) => {
    await boot(page);
    await section(page, 'System').click();
    await expect(page.getByTestId('ai-spend')).toBeVisible();

    await page.locator('nav button').filter({ hasText: /^Today$/ }).first().click();
    await page.locator('nav button').filter({ hasText: /^Admin$/ }).first().click();
    await expect(page.getByTestId('ai-spend')).toBeVisible();
  });
});

test.describe('the old name still works', () => {
  test('?view=stats lands on Admin', async ({ page }) => {
    // Manifest shortcuts, bookmarks, and any device that synced its view
    // before the rename.
    await boot(page, STATE({ ui: {} }), '/?view=stats');
    await expect(nav(page)).toBeVisible();
    await expect(page.getByText("The numbers don't lie")).toBeVisible();
  });

  test('a device-local view of "stats" is not left pointing at nothing', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('madinah_v1', JSON.stringify({ habits: [], ui: { view: 'today' } }));
      localStorage.setItem('madinah_ui_local_v1', JSON.stringify({ view: 'stats', selectedDate: '2026-07-29' }));
    });
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    await expect(nav(page)).toBeVisible();
  });
});

test.describe('AI spend', () => {
  /* Built from calls this app made and the token counts the APIs
     reported back — never scraped from a billing page, so it can be
     asserted on exactly. */

  const withUsage = () => STATE({
    tasks: [
      { id: 't-1', title: 'One', done: false, created: 1, ai: { at: Date.now() - DAY, tok: { i: 400, o: 60 } } },
      { id: 't-2', title: 'Two', done: false, created: 1, ai: { at: Date.now() - 2 * DAY, tok: { i: 400, o: 60 } } },
    ],
    coach: {
      at: Date.now(), review: null, runs: [], notes: [],
      history: [{ at: Date.now() - 3 * DAY, note: 'x', actions: [], metrics: {}, usage: { i: 1400, o: 1100 } }],
    },
  });

  const card = (page) => page.getByTestId('ai-spend');

  test('the two bills are reported separately', async ({ page }) => {
    /* Capture is Neurons against a daily free allowance; reviews are
       Opus at real per-token rates. One combined number would hide
       which of them is actually costing anything. */
    await boot(page, withUsage());
    await section(page, 'System').click();

    await expect(card(page)).toContainText('WORKERS AI');
    await expect(card(page)).toContainText('UNIFIED BILLING');
    await expect(card(page)).toContainText('2 parsed');
    await expect(card(page)).toContainText('1 run ·');
  });

  test('capture inside the daily allowance costs nothing and says so', async ({ page }) => {
    await boot(page, withUsage());
    await section(page, 'System').click();
    await expect(card(page)).toContainText('Inside the free 10k/day allowance');
  });

  test('the review is priced from the tokens it actually used', async ({ page }) => {
    // 1400 in at $5/M + 1100 out at $25/M = $0.0345, +5% top-up fee,
    // at £0.79/$ ≈ £0.0286 → rounds to £0.03.
    await boot(page, withUsage());
    await section(page, 'System').click();
    await expect(card(page)).toContainText('1.4k tokens in');
    await expect(card(page)).toContainText('1.1k out');
    await expect(page.getByTestId('spend-total')).toHaveText('£0.03');
  });

  test('an estimated figure is labelled as one', async ({ page }) => {
    /* Runs and captures that predate token logging are still counted —
       silently dropping them would understate the bill — but the card
       has to say which numbers are measured and which are not. */
    await boot(page, STATE({
      tasks: [{ id: 't-1', title: 'One', done: false, created: 1, ai: { at: Date.now() - DAY } }],
      coach: { at: Date.now(), runs: [], notes: [], history: [{ at: Date.now() - DAY, metrics: {} }] },
    }));
    await section(page, 'System').click();
    await expect(card(page)).toContainText('estimated');
    await expect(card(page)).toContainText('predate token logging');
    // And it is still costed. Dropping what wasn't metered would report
    // a bill of zero for a review that was genuinely paid for.
    await expect(page.getByTestId('spend-total')).toHaveText('£0.03');
  });

  test('nothing spent reads as nothing spent, not as £0.00 of something', async ({ page }) => {
    await boot(page);
    await section(page, 'System').click();
    await expect(card(page)).toContainText('Nothing spent in this window');
    await expect(page.getByTestId('spend-total')).toHaveCount(0);
  });

  /* Two captures of ~8k neurons each. Spread over two days both fit
     inside the allowance; landed on one day the second is mostly
     billable. The pair is the test: a month-wide total against a
     month's worth of allowance calls both cases free, and quietly
     under-reports the one that actually costs money. */
  const heavy = (at, id) => ({ id, title: 'Heavy', done: false, created: 1, ai: { at, tok: { i: 100_000, o: 220_000 } } });

  test('a heavy day either side of midnight is two allowances', async ({ page }) => {
    const now = Date.now();
    await boot(page, STATE({ tasks: [heavy(now - DAY, 't-a'), heavy(now - 2 * DAY, 't-b')] }));
    await section(page, 'System').click();
    await expect(card(page)).toContainText('Inside the free 10k/day allowance');
  });

  test('the same load on one day spills over it', async ({ page }) => {
    const now = Date.now();
    await boot(page, STATE({ tasks: [heavy(now - DAY, 't-a'), heavy(now - DAY, 't-b')] }));
    await section(page, 'System').click();
    await expect(card(page)).toContainText('over the free 10k/day');
  });

  test('spend outside the window is not counted in it', async ({ page }) => {
    await boot(page, STATE({
      tasks: [{ id: 't-old', title: 'Old', done: false, created: 1, ai: { at: Date.now() - 200 * DAY, tok: { i: 400, o: 60 } } }],
      coach: { at: 1, runs: [], notes: [], history: [{ at: Date.now() - 200 * DAY, metrics: {}, usage: { i: 1400, o: 1100 } }] },
    }));
    await section(page, 'System').click();
    await expect(card(page)).toContainText('Nothing spent in this window');

    await card(page).getByRole('button', { name: '1YR' }).click();
    await expect(page.getByTestId('spend-total')).toHaveText('£0.03');
  });
});
