import { test, expect } from '@playwright/test';

/* Ticking a habit off from the Habits tab.

   Until now the tab was read-only — five columns of heatmaps — so the
   only place in the app you could actually mark a habit done was Today.
   These are about the tick being real (it reaches the same logs, from
   the same write) and about the list around it: which habits show for
   the selected day, and which sink to the bottom once they're done. */

const DAY = '2026-08-20';          // a Thursday
const AT  = new Date('2026-08-20T09:13:00');

const HABITS = [
  { id: 'h-quran', name: 'Quran',        pillar: 'deen',      days: [0,1,2,3,4,5,6], created: 1, icon: '📖' },
  { id: 'h-fajr',  name: 'Fajr',         pillar: 'deen',      days: [0,1,2,3,4,5,6], created: 2 },
  { id: 'h-ship',  name: 'Ship a commit',pillar: 'tech',      days: [1,2,3,4,5],     created: 3 },
  { id: 'h-gym',   name: 'Gym',          pillar: 'combat',    days: [1,3,5],         created: 4 },  // not Thursday
  { id: 'h-call',  name: 'Call parents', pillar: 'character', days: [2,4],           created: 5 },
];

const STATE = (over = {}) => ({
  habits: HABITS, tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view: 'habits', selectedDate: DAY },
  ...over,
});

const boot = async (page, state = STATE()) => {
  await page.clock.install({ time: AT });
  await page.addInitScript((s) => {
    localStorage.setItem('madinah_v1', JSON.stringify(s));
    /* view lives on the device, not in the synced blob — seeding it in
       `ui` alone leaves hydrate() restoring whatever this device last
       had, which is Today. */
    localStorage.setItem('madinah_ui_local_v1', JSON.stringify({ view: 'habits', selectedDate: s.ui.selectedDate }));
  }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
/* The tab bar is a row of buttons from 640px and a <select> below it,
   and these run on both a desktop and a phone viewport. */
const goTab = async (page, name) => {
  const select = page.getByLabel('Section');
  if (await select.isVisible()) await select.selectOption({ label: name });
  else await page.locator('nav button').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
};
const rows   = (page) => page.getByTestId('habit-list').getByTestId('habit-row');
const row    = (page, name) => page.getByTestId('habit-row').filter({ hasText: name }).first();
const names  = (page) => rows(page).evaluateAll(els => els.map(e => e.querySelector('button')?.innerText.split('\n')[0]));

test.describe('ticking a habit from the Habits tab', () => {
  test('the tick reaches the log for the selected day', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Tick Quran' }).click();

    await expect.poll(async () => (await stored(page)).logs?.[DAY]?.['h-quran'], { timeout: 10_000 }).toBeTruthy();
    await expect(row(page, 'Quran')).toHaveAttribute('data-done', '1');
  });

  test('un-ticking is recorded, not merely dropped', async ({ page }) => {
    /* Bare absence loses the sync merge — the stored tick unions back
       over it and the row re-ticks itself a second later. */
    await boot(page);
    await page.getByRole('button', { name: 'Tick Quran' }).click();
    await expect(row(page, 'Quran')).toHaveAttribute('data-done', '1');

    await page.getByRole('button', { name: 'Untick Quran' }).click();
    await expect(row(page, 'Quran')).toHaveAttribute('data-done', '0');

    await expect.poll(async () => {
      const s = await stored(page);
      return !!s.logsOff?.[DAY]?.['h-quran'] && !s.logs?.[DAY]?.['h-quran'];
    }, { timeout: 10_000 }).toBe(true);
  });

  test('it is the same tick as Today’s — one shows up in the other', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Tick Fajr' }).click();
    await expect(row(page, 'Fajr')).toHaveAttribute('data-done', '1');

    /* The clock is pinned to the seeded day, so Today opens on it. */
    await goTab(page, 'Today');
    const checklistFajr = page.getByTestId('checklist-habit').filter({ hasText: 'Fajr' }).first();
    await expect(checklistFajr.locator('.tick.on')).toHaveCount(1);
  });

  test('done sinks to the bottom, so what is left is under your thumb', async ({ page }) => {
    await boot(page);
    expect(await names(page)).toEqual(['Quran', 'Fajr', 'Ship a commit', 'Call parents']);

    await page.getByRole('button', { name: 'Tick Quran' }).click();
    await expect.poll(() => names(page)).toEqual(['Fajr', 'Ship a commit', 'Call parents', 'Quran']);
  });

  test('the day’s count moves with the tick', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('habits-progress')).toContainText('0 / 4');
    await page.getByRole('button', { name: 'Tick Quran' }).click();
    await expect(page.getByTestId('habits-progress')).toContainText('1 / 4');
  });
});

