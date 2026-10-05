import { test, expect } from '@playwright/test';

/* Subtasks: a checklist carried on the task itself, behind a dropdown on
   its row. Only the Tasks and Matrix views offer it — Today's rows stay a
   single line. No sync configured, so nothing to mock. */

const TASK = {
  id: 't-move', title: 'Move flat', listId: 'l-inbox',
  quadrant: 'plan', done: false, created: 1, due: null,
};

const STATE = (view, over = {}) => ({
  habits: [], tasks: [TASK], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view },
  ...over,
});

const boot = async (page, state) => {
  await page.addInitScript((s) => {
    if (!localStorage.getItem('madinah_v1')) localStorage.setItem('madinah_v1', JSON.stringify(s));
  }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
const row    = (page) => page.getByTestId('task-row').filter({ hasText: 'Move flat' }).first();

for (const view of ['tasks', 'matrix']) {
  test.describe(`subtasks in the ${view} view`, () => {
    test('the dropdown opens a checklist that can be added to, ticked and pruned', async ({ page }) => {
      await boot(page, STATE(view));

      const toggle = row(page).getByTestId('subtask-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('subtask-list')).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const input = page.getByLabel('Add subtask to Move flat');
      await input.fill('Book van');
      await input.press('Enter');
      await input.fill('Pack kitchen');
      await input.press('Enter');

      await expect(page.getByTestId('subtask-row')).toHaveCount(2);
      await expect(toggle).toContainText('0/2');

      await page.getByLabel('Toggle Book van').click();
      await expect(toggle).toContainText('1/2');

      await page.getByLabel('Delete Pack kitchen').click();
      await expect(page.getByTestId('subtask-row')).toHaveCount(1);
      await expect(toggle).toContainText('1/1');

      const subs = (await stored(page)).tasks.find(t => t.id === 't-move').subtasks;
      expect(subs).toEqual([expect.objectContaining({ title: 'Book van', done: true })]);

      // Closing the dropdown hides the list but keeps the count on the row.
      await toggle.click();
      await expect(page.getByTestId('subtask-list')).toHaveCount(0);
      await expect(toggle).toContainText('1/1');
    });

    test('a blank subtask is not added', async ({ page }) => {
      await boot(page, STATE(view));
      await row(page).getByTestId('subtask-toggle').click();
      await page.getByLabel('Add subtask to Move flat').press('Enter');
      await expect(page.getByTestId('subtask-row')).toHaveCount(0);
    });
  });
}

test('Today does not offer subtasks', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  await boot(page, STATE('today', { tasks: [{ ...TASK, due: today, subtasks: [{ id: 's1', title: 'Book van', done: false }] }] }));
  await expect(row(page)).toBeVisible();
  await expect(page.getByTestId('subtask-toggle')).toHaveCount(0);
});
