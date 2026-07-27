import { test, expect } from '@playwright/test';
import { buildTodaysSchedule, nextFireAt, staleAfter, salahOffsets, salahMinutes } from '../push-worker/index.js';

/* The Cron Worker's plan builder decides what gets delivered and when, for
   every device, whether or not the app is running. It had no tests. No browser
   needed — these are pure functions of (state, timezone, day). */

const TZ = 'Europe/London';
/* 2026-07-15 is a Wednesday, and British Summer Time (UTC+1). */
const SUMMER = { y: 2026, mo: 7,  d: 15, dow: 3, key: '2026-07-15' };
/* 2026-01-14 is a Wednesday, and GMT (UTC+0). */
const WINTER = { y: 2026, mo: 1,  d: 14, dow: 3, key: '2026-01-14' };

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const habit = (over = {}) => ({ id: 'h1', name: 'Read Quran', days: EVERY_DAY, reminder: '07:00', ...over });
const build = (state, parts = SUMMER) => buildTodaysSchedule(state, TZ, parts);
const find  = (schedule, id) => schedule.find(n => n.id === id);

test.describe('notification plan — timing', () => {
  test('a reminder lands on the right instant during summer time', async () => {
    const { schedule } = await build({ habits: [habit()] });
    // 07:00 BST is 06:00 UTC — not 07:00 UTC.
    expect(find(schedule, 'h-h1').fireAt).toBe(Date.UTC(2026, 6, 15, 6, 0, 0));
  });

  test('the same reminder shifts correctly in winter', async () => {
    const { schedule } = await build({ habits: [habit()] }, WINTER);
    expect(find(schedule, 'h-h1').fireAt).toBe(Date.UTC(2026, 0, 14, 7, 0, 0));
  });

  test('a block crossing midnight anchors its end to the next day', async () => {
    const state = { blocks: [{ id: 'b1', title: 'Night shift', every: EVERY_DAY, start: 22 * 60, end: 6 * 60 }] };
    const { schedule } = await build(state);

    // Starts 22:00 BST = 21:00 UTC; the 06:00 end belongs to the 16th.
    expect(find(schedule, 'b-b1-15').fireAt).toBe(Date.UTC(2026, 6, 15, 20, 45, 0));
    expect(find(schedule, 'b-b1-5').fireAt).toBe(Date.UTC(2026, 6, 15, 20, 55, 0));
    expect(find(schedule, 'b-b1-end').fireAt).toBe(Date.UTC(2026, 6, 16, 4, 55, 0));
  });

  test('goal reminders fire morning and evening, staggered by horizon', async () => {
    const state = {
      goals: [
        { id: 'g1', title: 'Ship it',   horizon: 'quarter', quarter: '2026-Q3', status: 'active' },
        { id: 'g2', title: 'Get fit',   horizon: '1year',   status: 'active' },
        { id: 'g3', title: 'The point', horizon: 'lifetime', status: 'active' },
      ],
      ui: { goalsReminder: { on: true, time: '07:00', eveningOn: true, eveningTime: '18:00' } },
    };
    const { schedule } = await build(state);

    expect(find(schedule, 'goals-am-quarter').fireAt).toBe(Date.UTC(2026, 6, 15, 6, 0, 0));
    expect(find(schedule, 'goals-am-year').fireAt).toBe(Date.UTC(2026, 6, 15, 6, 2, 0));
    expect(find(schedule, 'goals-am-lifetime').fireAt).toBe(Date.UTC(2026, 6, 15, 6, 4, 0));
    expect(find(schedule, 'goals-pm-quarter').fireAt).toBe(Date.UTC(2026, 6, 15, 17, 0, 0));
  });

  test('completed goals are left out', async () => {
    const state = {
      goals: [{ id: 'g1', title: 'Done', horizon: '1year', status: 'completed' }],
      ui: { goalsReminder: { on: true, time: '07:00' } },
    };
    const { schedule } = await build(state);
    expect(find(schedule, 'goals-am-year')).toBeUndefined();
  });
});

