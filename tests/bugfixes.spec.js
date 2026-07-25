import { test, expect } from '@playwright/test';

test.describe('Bug fixes', () => {
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
});
