import { test, expect } from '@playwright/test';

/* Fard Prayers — the five obligatory prayers as ONE habit.

   The prayers are still recorded individually (as `salah-Fajr` … in the
   day's log, the ids the calendar's prayer rows tick). The habit is derived
   from them: ticked exactly when all five are, and impossible to tick any
   other way. These pin that, the one-off conversion of the old five
   separate habits, and the reconcile that heals a day whose halves arrived
   from different devices.

   No sync configured, so nothing to mock beyond the prayer-time calendar. */

const DAY = '2026-08-20';          // a Thursday
const AT  = new Date('2026-08-20T09:13:00');
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
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
const prayer = (page, p) => fard(page).locator(`[data-testid="fard-prayer"][data-prayer="${p}"]`);
const habitNames = (page) => page.getByTestId('habit-row').evaluateAll(els =>
  els.map(e => e.querySelector('button')?.innerText.split('\n')[0]).sort());

/* Tick the first `n` prayers in turn. */
const tickPrayers = async (page, list) => {
  for (const p of list) await prayer(page, p).click();
};

test.describe('Fard Prayers on the Habits tab', () => {
  test('lists the five prayers under one habit, none done', async ({ page }) => {
    await boot(page);
    await expect(fard(page)).toBeVisible();
    await expect(fard(page).getByTestId('fard-prayer')).toHaveCount(5);
    await expect(fard(page)).toContainText('0/5');
    await expect(fard(page)).toHaveAttribute('data-done', '0');
  });

  test('the habit cannot be ticked while a prayer is missing', async ({ page }) => {
    await boot(page);
    await tickPrayers(page, ['Fajr', 'Dhuhr', 'Asr', 'Maghrib']);   // Isha missing
    await expect(fard(page)).toContainText('4/5');

    await page.getByRole('button', { name: 'Tick Fard Prayers' }).click();

    await expect(fard(page)).toHaveAttribute('data-done', '0');
    const s = await stored(page);
    expect(s.logs[DAY][FARD_ID]).toBeUndefined();
    // …and the four that were ticked are still ticked.
    for (const p of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib']) expect(s.logs[DAY][`salah-${p}`]).toBeTruthy();
  });

  test('the fifth prayer completes the habit by itself', async ({ page }) => {
    await boot(page);
    await tickPrayers(page, PRAYERS);

    await expect(fard(page)).toHaveAttribute('data-done', '1');
    await expect(fard(page)).toContainText('5/5');
    await expect.poll(async () => (await stored(page)).logs?.[DAY]?.[FARD_ID], { timeout: 10_000 }).toBeTruthy();
    // Each prayer is under its own id, the same one the calendar row writes.
    const s = await stored(page);
    for (const p of PRAYERS) expect(s.logs[DAY][`salah-${p}`]).toBeTruthy();
  });

  test('taking one prayer back un-ticks the habit, and the un-tick is recorded', async ({ page }) => {
    await boot(page);
    await tickPrayers(page, PRAYERS);
    await expect(fard(page)).toHaveAttribute('data-done', '1');

    await prayer(page, 'Asr').click();   // un-tick

    await expect(fard(page)).toHaveAttribute('data-done', '0');
    await expect(fard(page)).toContainText('4/5');
    await expect.poll(async () => {
      const s = await stored(page);
      return !s.logs?.[DAY]?.[FARD_ID] && !!s.logsOff?.[DAY]?.[FARD_ID];
    }, { timeout: 10_000 }).toBe(true);
  });

  test('a completed habit cannot be un-ticked from itself either', async ({ page }) => {
    // It follows the prayers; to undo it, un-tick a prayer.
    await boot(page);
    await tickPrayers(page, PRAYERS);
    await expect(fard(page)).toHaveAttribute('data-done', '1');

    await page.getByRole('button', { name: 'Untick Fard Prayers' }).click();

    await expect(fard(page)).toHaveAttribute('data-done', '1');
    for (const p of PRAYERS) await expect(prayer(page, p)).toHaveAttribute('data-done', '1');
  });

  test('ordinary habits beside it are unaffected', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Tick Quran' }).click();
    await expect(row(page, 'Quran')).toHaveAttribute('data-done', '1');
    await expect(fard(page)).toHaveAttribute('data-done', '0');
  });

  test('editing the habit keeps it a Fard Prayers habit', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Edit Fard Prayers' }).click();
    await page.getByRole('button', { name: 'Choose an icon' }).click();
    await page.getByRole('button', { name: 'Icon 🌙' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => (await stored(page)).habits?.find(h => h.id === FARD_ID)?.icon,
      { timeout: 10_000 }).toBe('🌙');
    expect((await stored(page)).habits.find(h => h.id === FARD_ID).fard).toBe(true);
    // Still gated: the chips are still there and it is still not tickable.
    await expect(fard(page).getByTestId('fard-prayer')).toHaveCount(5);
  });
});

