import { test, expect } from '@playwright/test';

/* Fard Prayers — a plain single-tick habit.

   Previously derived from five individual prayer logs; now it is ticked
   directly like any other habit. These tests pin that behaviour, the
   one-off conversion of the old five separate habits, and the migration
   reconcile.

   No sync configured, so nothing to mock beyond the prayer-time calendar. */

const DAY = '2026-08-20';          // a Thursday
const AT  = new Date('2026-08-20T09:13:00');
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];   // kept for migration tests
const FARD_ID = 'h-fard-prayers';

const FARD = { id: FARD_ID, name: 'Fard Prayers', pillar: 'deen', days: ALL_DAYS, created: 1, icon: '🕌', fard: true };
const QURAN = { id: 'h-quran', name: 'Quran', pillar: 'deen', days: ALL_DAYS, created: 2 };

const STATE = (over = {}) => ({
  habits: [FARD, QURAN], tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view: 'habits', selectedDate: DAY },
  ...over,
});

const boot = async (page, state = STATE(), view = 'habits') => {
  await page.clock.install({ time: AT });
  await page.addInitScript(([s, view]) => {
    localStorage.setItem('madinah_v1', JSON.stringify(s));
    localStorage.setItem('madinah_ui_local_v1', JSON.stringify({ view, selectedDate: s.ui.selectedDate }));
  }, [state, view]);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
const row    = (page, name) => page.getByTestId('habit-row').filter({ has: page.getByRole('button', { name: `Edit ${name}` }) });
const fard   = (page) => row(page, 'Fard Prayers');
const habitNames = (page) => page.getByTestId('habit-row').evaluateAll(els =>
  els.map(e => e.querySelector('button')?.innerText.split('\n')[0]).sort());

test.describe('Fard Prayers on the Habits tab', () => {
  test('shows the habit with a 0/1 badge when unticked', async ({ page }) => {
    await boot(page);
    await expect(fard(page)).toBeVisible();
    await expect(fard(page)).toContainText('0/1');
    await expect(fard(page)).toHaveAttribute('data-done', '0');
    // No prayer chips — it is a plain habit now.
    await expect(fard(page).getByTestId('fard-prayer')).toHaveCount(0);
  });

  test('ticking it directly marks it done', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Tick Fard Prayers' }).click();

    await expect(fard(page)).toHaveAttribute('data-done', '1');
    await expect(fard(page)).toContainText('1/1');
    await expect.poll(async () => (await stored(page)).logs?.[DAY]?.[FARD_ID], { timeout: 10_000 }).toBeTruthy();
  });

  test('ticking it again un-ticks it', async ({ page }) => {
    await boot(page, STATE({ logs: { [DAY]: { [FARD_ID]: 1 } } }));
    await expect(fard(page)).toHaveAttribute('data-done', '1');

    await page.getByRole('button', { name: 'Untick Fard Prayers' }).click();

    await expect(fard(page)).toHaveAttribute('data-done', '0');
    await expect.poll(async () => {
      const s = await stored(page);
      return !s.logs?.[DAY]?.[FARD_ID] && !!s.logsOff?.[DAY]?.[FARD_ID];
    }, { timeout: 10_000 }).toBe(true);
  });

  test('ordinary habits beside it are unaffected', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Tick Quran' }).click();
    await expect(row(page, 'Quran')).toHaveAttribute('data-done', '1');
    await expect(fard(page)).toHaveAttribute('data-done', '0');
  });
});

