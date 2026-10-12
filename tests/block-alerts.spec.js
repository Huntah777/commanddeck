import { test, expect } from '@playwright/test';

/* Calendar alerts, one item at a time.

   The countdown before a calendar item (15 and 5 minutes before, 5 before the
   end) used to be one global setting: the whole day buzzed or none of it did.
   It is now a property of each item — `alerts` on the block record — set
   wherever the item is made or edited, and off until set.

   Five places edit a calendar item and each one has to offer it and carry it:
   the block editor (plain, habit and task variants), the two inline pickers,
   the habit editor and the task editor. The last test follows one all the way
   to what will actually fire. */

const DAY = '2026-07-29';              // a Wednesday
const AT  = new Date(`${DAY}T09:00:00`);

const HABIT = { id: 'h-fajr', name: 'Fajr in jama', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1, reminder: '07:30' };
const TASK  = { id: 't-report', title: 'Finish the quarterly report', listId: 'l-work', quadrant: 'plan', done: false, created: 1, due: null };

const STATE = (over = {}) => ({
  habits: [HABIT], tasks: [TASK], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }, { id: 'l-work', name: 'Work', color: '#22d3ee' }],
  ui: { view: 'today', selectedDate: DAY },
  ...over,
});

const boot = async (page, state = STATE()) => {
  await page.clock.install({ time: AT });
  await page.addInitScript((s) => {
    /* Permission is read from the live global, not from state. */
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    if (!localStorage.getItem('madinah_v1')) localStorage.setItem('madinah_v1', JSON.stringify(s));
  }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const stored  = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
const blockOf = async (page, pred) => (await stored(page)).blocks?.find(pred);
const toggle  = (page) => page.getByTestId('block-alerts');
const modal   = (page) => page.locator('[data-modal]');
/* The tab bar is a row of buttons from 640px and a <select> below it. */
const goTab = async (page, name) => {
  const select = page.getByLabel('Section');
  if (await select.isVisible()) await select.selectOption({ label: name });
  else await page.locator('nav button').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
};

test.describe('the block editor', () => {
  const openNew = async (page) => {
    await page.getByTestId('agenda-add').click();
    await expect(page.getByText('New time block')).toBeVisible();
  };

  test('a new block is silent until you say otherwise', async ({ page }) => {
    // The "block out some time" button lives under an agenda that has something in it.
    await boot(page, STATE({ blocks: [{ id: 'b-other', title: 'Other', pillar: 'tech', start: 780, end: 840, every: [3] }] }));
    await openNew(page);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

    await modal(page).getByPlaceholder(/Deep work/).fill('Reading');
    await page.getByRole('button', { name: 'Save block' }).click();

    await expect.poll(async () => (await blockOf(page, b => b.title === 'Reading'))?.alerts, { timeout: 10_000 }).toBe(false);
  });

  test('switching it on is saved with that block alone', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-other', title: 'Other', pillar: 'tech', start: 780, end: 840, every: [3] }] }));
    await openNew(page);
    await modal(page).getByPlaceholder(/Deep work/).fill('Deep work');
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Save block' }).click();

    await expect.poll(async () => (await blockOf(page, b => b.title === 'Deep work'))?.alerts, { timeout: 10_000 }).toBe(true);
    // The block beside it was not touched.
    expect((await blockOf(page, b => b.id === 'b-other')).alerts).toBeUndefined();
  });

  test('an existing block shows its setting, and changing it sticks', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-1', title: 'Deep work', pillar: 'tech', start: 600, end: 660, every: [3], alerts: true }] }));
    await page.getByTestId('agenda-row').filter({ hasText: 'Deep work' }).getByRole('button', { name: /Deep work/ }).first().click();
    await expect(page.getByText('Edit block')).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

    await toggle(page).click();
    await page.getByRole('button', { name: 'Save block' }).click();
    await expect.poll(async () => (await blockOf(page, b => b.id === 'b-1'))?.alerts, { timeout: 10_000 }).toBe(false);
  });

  test('a habit\'s slot and a task\'s slot offer it too, and keep only pointers', async ({ page }) => {
    await boot(page, STATE({
      blocks: [
        { id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390 },
        { id: 'b-t-report', taskId: 't-report', date: DAY, start: 840, end: 900 },
      ],
    }));

    await page.getByTestId('agenda-row').filter({ hasText: 'Fajr in jama' }).getByText('Fajr in jama').first().click();
    await expect(page.getByText('Habit on the calendar')).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await toggle(page).click();
    await page.getByRole('button', { name: 'Save block' }).click();
    await expect.poll(async () => (await blockOf(page, b => b.id === 'b-h-fajr'))?.alerts, { timeout: 10_000 }).toBe(true);

    await page.getByTestId('agenda-row').filter({ hasText: 'Finish the quarterly report' }).getByText('Finish the quarterly report').first().click();
    await expect(page.getByText('Task on the calendar')).toBeVisible();
    await toggle(page).click();
    await page.getByRole('button', { name: 'Save block' }).click();
    await expect.poll(async () => (await blockOf(page, b => b.id === 'b-t-report'))?.alerts, { timeout: 10_000 }).toBe(true);

    // The setting is the block's own; the name still belongs to the habit and the task.
    const s = await stored(page);
    for (const id of ['b-h-fajr', 'b-t-report']) {
      const b = s.blocks.find(x => x.id === id);
      expect(b.title).toBeUndefined();
      expect(b.pillar).toBeUndefined();
      expect(b.every).toBeUndefined();
    }
  });

  test('it says so when alerts are on but notifications are not', async ({ page }) => {
    await boot(page, STATE({
      blocks: [{ id: 'b-1', title: 'Deep work', pillar: 'tech', start: 600, end: 660, every: [3], alerts: true }],
      ui: { view: 'today', selectedDate: DAY, notif: false },
    }));
    await page.getByTestId('agenda-row').filter({ hasText: 'Deep work' }).getByRole('button', { name: /Deep work/ }).first().click();
    await expect(modal(page)).toContainText('Notifications are off');
  });

  test('and says nothing of the kind when they are', async ({ page }) => {
    await boot(page, STATE({
      blocks: [{ id: 'b-1', title: 'Deep work', pillar: 'tech', start: 600, end: 660, every: [3], alerts: true }],
      ui: { view: 'today', selectedDate: DAY, notif: true },
    }));
    await page.getByTestId('agenda-row').filter({ hasText: 'Deep work' }).getByRole('button', { name: /Deep work/ }).first().click();
    await expect(modal(page)).toBeVisible();
    await expect(modal(page)).not.toContainText('Notifications are off');
  });
});

