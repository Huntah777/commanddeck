import { test, expect } from '@playwright/test';

/* The People tab in Configuration (Stats → scroll to Admin card). No sync
   configured anywhere here — this is pure local UI, so there is nothing to
   mock and no network to wait on. */

const seed = async (page, people) => page.addInitScript((people) => {
  localStorage.setItem('madinah_v1', JSON.stringify({
    habits: [], tasks: [], blocks: [], logs: {},
    lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
    people,
    ui: {},
  }));
}, people);

const goToPeopleTab = async (page) => {
  await page.goto('/?view=stats');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  await page.getByText('Configuration').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'People' }).click();
};

const rows = (page) => page.getByTestId('person-row');
const row = (page, name) => rows(page).filter({ hasText: name });

test.describe('People tab — collapsed list', () => {
  test('rows show name, weight and alias preview without expanding', async ({ page }) => {
    await seed(page, [{ id: 'pp-1', name: 'Aisha', aliases: ['wife', 'the wife', 'her indoors', 'boss'], weight: 5 }]);
    await goToPeopleTab(page);

    const r = row(page, 'Aisha');
    await expect(r).toContainText('5');
    await expect(r).toContainText('wife, the wife');
    await expect(r).toContainText('+1'); // 4th alias summarised, not spelled out
    // Editing controls are not part of the collapsed row.
    await expect(r.locator('input[type="range"]')).toHaveCount(0);
  });

  test('a row expands on click to reveal the editor, and collapses again', async ({ page }) => {
    await seed(page, [{ id: 'pp-1', name: 'Aisha', aliases: [], weight: 3 }]);
    await goToPeopleTab(page);

    const r = row(page, 'Aisha');
    await expect(r.locator('input[type="range"]')).toHaveCount(0);
    await r.getByRole('button', { name: /Aisha/ }).click();
    await expect(r.locator('input[type="range"]')).toBeVisible();
    await r.getByRole('button', { name: /Aisha/ }).click();
    await expect(r.locator('input[type="range"]')).toHaveCount(0);
  });

  test('the heaviest weight sorts first', async ({ page }) => {
    await seed(page, [
      { id: 'pp-mgr', name: 'Dave', aliases: [], weight: 2 },
      { id: 'pp-wife', name: 'Aisha', aliases: [], weight: 5 },
      { id: 'pp-mid', name: 'Sam', aliases: [], weight: 3 },
    ]);
    await goToPeopleTab(page);
    await expect(rows(page)).toHaveCount(3);
    const names = await rows(page).allInnerTexts();
    expect(names[0]).toContain('Aisha');
    expect(names[2]).toContain('Dave');
  });
});

test.describe('People tab — one person, several names', () => {
  test('aliases can be added as chips and are matched case-insensitively against duplicates', async ({ page }) => {
    await seed(page, [{ id: 'pp-1', name: 'Aisha', aliases: ['wife'], weight: 5 }]);
    await goToPeopleTab(page);

    const r = row(page, 'Aisha');
    await r.getByRole('button', { name: /Aisha/ }).click();

    const aliasInput = r.getByPlaceholder(/Enter to add/i);
    await aliasInput.fill('the boss');
    await aliasInput.press('Enter');
    // The chip's own text node, not the placeholder example that also
    // happens to say "the boss".
    await expect(r.locator('span').filter({ hasText: /^the boss×$/ })).toBeVisible();

    // Case-insensitive duplicate of an existing alias is not added twice.
    await aliasInput.fill('WIFE');
    await aliasInput.press('Enter');
    await expect(r.locator('span').filter({ hasText: /^wife×$/ })).toHaveCount(1);

    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1')).people[0]);
    expect(state.aliases.sort()).toEqual(['the boss', 'wife']);
  });

  test('a chip can be removed', async ({ page }) => {
    await seed(page, [{ id: 'pp-1', name: 'Aisha', aliases: ['wife', 'the wife'], weight: 5 }]);
    await goToPeopleTab(page);

    const r = row(page, 'Aisha');
    await r.getByRole('button', { name: /Aisha/ }).click();
    await r.getByRole('button', { name: 'Remove wife' }).click();

    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1')).people[0]);
    expect(state.aliases).toEqual(['the wife']);
  });

  test('typing without pressing Enter still commits the alias on blur', async ({ page }) => {
    await seed(page, [{ id: 'pp-1', name: 'Dave', aliases: [], weight: 2 }]);
    await goToPeopleTab(page);

    const r = row(page, 'Dave');
    await r.getByRole('button', { name: /Dave/ }).click();
    await r.getByPlaceholder(/Enter to add/i).fill('manager');
    await r.locator('input[type="range"]').focus(); // moves focus away, blurring the alias input

    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1')).people[0]);
    expect(state.aliases).toEqual(['manager']);
  });
});

