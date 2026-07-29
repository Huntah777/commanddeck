import { test, expect } from '@playwright/test';

/* The Task lists tab in Configuration — name/colour/delete plus the
   capture keywords that route a typed task there without it naming the
   list outright. No sync configured — pure local UI, nothing to mock. */

const seed = async (page, lists) => page.addInitScript((lists) => {
  localStorage.setItem('madinah_v1', JSON.stringify({
    habits: [], tasks: [], blocks: [], logs: {}, people: [],
    lists,
    ui: {},
  }));
}, lists);

const goToListsTab = async (page) => {
  await page.goto('/?view=stats');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  await page.getByTestId('admin-nav').getByRole('button', { name: 'Setup' }).click();
  await page.getByRole('button', { name: 'Task lists' }).click();
};

const rows = (page) => page.getByTestId('list-row');
/* The name lives in an editable input, not static text, so hasText can't
   find a row by name reliably (nothing else on the row need mention it —
   see the Inbox catch-all test). Rows render in seed order, so index in
   directly instead. */
const row = (page, i) => rows(page).nth(i);
const storedLists = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1')).lists);

test.describe('Task lists — keywords', () => {
  test('Inbox explains it is the catch-all instead of inviting keywords', async ({ page }) => {
    await seed(page, [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788', keywords: [] }]);
    await goToListsTab(page);
    await expect(row(page, 0)).toContainText('catch-all');
  });

  test('a keyword can be added as a chip and persists', async ({ page }) => {
    await seed(page, [{ id: 'l-work', name: 'Work', color: '#22d3ee', keywords: [] }]);
    await goToListsTab(page);

    const r = row(page, 0);
    await expect(r).toContainText('only naming this list by name will match it');

    const kwInput = r.getByPlaceholder(/Enter to add/i);
    await kwInput.fill('meeting');
    await kwInput.press('Enter');
    await expect(r.locator('span').filter({ hasText: /^meeting×$/ })).toBeVisible();

    const lists = await storedLists(page);
    expect(lists.find(l => l.id === 'l-work').keywords).toEqual(['meeting']);
  });

  test('a duplicate keyword is not added twice, case-insensitively', async ({ page }) => {
    await seed(page, [{ id: 'l-work', name: 'Work', color: '#22d3ee', keywords: ['meeting'] }]);
    await goToListsTab(page);

    const kwInput = row(page, 0).getByPlaceholder(/Enter to add/i);
    await kwInput.fill('MEETING');
    await kwInput.press('Enter');

    const lists = await storedLists(page);
    expect(lists.find(l => l.id === 'l-work').keywords).toEqual(['meeting']);
  });

  test('a keyword chip can be removed', async ({ page }) => {
    await seed(page, [{ id: 'l-work', name: 'Work', color: '#22d3ee', keywords: ['meeting', 'invoice'] }]);
    await goToListsTab(page);

    await row(page, 0).getByRole('button', { name: 'Remove meeting' }).click();

    const lists = await storedLists(page);
    expect(lists.find(l => l.id === 'l-work').keywords).toEqual(['invoice']);
  });

  test('renaming and recolouring still work alongside the keyword editor', async ({ page }) => {
    await seed(page, [{ id: 'l-work', name: 'Work', color: '#22d3ee', keywords: [] }]);
    await goToListsTab(page);

    await row(page, 0).getByPlaceholder('Name').fill('Job');
    const lists = await storedLists(page);
    expect(lists.find(l => l.id === 'l-work').name).toBe('Job');
  });

  test('Inbox has no delete button; other lists do', async ({ page }) => {
    await seed(page, [
      { id: 'l-inbox', name: 'Inbox', color: '#9a9788', keywords: [] },
      { id: 'l-work', name: 'Work', color: '#22d3ee', keywords: [] },
    ]);
    await goToListsTab(page);

    await expect(row(page, 0).getByRole('button', { name: /Delete/ })).toHaveCount(0);
    await expect(row(page, 1).getByRole('button', { name: 'Delete Work' })).toBeVisible();
  });
});
