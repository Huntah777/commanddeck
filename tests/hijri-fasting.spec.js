import { test, expect } from '@playwright/test';
import { buildTodaysSchedule, fastingInfo, hijriOn } from '../push-worker/index.js';

/* Fasting used to be two weekday numbers seeded into everyone's state —
   Mon and Thu — which is wrong twice over: it decided something personal
   on the user's behalf, and it could not express any of the fasts that
   actually move, from Ramadan down to the days on which fasting is
   forbidden. These tests pin the Hijri behaviour that replaced it, and
   the night-before notification that makes it usable.
   
   Dates below are real: 2026-09-24 is 13 Rabi al-Thani 1448, and
   2027-03-09 is Eid al-Fitr. Both checked against Umm al-Qura. */

const TZ = 'Europe/London';
const build = (state, parts) => buildTodaysSchedule(state, TZ, parts);
const find  = (schedule, id) => schedule.find(n => n.id === id);

/* Wed 23 Sep 2026 — the eve of a white day, and British Summer Time. */
const WHITE_EVE = { y: 2026, mo: 9, d: 23, dow: 3, key: '2026-09-23' };
/* Sun 6 Sep 2026 — the eve of an ordinary Monday. */
const SUNDAY    = { y: 2026, mo: 9, d: 6,  dow: 0, key: '2026-09-06' };
/* Mon 8 Mar 2027 — the eve of Eid al-Fitr. */
const EID_EVE   = { y: 2027, mo: 3, d: 8,  dow: 1, key: '2027-03-08' };

test.describe('reading the Hijri date', () => {
  test('a Gregorian day converts to its Umm al-Qura date', async () => {
    expect(hijriOn('2026-09-24')).toMatchObject({ y: 1448, m: 4, d: 13, month: 'Rabi al-Thani' });
  });

  test('the offset moves the Hijri date, for a local moonsighting a day out', async () => {
    expect(hijriOn('2026-09-24',  1).d).toBe(14);
    expect(hijriOn('2026-09-24', -1).d).toBe(12);
  });

  test('the offset is clamped rather than trusted', async () => {
    /* A stored value from a bad sync must not silently shift the calendar
       by a month. */
    expect(hijriOn('2026-09-24', 99).d).toBe(hijriOn('2026-09-24', 2).d);
  });

  test('a malformed date key is "no Hijri date", not a crash', async () => {
    expect(hijriOn('')).toBeNull();
    expect(hijriOn('not-a-date')).toBeNull();
  });
});

test.describe('which days are fasts', () => {
  const on = (key, state = {}) => fastingInfo(key, state);

  test('the white days of every month are fasts by default', async () => {
    expect(on('2026-09-24').fasting).toBe(true);
    expect(on('2026-09-24').reasons).toContain('Ayyam al-Bid');
    expect(on('2026-09-26').fasting).toBe(true);   // 15th
    expect(on('2026-09-27').fasting).toBe(false);  // 16th
  });

  test('Ramadan is a fast throughout', async () => {
    expect(on('2027-02-08').reasons).toContain('Ramadan');  // 1 Ramadan 1448
    expect(on('2027-03-01').reasons).toContain('Ramadan');
  });

  test('Arafah is a fast; the Eid the day after is not', async () => {
    expect(on('2027-05-15').reasons).toContain('Arafah');   // 9 Dhu al-Hijjah
    expect(on('2027-05-16').fasting).toBe(false);
    expect(on('2027-05-16').forbidden).toBe('Eid al-Adha');
  });

  test('the days of Tashriq beat the white days they overlap', async () => {
    /* 13 Dhu al-Hijjah is a white day AND a day of Tashriq. This is the
       case a weekday list gets wrong every single year. */
    const tashriq = on('2027-05-19');
    expect(hijriOn('2027-05-19')).toMatchObject({ m: 12, d: 13 });
    expect(tashriq.fasting).toBe(false);
    expect(tashriq.forbidden).toBe('Days of Tashriq');
    expect(on('2027-05-20').reasons).toContain('Ayyam al-Bid'); // 14th, allowed again
  });

  test('Mondays and Thursdays are NOT fasts unless asked for', async () => {
    expect(on('2026-09-07').fasting).toBe(false);  // an ordinary Monday
    expect(on('2026-09-10').fasting).toBe(false);  // an ordinary Thursday
    expect(on('2026-09-07', { admin: { fastingDays: [1] } }).reasons).toContain('Mondays');
  });

  test('a forbidden day overrides a weekday picked by hand', async () => {
    /* Eid al-Fitr 1448 falls on a Tuesday. Choosing "every Tuesday"
       must not put a fast on it. */
    const eid = on('2027-03-09', { admin: { fastingDays: [2] } });
    expect(eid.fasting).toBe(false);
    expect(eid.forbidden).toBe('Eid al-Fitr');
  });

  test('a rule can be switched off', async () => {
    expect(on('2026-09-24', { admin: { fastingRules: { whiteDays: false } } }).fasting).toBe(false);
  });

  test('the six of Shawwal are off until asked for', async () => {
    expect(on('2027-03-11').fasting).toBe(false);  // 3 Shawwal
    expect(on('2027-03-11', { admin: { fastingRules: { shawwal: true } } }).reasons)
      .toContain('Six of Shawwal');
  });
});