test.describe('which habits the list shows', () => {
  test('only the ones scheduled on the selected day are tickable', async ({ page }) => {
    await boot(page);
    expect(await names(page)).not.toContain('Gym');          // Mon/Wed/Fri
    await expect(page.getByTestId('habit-list-off')).toContainText('Gym');
    /* Every completion figure in the app counts scheduled days only, so
       a tick on an off day would change nothing you can see. */
    await expect(page.getByRole('button', { name: 'Tick Gym' })).toHaveCount(0);
    /* It stays reachable for editing, which is the point of keeping it. */
    await expect(page.getByRole('button', { name: 'Edit Gym' })).toHaveCount(1);
  });

  test('the pillar filter narrows it', async ({ page }) => {
    await boot(page);
    await page.getByTestId('pillar-chip').filter({ hasText: 'Tech' }).click();
    expect(await names(page)).toEqual(['Ship a commit']);
    await expect(page.getByTestId('habit-list-off')).toHaveCount(0);

    await page.getByTestId('pillar-chip').filter({ hasText: 'All' }).click();
    expect(await names(page)).toHaveLength(4);
  });

  test('the week strip moves the day, and the tick lands on that day', async ({ page }) => {
    await boot(page);
    await page.locator('[data-testid="week-strip-day"][data-date="2026-08-21"]').click();   // Friday

    /* Friday is a Gym day and not a Call-parents day. */
    await expect.poll(() => names(page)).toEqual(['Quran', 'Fajr', 'Ship a commit', 'Gym']);

    await page.getByRole('button', { name: 'Tick Gym' }).click();
    await expect.poll(async () => (await stored(page)).logs?.['2026-08-21']?.['h-gym'], { timeout: 10_000 }).toBeTruthy();
    expect((await stored(page)).logs?.[DAY]?.['h-gym']).toBeFalsy();
  });

  test('a day with nothing scheduled says so rather than showing an empty box', async ({ page }) => {
    await boot(page, STATE({ habits: [HABITS[3]] }));   // Gym, Mon/Wed/Fri
    await expect(page.getByTestId('habit-list')).toContainText('Nothing scheduled for Thursday');
  });
});

test.describe('the streak on a row', () => {
  const withRun = (n) => {
    const logs = {};
    for (let i = 1; i <= n; i++) {
      const d = new Date('2026-08-20T09:00:00');
      d.setDate(d.getDate() - i);
      const p = (x) => String(x).padStart(2, '0');
      logs[`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`] = { 'h-quran': 1 };
    }
    return STATE({ logs });
  };

  test('a run of days still reads as a run before today is ticked', async ({ page }) => {
    /* Counting strictly back from the selected day means every streak in
       the app reads zero for most of the day it describes — at nine in
       the morning a three-day run is still three days. */
    await boot(page, withRun(3));
    await expect(row(page, 'Quran').getByTestId('habit-streak')).toHaveText('3');
  });

  test('and ticking today advances it', async ({ page }) => {
    await boot(page, withRun(3));
    await page.getByRole('button', { name: 'Tick Quran' }).click();
    await expect(row(page, 'Quran').getByTestId('habit-streak')).toHaveText('4');
  });

  test('a habit scheduled on no days at all does not hang the streak', async ({ page }) => {
    await boot(page, STATE({ habits: [{ id: 'h-none', name: 'No scheduled days', pillar: 'deen', days: [], created: 1 }] }));
    await expect(page.getByTestId('habit-list-off')).toContainText('No scheduled days');
  });
});

test.describe('a habit’s icon', () => {
  test('shows on its row, and on its block in the agenda', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-q', habitId: 'h-quran', start: 330, end: 350 }] }));
    await expect(row(page, 'Quran')).toContainText('📖');

    await goTab(page, 'Today');
    await expect(page.getByTestId('agenda-row').filter({ hasText: 'Quran' }).first()).toContainText('📖');
  });

  test('is chosen from the editor and saved with the habit', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Edit Fajr' }).click();
    await page.getByRole('button', { name: 'Choose an icon' }).click();
    await page.getByRole('button', { name: 'Icon 🕌' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => (await stored(page)).habits?.find(h => h.id === 'h-fajr')?.icon,
      { timeout: 10_000 }).toBe('🕌');
    await expect(row(page, 'Fajr')).toContainText('🕌');
  });
});
