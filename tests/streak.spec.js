import { test, expect } from '@playwright/test';

/* The DAY STREAK figure in the header. A day counts if enough of that
   day's scheduled habits were done — STREAK_THRESHOLD (74%), not 100%.
   With a lot of habits scheduled on the same day, missing one shouldn't
   wipe out the whole day's effort. */

const DAILY = [0,1,2,3,4,5,6];

/* Four habits scheduled every day, for four days ending on `end`
   (inclusive), with `donePerDay[i]` of them logged done on day i
   (0 = end, 1 = end-1, ...). */
function seedFor(end, donePerDay, days = DAILY) {
  const habits = Array.from({ length: 4 }, (_, i) => ({
    id: `h-${i}`, name: `Habit ${i}`, pillar: 'deen', days, created: 1,
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
    // s=1, 50%(grace1), 50%(none left → reset), today✓ → 1
    await boot(page, seedFor('2026-07-30', [4, 2, 2, 3]));
    expect(await streakValue(page)).toBe(1);
  });

  test('100% is not required — the streak does not stop at a partial day', async ({ page }) => {
    await boot(page, seedFor('2026-07-30', [4, 3, 4, 3]));
    expect(await streakValue(page)).toBe(4);
  });

  test('two consecutive days below the bar break the streak (grace absorbed the first)', async ({ page }) => {
    // today✓ yesterday✓ 2-days-ago✗(grace) 3-days-ago✗(break) → 2
    await boot(page, seedFor('2026-07-30', [3, 3, 1, 1, 3]));
    expect(await streakValue(page)).toBe(2);
  });
});

test.describe('tiered grace — longer streaks earn more forgiveness days', () => {
  test('a single miss at low streak (s<3) is bridged by the one available grace', async ({ page }) => {
    // s=2, miss(grace1), continue → 3
    await boot(page, seedFor('2026-07-30', [3, 3, 1, 3]));
    expect(await streakValue(page)).toBe(3);
  });

  test('two misses at low streak exhaust the single grace and break', async ({ page }) => {
    // s=1, miss(grace1), miss(none left) → 1
    await boot(page, seedFor('2026-07-30', [3, 1, 1, 3]));
    expect(await streakValue(page)).toBe(1);
  });

  test('a miss before any days are done does not trigger grace', async ({ page }) => {
    // miss at s=0 → no grace, s=1, today✓ → 2
    await boot(page, seedFor('2026-07-30', [3, 3, 1]));
    expect(await streakValue(page)).toBe(2);
  });

  test('today not yet done is pending, not a miss', async ({ page }) => {
    // s=3, today 25% (day not over) → 3, not 0
    await boot(page, seedFor('2026-07-30', [1, 3, 3, 3]));
    expect(await streakValue(page)).toBe(3);
  });

  test('graces are earned by the streak built before the miss', async ({ page }) => {
    // s=6 (3 graces), miss(grace1), miss(grace2), today✓ → 7.
    // Walking backwards sized the allowance from today alone and gave 1.
    await boot(page, seedFor('2026-07-30', [3, 1, 1, 3, 3, 3, 3, 3, 3]));
    expect(await streakValue(page)).toBe(7);
  });

  test('a day with no habits scheduled neither counts nor breaks', async ({ page }) => {
    // 2026-07-29 is a Wednesday with nothing scheduled → Mon, Tue, Thu → 3
    await boot(page, seedFor('2026-07-30', [3, 0, 3, 3], [0, 1, 2, 4, 5, 6]));
    expect(await streakValue(page)).toBe(3);
  });

  test('at 3+ days a second isolated miss is also forgiven', async ({ page }) => {
    // s=1, miss(grace1), s=2,3, miss(grace2 unlocked at s=3), s=4 → 4
    await boot(page, seedFor('2026-07-30', [3, 1, 3, 3, 1, 3]));
    expect(await streakValue(page)).toBe(4);
  });

  test('three consecutive misses at a 3-day streak exhaust both graces and break', async ({ page }) => {
    // s=3, miss(grace1), miss(grace2), miss(none left) → 3
    await boot(page, seedFor('2026-07-30', [3, 3, 3, 1, 1, 1, 3]));
    expect(await streakValue(page)).toBe(3);
  });
});

test.describe('grace is visible, and applies to each habit too', () => {
  const headerGrace = (page) => page.getByText('DAY STREAK').locator('..').getByTestId('streak-grace');
  const checklistRow = (page, name) => page.getByTestId('checklist-habit').filter({ hasText: name });

  test('the header shows graces used out of the allowance', async ({ page }) => {
    // s=1, miss(grace1), s=2, s=3 → 3 days earns 2, 1 spent
    await boot(page, seedFor('2026-07-30', [3, 3, 1, 3]));
    await expect(headerGrace(page)).toHaveText('1/2');
    await expect(headerGrace(page)).toHaveAttribute('title', /Forgiven: .*28/);
  });

  test('and shows 0 spent when nothing has been forgiven', async ({ page }) => {
    await boot(page, seedFor('2026-07-30', [3, 3, 3, 3]));
    await expect(headerGrace(page)).toHaveText('0/2');
  });

  test("a habit's own missed session is forgiven, not a reset", async ({ page }) => {
    // Habit 3 is only done on 4-of-4 days: done, missed, done, done(today) → 3
    await boot(page, seedFor('2026-07-30', [4, 4, 2, 4]));
    const row = checklistRow(page, 'Habit 3');
    await expect(row).toContainText('3');
    await expect(row.getByTestId('streak-grace')).toHaveText('1/2');
  });

  test('a habit with no forgiven sessions shows no grace badge', async ({ page }) => {
    await boot(page, seedFor('2026-07-30', [4, 4, 2, 4]));
    await expect(checklistRow(page, 'Habit 0').getByTestId('streak-grace')).toHaveCount(0);
  });

  test('two missed sessions in a row at a short run still break a habit', async ({ page }) => {
    // Habit 3: done, missed, missed, done(today) → 1
    await boot(page, seedFor('2026-07-30', [4, 2, 2, 4]));
    const row = checklistRow(page, 'Habit 3');
    await expect(row.getByTestId('streak-grace')).toHaveCount(0);
    await expect(row.locator('.font-mono').first()).toHaveText('1');
  });
});
