import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/* The iOS widget's day logic.

   widget/command-deck.js has to run standalone inside Scriptable — no
   build step, no imports, one file — so it carries a hand copy of the
   app's rules for what is on a day and whether it is done
   (resolveBlocks + blockOnDay + blockDone in index.html).

   A copy nobody checks is a copy that drifts, and this one drifts
   silently: the widget would just quietly show the wrong day and you'd
   have no reason to look. So the file marks its pure region, and these
   tests slice that region out and run it against the same fixtures the
   app's own tests use. */

/* Resolved from the repo root rather than from this file, because the
   specs are transpiled and import.meta is not available in them. */
const WIDGET = path.resolve(process.cwd(), 'widget/command-deck.js');
if (!existsSync(WIDGET)) throw new Error(`Cannot find ${WIDGET} — run playwright from the repo root.`);
const SRC = readFileSync(WIDGET, 'utf8');

const pure = (() => {
  const start = SRC.indexOf('/* ===== PURE START');
  const end   = SRC.indexOf('/* ===== PURE END');
  if (start < 0 || end < 0) throw new Error('widget/command-deck.js lost its PURE markers');
  const consts = SRC.slice(0, start);              /* PILLARS, MUTED, SALAH_* live above it */
  const body   = SRC.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${consts}\n${body}\nreturn { itemsForDay, habitTally, nextChangeAt, salahMinutes, durLabel, toHM, dayKeyOf };`)();
})();

const { itemsForDay, habitTally, nextChangeAt, salahMinutes, durLabel, toHM, dayKeyOf } = pure;

const THU = '2026-08-20';
const DOW = 4;                                      /* 2026-08-20 is a Thursday */

const STATE = (over = {}) => ({
  habits: [
    { id: 'h-fajr',  name: 'Fajr',  pillar: 'deen',   days: [0,1,2,3,4,5,6], icon: '🕌' },
    { id: 'h-gym',   name: 'Gym',   pillar: 'combat', days: [1,3,5] },        /* not Thursday */
  ],
  tasks: [{ id: 't-1', title: 'Ship the deck', listId: 'l-work', done: false }],
  lists: [{ id: 'l-work', name: 'Work', color: '#3b82f6' }],
  blocks: [],
  logs: {},
  ui: {},
  ...over,
});

test.describe('what the widget thinks is on the day', () => {
  test('a habit block takes its title and colour from the habit', async () => {
    const state = STATE({ blocks: [{ id: 'b-1', habitId: 'h-fajr', start: 330, end: 350 }] });
    const [it] = itemsForDay(state, THU, DOW);
    expect(it).toMatchObject({ id: 'b-1', title: 'Fajr', icon: '🕌', colour: '#10b981', start: 330 });
  });

  test('and its done state from the habit’s tick, not the block', async () => {
    const state = STATE({
      blocks: [{ id: 'b-1', habitId: 'h-fajr', start: 330, end: 350 }],
      logs: { [THU]: { 'h-fajr': 1 } },
    });
    expect(itemsForDay(state, THU, DOW)[0].done).toBe(true);
  });

  test('a habit block only shows on the habit’s days', async () => {
    /* The block carries no weekdays of its own — they are read off the
       habit, so a reschedule can never leave a stale twin. */
    const state = STATE({ blocks: [{ id: 'b-2', habitId: 'h-gym', start: 1080, end: 1140 }] });
    expect(itemsForDay(state, THU, DOW)).toHaveLength(0);
    expect(itemsForDay(state, '2026-08-21', 5)).toHaveLength(1);   /* Friday */
  });

  test('a block whose habit was deleted resolves to nothing', async () => {
    const state = STATE({ habits: [], blocks: [{ id: 'b-1', habitId: 'h-fajr', start: 330, end: 350 }] });
    expect(itemsForDay(state, THU, DOW)).toHaveLength(0);
  });

  test('a task block sits on its date and no other, and never recurs', async () => {
    const state = STATE({ blocks: [
      { id: 'b-t', taskId: 't-1', date: THU, start: 540, end: 600, every: [0,1,2,3,4,5,6] },
    ] });
    expect(itemsForDay(state, THU, DOW).map(i => i.title)).toEqual(['Ship the deck']);
    /* The stale weekday list must not make it repeat. */
    expect(itemsForDay(state, '2026-08-21', 5)).toHaveLength(0);
  });

  test('a task block takes its list’s colour and the task’s done flag', async () => {
    const state = STATE({
      tasks:  [{ id: 't-1', title: 'Ship the deck', listId: 'l-work', done: true }],
      blocks: [{ id: 'b-t', taskId: 't-1', date: THU, start: 540, end: 600 }],
    });
    expect(itemsForDay(state, THU, DOW)[0]).toMatchObject({ colour: '#3b82f6', done: true });
  });

  test('a plain block is itself, and ticks under its own id', async () => {
    const state = STATE({
      blocks: [{ id: 'b-wake', title: 'Wake up', pillar: 'character', start: 315, end: 330, every: [0,1,2,3,4,5,6] }],
      logs: { [THU]: { 'b-wake': 1 } },
    });
    expect(itemsForDay(state, THU, DOW)[0]).toMatchObject({ title: 'Wake up', colour: '#a78bfa', done: true });
  });

  test('a block with no title at all is dropped rather than drawn blank', async () => {
    const state = STATE({ blocks: [{ id: 'b-x', pillar: 'tech', start: 540, end: 600, every: [4] }] });
    expect(itemsForDay(state, THU, DOW)).toHaveLength(0);
  });
});

test.describe('the habit count under it', () => {
  test('counts habits scheduled today whether or not they have a slot', async () => {
    /* The number is about the day, not about what happens to have been
       given a time on the calendar. */
    const state = STATE({ logs: { [THU]: { 'h-fajr': 1 } } });
    expect(habitTally(state, THU, DOW)).toEqual({ done: 1, total: 1 });   /* Gym is Mon/Wed/Fri */
    expect(habitTally(state, '2026-08-21', 5)).toEqual({ done: 0, total: 2 });
  });

  test('a day with nothing scheduled reads zero of zero, not a divide by nothing', async () => {
    expect(habitTally(STATE({ habits: [] }), THU, DOW)).toEqual({ done: 0, total: 0 });
  });
});

test.describe('when it asks iOS to wake it', () => {
  const at = (h, m) => new Date(`2026-08-20T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);

  test('at the next boundary that changes what it shows', async () => {
    const items = [{ start: 540, end: 660 }, { start: 780, end: 840 }];
    const now = at(11, 0);                       /* 660 — inside nothing, next mark is 780 */
    const when = nextChangeAt(items, now, 660);
    expect(when.getHours()).toBe(13);
    expect(when.getMinutes()).toBe(0);
  });

  test('the end of the thing you are in counts as a boundary too', async () => {
    const items = [{ start: 540, end: 660 }];
    const when = nextChangeAt(items, at(10, 0), 600);
    expect(when.getHours()).toBe(11);            /* 660 — when it finishes */
  });

  test('never sooner than five minutes, whatever the timetable says', async () => {
    /* iOS budgets these wakes. Spending one on the minute either side of
       a boundary buys nothing. */
    const items = [{ start: 601, end: 660 }];
    const now = at(10, 0);
    const when = nextChangeAt(items, now, 600);
    expect(when.getTime() - now.getTime()).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  test('with nothing left, it waits for the next day rather than spinning', async () => {
    const when = nextChangeAt([], at(22, 0), 1320);
    expect(when.getDate()).toBe(21);
    expect(when.getHours()).toBe(0);
  });
});

test.describe('prayer times', () => {
  test('parses Aladhan’s "HH:MM (TZ)" and applies the offset', async () => {
    expect(salahMinutes('13:10 (BST)', 0)).toBe(13 * 60 + 10);
    expect(salahMinutes('13:10 (BST)', 5)).toBe(13 * 60 + 15);
    expect(salahMinutes('13:10 (BST)', -10)).toBe(13 * 60);
  });

  test('an offset cannot push a prayer into another day', async () => {
    /* Same clamp the app applies: an offset is a nudge, and one that
       spilled past midnight would silently move a prayer's date. */
    expect(salahMinutes('23:50 (BST)', 30)).toBe(1439);
    expect(salahMinutes('00:05 (BST)', -30)).toBe(0);
  });

  test('nothing in, nothing out', async () => {
    expect(salahMinutes('', 0)).toBe(null);
    expect(salahMinutes(undefined, 0)).toBe(null);
    expect(salahMinutes('not a time', 0)).toBe(null);
  });
});

test.describe('formatting', () => {
  test('durations read the way you would say them', async () => {
    expect(durLabel(45)).toBe('45m');
    expect(durLabel(60)).toBe('1h');
    expect(durLabel(90)).toBe('1h 30m');
  });

  test('times and day keys match the app’s', async () => {
    expect(toHM(0)).toBe('00:00');
    expect(toHM(13 * 60 + 5)).toBe('13:05');
    expect(dayKeyOf(new Date('2026-08-20T09:00:00'))).toBe('2026-08-20');
  });
});
