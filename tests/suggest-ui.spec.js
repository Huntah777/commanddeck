import { test, expect } from '@playwright/test';

/* Suggestions in Configuration — what the system learned from being
   overruled, offered as one-tap changes to the rules it files by.

   /api/suggest is mocked here; the rules that produce suggestions are
   unit-tested in learn.spec.js. What matters at this level is that
   accepting one actually writes the rule into synced state, because a
   suggestion you can't act on is decoration. */

const SUGGESTIONS = {
  keywords: [{ listId: 'l-life', keyword: 'dentist', count: 3, titles: ['Book dentist appointment', 'Dentist follow up'] }],
  weights:  [{ personId: 'pp-mgr', name: 'Dave', from: 2, to: 3, moves: 2, direction: 'up' }],
};

async function seed(page, suggestions = SUGGESTIONS) {
  await page.addInitScript(() => {
    localStorage.setItem('madinah_token', 'test-token');
    localStorage.setItem('madinah_v1', JSON.stringify({
      habits: [{ id: 'h-1', title: 'Fajr', pillar: 'deen', days: [0, 1, 2, 3, 4, 5, 6], created: 1 }],
      tasks: [], blocks: [], logs: {},
      lists: [
        { id: 'l-inbox', name: 'Inbox', color: '#9a9788', keywords: [] },
        { id: 'l-life',  name: 'Life',  color: '#a78bfa', keywords: [] },
      ],
      people: [{ id: 'pp-mgr', name: 'Dave', aliases: [], weight: 2 }],
      ui: { view: 'stats' },
    }));
  });

  let stored = null, version = 1;
  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'PUT') {
      stored = JSON.parse(route.request().postData() || '{}');
      version++;
      return route.fulfill({
        status: 200, headers: { 'Content-Type': 'application/json', ETag: `"v${version}"` },
        body: JSON.stringify({ ok: true, updated_at: version, data: stored }),
      });
    }
    await route.fulfill({
      status: 200, headers: { 'Content-Type': 'application/json', ETag: `"v${version}"` },
      body: JSON.stringify(stored || {
        habits: [{ id: 'h-1', title: 'Fajr', pillar: 'deen', days: [0, 1, 2, 3, 4, 5, 6], created: 1 }],
        tasks: [], lists: [
          { id: 'l-inbox', name: 'Inbox', keywords: [] },
          { id: 'l-life', name: 'Life', keywords: [] },
        ],
        people: [{ id: 'pp-mgr', name: 'Dave', aliases: [], weight: 2 }],
        ui: { view: 'stats' },
      }),
    });
  });

  const api = { calls: 0, lastBody: null };
  await page.route('**/api/suggest', async (route) => {
    api.calls++;
    try { api.lastBody = JSON.parse(route.request().postData() || '{}'); } catch {}
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(suggestions) });
  });
  return api;
}

const openTab = async (page, name) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  await page.getByTestId('admin-nav').getByRole('button', { name: 'Setup' }).click();
  await page.getByRole('button', { name, exact: true }).click();
};

const localState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1')));

test.describe('keyword suggestions', () => {
  test('a learned routing rule is offered with the evidence behind it', async ({ page }) => {
    await seed(page);
    await openTab(page, 'Task lists');

    const s = page.getByTestId('keyword-suggestion');
    await expect(s).toContainText('dentist', { timeout: 10_000 });
    await expect(s).toContainText('Life');
    await expect(s).toContainText('You moved 3 tasks');
    await expect(s).toContainText('Book dentist appointment'); // the evidence, not just a claim
  });

  test('accepting one writes the keyword onto the list', async ({ page }) => {
    await seed(page);
    await openTab(page, 'Task lists');
    await page.getByTestId('keyword-suggestion').getByRole('button', { name: 'ADD' }).click({ timeout: 10_000 });

    await expect.poll(async () => (await localState(page)).lists.find(l => l.id === 'l-life')?.keywords, { timeout: 5_000 })
      .toContain('dentist');
    await expect(page.getByTestId('keyword-suggestion')).toHaveCount(0); // and it stops asking
  });

  test('dismissing one changes nothing but stops it asking', async ({ page }) => {
    await seed(page);
    await openTab(page, 'Task lists');
    await page.getByTestId('keyword-suggestion').getByRole('button', { name: /Dismiss/ }).click({ timeout: 10_000 });

    await expect(page.getByTestId('keyword-suggestion')).toHaveCount(0);
    expect((await localState(page)).lists.find(l => l.id === 'l-life').keywords).toEqual([]);
  });
});

test.describe('weight suggestions', () => {
  test('a learned weight change is offered with the count behind it', async ({ page }) => {
    await seed(page);
    await openTab(page, 'People');

    const s = page.getByTestId('weight-suggestion');
    await expect(s).toContainText('Dave', { timeout: 10_000 });
    await expect(s).toContainText('weight 3');
    await expect(s).toContainText('re-filed 2');
  });

  test('accepting one writes the new weight', async ({ page }) => {
    await seed(page);
    await openTab(page, 'People');
    await page.getByTestId('weight-suggestion').getByRole('button', { name: 'APPLY' }).click({ timeout: 10_000 });

    await expect.poll(async () => (await localState(page)).people[0].weight, { timeout: 5_000 }).toBe(3);
    await expect(page.getByTestId('weight-suggestion')).toHaveCount(0);
  });
});

test.describe('nothing learned yet', () => {
  test('no suggestions means no clutter', async ({ page }) => {
    await seed(page, { keywords: [], weights: [] });
    await openTab(page, 'People');
    await expect(page.getByTestId('weight-suggestion')).toHaveCount(0);
    await openTab(page, 'Task lists');
    await expect(page.getByTestId('keyword-suggestion')).toHaveCount(0);
  });

  test('the endpoint is sent only the tasks the parser filed', async ({ page }) => {
    // Sending the whole task list would grow unbounded; only filed tasks
    // can carry a correction anyway.
    const api = await seed(page);
    await openTab(page, 'People');
    await expect.poll(() => api.lastBody, { timeout: 10_000 }).toBeTruthy();
    expect(Array.isArray(api.lastBody.filedTasks)).toBe(true);
    expect(api.lastBody.people).toContainEqual(expect.objectContaining({ name: 'Dave' }));
  });
});
