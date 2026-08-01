import { test, expect } from '@playwright/test';

/* Day / week / month on the Today tab.

   The three scopes are three drawings of the same data — the same
   resolved blocks, the same logs, the same selected date. What these
   tests pin down is that they agree: a block that repeats Mon–Fri shows
   up on five columns of the week and on every weekday cell of the
   month, and tapping any of those days lands the day view exactly
   there.

   The clock is pinned because the Today tab resets selectedDate to the
   real today on load (landToday) — without it these fixtures stop being
   "today" the day after they're written. 2026-07-29 is a Wednesday, and
   its week (Mon 27 Jul – Sun 2 Aug) deliberately straddles a month
   boundary. */

const DAILY = [0,1,2,3,4,5,6];

const BLOCKS = [
  { id: 'b-deep',    title: 'Deep work', pillar: 'tech',     start:  9*60, end: 11*60, every: [1,2,3,4,5] },
  { id: 'b-council', title: 'Council',   pillar: 'strategy', start: 14*60, end: 15*60, every: [1] },
];

const HABITS = [
  { id: 'h-fajr', name: 'Fajr in jama', pillar: 'deen', days: DAILY, created: 1, reminder: null },
  { id: 'h-gym',  name: 'Gym',          pillar: 'combat', days: [1,3,5], created: 1, reminder: null },
];

const STATE = (over = {}) => ({
  habits: HABITS, tasks: [], blocks: BLOCKS, logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view: 'today', selectedDate: '2026-07-29' },
  ...over,
});

const boot = async (page, state = STATE()) => {
  await page.clock.install({ time: new Date('2026-07-29T09:30:00') });
  await page.addInitScript((s) => {
    if (!localStorage.getItem('madinah_v1')) localStorage.setItem('madinah_v1', JSON.stringify(s));
  }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const stored     = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
const scope      = (page, name) => page.getByTestId(`scope-${name}`).click();
const weekBlock  = (page, title) => page.getByTestId('week-time-block').filter({ hasText: title });
const monthCell  = (page, date) => page.locator(`[data-testid="month-day"][data-date="${date}"]`);

test.describe('choosing a scope', () => {
  test('opens on the day, and the timeline is what it draws', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('time-block').first()).toBeVisible();
    await expect(page.getByTestId('week-calendar')).toHaveCount(0);
    await expect(page.getByTestId('month-calendar')).toHaveCount(0);
  });

  test('week and month replace the timeline, not sit alongside it', async ({ page }) => {
    await boot(page);

    await scope(page, 'week');
    await expect(page.getByTestId('week-calendar')).toBeVisible();
    await expect(page.getByTestId('time-block')).toHaveCount(0);

    await scope(page, 'month');
    await expect(page.getByTestId('month-calendar')).toBeVisible();
    await expect(page.getByTestId('week-calendar')).toHaveCount(0);

    await scope(page, 'day');
    await expect(page.getByTestId('time-block').first()).toBeVisible();
  });

  test('the chosen scope survives a reload', async ({ page }) => {
    /* Device-local, deliberately kept out of the synced blob — so it has
       to be its own localStorage key, not part of state. */
    await boot(page);
    await scope(page, 'month');
    await expect(page.getByTestId('month-calendar')).toBeVisible();

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    await expect(page.getByTestId('month-calendar')).toBeVisible();

    const s = await stored(page);
    expect(s.ui.todayScope).toBeUndefined();
  });
});

