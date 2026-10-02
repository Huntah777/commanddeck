import { test, expect } from '@playwright/test';

/* Liquid Glass (iOS 26, refined in iOS 27): the header and sheets are a
   translucent, blurred material, with a Clear ↔ Tinted slider in
   Appearance and an opaque fallback for people who ask the OS for less
   transparency. These tests pin the behaviour, not the look. */

const mounted = (page) =>
  page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });

const level = (page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--glass-level').trim());

/* The tint's alpha, read back from the header's computed background. */
const headerAlpha = (page) =>
  page.evaluate(() => {
    const m = getComputedStyle(document.querySelector('header')).backgroundColor.match(/rgba?\(([^)]+)\)/);
    const parts = m[1].split(',').map(s => parseFloat(s));
    return parts.length === 4 ? parts[3] : 1;
  });

const openAppearance = async (page) => {
  await page.locator('nav button').filter({ hasText: /^Admin$/ }).first().click();
  await page.getByTestId('admin-nav').getByRole('button', { name: 'Appearance' }).click();
};

test.describe('Liquid Glass', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await mounted(page);
  });

  test('the header is blurred glass by default, and not fully opaque', async ({ page }) => {
    const bf = await page.evaluate(() => getComputedStyle(document.querySelector('header')).backdropFilter);
    expect(bf).toMatch(/blur\(/);
    expect(await level(page)).toBe('0.55');
    const a = await headerAlpha(page);
    expect(a).toBeGreaterThan(0.4);
    expect(a).toBeLessThan(1);
  });

  test('the slider moves the material between Clear and Tinted', async ({ page }) => {
    await openAppearance(page);
    const slider = page.getByRole('slider', { name: 'Liquid Glass' });

    await slider.fill('0');
    const clear = await headerAlpha(page);
    await slider.fill('100');
    const tinted = await headerAlpha(page);

    expect(await level(page)).toBe('1');
    expect(tinted).toBeGreaterThan(clear);
    /* Clear is still a legible bar, not a hole: the floor is what keeps
       10px labels readable over a bright photo. */
    expect(clear).toBeGreaterThanOrEqual(0.5);
  });

  test('the setting is stored on this device and survives a reload', async ({ page }) => {
    await openAppearance(page);
    await page.getByRole('slider', { name: 'Liquid Glass' }).fill('20');
    expect(await page.evaluate(() => localStorage.getItem('madinah_glass'))).toBe('20');

    await page.reload();
    await mounted(page);
    expect(await level(page)).toBe('0.2');
  });

  test('a saved level applies before React mounts (no jump on load)', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('madinah_glass', '100'); });
    await page.goto('/');
    /* Straight after navigation, same check as the theme's flash test. */
    expect(await level(page)).toBe('1');
  });

  test('junk in storage falls back to the default rather than breaking the bar', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('madinah_glass', 'banana'); });
    await page.goto('/');
    await mounted(page);
    expect(await level(page)).toBe('0.55');
    expect(await headerAlpha(page)).toBeLessThan(1);
  });

  test('asking the OS for more contrast makes the glass opaque', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    expect(await headerAlpha(page)).toBe(1);
  });

  test('the nav lens sits under the current tab and follows a change', async ({ page }) => {
    const lensMatchesActive = () => page.evaluate(() => {
      const nav = document.querySelector('nav.glass-nav');
      const on = nav.querySelector('button[aria-pressed="true"]');
      return {
        x: nav.style.getPropertyValue('--lens-x'), w: nav.style.getPropertyValue('--lens-w'),
        want: { x: `${on.offsetLeft}px`, w: `${on.offsetWidth}px` }, label: on.textContent.trim(),
      };
    });

    let r = await lensMatchesActive();
    expect(r.label).toBe('Today');
    expect(r.x).toBe(r.want.x);
    expect(r.w).toBe(r.want.w);

    await page.locator('nav button').filter({ hasText: /^Habits$/ }).first().click();
    await expect.poll(async () => (await lensMatchesActive()).label).toBe('Habits');
    /* The selected tab is semibold, hence wider, so the lens is measured
       again once the layout has settled rather than assumed. */
    await expect.poll(async () => {
      const s = await lensMatchesActive();
      return s.x === s.want.x && s.w === s.want.w;
    }).toBe(true);
  });

  test('the lens is not a button, so tabs are still found by their text', async ({ page }) => {
    await expect(page.locator('nav.glass-nav > button')).toHaveCount(7);
    await expect(page.locator('nav.glass-nav > span.lens')).toHaveCount(1);
  });
});

test.describe('Sheets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await mounted(page);
    await page.locator('button[title="Configure D1 sync"]:visible').first().click();
  });

  test('a sheet is glass over a plain dim — never a blur stacked on a blur', async ({ page }) => {
    const sheet = page.locator('.glass-sheet');
    await expect(sheet).toBeVisible();
    const bf = await sheet.evaluate(el => getComputedStyle(el).backdropFilter);
    expect(bf).toMatch(/blur\(/);
    /* A backdrop-filter inside another one only sees its parent, so if the
       scrim blurred too the sheet would be blurring nothing. */
    const scrim = await page.locator('.modal-scrim').evaluate(el => getComputedStyle(el).backdropFilter);
    expect(scrim).toBe('none');
  });

  test('a sheet never goes as clear as the bar, so its text stays legible', async ({ page }) => {
    await page.evaluate(() => document.documentElement.style.setProperty('--glass-level', '0'));
    const alpha = await page.locator('.glass-sheet').evaluate(el => {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      const p = m[1].split(',').map(s => parseFloat(s));
      return p.length === 4 ? p[3] : 1;
    });
    expect(alpha).toBeGreaterThanOrEqual(0.6);
  });

  test('tapping the dim still dismisses it', async ({ page }) => {
    await expect(page.locator('.glass-sheet')).toBeVisible();
    await page.locator('.modal-scrim').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.glass-sheet')).toHaveCount(0);
  });

  test('the close button still dismisses it', async ({ page }) => {
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.glass-sheet')).toHaveCount(0);
  });
});

test.describe('Sheets on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('it rises from the bottom, with a grabber', async ({ page }) => {
    await page.goto('/');
    await mounted(page);
    await page.locator('button[title="Configure D1 sync"]:visible').first().click();
    const sheet = page.locator('.glass-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.locator('.sheet-grabber')).toBeVisible();
    await expect.poll(async () => {
      const box = await sheet.boundingBox();
      return 844 - (box.y + box.height);
    }).toBeLessThan(24); /* bottom-aligned, inset by the scrim's 8px padding */
  });
});
