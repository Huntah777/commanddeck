import { test, expect } from '@playwright/test';

/* The "upcoming today" list in Admin → Alerts.

   Deliberately reads its list straight off buildPlan — the exact function
   that hands the schedule to the service worker and, via
   syncPushSchedule, to the server (see index.html). These tests are
   mostly about proving that connection holds: what's shown is what will
   actually fire, in the order it will fire, and nothing that has already
   fired or already been done.

   Pinned to a fixed instant AND a fixed browser timezone together —
   buildPlan converts "now" into the app's configured IANA zone
   (state.ui.timezone), so the clock and the zone have to agree for the
   fixture's expected fire times to be the ones actually computed. */

test.use({ timezoneId: 'Europe/London' });

/* 2026-07-29 is a Wednesday, and British Summer Time (UTC+1). Every
   fixture below is built around alerts landing after this instant. */
const NOW = '2026-07-29T09:00:00';

const STATE = (over = {}) => ({
  habits: [], tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [], goals: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  ui: { view: 'admin', notif: true, timezone: 'Europe/London' },
  ...over,
});

async function boot(page, state = STATE()) {
  await page.clock.install({ time: new Date(NOW) });
  await page.addInitScript((s) => {
    /* Notification permission is read at mount from the live global, not
       from state — the section wouldn't render at all without this,
       whatever ui.notif says. No sync token is set, so the app never
       attempts a real push subscription (see Sync.configured() gate in
       syncPushSchedule) and no /api/state or /api/push mocking is needed. */
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    localStorage.setItem('madinah_v1', JSON.stringify(s));
  }, state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
  await page.getByTestId('admin-nav').getByRole('button', { name: 'Alerts' }).click();
}

const section = (page) => page.getByTestId('upcoming-notifications');
const rows    = (page) => page.getByTestId('upcoming-notif');
const ids     = (page) => rows(page).evaluateAll(els => els.map(el => el.dataset.id));

test.describe('what is left to fire today', () => {
  test('a habit reminder and a scheduled block both show up, in the order they will fire', async ({ page }) => {
    const state = STATE({
      /* Reminder at 09:30 — 30 minutes out, and earlier than the block
         alerts below, so this also exercises the sort. */
      habits: [{ id: 'h-1', name: 'Fajr', pillar: 'deen', days: [0,1,2,3,4,5,6], reminder: '09:30', created: 1 }],
      /* 10:00–11:00 on Wednesdays → three alerts: 09:45, 09:55, 10:55. */
      blocks: [{ id: 'b-1', title: 'Deep work', pillar: 'tech', start: 600, end: 660, every: [3] }],
    });
    await boot(page, state);

    await expect(section(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(4);
    expect(await ids(page)).toEqual(['h-h-1', 'b-b-1-15', 'b-b-1-5', 'b-b-1-end']);

    const first = rows(page).nth(0);
    await expect(first).toContainText('Habit reminder');
    await expect(first).toContainText('Fajr');
    await expect(first).toHaveAttribute('data-fire-at', String(Date.parse('2026-07-29T09:30:00+01:00')));

    const last = rows(page).nth(3);
    await expect(last).toContainText('Ending in 5 min');
    await expect(last).toContainText('Deep work');
    await expect(last).toHaveAttribute('data-fire-at', String(Date.parse('2026-07-29T10:55:00+01:00')));

    /* The count in the section header is not a separate tally — it is
       the same list, so it can never quietly disagree with the rows. */
    await expect(section(page)).toContainText('UPCOMING TODAY · 4');
  });

  test('shows how long until each one, not just the clock time', async ({ page }) => {
    const state = STATE({
      habits: [{ id: 'h-1', name: 'Fajr', pillar: 'deen', days: [0,1,2,3,4,5,6], reminder: '09:30', created: 1 }],
      blocks: [{ id: 'b-1', title: 'Deep work', pillar: 'tech', start: 600, end: 660, every: [3] }],
    });
    await boot(page, state);

    // 30m, 45m, 55m, and 115 minutes rendered as "1h55" — parse.js's
    // fmtMins uses the same hour-then-minutes convention.
    await expect(rows(page).nth(0)).toContainText('in 30m');
    await expect(rows(page).nth(1)).toContainText('in 45m');
    await expect(rows(page).nth(2)).toContainText('in 55m');
    await expect(rows(page).nth(3)).toContainText('in 1h55');
  });

  test('nothing to fire today reads as empty, not as broken', async ({ page }) => {
    await boot(page, STATE());
    await expect(section(page)).toBeVisible();
    await expect(page.getByTestId('upcoming-empty')).toContainText('Nothing left to fire today');
    await expect(rows(page)).toHaveCount(0);
    // No count badge on an empty list.
    await expect(section(page)).not.toContainText('UPCOMING TODAY ·');
  });

  test('a notification whose moment has already passed is not shown', async ({ page }) => {
    // 08:00 is before the pinned 09:00 "now" — already happened.
    const state = STATE({
      habits: [{ id: 'h-1', name: 'Fajr', pillar: 'deen', days: [0,1,2,3,4,5,6], reminder: '08:00', created: 1 }],
    });
    await boot(page, state);
    await expect(page.getByTestId('upcoming-empty')).toBeVisible();
  });

  test('a habit already ticked off today drops off the list, alert and all', async ({ page }) => {
    /* The alerts exist to get it done — one already ticked has nothing
       left to remind about, whether it has a plain reminder or a
       calendar slot. */
    const state = STATE({
      habits: [{ id: 'h-1', name: 'Fajr', pillar: 'deen', days: [0,1,2,3,4,5,6], reminder: '09:30', created: 1 }],
      logs: { '2026-07-29': { 'h-1': Date.now() } },
    });
    await boot(page, state);
    await expect(page.getByTestId('upcoming-empty')).toBeVisible();
  });

  test('a habit given a calendar slot is not also reminded twice', async ({ page }) => {
    /* A scheduled habit's block alerts cover it — the standalone
       reminder would be a fourth notification for one habit. */
    const state = STATE({
      habits: [{ id: 'h-1', name: 'Fajr', pillar: 'deen', days: [0,1,2,3,4,5,6], reminder: '09:30', created: 1 }],
      blocks: [{ id: 'b-h-1', habitId: 'h-1', start: 570, end: 600 }],   // 09:30–10:00, Wed included via habit.days
    });
    await boot(page, state);

    const shown = await ids(page);
    expect(shown).not.toContain('h-h-1');
    // Its own three block alerts still fire (09:15, 09:25, 09:55 — all
    // after the pinned 09:00 "now").
    expect(shown).toEqual(['b-b-h-1-15', 'b-b-h-1-5', 'b-b-h-1-end']);
  });

  test('only appears once notifications are actually enabled', async ({ page }) => {
    // ui.notif: false — the toggle is off, so nothing here would ever
    // fire and showing a preview would be showing a lie.
    await boot(page, STATE({ ui: { view: 'admin', notif: false, timezone: 'Europe/London' } }));
    await expect(page.getByTestId('notifications-card')).toBeVisible();
    await expect(section(page)).toHaveCount(0);
  });
});
