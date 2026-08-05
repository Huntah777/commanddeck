import { test, expect } from '@playwright/test';

/* Booking a to-do into the day.

   A scheduled task is stored as an ordinary block carrying a taskId, a
   date and the times — nothing else of its own. The title, the list and
   whether it is done are read back off the task. That is the property
   most of these tests are really about: one source of truth, so a rename
   or a tick can never leave a stale twin sitting on the timeline.

   The one way this differs from a habit's slot is the whole reason it
   needs a date at all: a habit recurs by weekday, a task happens once.
   Several tests below exist only to pin that down.

   No sync configured anywhere here, so nothing to mock. */

const TASK = {
  id: 't-report', title: 'Finish the quarterly report', listId: 'l-work',
  quadrant: 'plan', done: false, created: 1, due: null,
};

const STATE = (over = {}) => ({
  habits: [], tasks: [TASK], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [
    { id: 'l-inbox', name: 'Inbox', color: '#9a9788' },
    { id: 'l-work',  name: 'Work',  color: '#22d3ee' },
  ],
  ui: { view: 'today', selectedDate: '2026-07-29' },
  ...over,
});

const SLOT = { id: 'b-t-report', taskId: 't-report', date: '2026-07-29', start: 840, end: 900 };

/* The Today tab resets selectedDate to the real today() on load, so the
   only way to look at another day from a cold boot is to be on it — pin
   the clock rather than fight the reset. */