test.describe('People tab — weight editing', () => {
  test('dragging the weight slider updates the label and persists', async ({ page }) => {
    await seed(page, [{ id: 'pp-1', name: 'Dave', aliases: [], weight: 2 }]);
    await goToPeopleTab(page);

    const r = row(page, 'Dave');
    await r.getByRole('button', { name: /Dave/ }).click();
    await expect(r).toContainText('BACKGROUND');

    await r.locator('input[type="range"]').fill('4');
    await expect(r).toContainText('IMPORTANT');

    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1')).people[0]);
    expect(state.weight).toBe(4);
  });

  test('a re-filed task surfaces as a nudge to change the weight', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('madinah_v1', JSON.stringify({
      habits: [], blocks: [], logs: {},
      lists: [{ id: 'l-inbox', name: 'Inbox' }],
      people: [{ id: 'pp-mgr', name: 'Dave', aliases: [], weight: 2 }],
      tasks: [{ id: 't1', title: 'x', quadrant: 'do', aiQuadrant: 'delegate', personId: 'pp-mgr', listId: 'l-inbox' }],
      ui: {},
    })));
    await goToPeopleTab(page);

    const r = row(page, 'Dave');
    await expect(r.locator('.bg-combat')).toBeVisible(); // collapsed-row hint dot
    await r.getByRole('button', { name: /Dave/ }).click();
    await expect(r).toContainText('re-filed 1');
    await expect(r).toContainText('consider raising');
  });
});

test.describe('People tab — scale', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `pp-${i}`, name: `Person ${i}`, aliases: i === 3 ? ['nickname-x'] : [], weight: 3 }));

  test('search only appears once the list is long, and filters by name or alias', async ({ page }) => {
    await seed(page, many.slice(0, 4));
    await goToPeopleTab(page);
    await expect(page.getByPlaceholder('Search people…')).toHaveCount(0);
  });

  test('filters a long list by name and by alias', async ({ page }) => {
    await seed(page, many);
    await goToPeopleTab(page);

    const search = page.getByPlaceholder('Search people…');
    await expect(search).toBeVisible();
    await expect(rows(page)).toHaveCount(7);

    await search.fill('Person 2');
    await expect(rows(page)).toHaveCount(1);

    await search.fill('nickname-x');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Person 3');

    await search.fill('nobody matches this');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText(/No one matches/)).toBeVisible();
  });
});

test.describe('People tab — add and delete', () => {
  test('adding a person opens them expanded, ready for aliases', async ({ page }) => {
    await seed(page, []);
    await goToPeopleTab(page);

    page.once('dialog', d => d.accept('Sam'));
    await page.getByRole('button', { name: '+ Add person' }).click();

    const r = row(page, 'Sam');
    await expect(r.locator('input[type="range"]')).toBeVisible(); // already expanded
  });

  test('deleting a person removes the row', async ({ page }) => {
    await seed(page, [{ id: 'pp-1', name: 'Aisha', aliases: [], weight: 5 }]);
    await goToPeopleTab(page);

    const r = row(page, 'Aisha');
    await r.getByRole('button', { name: /Aisha/ }).click();
    page.once('dialog', d => d.accept());
    await r.getByRole('button', { name: '✕' }).click();

    await expect(rows(page)).toHaveCount(0);
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1')).people);
    expect(state).toHaveLength(0);
  });
});
