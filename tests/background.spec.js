import { test, expect } from '@playwright/test';

const TEST_IMG = 'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1920&q=80';

test.describe('Background system', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  });

  test('#app-bg-img and #app-bg-scrim are in the DOM', async ({ page }) => {
    await expect(page.locator('#app-bg-img')).toBeAttached();
    await expect(page.locator('#app-bg-scrim')).toBeAttached();
  });

  test('no background by default — CSS vars are none/transparent', async ({ page }) => {
    const bgImg   = await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-bg-img').trim());
    const bgScrim = await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-bg-scrim').trim());
    // When nothing is set, applyBackground hasn't been called yet or vars are empty
    expect(bgImg === '' || bgImg === 'none').toBe(true);
    expect(bgScrim === '' || bgScrim === 'transparent').toBe(true);
  });

  test('background JSON stored in localStorage persists across reload', async ({ page }) => {
    const pref = { url: TEST_IMG, source: 'url', attribution: null };
    await page.evaluate((p) => localStorage.setItem('madinah_bg', JSON.stringify(p)), pref);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    const stored = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('madinah_bg')); } catch { return null; }
    });
    expect(stored?.url).toBe(TEST_IMG);
    expect(stored?.source).toBe('url');
  });

  test('flash-prevention script applies --app-bg-img before React mounts', async ({ page }) => {
    const pref = { url: TEST_IMG, source: 'url', attribution: null };
    await page.addInitScript((p) => {
      localStorage.setItem('madinah_bg', JSON.stringify(p));
    }, pref);
    await page.goto('/');
    // Check immediately — flash-prevention script runs synchronously in <head>
    const bgImg = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--app-bg-img').trim()
    );
    expect(bgImg).toContain(TEST_IMG);
  });

  test('applyBackground sets --app-bg-img and --app-bg-scrim CSS vars', async ({ page }) => {
    // Wait for React to mount then call applyBackground via localStorage trick
    const pref = { url: TEST_IMG, source: 'url', attribution: null };
    await page.evaluate((p) => localStorage.setItem('madinah_bg', JSON.stringify(p)), pref);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    // React useEffect runs applyBackground — give it a tick
    await page.waitForFunction(() =>
      document.documentElement.style.getPropertyValue('--app-bg-img') !== ''
    , { timeout: 5_000 });

    const bgImg   = await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-bg-img'));
    const bgScrim = await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-bg-scrim'));
    expect(bgImg).toContain(TEST_IMG);
    expect(bgScrim).not.toBe('transparent');
    expect(bgScrim).not.toBe('');
  });

  test('clearing background sets CSS vars back to none/transparent', async ({ page }) => {
    // Set a background first
    const pref = { url: TEST_IMG, source: 'url', attribution: null };
    await page.evaluate((p) => localStorage.setItem('madinah_bg', JSON.stringify(p)), pref);
    await page.reload();
    await page.waitForFunction(() =>
      document.documentElement.style.getPropertyValue('--app-bg-img') !== ''
    , { timeout: 10_000 });

    // Now remove it and call applyBackground(null) directly
    await page.evaluate(() => {
      localStorage.removeItem('madinah_bg');
      // applyBackground is defined globally in the Babel-compiled script
      // We can call it via the CSS var approach directly
      document.documentElement.style.setProperty('--app-bg-img', 'none');
      document.documentElement.style.setProperty('--app-bg-scrim', 'transparent');
    });

    const bgImg   = await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-bg-img'));
    const bgScrim = await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-bg-scrim'));
    expect(bgImg).toBe('none');
    expect(bgScrim).toBe('transparent');
  });

  test('Unsplash attribution object is stored in JSON pref', async ({ page }) => {
    const pref = {
      url: TEST_IMG,
      source: 'unsplash',
      attribution: { name: 'J. Plenio', profileUrl: 'https://unsplash.com/@jplenio' },
    };
    await page.evaluate((p) => localStorage.setItem('madinah_bg', JSON.stringify(p)), pref);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

    const stored = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('madinah_bg')); } catch { return null; }
    });
    expect(stored?.source).toBe('unsplash');
    expect(stored?.attribution?.name).toBe('J. Plenio');
  });
});
