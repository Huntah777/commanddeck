import { test, expect } from '@playwright/test';

/* Putting a habit on the day.

   A scheduled habit is stored as an ordinary block carrying a habitId
   and nothing else of its own — the title, pillar and days are read back
   off the habit. That is the property most of these tests are really
   about: there is one source of truth, so a rename or a reschedule can
   never leave a stale twin sitting on the timeline.

   No sync configured anywhere here, so nothing to mock. */

const HABIT = { id: 'h-fajr', name: 'Fajr in jama', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1, reminder: null };

const STATE = (over = {}) => ({
  habits: [HABIT], tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view: 'today', selectedDate: '2026-07-29' },
  ...over,
});

const boot = async (page, state = STATE()) => {
  await page.addInitScript((s) => {
    if (!localStorage.getItem('madinah_v1')) localStorage.setItem('madinah_v1', JSON.stringify(s));
  }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const stored     = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
const goTab      = (page, name) => page.locator('nav button').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
const habitBlock = (page) => page.getByTestId('habit-block');
const checklist  = (page) => page.getByTestId('checklist-habit');

/* Open the habit editor from the Habits view. */
const openEditor = async (page, name) => {
  await goTab(page, 'Habits');
  await page.getByRole('button', { name: `Edit ${name}` }).click();
};

test.describe('giving a habit a slot', () => {
  test('from the habit editor, it appears on the timeline', async ({ page }) => {
    await boot(page);
    await expect(habitBlock(page)).toHaveCount(0);

    await openEditor(page, 'Fajr in jama');
    await page.getByLabel('Calendar time').fill('06:00');
    await page.getByLabel('Length').selectOption('20');
    await page.getByRole('button', { name: 'Save' }).click();

    await goTab(page, 'Today');
    const block = habitBlock(page).first();
    await expect(block).toBeVisible();
    await expect(block).toContainText('Fajr in jama');
    await expect(block).toContainText('06:00–06:20');
  });

  test('the block stores only the times and a pointer to the habit', async ({ page }) => {
    /* The whole design in one assertion. A copied title is a title that
       can go stale. */
    await boot(page);
    await openEditor(page, 'Fajr in jama');
    await page.getByLabel('Calendar time').fill('06:00');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(1);
    const [b] = (await stored(page)).blocks;
    expect(b.habitId).toBe('h-fajr');
    expect(b.start).toBe(360);
    expect(b.end).toBe(390);          // the 30-minute default
    expect(b.title).toBeUndefined();
    expect(b.pillar).toBeUndefined();
    expect(b.every).toBeUndefined();
  });

  test('renaming the habit renames the block, with no twin left behind', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    await openEditor(page, 'Fajr in jama');
    await page.locator('input').first().fill('Fajr at the masjid');
    await page.getByRole('button', { name: 'Save' }).click();

    await goTab(page, 'Today');
    await expect(habitBlock(page)).toHaveCount(1);
    await expect(habitBlock(page).first()).toContainText('Fajr at the masjid');
  });

  test('the reminder time steps aside once there is a slot', async ({ page }) => {
    // Its three block alerts replace the reminder — offering both invites
    // four notifications for one habit.
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    await openEditor(page, 'Fajr in jama');
    await expect(page.getByLabel('Daily reminder')).toBeDisabled();
    await expect(page.getByText("The block's alerts cover this")).toBeVisible();
  });

  test('taking it off the calendar tombstones the block rather than dropping it', async ({ page }) => {
    /* An absent block reads to the sync merge as "this device hasn't
       heard about it", and it would be handed straight back. */
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    await openEditor(page, 'Fajr in jama');
    await page.getByRole('button', { name: 'REMOVE' }).click();
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(0);
    expect((await stored(page)).deleted).toHaveProperty('b-h-fajr');
  });

  test('deleting the habit takes its slot with it', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    page.on('dialog', d => d.accept());
    await openEditor(page, 'Fajr in jama');
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(0);
    const after = await stored(page);
    expect(after.deleted).toHaveProperty('h-fajr');
    expect(after.deleted).toHaveProperty('b-h-fajr');
  });
});

