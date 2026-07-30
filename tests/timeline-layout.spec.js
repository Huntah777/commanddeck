import { test, expect } from '@playwright/test';

/* Two blocks whose real time ranges don't overlap can still visually
   collide: a block's rendered box has a floor on its height (MIN_BLOCK_PX
   in index.html) so a short slot — 15 minutes, say — still draws roughly
   half an hour tall. A block starting soon after inherits none of that
   from the layout column algorithm unless the overlap check also widens
   short blocks to their rendered size, not their raw duration. Without
   that, two blocks land in the same column and the second is drawn
   starting inside the first's box instead of beside it — exactly the bug
   reported: two near-but-not-quite-overlapping blocks rendered on top of
   each other rather than side by side. */

const DAILY = [0,1,2,3,4,5,6];
const block = (id, start, end, title = id) => ({ id, title, pillar: 'tech', start, end, every: DAILY });

const boot = async (page, blocks) => {
  await page.addInitScript((s) => localStorage.setItem('madinah_v1', JSON.stringify(s)), {
    habits: [], tasks: [], blocks, logs: {}, people: [], pomodoroLogs: [],
    lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
    ui: { view: 'today', selectedDate: '2026-07-29' },
  });
  await page.clock.install({ time: new Date('2026-07-29T09:00:00') });
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const box = (page, title) => page.getByTestId('time-block').filter({ hasText: title });

/* Two boxes are side by side if they occupy different horizontal slots —
   read directly off the inline style, since that's what layoutBlocks
   actually wrote, not a derived/computed value that could mask a bug. */
const geometry = async (locator) => locator.evaluate(el => ({ left: el.style.left, width: el.style.width, top: parseFloat(el.style.top) }));

test.describe('short blocks do not visually swallow the one after them', () => {
  test('a 15-minute block and one starting 2 minutes after it are placed side by side', async ({ page }) => {
    // Real gap: 12:15–12:17 free. But a 15-minute block renders far taller
    // than 15 minutes' worth of pixels (MIN_BLOCK_PX), so on screen these
    // two would otherwise collide.
    await boot(page, [
      block('b-pills', 12 * 60,     12 * 60 + 15, 'Take Second Part of Pills'),
      block('b-read',  12 * 60 + 17, 13 * 60,      'Strategic reading'),
    ]);

    const pills = await geometry(box(page, 'Take Second Part of Pills'));
    const read  = await geometry(box(page, 'Strategic reading'));

    expect(pills.left).not.toBe(read.left);
    expect(pills.width).toContain('50%');
    expect(read.width).toContain('50%');
  });

  test('back-to-back blocks — zero real gap — are still separated', async ({ page }) => {
    await boot(page, [
      block('b-a', 12 * 60,      12 * 60 + 10, 'Quick call'),
      block('b-b', 12 * 60 + 10, 12 * 60 + 40, 'Follow-up'),
    ]);
    const a = await geometry(box(page, 'Quick call'));
    const b = await geometry(box(page, 'Follow-up'));
    expect(a.left).not.toBe(b.left);
  });

  test('a gap wide enough to clear the short block\'s rendered height needs no split', async ({ page }) => {
    /* The other side of the same fix: widening the overlap check must
       not make it trigger-happy. Once the gap clears the short block's
       actual drawn box, both blocks should be full width, stacked. */
    await boot(page, [
      block('b-a', 12 * 60,      12 * 60 + 15, 'Short one'),
      block('b-b', 12 * 60 + 40, 13 * 60 + 10, 'Comfortably later'),
    ]);
    const a = await geometry(box(page, 'Short one'));
    const b = await geometry(box(page, 'Comfortably later'));
    expect(a.width).toContain('100%');
    expect(b.width).toContain('100%');
    expect(a.left).toBe(b.left);
    expect(b.top).toBeGreaterThan(a.top);
  });

  test('a normal-length block genuinely overlapping another still splits, as before', async ({ page }) => {
    // Regression guard on the pre-existing behaviour this fix must not disturb.
    await boot(page, [
      block('b-a', 9 * 60,  10 * 60,      'Meeting A'),
      block('b-b', 9 * 60 + 30, 10 * 60 + 30, 'Meeting B'),
    ]);
    const a = await geometry(box(page, 'Meeting A'));
    const b = await geometry(box(page, 'Meeting B'));
    expect(a.left).not.toBe(b.left);
  });

  test('three short blocks in a row each land in their own column', async ({ page }) => {
    await boot(page, [
      block('b-a', 8 * 60,      8 * 60 + 10, 'One'),
      block('b-b', 8 * 60 + 10, 8 * 60 + 20, 'Two'),
      block('b-c', 8 * 60 + 20, 8 * 60 + 30, 'Three'),
    ]);
    const lefts = new Set();
    for (const title of ['One', 'Two', 'Three']) lefts.add((await geometry(box(page, title))).left);
    expect(lefts.size).toBe(3);
  });
});