test.describe('converting the five old prayer habits', () => {
  const old = (id, name, created) => ({ id, name, pillar: 'deen', days: ALL_DAYS, created });
  const FIVE = [
    old('h-1', 'Fajr', 10), old('h-2', 'Dhur', 11), old('h-3', 'Asr', 12),
    old('h-4', 'Maghrib', 13), old('h-5', 'Isha', 14),
  ];
  const WITR = old('h-witr', 'Witr', 15);
  const OLD_STATE = (over = {}) => ({
    habits: [...FIVE, WITR], tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
    lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
    ui: { view: 'habits', selectedDate: DAY },
    ...over,
  });

  /* The load itself is not written back until something changes, so tick the
     unrelated habit to make the app persist what it converted. */
  const settle = async (page) => {
    await page.getByRole('button', { name: 'Tick Witr' }).click();
    await expect.poll(async () => (await stored(page)).logs?.[DAY]?.['h-witr'], { timeout: 10_000 }).toBeTruthy();
    return stored(page);
  };

  test('five habits become one, and the others are left alone', async ({ page }) => {
    await boot(page, OLD_STATE());
    expect(await habitNames(page)).toEqual(['Fard Prayers', 'Witr']);

    const s = await settle(page);
    const f = s.habits.find(h => h.id === FARD_ID);
    expect(f).toMatchObject({ name: 'Fard Prayers', fard: true, pillar: 'deen', reminder: null });
    expect(f.days).toEqual(ALL_DAYS);
    expect(f.created).toBe(10);                         // as old as the oldest of the five
    expect(s.habits.map(h => h.id).sort()).toEqual([FARD_ID, 'h-witr']);
    expect(s.admin.fardMerged).toBe(true);
  });

  test('the old habits are tombstoned so another device cannot hand them back', async ({ page }) => {
    await boot(page, OLD_STATE({ blocks: [{ id: 'b-h-1', habitId: 'h-1', start: 300, end: 320 }] }));
    const s = await settle(page);
    for (const id of ['h-1', 'h-2', 'h-3', 'h-4', 'h-5', 'b-h-1']) expect(s.deleted[id]).toBeGreaterThan(0);
    expect(s.blocks).toEqual([]);                        // the slot went with the habit
  });

  test('history comes with them, so a streak survives', async ({ page }) => {
    await boot(page, OLD_STATE({
      logs: {
        // All five habits ticked, before the prayers were recorded alongside them.
        '2026-08-18': { 'h-1': 1000, 'h-2': 2000, 'h-3': 3000, 'h-4': 4000, 'h-5': 5000 },
        // Only three.
        '2026-08-19': { 'h-1': 1000, 'h-2': 2000, 'h-3': 3000 },
        // The prayers were on the calendar and one habit was ticked as well.
        [DAY]: Object.fromEntries([...PRAYERS.map(p => [`salah-${p}`, 9000]), ['h-1', 8000]]),
      },
    }));
    const { logs } = await settle(page);

    // A full day becomes a full tick, stamped when the last prayer went in.
    expect(logs['2026-08-18'][FARD_ID]).toBe(5000);
    for (const p of PRAYERS) expect(logs['2026-08-18'][`salah-${p}`]).toBeTruthy();

    // A partial day keeps what it had and gains no habit tick.
    expect(logs['2026-08-19'][FARD_ID]).toBeUndefined();
    expect(logs['2026-08-19']['salah-Fajr']).toBe(1000);
    expect(logs['2026-08-19']['salah-Asr']).toBe(3000);
    expect(logs['2026-08-19']['salah-Maghrib']).toBeUndefined();

    expect(logs[DAY][FARD_ID]).toBe(9000);
  });

  test('all five are needed — fewer are somebody tracking exactly that', async ({ page }) => {
    await boot(page, OLD_STATE({ habits: [...FIVE.slice(0, 4), WITR] }));   // no Isha
    expect(await habitNames(page)).toEqual(['Asr', 'Dhur', 'Fajr', 'Maghrib', 'Witr']);
  });

  test('it happens once: a prayer habit made afterwards stays', async ({ page }) => {
    await boot(page, OLD_STATE({ admin: { fardMerged: true } }));
    expect(await habitNames(page)).toEqual(['Asr', 'Dhur', 'Fajr', 'Isha', 'Maghrib', 'Witr']);
  });
});
