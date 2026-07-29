import { test, expect } from '@playwright/test';

test.describe('App smoke tests', () => {
  test('page loads and renders the header', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
    // The app mounts React — wait for something inside root to appear
    await expect(page.locator('header, nav, [role="banner"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('app title is set correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Command Deck|Madinah/i);
  });

  test('navigating to the admin view works', async ({ page }) => {
    await page.goto('/');
    // Wait for the app to mount
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    await page.locator('nav button').filter({ hasText: /^Admin$/ }).first().click();
    await expect(page.getByTestId('admin-nav')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('admin-nav').getByRole('button', { name: 'Appearance' }).click();
    await expect(page.locator('text=/theme/i').first()).toBeVisible({ timeout: 5_000 });
  });

  test('background layers exist in DOM', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app-bg-img')).toBeAttached();
    await expect(page.locator('#app-bg-scrim')).toBeAttached();
  });
});
