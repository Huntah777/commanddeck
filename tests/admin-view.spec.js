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

  test('where you were is where you come back to', async ({ page }) => {
    await boot(page);
    await section(page, 'System').click();
    await expect(page.getByText(/Backup, restore, reset/).first()).toBeVisible();

    await page.locator('nav button').filter({ hasText: /^Today$/ }).first().click();
    await page.locator('nav button').filter({ hasText: /^Admin$/ }).first().click();
    await expect(page.getByText(/Backup, restore, reset/).first()).toBeVisible();
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

/* ============================================================
   Throughput
   ------------------------------------------------------------
   It used to report an all-time done/open pair over a fixed
   fourteen-day chart, which answered nothing worth asking: a lifetime
   "done" total only ever goes up, and a bare "open" count cannot tell
   a backlog built this week from one that has been sitting since
   spring. What it reports now is flow, scoped to the selected range
   like every other card on the page.
   ============================================================ */
test.describe('throughput', () => {
  /* Pinned: every fixture below is positioned relative to "now", so
     without a fixed clock these stop meaning what they say the day
     after they are written. */
  const NOW = new Date('2026-08-11T12:00:00');
  const ago = (days) => NOW.getTime() - days * DAY;

  const task = (id, over = {}) => ({
    id, title: id.toUpperCase(), done: false, quadrant: 'do', listId: 'l-inbox', ...over,
  });

  /* Two closed and one opened inside a 30-day window; one closed and
     two opened long outside it. The old card would have shown "3 done
     / 3 open" whatever range was selected. */
  const TASKS = [
    task('a', { done: true, doneAt: ago(2),   created: ago(5) }),
    task('b', { done: true, doneAt: ago(9),   created: ago(12) }),
    task('c', { done: true, doneAt: ago(200), created: ago(210) }),
    task('d', { created: ago(3) }),
    task('e', { created: ago(180), due: '2026-01-01' }),   // ancient AND overdue
    task('f', { created: ago(190) }),
  ];

  const openAt = async (page, tasks = TASKS) => {
    await page.clock.install({ time: NOW });
    await boot(page, STATE({ tasks }));
  };
  const range    = (page, label) => page.getByRole('button', { name: label, exact: true }).click();
  const rate     = (page) => page.getByTestId('throughput-rate');
  const net      = (page) => page.getByTestId('throughput-net');
  const backlog  = (page) => page.getByTestId('throughput-backlog');
  const bars     = (page) => page.getByTestId('throughput').locator('div.relative.flex-1');

  test('counts only what closed inside the selected range', async ({ page }) => {
    await openAt(page);
    // 30d: A and B closed, C (200 days ago) did not. 2 ÷ (30/7) weeks.
    await expect(rate(page)).toHaveText('0.5');

    // 7d: only A. One week, so the rate is the count.
    await range(page, '7d');
    await expect(rate(page)).toHaveText('1');

    // 1yr: all three, spread thin — 3 ÷ 52 weeks.
    await range(page, '1yr');
    await expect(rate(page)).toHaveText('0.1');
  });

  test('says whether the pile grew or shrank, which done/open never could', async ({ page }) => {
    await openAt(page);
    // 30d: 2 closed against 3 opened — losing ground.
    await expect(net(page)).toContainText('1 onto the pile');

    // A range where more was closed than opened reverses it.
    await openAt(page, [
      task('x', { done: true, doneAt: ago(1), created: ago(90) }),
      task('y', { done: true, doneAt: ago(2), created: ago(95) }),
      task('z', { created: ago(4) }),
    ]);
    await expect(net(page)).toContainText('1 off the pile');
  });

  test('nothing moving either way reads as level, not as a bare zero', async ({ page }) => {
    await openAt(page, [task('q', { done: true, doneAt: ago(1), created: ago(1) })]);
    await expect(net(page)).toHaveText('holding level');
  });

  test('names the old pile rather than burying it in an open count', async ({ page }) => {
    /* The actual complaint: three open tasks, two of which have been
       sitting since spring. "3 open" hides that; this says it. */
    await openAt(page);
    await expect(backlog(page)).toContainText('3 still open');
    await expect(backlog(page)).toContainText('2 older than this window');
    await expect(backlog(page)).toContainText('1 overdue');
  });

  test('"older than this window" is relative to the window, so a wide enough range clears it', async ({ page }) => {
    await openAt(page);
    await expect(backlog(page)).toContainText('2 older than this window');

    // Every open task was created inside the last year, so at 1yr
    // nothing is carried in — the backlog is old, but not older than
    // what is being looked at.
    await range(page, '1yr');
    await expect(backlog(page)).toContainText('3 still open');
    await expect(backlog(page)).not.toContainText('older than this window');
    await expect(backlog(page)).toContainText('1 overdue');  // still true regardless of range
  });

  test('the chart follows the range selector instead of a fixed fortnight', async ({ page }) => {
    await openAt(page);
    await expect(bars(page)).toHaveCount(30);

    await range(page, '7d');
    await expect(bars(page)).toHaveCount(7);

    await range(page, '60d');
    await expect(bars(page)).toHaveCount(60);
  });

  test('past 60 days it buckets by week, and says so', async ({ page }) => {
    /* Same rule as the habit chart beside it — 365 daily bars would be
       a smear. Both charts sit under one range selector, so a bar in
       one has to mean the same span as a bar in the other. */
    await openAt(page);
    await expect(page.getByTestId('throughput')).toContainText('30D · DAILY');

    await range(page, '1yr');
    await expect(bars(page)).toHaveCount(53);   // ceil(365 / 7)
    await expect(page.getByTestId('throughput')).toContainText('1YR · WEEKLY');
  });

  test('an empty task list reads as empty, not as broken', async ({ page }) => {
    await openAt(page, []);
    await expect(rate(page)).toHaveText('0');
    await expect(net(page)).toHaveText('holding level');
    await expect(backlog(page)).toHaveText('0 still open');
    await expect(bars(page)).toHaveCount(30);
  });

  test('a task completed before doneAt was recorded cannot land on a date it never had', async ({ page }) => {
    /* done with no doneAt is real in old data. It must not be counted
       into a window it cannot be placed in — and must not crash the
       chart by bucketing to an invalid date. */
    await openAt(page, [
      task('old', { done: true, created: ago(300) }),          // no doneAt
      task('new', { done: true, doneAt: ago(1), created: ago(1) }),
    ]);
    await expect(rate(page)).toHaveText('0.2');   // 1 ÷ (30/7), the dated one only
    await expect(backlog(page)).toContainText('0 still open');
  });
});