test.describe('the week', () => {
  test('runs Monday to Sunday over the week holding the selected day', async ({ page }) => {
    await boot(page);
    await scope(page, 'week');

    const headers = page.getByTestId('week-day-header');
    await expect(headers).toHaveCount(7);
    /* Mon 27 Jul → Sun 2 Aug, so the week crosses into August. */
    await expect(headers.nth(0)).toContainText('MON');
    await expect(headers.nth(0)).toContainText('27');
    await expect(headers.nth(6)).toContainText('SUN');
    await expect(headers.nth(6)).toContainText('2');
    await expect(page.getByTestId('period-label')).toHaveText('27 Jul – 2 Aug 2026');
  });

  test('a block appears on exactly the days it repeats on', async ({ page }) => {
    await boot(page);
    await scope(page, 'week');
    await expect(weekBlock(page, 'Deep work')).toHaveCount(5);   // Mon–Fri
    await expect(weekBlock(page, 'Council')).toHaveCount(1);     // Mondays only
  });

  test('stepping a period moves a whole week, not a day', async ({ page }) => {
    await boot(page);
    await scope(page, 'week');

    await page.getByTestId('period-next').click();
    await expect(page.getByTestId('period-label')).toHaveText('3–9 Aug 2026');
    await expect(page.getByTestId('week-day-header').nth(0)).toContainText('3');

    await page.getByTestId('period-prev').click();
    await page.getByTestId('period-prev').click();
    await expect(page.getByTestId('period-label')).toHaveText('20–26 Jul 2026');

    await page.getByTestId('period-today').click();
    await expect(page.getByTestId('period-label')).toHaveText('27 Jul – 2 Aug 2026');
  });

  test('tapping a date opens that day', async ({ page }) => {
    await boot(page);
    await scope(page, 'week');
    await page.getByRole('button', { name: 'Open Friday 31 July' }).click();

    await expect(page.getByTestId('week-calendar')).toHaveCount(0);
    await expect(page.locator('header')).toContainText('Friday');
    await expect(page.locator('header')).toContainText('31 July 2026');
    const s = await stored(page);
    expect(s.ui.selectedDate).toBe('2026-07-31');
  });

  test('clicking an empty hour drops the block on that column, not the selected day', async ({ page }) => {
    /* The whole point of adding from a week grid: the day you clicked
       is the day it lands on. Selected date is Wednesday throughout. */
    await boot(page);
    await scope(page, 'week');

    await page.getByLabel('Add block on Fri at 16:00').click();
    await page.getByPlaceholder('Deep work · Asbab al-Nuzul · etc.').fill("Jumu'ah prep");
    await page.getByRole('button', { name: 'Save block' }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(3);
    const saved = (await stored(page)).blocks.find(b => b.title === "Jumu'ah prep");
    expect(saved.every).toEqual([5]);     // Friday
    expect(saved.start).toBe(960);        // 16:00
  });
});

test.describe('the month', () => {
  test('draws whole weeks, dated from the month it is showing', async ({ page }) => {
    await boot(page);
    await scope(page, 'month');

    /* July 2026 starts on a Wednesday and ends on a Friday — five whole
       Monday-start weeks, 29 Jun through 2 Aug. */
    await expect(page.getByTestId('month-day')).toHaveCount(35);
    await expect(monthCell(page, '2026-06-29')).toBeVisible();
    await expect(monthCell(page, '2026-08-02')).toBeVisible();
    await expect(page.getByTestId('period-label')).toHaveText('July 2026');
  });

  test('stepping a period moves a whole month', async ({ page }) => {
    await boot(page);
    await scope(page, 'month');

    await page.getByTestId('period-next').click();
    await expect(page.getByTestId('period-label')).toHaveText('August 2026');
    await expect(page.getByTestId('month-day')).toHaveCount(42);

    await page.getByTestId('period-today').click();
    await expect(page.getByTestId('period-label')).toHaveText('July 2026');
  });

  test('a day shows how many of its habits are done', async ({ page }) => {
    /* Wednesday runs Fajr only (Gym is Mon/Wed/Fri — so Wed runs both).
       28 Jul is a Tuesday: Fajr only, and it is ticked. */
    await boot(page, STATE({ logs: { '2026-07-28': { 'h-fajr': 1 }, '2026-07-29': { 'h-fajr': 1 } } }));
    await scope(page, 'month');

    await expect(monthCell(page, '2026-07-28')).toHaveAttribute('data-habits', '1/1');
    await expect(monthCell(page, '2026-07-29')).toHaveAttribute('data-habits', '1/2');
  });

  test('tapping a day opens it', async ({ page }) => {
    await boot(page);
    await scope(page, 'month');
    await monthCell(page, '2026-07-16').click();

    await expect(page.getByTestId('month-calendar')).toHaveCount(0);
    await expect(page.locator('header')).toContainText('16 July 2026');
    const s = await stored(page);
    expect(s.ui.selectedDate).toBe('2026-07-16');
  });

  test('tasks due that day are counted on the cell', async ({ page }) => {
    await boot(page, STATE({ tasks: [
      { id: 't1', title: 'File accounts', due: '2026-07-30', done: false, quadrant: 'do', created: 1 },
      { id: 't2', title: 'Call Yusuf',    due: '2026-07-30', done: false, quadrant: 'do', created: 1 },
      { id: 't3', title: 'Done already',  due: '2026-07-30', done: true,  quadrant: 'do', created: 1 },
    ] }));
    await scope(page, 'month');
    /* Three tasks on the day, one already done — the badge counts what
       is still outstanding. */
    await expect(monthCell(page, '2026-07-30').getByTestId('month-due')).toHaveText('2');
  });
});