test.describe('the night-before notification', () => {
  test('it fires the evening before a fast and says which one', async () => {
    const { schedule } = await build({}, WHITE_EVE);
    const n = find(schedule, 'fast-eve');
    // 20:00 BST is 19:00 UTC.
    expect(n.fireAt).toBe(Date.UTC(2026, 8, 23, 19, 0, 0));
    expect(n.title).toBe('Fasting tomorrow');
    expect(n.body).toContain('Ayyam al-Bid');
    expect(n.body).toContain('13 Rabi al-Thani 1448 AH');
  });

  test('nothing is sent on the eve of an ordinary day', async () => {
    const { schedule } = await build({}, SUNDAY);
    expect(find(schedule, 'fast-eve')).toBeUndefined();
  });

  test('nothing is sent on the eve of a day fasting is forbidden', async () => {
    const { schedule } = await build({ admin: { fastingDays: [2] } }, EID_EVE);
    expect(find(schedule, 'fast-eve')).toBeUndefined();
  });

  test('it honours the chosen time', async () => {
    const { schedule } = await build({ ui: { fastReminder: { on: true, time: '21:30' } } }, WHITE_EVE);
    expect(find(schedule, 'fast-eve').fireAt).toBe(Date.UTC(2026, 8, 23, 20, 30, 0));
  });

  test('it can be turned off', async () => {
    const { schedule } = await build({ ui: { fastReminder: { on: false, time: '20:00' } } }, WHITE_EVE);
    expect(find(schedule, 'fast-eve')).toBeUndefined();
  });

  test('a weekday fast chosen by hand gets the same warning', async () => {
    const { schedule } = await build({ admin: { fastingDays: [1] } }, SUNDAY);
    expect(find(schedule, 'fast-eve').body).toContain('Mondays');
  });
});

/* ── In the app ─────────────────────────────────────────────────── */

const STATE = (over = {}) => ({
  habits: [], tasks: [], blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788', keywords: [] }],
  ui: { view: 'today' },
  ...over,
});

/* The Today tab resets selectedDate to the real today() on load, so the
   only way to look at a particular day from a cold boot is to be on it —
   pin the clock, the same way the calendar specs do. */
const bootOn = async (page, day, state = STATE()) => {
  await page.clock.install({ time: new Date(`${day}T09:00:00`) });
  await page.addInitScript((s) => localStorage.setItem('madinah_v1', JSON.stringify(s)), state);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}'));