test.describe('from today\'s checklist', () => {
  test('a habit can be put on the day without leaving the list', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Add Fajr in jama to the calendar' }).click();
    await page.getByLabel('Time for Fajr in jama').fill('05:45');
    await page.getByLabel('Length for Fajr in jama').selectOption('20');
    await page.getByTestId('habit-slot-picker').getByRole('button', { name: 'ADD', exact: true }).click();

    await expect(checklist(page).first()).toContainText('05:45–06:05');
    await expect(habitBlock(page).first()).toContainText('Fajr in jama');
  });

  test('an existing slot can be moved or removed from there too', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    await page.getByRole('button', { name: 'Reschedule Fajr in jama' }).click();
    await page.getByLabel('Time for Fajr in jama').fill('07:15');
    await page.getByTestId('habit-slot-picker').getByRole('button', { name: 'MOVE', exact: true }).click();
    await expect(checklist(page).first()).toContainText('07:15');

    await page.getByRole('button', { name: 'Reschedule Fajr in jama' }).click();
    await page.getByTestId('habit-slot-picker').getByRole('button', { name: 'OFF', exact: true }).click();
    await expect(habitBlock(page)).toHaveCount(0);
  });
});

test.describe('the block is the habit', () => {
  test('it can be ticked off from the timeline', async ({ page }) => {
    // The reason to put a habit on the calendar is to act on it there.
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    await page.getByRole('button', { name: 'Tick Fajr in jama' }).first().click();

    await expect.poll(async () => (await stored(page)).logs?.['2026-07-29']?.['h-fajr'], { timeout: 10_000 })
      .toBeTruthy();
    // And the checklist agrees — one log, two views of it.
    await expect(page.getByRole('button', { name: 'Untick Fajr in jama' })).toHaveCount(2);
  });

  test('un-ticking is recorded, not merely absent', async ({ page }) => {
    /* Bare absence can't survive a merge: the stored tick unions back
       over the un-tick and the box re-ticks itself. */
    await boot(page, STATE({
      blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }],
      logs: { '2026-07-29': { 'h-fajr': 1 } },
    }));
    await page.getByRole('button', { name: 'Untick Fajr in jama' }).first().click();

    await expect.poll(async () => (await stored(page)).logsOff?.['2026-07-29']?.['h-fajr'], { timeout: 10_000 })
      .toBeTruthy();
    expect((await stored(page)).logs?.['2026-07-29']?.['h-fajr']).toBeFalsy();
  });

  test('editing it offers the times only, and points at the habit for the rest', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    await habitBlock(page).first().getByText('Fajr in jama').click();

    await expect(page.getByText('Habit on the calendar')).toBeVisible();
    await expect(page.getByLabel('Start')).toHaveValue('06:00');
    // No title or pillar controls — those belong to the habit.
    await expect(page.getByRole('button', { name: 'Take off calendar' })).toBeVisible();
  });

  test('a stale copy on the block loses to the habit', async ({ page }) => {
    /* Nothing writes these fields onto a habit block today, but a block
       that predates the feature, or one merged in from a device running
       an older build, can arrive carrying them. The habit has to win, or
       the timeline shows a name and a colour nothing in the app can
       explain or change. */
    await boot(page, STATE({
      blocks: [{
        id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390,
        title: 'Something else entirely', pillar: 'combat', every: [2],
      }],
    }));
    const block = habitBlock(page).first();
    await expect(block).toContainText('Fajr in jama');
    await expect(block).not.toContainText('Something else entirely');
    await expect(block).toContainText('Deen');
  });

  test('a block whose habit is gone does not render', async ({ page }) => {
    await boot(page, STATE({ habits: [], blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 }] }));
    await expect(habitBlock(page)).toHaveCount(0);
  });

  test('an ordinary block still behaves like one', async ({ page }) => {
    await boot(page, STATE({
      blocks: [{ id: 'b-work', title: 'Deep work', pillar: 'tech', start: 540, end: 660, every: [0,1,2,3,4,5,6] }],
    }));
    const b = page.getByTestId('time-block').filter({ hasText: 'Deep work' });
    await expect(b).toBeVisible();
    // No tick — there is nothing to complete.
    await expect(b.locator('.tick')).toHaveCount(0);
    await b.getByText('Deep work').click();
    await expect(page.getByText('Edit block')).toBeVisible();
  });
});