test.describe('Fard Prayers on Today', () => {
  test('the checklist offers the five prayers and the habit completes on the fifth', async ({ page }) => {
    await boot(page, STATE({ ui: { view: 'today', selectedDate: DAY } }), 'today');
    const item = page.getByTestId('checklist-habit').filter({ hasText: 'Fard Prayers' });
    await expect(item.getByTestId('fard-prayer')).toHaveCount(5);

    for (const p of PRAYERS.slice(0, 4)) await item.locator(`[data-prayer="${p}"]`).click();
    await expect(item.getByRole('button', { name: 'Tick Fard Prayers' })).toBeVisible();   // still open
    await item.locator('[data-prayer="Isha"]').click();
    await expect(item.getByRole('button', { name: 'Untick Fard Prayers' })).toBeVisible();
  });

  test('the agenda chip shows how far along it is rather than ticking', async ({ page }) => {
    await boot(page, STATE({
      ui: { view: 'today', selectedDate: DAY },
      logs: { [DAY]: { 'salah-Fajr': 1, 'salah-Dhuhr': 1 } },
    }), 'today');
    const chip = page.getByTestId('habit-chip').filter({ hasText: 'Fard Prayers' });
    await expect(chip).toContainText('2/5');
    await expect(chip).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not disabled, so the tap is still delivered — and ignored.
    await chip.click({ force: true });
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect((await stored(page)).logs?.[DAY]?.[FARD_ID]).toBeUndefined();
  });
});

test.describe('Fard Prayers from the calendar', () => {
  /* The prayer rows on the day's timeline write the same ids, so ticking
     the last one there has to complete the habit just the same. */
  const DATE = '2026-07-29';
  const LOC = { lat: 51.5, lon: -0.12 };
  const TIMINGS = { Fajr: '04:20 (BST)', Dhuhr: '13:10 (BST)', Asr: '17:20 (BST)', Maghrib: '21:00 (BST)', Isha: '22:30 (BST)' };

  const bootCalendar = async (page, logs) => {
    await page.route('**api.aladhan.com/v1/calendar/**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: Array.from({ length: 31 }, (_, i) => ({
        date: { gregorian: { date: `${String(i + 1).padStart(2, '0')}-07-2026` } }, timings: TIMINGS,
      })) }),
    }));
    await page.clock.install({ time: new Date(`${DATE}T09:00:00`) });
    await page.addInitScript(([s]) => {
      localStorage.setItem('madinah_v1', JSON.stringify(s));
    }, [STATE({ ui: { view: 'today', selectedDate: DATE, salahLoc: LOC }, logs })]);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  };
  const agendaRow = (page, p) => page.getByTestId('agenda-row').filter({ hasText: p });

  test('ticking the last prayer on the timeline completes the habit', async ({ page }) => {
    await bootCalendar(page, { [DATE]: { 'salah-Fajr': 1, 'salah-Dhuhr': 1, 'salah-Asr': 1, 'salah-Maghrib': 1 } });
    await agendaRow(page, 'Isha').getByRole('button', { name: 'Tick Isha' }).click();

    await expect.poll(async () => (await stored(page)).logs?.[DATE]?.[FARD_ID], { timeout: 10_000 }).toBeTruthy();
  });

  test('and un-ticking one there takes it back down', async ({ page }) => {
    await bootCalendar(page, { [DATE]: Object.fromEntries([...PRAYERS.map(p => [`salah-${p}`, 1]), [FARD_ID, 1]]) });
    await agendaRow(page, 'Dhuhr').getByRole('button', { name: 'Untick Dhuhr' }).click();

    await expect.poll(async () => {
      const s = await stored(page);
      return !s.logs?.[DATE]?.[FARD_ID] && !!s.logsOff?.[DATE]?.[FARD_ID];
    }, { timeout: 10_000 }).toBe(true);
  });

  test('four of five on the timeline leaves the habit open', async ({ page }) => {
    await bootCalendar(page, {});
    for (const p of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib'])
      await agendaRow(page, p).getByRole('button', { name: `Tick ${p}` }).click();
    await expect.poll(async () => (await stored(page)).logs?.[DATE]?.['salah-Maghrib'], { timeout: 10_000 }).toBeTruthy();
    expect((await stored(page)).logs[DATE][FARD_ID]).toBeUndefined();
  });
});

test.describe('days whose halves arrived separately', () => {
  /* One device heard about four prayers, another about the fifth. Each side's
     own sync only ever saw its half, so the merge can hold all five prayers
     and no habit tick — or a habit tick and fewer than five prayers. Adopting
     state reconciles it either way. */
  test('five prayers and no tick: the habit reads as done', async ({ page }) => {
    await boot(page, STATE({ logs: { [DAY]: Object.fromEntries(PRAYERS.map(p => [`salah-${p}`, 1])) } }));
    await expect(fard(page)).toHaveAttribute('data-done', '1');
  });

  test('a tick with a prayer missing: the habit reads as open', async ({ page }) => {
    await boot(page, STATE({ logs: { [DAY]: { [FARD_ID]: 1, 'salah-Fajr': 1, 'salah-Dhuhr': 1, 'salah-Asr': 1 } } }));
    await expect(fard(page)).toHaveAttribute('data-done', '0');
    await expect(fard(page)).toContainText('3/5');
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