test.describe('notification plan — suppression', () => {
  test('a habit already ticked today is not reminded about', async () => {
    // Ticks are timestamps now, not `true` — the plan builder reads them for
    // truthiness, so this must keep working after that change.
    const state = { habits: [habit()], logs: { '2026-07-15': { h1: 1_800_000_000_000 } } };
    const { schedule } = await build(state);
    expect(find(schedule, 'h-h1')).toBeUndefined();
  });

  test('a legacy `true` tick still suppresses the reminder', async () => {
    const state = { habits: [habit()], logs: { '2026-07-15': { h1: true } } };
    const { schedule } = await build(state);
    expect(find(schedule, 'h-h1')).toBeUndefined();
  });

  test('a tick on a different day does not suppress today', async () => {
    const state = { habits: [habit()], logs: { '2026-07-14': { h1: 1_800_000_000_000 } } };
    const { schedule } = await build(state);
    expect(find(schedule, 'h-h1')).toBeDefined();
  });

  test('habits not scheduled for today are skipped', async () => {
    const { schedule } = await build({ habits: [habit({ days: [0, 6] })] }); // weekends only
    expect(find(schedule, 'h-h1')).toBeUndefined();
  });

  test('a completed task raises no reminder', async () => {
    const at = Date.UTC(2026, 6, 15, 9, 0, 0);
    const done = { tasks: [{ id: 't1', title: 'x', reminder: new Date(at).toISOString(), done: true }] };
    const open = { tasks: [{ id: 't1', title: 'x', reminder: new Date(at).toISOString(), done: false }] };
    expect(find((await build(done)).schedule, 't-t1')).toBeUndefined();
    expect(find((await build(open)).schedule, 't-t1').fireAt).toBe(at);
  });
});

test.describe('notification plan — prayer time offsets', () => {
  const withTimings = (fn) => async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ data: { timings: { Fajr: '03:12 (BST)', Dhuhr: '13:05 (BST)', Isha: '23:50 (BST)' } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    try { await fn(); } finally { globalThis.fetch = realFetch; }
  };

  test('an offset moves the notification, not just the displayed time', withTimings(async () => {
    // The reminder has to land on the minute the app shows, so the worker
    // applies the same offsets the client does.
    const state = { ui: { salahLoc: { lat: 51.5, lon: -0.12 }, salahOffsets: { Dhuhr: 5 } } };
    const { schedule } = await build(state);

    expect(find(schedule, 'salah-Dhuhr').fireAt).toBe(Date.UTC(2026, 6, 15, 12, 10, 0)); // 13:10 BST
    expect(find(schedule, 'salah-Fajr').fireAt).toBe(Date.UTC(2026, 6, 15, 2, 12, 0));   // untouched
  }));

  test('a negative offset works too', withTimings(async () => {
    const state = { ui: { salahLoc: { lat: 51.5, lon: -0.12 }, salahOffsets: { Fajr: -7 } } };
    const { schedule } = await build(state);
    expect(find(schedule, 'salah-Fajr').fireAt).toBe(Date.UTC(2026, 6, 15, 2, 5, 0)); // 03:05 BST
  }));

  test('an offset cannot push a prayer onto the next day', withTimings(async () => {
    // Isha at 23:50 with a large positive offset must stay on today.
    const state = { ui: { salahLoc: { lat: 51.5, lon: -0.12 }, salahOffsets: { Isha: 60 } } };
    const { schedule } = await build(state);
    const isha = find(schedule, 'salah-Isha').fireAt;
    expect(isha).toBeLessThan(Date.UTC(2026, 6, 15, 23, 0, 0)); // still the 15th in UTC terms
    expect(salahMinutes('23:50 (BST)', 60)).toBe(24 * 60 - 1);
  }));

  test('offsets default to zero and are clamped to a sane range', () => {
    expect(salahOffsets(undefined)).toEqual({ Fajr: 0, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0 });
    expect(salahOffsets({ salahOffsets: { Dhuhr: 5 } }).Dhuhr).toBe(5);
    expect(salahOffsets({ salahOffsets: { Dhuhr: 'nonsense' } }).Dhuhr).toBe(0);
    expect(salahOffsets({ salahOffsets: { Dhuhr: 9999 } }).Dhuhr).toBe(60);
    expect(salahOffsets({ salahOffsets: { Dhuhr: -9999 } }).Dhuhr).toBe(-60);
  });

  test('salahMinutes parses Aladhan formatting and applies the offset', () => {
    expect(salahMinutes('13:05 (BST)', 0)).toBe(13 * 60 + 5);
    expect(salahMinutes('13:05', 5)).toBe(13 * 60 + 10);
    expect(salahMinutes('00:10 (GMT)', -30)).toBe(0); // clamped, never yesterday
    expect(salahMinutes(undefined, 5)).toBeNull();
  });
});