test.describe('the inline pickers', () => {
  test('putting a habit on the day from the checklist: off, then on', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Add Fajr in jama to the calendar' }).click();
    const picker = page.getByTestId('habit-slot-picker');
    await expect(picker.getByTestId('block-alerts')).toHaveAttribute('aria-pressed', 'false');

    await picker.getByTestId('block-alerts').click();
    await expect(picker.getByTestId('block-alerts')).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: 'ADD', exact: true }).click();

    await expect.poll(async () => (await blockOf(page, b => b.habitId === 'h-fajr'))?.alerts, { timeout: 10_000 }).toBe(true);
  });

  test('left alone it adds the habit without alerts', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Add Fajr in jama to the calendar' }).click();
    await page.getByTestId('habit-slot-picker').getByRole('button', { name: 'ADD', exact: true }).click();
    await expect.poll(async () => (await blockOf(page, b => b.habitId === 'h-fajr'))?.alerts, { timeout: 10_000 }).toBe(false);
  });

  test('moving a slot keeps the setting it had', async ({ page }) => {
    await boot(page, STATE({ blocks: [{ id: 'b-h-fajr', habitId: 'h-fajr', start: 360, end: 390, alerts: true }] }));
    await page.getByRole('button', { name: 'Reschedule Fajr in jama' }).click();
    const picker = page.getByTestId('habit-slot-picker');
    await expect(picker.getByTestId('block-alerts')).toHaveAttribute('aria-pressed', 'true');
    await picker.getByLabel('Time for Fajr in jama').fill('06:30');
    await picker.getByRole('button', { name: 'MOVE', exact: true }).click();

    await expect.poll(async () => (await blockOf(page, b => b.habitId === 'h-fajr'))?.start, { timeout: 10_000 }).toBe(390);
    expect((await blockOf(page, b => b.habitId === 'h-fajr')).alerts).toBe(true);
  });

  test('a task, too', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Add Finish the quarterly report to the calendar' }).click();
    const picker = page.getByTestId('task-slot-picker');
    await picker.getByTestId('block-alerts').click();
    await picker.getByRole('button', { name: 'ADD', exact: true }).click();

    await expect.poll(async () => (await blockOf(page, b => b.taskId === 't-report'))?.alerts, { timeout: 10_000 }).toBe(true);
  });
});