test.describe('the header', () => {
  test('shows the Hijri date alongside the Gregorian one', async ({ page }) => {
    await bootOn(page, '2026-09-24');
    await expect(page.getByTestId('hijri-date')).toHaveText('13 Rabi al-Thani');
  });

  test('marks a white day as a fast, and names it', async ({ page }) => {
    await bootOn(page, '2026-09-24');
    await expect(page.getByTestId('fasting-badge')).toContainText('Ayyam al-Bid');
  });

  test('leaves an ordinary Monday alone', async ({ page }) => {
    await bootOn(page, '2026-09-07');
    await expect(page.getByTestId('hijri-date')).toBeVisible();
    await expect(page.getByTestId('fasting-badge')).toHaveCount(0);
  });

  test('says outright when fasting is not allowed', async ({ page }) => {
    await bootOn(page, '2027-03-09');
    await expect(page.getByTestId('no-fasting-badge')).toHaveText('Eid al-Fitr');
    await expect(page.getByTestId('fasting-badge')).toHaveCount(0);
  });

  test('a state still carrying the old seeded Mon/Thu is cleared on load', async ({ page }) => {
    /* Changing the seed reaches new installs only. Anyone who has already
       synced has [1, 4] sitting in their state, and it has to be retired
       there too — otherwise "remove the default" removes nothing. */
    await bootOn(page, '2026-09-07', STATE({ admin: { fastingDays: [1, 4] } }));
    await expect(page.getByTestId('fasting-badge')).toHaveCount(0);
  });

  test('a hand-picked weekday survives that clearing', async ({ page }) => {
    await bootOn(page, '2026-09-07', STATE({ admin: { fastingDays: [1] } }));
    await expect(page.getByTestId('fasting-badge')).toContainText('Mondays');
  });

  test('and choosing Mon/Thu again is not undone on the next load', async ({ page }) => {
    /* The clearing is once-only. Without the flag that makes it so, the
       migration would keep deleting a pair the user had deliberately
       picked back. */
    await bootOn(page, '2026-09-07', STATE({ admin: { fastingDays: [1, 4], fastingDaysCleared: true } }));
    await expect(page.getByTestId('fasting-badge')).toContainText('Mondays');
  });
});

test.describe('the Fasting settings', () => {
  const openFasting = async (page) => {
    await page.getByTestId('admin-nav').getByRole('button', { name: 'Setup' }).click();
    await page.getByRole('button', { name: 'Fasting', exact: true }).click();
  };

  const bootAdmin = (page) => bootOn(page, '2026-09-24', STATE({ ui: { view: 'admin' } }));

  test('the Hijri rules are listed and can be toggled', async ({ page }) => {
    await bootAdmin(page);
    await openFasting(page);
    await expect(page.getByTestId('fast-rule-ramadan')).toBeVisible();

    await page.getByTestId('fast-rule-whiteDays').click();
    await expect(page.getByTestId('fasting-badge')).toHaveCount(0);
    expect((await stored(page)).admin.fastingRules.whiteDays).toBe(false);
  });

  test('it shows the fasts that are actually coming', async ({ page }) => {
    await bootAdmin(page);
    await openFasting(page);
    await expect(page.getByTestId('upcoming-fasts').locator('> div').first()).toContainText('Ayyam al-Bid');
  });

  test('the Hijri date can be nudged to match a local moonsighting', async ({ page }) => {
    await bootAdmin(page);
    await openFasting(page);
    await expect(page.getByTestId('hijri-today')).toContainText('13 Rabi al-Thani 1448 AH');

    await page.getByRole('button', { name: '+1', exact: true }).click();
    await expect(page.getByTestId('hijri-today')).toContainText('14 Rabi al-Thani 1448 AH');
    await expect(page.getByTestId('hijri-date')).toHaveText('14 Rabi al-Thani');
  });

  test('no weekday is selected out of the box', async ({ page }) => {
    await bootAdmin(page);
    await openFasting(page);
    /* Every weekday button reads as unselected — the Mon/Thu default is
       gone from the seed, not just from the badge. */
    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      await expect(page.getByRole('button', { name: day, exact: true })).not.toHaveClass(/text-deen/);
    }
  });

  test('the night-before reminder can be turned off', async ({ page }) => {
    await bootAdmin(page);
    await openFasting(page);
    await page.getByTestId('fast-reminder-toggle').click();
    expect((await stored(page)).ui.fastReminder.on).toBe(false);
  });
});