test.describe('notification plan — delivery safety', () => {
  test('one device turning notifications off does not silence the others', async () => {
    // ui.notif is synced, so gating the whole plan on it let one device mute
    // every other device. Opting out is per-device: it deletes that device's
    // push_subs row.
    const state = { habits: [habit()], ui: { notif: false } };
    const { schedule } = await build(state);
    expect(find(schedule, 'h-h1')).toBeDefined();
  });

  test('a failed prayer-time fetch reports not-ok so stored plans are kept', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    try {
      const state = { habits: [habit()], ui: { salahLoc: { lat: 51.5, lon: -0.12 } } };
      const { ok } = await build(state);
      expect(ok).toBe(false);
    } finally { globalThis.fetch = realFetch; }
  });

  test('prayer times are scheduled in local time, not UTC', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ data: { timings: { Fajr: '03:12 (BST)', Dhuhr: '13:05 (BST)' } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    try {
      const state = { ui: { salahLoc: { lat: 51.5, lon: -0.12 } } };
      const { schedule, ok } = await build(state);
      expect(ok).toBe(true);
      // Aladhan returns local wall-clock time; 03:12 BST is 02:12 UTC.
      expect(find(schedule, 'salah-Fajr').fireAt).toBe(Date.UTC(2026, 6, 15, 2, 12, 0));
      expect(find(schedule, 'salah-Dhuhr').fireAt).toBe(Date.UTC(2026, 6, 15, 12, 5, 0));
    } finally { globalThis.fetch = realFetch; }
  });

  test('the plan is a pure function of its inputs — rebuilding is safe', async () => {
    // Every tick rebuilds from scratch and compares; drift here would rewrite
    // D1 every minute and could resurrect delivered entries.
    const state = { habits: [habit()], blocks: [{ id: 'b1', title: 'Gym', every: EVERY_DAY, start: 540, end: 600 }] };
    const a = (await build(state)).schedule;
    const b = (await build(state)).schedule;
    expect(b).toEqual(a);
  });

  test('a reminder still worth acting on survives a phone being offline', () => {
    // A blanket 10-minute window meant a habit or task reminder was dropped
    // entirely if the device was out of signal when it fired. Time-critical
    // ones stay short, because a late "time to pray" is worse than none.
    expect(staleAfter('salah-Fajr')).toBe(10 * 60_000);
    expect(staleAfter('b-b1-5')).toBe(10 * 60_000);

    expect(staleAfter('h-h1')).toBeGreaterThan(60 * 60_000);
    expect(staleAfter('t-t1')).toBeGreaterThan(60 * 60_000);
    expect(staleAfter('goals-am-year')).toBeGreaterThan(60 * 60_000);
  });

  test('nextFireAt skips what has already been delivered', () => {
    const schedule = [
      { id: 'a', fireAt: 1000 },
      { id: 'b', fireAt: 2000 },
      { id: 'c', fireAt: 3000 },
    ];
    expect(nextFireAt(schedule, new Set())).toBe(1000);
    expect(nextFireAt(schedule, new Set(['a']))).toBe(2000);
    expect(nextFireAt(schedule, new Set(['a', 'b', 'c']))).toBe(0);
  });
});