const bootOn = async (page, day, state = STATE()) => {
  await page.clock.install({ time: new Date(`${day}T09:00:00`) });
  await page.addInitScript((s) => {
    if (!localStorage.getItem('madinah_v1')) localStorage.setItem('madinah_v1', JSON.stringify(s));
  }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};
const boot = (page, state) => bootOn(page, '2026-07-29', state);

const stored    = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
const taskBlock = (page) => page.getByTestId('task-block');
const picker    = (page) => page.getByTestId('task-slot-picker');
const rows      = (page) => page.getByTestId('task-row');

/* Open the task editor from its row — the title on the block opens the
   block, which is a different modal. */
const openEditor = async (page, title) => {
  await rows(page).filter({ hasText: title }).first().getByText(title).click();
  await expect(page.getByText('Edit task')).toBeVisible();
};

test.describe('giving a task a slot', () => {
  test('from its row, it appears on the timeline without leaving the list', async ({ page }) => {
    await boot(page);
    await expect(taskBlock(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Add Finish the quarterly report to the calendar' }).click();
    await page.getByLabel('Day for Finish the quarterly report').fill('2026-07-29');
    await page.getByLabel('Time for Finish the quarterly report').fill('14:00');
    await page.getByLabel('Length for Finish the quarterly report').selectOption('60');
    await picker(page).getByRole('button', { name: 'ADD', exact: true }).click();

    const block = taskBlock(page).first();
    await expect(block).toBeVisible();
    await expect(block).toContainText('Finish the quarterly report');
    await expect(block).toContainText('14:00–15:00');
    // It takes the name — and the colour — of the list it lives in.
    await expect(block).toContainText('Work · task');
    // And the row it came from now says when it is happening.
    await expect(rows(page).first()).toContainText('14:00–15:00');
  });

  test('the block stores only the day, the times and a pointer to the task', async ({ page }) => {
    /* The whole design in one assertion. A copied title is a title that
       can go stale. */
    await boot(page);
    await page.getByRole('button', { name: 'Add Finish the quarterly report to the calendar' }).click();
    await page.getByLabel('Time for Finish the quarterly report').fill('14:00');
    await picker(page).getByRole('button', { name: 'ADD', exact: true }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(1);
    const [b] = (await stored(page)).blocks;
    expect(b.taskId).toBe('t-report');
    expect(b.date).toBe('2026-07-29');
    expect(b.start).toBe(840);
    expect(b.end).toBe(870);          // the 30-minute default
    expect(b.title).toBeUndefined();
    expect(b.listId).toBeUndefined();
    expect(b.every).toBeUndefined();
  });

  test('from the task editor, with the day and the length', async ({ page }) => {
    await boot(page);
    await openEditor(page, 'Finish the quarterly report');
    await page.getByLabel('Calendar day').fill('2026-07-30');
    await page.getByLabel('Calendar time').fill('11:00');
    await page.getByLabel('Length').selectOption('45');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(1);
    const [b] = (await stored(page)).blocks;
    expect(b).toMatchObject({ taskId: 't-report', date: '2026-07-30', start: 660, end: 705 });
  });

  test('an existing slot can be moved or taken off from the row', async ({ page }) => {
    await boot(page, STATE({ blocks: [SLOT] }));
    await page.getByRole('button', { name: 'Reschedule Finish the quarterly report' }).click();
    await page.getByLabel('Time for Finish the quarterly report').fill('16:30');
    await picker(page).getByRole('button', { name: 'MOVE', exact: true }).click();
    await expect(taskBlock(page).first()).toContainText('16:30');

    await page.getByRole('button', { name: 'Reschedule Finish the quarterly report' }).click();
    await picker(page).getByRole('button', { name: 'OFF', exact: true }).click();
    await expect(taskBlock(page)).toHaveCount(0);
  });

  test('taking it off tombstones the block rather than dropping it', async ({ page }) => {
    /* An absent block reads to the sync merge as "this device hasn't
       heard about it", and it would be handed straight back. */
    await boot(page, STATE({ blocks: [SLOT] }));
    await page.getByRole('button', { name: 'Reschedule Finish the quarterly report' }).click();
    await picker(page).getByRole('button', { name: 'OFF', exact: true }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(0);
    expect((await stored(page)).deleted).toHaveProperty('b-t-report');
  });

  test('deleting the task takes its slot with it', async ({ page }) => {
    await boot(page, STATE({ blocks: [SLOT] }));
    await page.getByRole('button', { name: 'Delete Finish the quarterly report' }).click();

    await expect.poll(async () => (await stored(page)).blocks?.length, { timeout: 10_000 }).toBe(0);
    const after = await stored(page);
    expect(after.tasks).toHaveLength(0);
    expect(after.deleted).toHaveProperty('t-report');
    expect(after.deleted).toHaveProperty('b-t-report');
  });
});

test.describe('a task happens once', () => {
  test('it sits on its own date and no other', async ({ page }) => {
    /* The difference from a habit, which recurs by weekday. */
    await bootOn(page, '2026-07-30', STATE({ blocks: [SLOT] }));   // slot is the 29th
    await expect(taskBlock(page)).toHaveCount(0);
  });

  test('a stale weekday list on the block cannot make it recur', async ({ page }) => {
    /* Nothing writes `every` or a title onto a task block today, but one
       merged in from a device running an older build could arrive
       carrying them. The task and the date have to win, or a one-off
       quietly becomes a weekly commitment under a name nothing in the
       app can explain or change. */
    const stale = { ...SLOT, every: [0,1,2,3,4,5,6], title: 'Something else entirely' };

    await bootOn(page, '2026-07-30', STATE({ blocks: [stale] }));
    await expect(taskBlock(page)).toHaveCount(0);

    await page.clock.setFixedTime(new Date('2026-07-29T09:00:00'));
    await page.reload();
    const block = taskBlock(page).first();
    await expect(block).toContainText('Finish the quarterly report');
    await expect(block).not.toContainText('Something else entirely');
  });

  test('a block whose task is gone does not render', async ({ page }) => {
    await boot(page, STATE({ tasks: [], blocks: [SLOT] }));
    await expect(taskBlock(page)).toHaveCount(0);
  });

  test('an ordinary block still behaves like one', async ({ page }) => {
    await boot(page, STATE({
      blocks: [{ id: 'b-work', title: 'Deep work', pillar: 'tech', start: 540, end: 660, every: [0,1,2,3,4,5,6] }],
    }));
    const b = page.getByTestId('time-block').filter({ hasText: 'Deep work' });
    await expect(b).toBeVisible();
    await expect(b.locator('.tick')).toHaveCount(0);   // nothing to complete
  });
});

test.describe('the block is the task', () => {
  test('it can be ticked off from the timeline, and the task agrees', async ({ page }) => {
    // The reason to put a task on the calendar is to act on it there.
    await boot(page, STATE({ blocks: [SLOT] }));
    await page.getByRole('button', { name: 'Tick Finish the quarterly report' }).click();

    await expect.poll(async () => (await stored(page)).tasks?.[0]?.done, { timeout: 10_000 }).toBe(true);
    // The block stays where it is, struck through and ready to be undone.
    await expect(taskBlock(page).first()).toContainText('Finish the quarterly report');
    await expect(page.getByRole('button', { name: 'Untick Finish the quarterly report' })).toBeVisible();
  });

  test('renaming the task renames the block, with no twin left behind', async ({ page }) => {
    await boot(page, STATE({ blocks: [SLOT] }));
    await openEditor(page, 'Finish the quarterly report');
    await page.getByLabel('Task title').fill('Ship the report');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(taskBlock(page)).toHaveCount(1);
    await expect(taskBlock(page).first()).toContainText('Ship the report');
  });

  test('editing it offers the day and the times, and points at the task for the rest', async ({ page }) => {
    await boot(page, STATE({ blocks: [SLOT] }));
    await taskBlock(page).first().getByText('Finish the quarterly report').click();

    await expect(page.getByText('Task on the calendar')).toBeVisible();
    await expect(page.getByLabel('Day')).toHaveValue('2026-07-29');
    await expect(page.getByLabel('Start')).toHaveValue('14:00');
    // No title or list controls — those belong to the task.
    await expect(page.getByRole('button', { name: 'Take off calendar' })).toBeVisible();

    await page.getByLabel('Day').fill('2026-07-31');
    await page.getByRole('button', { name: 'Save block' }).click();

    await expect(taskBlock(page)).toHaveCount(0);   // moved off this day
    await expect.poll(async () => (await stored(page)).blocks?.[0]?.date, { timeout: 10_000 }).toBe('2026-07-31');
    // Still only a pointer — the modal must not write the resolved title back.
    expect((await stored(page)).blocks[0].title).toBeUndefined();
  });
});

test.describe('the day it is booked into', () => {
  test('a task due later still shows in the list of the day it is booked for', async ({ page }) => {
    /* Having decided to do it today, you should not have to go and find
       it in another day's list. */
    await boot(page, STATE({ tasks: [{ ...TASK, due: '2026-08-14' }], blocks: [SLOT] }));
    await expect(taskBlock(page)).toHaveCount(1);
    await expect(rows(page).filter({ hasText: 'Finish the quarterly report' })).toHaveCount(1);
  });

  test('an overdue task booked into today moves out of OVERDUE', async ({ page }) => {
    await boot(page, STATE({ tasks: [{ ...TASK, due: '2026-07-20' }], blocks: [SLOT] }));
    await expect(page.getByText(/^OVERDUE/)).toHaveCount(0);
    await expect(rows(page).filter({ hasText: 'Finish the quarterly report' })).toHaveCount(1);
  });

  test('it shows on the week grid, in that day\'s column only', async ({ page }) => {
    await boot(page, STATE({ blocks: [SLOT] }));
    await page.getByTestId('scope-week').click();
    await expect(page.getByTestId('week-task-block')).toHaveCount(1);
    await expect(page.getByTestId('week-task-block').first()).toContainText('Finish the quarterly report');
  });
});