test.describe('the habit and task editors', () => {
  test('the habit editor: set a time, then choose whether it alerts', async ({ page }) => {
    await boot(page, STATE({ ui: { view: 'habits', selectedDate: DAY } }));
    await page.getByRole('button', { name: 'Edit Fajr in jama' }).click();

    // No time yet, so nothing to alert about.
    await expect(toggle(page)).toHaveCount(0);
    await page.getByLabel('Calendar time').fill('06:00');
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    // Silent slot: the habit's own reminder is still the only thing that will tell you.
    await expect(page.getByLabel('Daily reminder')).toBeEnabled();

    await toggle(page).click();
    await expect(page.getByLabel('Daily reminder')).toBeDisabled();       // the slot's alerts cover it now
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => (await blockOf(page, b => b.habitId === 'h-fajr'))?.alerts, { timeout: 10_000 }).toBe(true);
  });

  test('the task editor', async ({ page }) => {
    await boot(page);
    await page.getByTestId('task-row').filter({ hasText: 'Finish the quarterly report' }).first()
      .getByText('Finish the quarterly report').click();
    await expect(page.getByText('Edit task')).toBeVisible();

    await expect(toggle(page)).toHaveCount(0);                            // not on the calendar yet
    await page.getByLabel('Calendar time').fill('14:00');
    await toggle(page).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => (await blockOf(page, b => b.taskId === 't-report'))?.alerts, { timeout: 10_000 }).toBe(true);
  });
});

test.describe('end to end', () => {
  test('switching one on is what puts its alerts in the plan — and only that one', async ({ page }) => {
    await boot(page, STATE({
      blocks: [
        { id: 'b-1', title: 'Deep work', pillar: 'tech', start: 600, end: 660, every: [3] },   // 10:00–11:00
        { id: 'b-2', title: 'Admin',     pillar: 'tech', start: 720, end: 780, every: [3] },   // 12:00–13:00
      ],
      ui: { view: 'today', selectedDate: DAY, notif: true, timezone: 'Europe/London' },
    }));

    await page.getByTestId('agenda-row').filter({ hasText: 'Deep work' }).getByRole('button', { name: /Deep work/ }).first().click();
    await toggle(page).click();
    await page.getByRole('button', { name: 'Save block' }).click();
    await expect.poll(async () => (await blockOf(page, b => b.id === 'b-1'))?.alerts, { timeout: 10_000 }).toBe(true);

    await goTab(page, 'Admin');
    await page.getByTestId('admin-nav').getByRole('button', { name: 'Alerts' }).click();

    await expect(page.getByTestId('calendar-alerts-count')).toHaveText('1 set to alert.');
    const shown = await page.getByTestId('upcoming-notif').evaluateAll(els => els.map(e => e.dataset.id));
    expect(shown).toEqual(['b-b-1-15', 'b-b-1-5', 'b-b-1-end']);
  });
});
