import { test, expect } from '@playwright/test';
import { mergeState } from '../functions/api/state.js';

/* End-to-end sync tests. The fake /api/state below runs the app's *real*
   merge function, so these exercise the actual conflict rules and the real
   client engine together — not a simplified stub of either. */

const fmtKey = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const TODAY = fmtKey(new Date());

const HABIT = { id: 'h1', name: 'Read Quran', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1, modifiedAt: 1 };

function fakeD1(page, initial) {
  const server = {
    state: { habits: [HABIT], tasks: [], logs: {}, ...initial },
    version: 1,
    online: true,
    puts: 0, gets: 0, notModified: 0,
  };

  page.route('**/api/state', async (route) => {
    if (!server.online) return route.abort('failed');
    const req = route.request();

    if (req.method() === 'PUT') {
      server.puts++;
      server.state = mergeState(server.state, JSON.parse(req.postData() || '{}'));
      server.version++;
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: `"v${server.version}"` },
        body: JSON.stringify({ ok: true, data: server.state }),
      });
    }

    server.gets++;
    const etag = `"v${server.version}"`;
    if (req.headers()['if-none-match'] === etag) {
      server.notModified++;
      return route.fulfill({ status: 304, headers: { ETag: etag } });
    }
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: etag },
      body: JSON.stringify(server.state),
    });
  });

  return server;
}

async function boot(page) {
  await page.addInitScript(() => localStorage.setItem('madinah_token', 'test-token'));
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
}

/* Specifically the checklist's row, not the agenda's habit chip — both
   toggle the same habit, but only the row carries the .tick element
   this reads its state from. */
const habitRow  = (page) => page.getByTestId('checklist-habit').filter({ hasText: 'Read Quran' }).getByRole('button').first();
const isTicked  = (page) => habitRow(page).locator('.tick.on').count().then(n => n > 0);

test.describe('multi-device sync', () => {
  test('un-ticking a habit sticks instead of bouncing back', async ({ page }) => {
    // Presence in `logs` used to mean "done", so the merge unioned the
    // stored tick back over the un-tick and the box re-ticked itself about
    // a second later — the sync round-trip undoing the user's click.
    const server = fakeD1(page);
    await boot(page);

    await habitRow(page).click();
    await expect.poll(() => server.puts).toBeGreaterThan(0);
    expect(await isTicked(page)).toBe(true);

    await habitRow(page).click();
    await expect.poll(() => isTicked(page)).toBe(false);

    // Well past the debounce and the merged response that used to undo it.
    await page.waitForTimeout(2_000);
    expect(await isTicked(page)).toBe(false);
    expect(server.state.logs?.[TODAY]?.h1).toBeFalsy();
  });

  test('an edit made offline is not destroyed by the next refresh', async ({ page }) => {
    // The pull replaced local state wholesale. Anything edited while the
    // save was failing was silently thrown away on the next refocus.
    const server = fakeD1(page);
    await boot(page);

    server.online = false;
    await habitRow(page).click();
    expect(await isTicked(page)).toBe(true);
    await page.waitForTimeout(1_500); // let the save fail

    server.online = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await expect.poll(() => server.state.logs?.[TODAY]?.h1, { timeout: 10_000 }).toBeTruthy();
    expect(await isTicked(page)).toBe(true);
  });

  test('an edit made offline survives the app being closed and reopened', async ({ page }) => {
    const server = fakeD1(page);
    await boot(page);

    server.online = false;
    await habitRow(page).click();
    await page.waitForTimeout(1_500); // save fails; dirty flag persists

    server.online = true;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    // On boot the unsynced cache must be pushed, not replaced by the server.
    await expect.poll(() => server.state.logs?.[TODAY]?.h1, { timeout: 10_000 }).toBeTruthy();
    expect(await isTicked(page)).toBe(true);
  });

  test('a change made on another device arrives on refresh', async ({ page }) => {
    const server = fakeD1(page);
    await boot(page);
    await expect(habitRow(page)).toBeVisible();

    // Another device adds a habit.
    server.state = mergeState(server.state, {
      habits: [{ id: 'h2', name: 'Cold plunge', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 2, modifiedAt: 2 }],
    });
    server.version++;

    await page.locator('button[title="Sync now"]').first().click();
    await expect(page.locator('button').filter({ hasText: 'Cold plunge' }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('an unchanged refresh costs a 304, not a fresh copy of the state', async ({ page }) => {
    const server = fakeD1(page);
    await boot(page);
    await expect(habitRow(page)).toBeVisible();

    const before = server.notModified;
    await page.locator('button[title="Sync now"]').first().click();
    await expect.poll(() => server.notModified).toBeGreaterThan(before);
  });

  test('stepping the date does not spend a write', async ({ page }) => {
    // view/selectedDate never leave the device, so moving between days is
    // pure local UI — it should cost nothing.
    const server = fakeD1(page);
    await boot(page);
    await expect(habitRow(page)).toBeVisible();

    const before = server.puts;
    await page.locator('button').filter({ hasText: /^‹$/ }).first().click();
    await page.locator('button').filter({ hasText: /^Habits$/ }).first().click();
    await page.waitForTimeout(2_000);
    expect(server.puts).toBe(before);
  });

  test('a deleted task is not resurrected by the merge', async ({ page }) => {
    const server = fakeD1(page, {
      tasks: [{ id: 't1', title: 'Delete me', listId: 'l-inbox', quadrant: 'do', done: false, created: 1, modifiedAt: 1 }],
    });
    await boot(page);

    const row = page.locator('div.group').filter({ hasText: 'Delete me' }).first();
    await expect(row).toBeVisible();
    await row.hover();
    await row.locator('button').last().click(); // the row's X

    await expect.poll(() => server.state.tasks.length, { timeout: 10_000 }).toBe(0);
    expect(server.state.deleted?.t1).toBeTruthy();

    // And it must not drift back in on the next round-trip.
    await page.waitForTimeout(1_500);
    expect(server.state.tasks.length).toBe(0);
    await expect(page.getByText('Delete me')).toHaveCount(0);
  });
});
