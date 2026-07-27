import { test, expect } from '@playwright/test';

test.describe('Bug fixes', () => {
  test('a brand-new local state has no hardcoded personal habits/blocks', async ({ page }) => {
    // SEED() used to ship with a hardcoded personal routine (Fajr, gym,
    // tennis, etc.) that could resurrect over real synced data via the
    // merge. A fresh device with no cache/sync must start completely empty.
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await expect(page.locator('text=No habits scheduled for this day.')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Fajr in jama')).toHaveCount(0);
    await expect(page.locator('text=Tennis with wife')).toHaveCount(0);
  });

  test('a habit with an empty days array does not hang the app', async ({ page }) => {
    const seed = {
      habits: [
        { id: 'h-empty-days', name: 'No scheduled days', pillar: 'deen', days: [], created: Date.now() },
      ],
      logs: {},
    };
    await page.addInitScript((s) => localStorage.setItem('madinah_v1', JSON.stringify(s)), seed);
    await page.goto('/', { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    // The Habits view lists every habit for its pillar regardless of which
    // days it's scheduled on, and computes a per-habit streak (HabitCard).
    // Before the fix, a habit with days:[] sent that streak calculation into
    // an infinite loop and the tab never became interactive.
    const habitsTab = page.locator('button, a').filter({ hasText: /^Habits$/i }).first();
    await habitsTab.click();
    await expect(page.locator('text=No scheduled days')).toBeVisible({ timeout: 10_000 });
  });

  test('importing a minimal/partial JSON backup does not crash the app', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    // Navigate to Stats, where Import JSON lives.
    const statsTab = page.locator('button, a').filter({ hasText: /^Stats$/i }).first();
    await statsTab.click();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'partial-export.json',
      mimeType: 'application/json',
      // Deliberately missing ui/admin/tasks/etc — only satisfies the
      // `parsed.habits` truthy check that gates the import.
      buffer: Buffer.from(JSON.stringify({ habits: [] })),
    });

    // The app should still be up and rendering — no unhandled exception.
    await expect(page.locator('#root')).toBeAttached();
    await expect(page.locator('header, nav, [role="banner"]').first()).toBeVisible({ timeout: 10_000 });
    expect(pageErrors).toEqual([]);
  });

  test('Today view rolls its date forward across midnight without a reload', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-07-25T23:58:00') });
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    // Advance the faked clock 5 minutes — past midnight, and past this app's
    // 60s day-rollover check — without reloading the page.
    await page.clock.fastForward('05:00');

    await expect(async () => {
      const after = await page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));
      expect(after?.ui?.selectedDate).toBe('2026-07-26');
    }).toPass({ timeout: 10_000 });
  });

  test('a block before 01:00 renders inside the visible timeline grid', async ({ page }) => {
    const seed = {
      habits: [],
      blocks: [
        { id: 'b-early', title: 'Early bird', pillar: 'deen', start: 15, end: 45, every: [0,1,2,3,4,5,6] },
      ],
    };
    await page.addInitScript((s) => localStorage.setItem('madinah_v1', JSON.stringify(s)), seed);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    const block = page.locator('button', { hasText: 'Early bird' });
    await expect(block).toBeVisible({ timeout: 10_000 });
    const top = await block.evaluate((el) => parseFloat(el.style.top));
    expect(top).toBeGreaterThanOrEqual(0);
  });

  test('a block crossing midnight renders as two in-bounds segments', async ({ page }) => {
    const seed = {
      habits: [],
      blocks: [
        { id: 'b-wrap', title: 'Tahajjud', pillar: 'deen', start: 1410, end: 30, every: [0,1,2,3,4,5,6] },
      ],
    };
    await page.addInitScript((s) => localStorage.setItem('madinah_v1', JSON.stringify(s)), seed);
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    const segments = page.locator('button', { hasText: 'Tahajjud' });
    await expect(segments).toHaveCount(2, { timeout: 10_000 });
    const tops = await segments.evaluateAll((els) => els.map((el) => parseFloat(el.style.top)));
    for (const top of tops) expect(top).toBeGreaterThanOrEqual(0);
  });

  test('BlockModal shows a visible error instead of silently failing on invalid input', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await page.getByLabel('Add block at 0:00').click();
    await page.locator('button', { hasText: 'Save block' }).click();
    await expect(page.locator('text=Give this block a title.')).toBeVisible({ timeout: 5_000 });

    await page.locator('input').first().fill('Test block');
    const timeInputs = page.locator('input[type="time"]');
    await timeInputs.nth(0).fill('09:00');
    await timeInputs.nth(1).fill('09:00');
    await page.locator('button', { hasText: 'Save block' }).click();
    await expect(page.locator("text=Start and end can't be the same time.")).toBeVisible({ timeout: 5_000 });
  });

  test('the device-local view survives even if the synced ui blob says otherwise', async ({ page }) => {
    // Simulates what hydrate() sees right after a remote pull/merge: the
    // main cache's ui.view is 'today' (a merged blob never carries a real
    // view anymore — Sync.save strips it), but this device was actually
    // sitting on the Focus tab. hydrate() must restore 'focus' from the
    // separate device-local key, not fall back to whatever's in the blob.
    await page.addInitScript(() => {
      localStorage.setItem('madinah_v1', JSON.stringify({ habits: [], ui: { view: 'today' } }));
      localStorage.setItem('madinah_ui_local_v1', JSON.stringify({ view: 'focus', selectedDate: '2026-07-25' }));
    });
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await expect(page.locator('text=Pomodoro timer')).toBeVisible({ timeout: 10_000 });
  });

  test('stepping back to a previous day is not undone by the day-rollover timer', async ({ page }) => {
    // The rollover check used to re-assert todayKey() on every 60s tick
    // whenever the Today tab was open, so a deliberate step backwards was
    // dragged forward again within a minute.
    await page.clock.install({ time: new Date('2026-07-25T12:00:00') });
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await page.locator('button').filter({ hasText: /^‹$/ }).first().click();

    const readDate = () => page.evaluate(
      () => JSON.parse(localStorage.getItem('madinah_v1') || '{}')?.ui?.selectedDate
    );
    await expect(async () => expect(await readDate()).toBe('2026-07-24')).toPass({ timeout: 10_000 });

    // Several rollover ticks, but no midnight crossing — the date must hold.
    await page.clock.fastForward('05:00');
    await page.waitForTimeout(500);
    expect(await readDate()).toBe('2026-07-24');
  });

  test('stepping back to a previous day survives the sync round-trip', async ({ page }) => {
    // Changing the date triggers the debounced save; the merged payload the
    // server hands back used to be run through landToday(), which forced
    // selectedDate to today ~800ms after every click of the back arrow.
    const blob = { habits: [{ id: 'h1', name: 'Read', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1 }], ui: {} };
    await page.route('**/api/state', async (route) => {
      const body = route.request().method() === 'PUT' ? { data: blob } : blob;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.addInitScript(() => localStorage.setItem('madinah_token', 'test-token'));
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    const readDate = () => page.evaluate(
      () => JSON.parse(localStorage.getItem('madinah_v1') || '{}')?.ui?.selectedDate
    );
    // The cache is only written on the first state change, so derive the
    // expected day from the browser's own clock rather than reading it back.
    const expected = await page.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    });
    await page.locator('button').filter({ hasText: /^‹$/ }).first().click();
    await expect(async () => expect(await readDate()).toBe(expected)).toPass({ timeout: 10_000 });

    // Well past the 800ms save debounce and its merged response.
    await page.waitForTimeout(2_500);
    expect(await readDate()).toBe(expected);
  });
});
