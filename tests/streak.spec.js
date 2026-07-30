import { test, expect } from '@playwright/test';

/* The DAY STREAK figure in the header. A day counts if enough of that
   day's scheduled habits were done — STREAK_THRESHOLD (74%), not 100%.
   With a lot of habits scheduled on the same day, missing one shouldn't
   wipe out the whole day's effort. */

const DAILY = [0,1,2,3,4,5,6];

/* Four habits scheduled every day, for four days ending on `end`
   (inclusive), with `donePerDay[i]` of them logged done on day i
   (0 = end, 1 = end-1, ...). */
function seedFor(end, donePerDay) {
  const habits = Array.from({ length: 4 }, (_, i) => ({
    id: `h-${i}`, name: `Habit ${i}`, pillar: 'deen', days: DAILY, created: 1,
  }));
  const logs = {};
  const endDate = new Date(`${end}T12:00:00Z`);
  donePerDay.forEach((done, i) => {
    const d = new Date(endDate); d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    logs[k] = {};
    for (let h = 0; h < done; h++) logs[k][`h-${h}`] = 1;
  });
  return {
    habits, logs, tasks: [], blocks: [], people: [], pomodoroLogs: [],
    lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
    ui: { view: 'today', selectedDate: end },
  };
}

const boot = async (page, state) => {
  /* The Today tab resets selectedDate to the real today() on load
     (landToday) — pin the clock to the fixture's own "end" date so this
     doesn't quietly break the day after it's written. */
  await page.clock.install({ time: new Date(`${state.ui.selectedDate}T09:00:00`) });
  await page.addInitScript((s) => localStorage.setItem('madinah_v1', JSON.stringify(s)), state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const streakValue = async (page) => {
  const text = await page.getByText('DAY STREAK').locator('..').locator('.font-display').innerText();
  return Number(text.trim());
};

test.describe('the day streak counts a day at 74%, not 100%', () => {
  test('3 of 4 habits (75%) keeps the streak alive — this is exactly what changed', async ({ page }) => {
    // At the old 80% bar, 75% would have broken the streak. This fixture
    // is the case the user asked for: a lot of habits, one missed, still
    // counts.
    await boot(page, seedFor('2026-07-30', [3, 3, 3, 3]));
    expect(await streakValue(page)).toBe(4);
  });

  test('2 of 4 habits (50%) still breaks it', async ({ page }) => {
    await boot(page, seedFor('2026-07-30', [2, 3, 3, 3]));
    expect(await streakValue(page)).toBe(0);
  });

  test('100% is not required — the streak does not stop at a partial day', async ({ page }) => {
    await boot(page, seedFor('2026-07-30', [4, 3, 4, 3]));
    expect(await streakValue(page)).toBe(4);
  });

  test('the streak stops counting at the first day below the bar', async ({ page }) => {
    await boot(page, seedFor('2026-07-30', [3, 3, 1, 3]));
    expect(await streakValue(page)).toBe(2);
  });
});
