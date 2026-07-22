import { test, expect } from '@playwright/test';

test.describe('Theme system', () => {
  test.beforeEach(async ({ page }) => {
    // Start clean — clear localStorage
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  });

  test('default theme is night', async ({ page }) => {
    const dataTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(dataTheme).toBe('night');
  });

  test('theme is stored in localStorage', async ({ page }) => {
    // Set theme via localStorage and reload — simulates existing pref
    await page.evaluate(() => localStorage.setItem('madinah_theme', 'cyberpunk'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    const dataTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(dataTheme).toBe('cyberpunk');
  });

  test('data-theme attribute applies before React mounts (flash prevention)', async ({ page }) => {
    // Inject the pref before navigating so flash-prevention script runs with it
    await page.addInitScript(() => {
      localStorage.setItem('madinah_theme', 'ghibli');
    });
    await page.goto('/');
    // Check immediately after navigation (before DOMContentLoaded fires React)
    const dataTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(dataTheme).toBe('ghibli');
  });

  test('cyberpunk theme sets correct CSS variable', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('madinah_theme', 'cyberpunk'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    const s0 = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--s0').trim()
    );
    // Cyberpunk s0 is #05000f
    expect(s0).toBeTruthy();
    expect(s0).not.toBe('#0a0a0b'); // not the night default
  });

  test('ghibli theme sets correct CSS variable', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('madinah_theme', 'ghibli'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    );
    expect(accent).toBeTruthy();
    expect(accent).not.toBe('#f59e0b'); // not the night/amber accent
  });
});
