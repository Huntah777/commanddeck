import { test, expect } from '@playwright/test';
import { buildDigest, digestFingerprint, metricsOf } from '../functions/api/digest.js';
import { checkAllowed, runsLeftIn, extractJson } from '../functions/api/coach.js';

/* Unit tests for the coaching review. No browser and no model — and that
   is the whole design: the model is handed finished arithmetic and asked
   only to phrase it, so everything that could be *wrong* is in here.

   A coaching report built on invented numbers is worse than no report, so
   these tests exist to guarantee the numbers are real. */

const TODAY = '2026-07-29';                 // a Wednesday
const dayMs = 86_400_000;
const at = (key) => Date.parse(`${key}T12:00:00Z`);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/* Build a logs map marking `habitId` done on each of the given offsets
   back from TODAY. */
const logsFor = (habitId, offsets) => Object.fromEntries(
  offsets.map(i => [new Date(at(TODAY) - i * dayMs).toISOString().slice(0, 10), { [habitId]: at(TODAY) - i * dayMs }])
);

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => i + from);

test.describe('digest — habit completion', () => {
  test('completion counts only the days a habit was scheduled for', () => {
    // Scheduled Mondays only: 30 days holds 4 Mondays, not 30. Measuring
    // against every day would read a perfect habit as an 86% failure.
    const state = { habits: [{ id: 'h1', name: 'Gym', days: [1] }], logs: {} };
    const d = buildDigest(state, TODAY);
    expect(d.habits.scheduled).toBeGreaterThanOrEqual(4);
    expect(d.habits.scheduled).toBeLessThanOrEqual(5);
  });

  test('a perfectly kept habit reads as 100%, not less', () => {
    const state = {
      habits: [{ id: 'h1', name: 'Fajr', days: EVERY_DAY }],
      logs: logsFor('h1', range(30)),
    };
    const d = buildDigest(state, TODAY);
    expect(d.habits.pct).toBe(100);
    expect(d.habits.weakest[0]).toMatchObject({ name: 'Fajr', pct: 100 });
  });

  test('an untouched habit reads as 0%, and is not silently dropped', () => {
    const state = { habits: [{ id: 'h1', name: 'Fajr', days: EVERY_DAY }], logs: {} };
    const d = buildDigest(state, TODAY);
    expect(d.habits.pct).toBe(0);
    expect(d.habits.tracked).toBe(1);
  });

  test('a habit never scheduled in the window is excluded rather than counted as failure', () => {
    // days: [] — scheduled on no weekday at all. 0/0 is not 0%.
    const state = { habits: [{ id: 'h1', name: 'Ghost', days: [] }], logs: {} };
    const d = buildDigest(state, TODAY);
    expect(d.habits.tracked).toBe(0);
    expect(d.habits.pct).toBeNull();
  });
});

test.describe('digest — trends', () => {
  test('a habit dropped in the last week shows up as slipping', () => {
    // Kept for the prior 23 days, missed every day of the last 7.
    const state = {
      habits: [{ id: 'h1', name: 'Reading', days: EVERY_DAY }],
      logs: logsFor('h1', range(23, 7)),
    };
    const d = buildDigest(state, TODAY);
    expect(d.habits.slipping[0]).toMatchObject({ name: 'Reading', recentPct: 0, priorPct: 100 });
    expect(d.habits.recentPct).toBe(0);
    expect(d.habits.priorPct).toBe(100);
  });

  test('a habit improving lately is not reported as slipping', () => {
    const state = {
      habits: [{ id: 'h1', name: 'Reading', days: EVERY_DAY }],
      logs: logsFor('h1', range(7)), // only the last week
    };
    const d = buildDigest(state, TODAY);
    expect(d.habits.slipping).toHaveLength(0);
    expect(d.habits.recentPct).toBe(100);
  });

  test('a habit not done for a week is flagged abandoned, with how long', () => {
    const state = {
      habits: [{ id: 'h1', name: 'Arabic', days: EVERY_DAY }],
      logs: logsFor('h1', range(20, 10)), // last tick was 10 days ago
    };
    const d = buildDigest(state, TODAY);
    expect(d.habits.abandoned[0]).toMatchObject({ name: 'Arabic', daysSinceDone: 10 });
  });

  test('a habit done today is not flagged abandoned', () => {
    const state = {
      habits: [{ id: 'h1', name: 'Arabic', days: EVERY_DAY }],
      logs: logsFor('h1', range(30)),
    };
    expect(buildDigest(state, TODAY).habits.abandoned).toHaveLength(0);
  });
});

test.describe('digest — tasks', () => {
  const task = (over) => ({ id: 't1', title: 'x', quadrant: 'plan', created: at(TODAY) - 5 * dayMs, ...over });

  test('open tasks are broken down by quadrant', () => {
    const state = { tasks: [
      task({ id: 't1', quadrant: 'do' }), task({ id: 't2', quadrant: 'do' }),
      task({ id: 't3', quadrant: 'plan' }), task({ id: 't4', quadrant: 'eliminate', done: true, doneAt: at(TODAY) }),
    ] };
    const d = buildDigest(state, TODAY);
    expect(d.tasks.open).toBe(3);
    expect(d.tasks.openByQuadrant).toMatchObject({ do: 2, plan: 1 });
    expect(d.tasks.openByQuadrant.eliminate).toBeUndefined(); // completed, not open
  });

  test('overdue counts only open tasks past their date', () => {
    const state = { tasks: [
      task({ id: 't1', due: '2026-07-01' }),                            // overdue
      task({ id: 't2', due: '2026-07-02', done: true, doneAt: at(TODAY) }), // done, not overdue
      task({ id: 't3', due: '2026-12-01' }),                            // future
      task({ id: 't4', due: TODAY }),                                   // due today is not late
    ] };
    const d = buildDigest(state, TODAY);
    expect(d.tasks.overdue).toBe(1);
    expect(d.tasks.oldestOverdue).toBe('2026-07-01');
  });

  test('completions outside the window do not inflate the period', () => {
    const state = { tasks: [
      task({ id: 't1', done: true, doneAt: at(TODAY) - 3 * dayMs }),
      task({ id: 't2', done: true, doneAt: at(TODAY) - 90 * dayMs }), // long before the window
    ] };
    expect(buildDigest(state, TODAY).tasks.completed).toBe(1);
  });

  test('tasks open a long time surface as stale, oldest first', () => {
    const state = { tasks: [
      task({ id: 't1', title: 'Ancient', created: at(TODAY) - 60 * dayMs }),
      task({ id: 't2', title: 'Old',     created: at(TODAY) - 25 * dayMs }),
      task({ id: 't3', title: 'Fresh',   created: at(TODAY) - 2 * dayMs }),
    ] };
    const d = buildDigest(state, TODAY);
    expect(d.tasks.stale.map(s => s.title)).toEqual(['Ancient', 'Old']);
    expect(d.tasks.stale[0].ageDays).toBe(60);
  });
});

test.describe('digest — resilience', () => {
  /* This runs against whatever is in D1, which spans every version of the
     app's shape that has ever synced. It must never throw. */
  test('an empty state produces a valid digest rather than throwing', () => {
    const d = buildDigest({}, TODAY);
    expect(d.habits.pct).toBeNull();
    expect(d.tasks.open).toBe(0);
    expect(d.pillars).toEqual([]);
  });

  test('malformed entries are tolerated', () => {
    const state = {
      habits: [{ id: 'h1' }, { id: 'h2', days: 'not-an-array' }],
      tasks: [{ id: 't1' }, null].filter(Boolean),
      pomodoroLogs: [{ mins: 'x', date: 'nope' }],
      goals: 'not-an-array',
    };
    expect(() => buildDigest(state, TODAY)).not.toThrow();
    expect(buildDigest(state, TODAY).goals.active).toBe(0);
  });

  test('a bad `today` falls back rather than producing nonsense dates', () => {
    const d = buildDigest({}, 'not-a-date');
    expect(d.window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

test.describe('spend guard', () => {
  /* Opus costs real money per call. These rules are the only thing
     between a client retry loop and a surprise bill. */
  const now = 1_800_000_000_000;
  const hour = 3_600_000, week = 7 * 24 * hour;
  const FP = 'fingerprint-a';

  test('the first ever review is allowed', () => {
    expect(checkAllowed(null, { now, force: false, fingerprint: FP })).toBeNull();
  });

  test('the scheduled review waits a full week', () => {
    const coach = { at: now - 3 * 24 * hour, runs: [now - 3 * 24 * hour], fingerprint: 'old' };
    expect(checkAllowed(coach, { now, force: false, fingerprint: FP })?.reason).toBe('not_due');
    // ...and a week later it fires.
    expect(checkAllowed(coach, { now: now + week, force: false, fingerprint: FP })).toBeNull();
  });

  test('a manual refresh skips the weekly wait but not the hourly floor', () => {
    const coach = { at: now - 10 * 60_000, runs: [now - 10 * 60_000], fingerprint: 'old' };
    expect(checkAllowed(coach, { now, force: true, fingerprint: FP })?.reason).toBe('too_soon');

    const older = { at: now - 2 * hour, runs: [now - 2 * hour], fingerprint: 'old' };
    expect(checkAllowed(older, { now, force: true, fingerprint: FP })).toBeNull();
  });

  test('three runs in a week is the hard ceiling, however hard it is forced', () => {
    const coach = { at: now - 2 * hour, fingerprint: 'old', runs: [now - 50 * hour, now - 26 * hour, now - 2 * hour] };
    expect(checkAllowed(coach, { now, force: true, fingerprint: FP })?.reason).toBe('weekly_limit');
    expect(runsLeftIn(coach, now)).toBe(0);
  });

  test('the ceiling is a rolling week, not a calendar one', () => {
    const coach = { at: now - 8 * 24 * hour, fingerprint: 'old', runs: [now - 8 * 24 * hour, now - 9 * 24 * hour, now - 10 * 24 * hour] };
    expect(runsLeftIn(coach, now)).toBe(3);
    expect(checkAllowed(coach, { now, force: false, fingerprint: FP })).toBeNull();
  });

  test('an unchanged digest is never re-bought, even when forced', () => {
    // Nothing has moved since the last review, so there is nothing new to
    // say and no reason to pay Opus to say it again.
    const coach = { at: now - 8 * 24 * hour, runs: [now - 8 * 24 * hour], fingerprint: FP };
    expect(checkAllowed(coach, { now, force: true, fingerprint: FP })?.reason).toBe('unchanged');
  });

  test('the fingerprint moves when the numbers that matter move', () => {
    const base = buildDigest({ habits: [{ id: 'h1', name: 'A', days: EVERY_DAY }], logs: {} }, TODAY);
    const after = buildDigest({ habits: [{ id: 'h1', name: 'A', days: EVERY_DAY }], logs: logsFor('h1', range(5)) }, TODAY);
    expect(digestFingerprint(after)).not.toBe(digestFingerprint(base));
  });

  test('the fingerprint ignores churn that would not change the advice', () => {
    // Renaming a habit is not a reason to spend money on a fresh review.
    const a = buildDigest({ habits: [{ id: 'h1', name: 'Gym', days: EVERY_DAY }], logs: logsFor('h1', range(10)) }, TODAY);
    const b = buildDigest({ habits: [{ id: 'h1', name: 'Training', days: EVERY_DAY }], logs: logsFor('h1', range(10)) }, TODAY);
    expect(digestFingerprint(a)).toBe(digestFingerprint(b));
  });
});

test.describe('learning between reviews', () => {
  /* A review that cannot check its own past advice is a horoscope. The
     metrics are snapshotted when advice is given, and the delta is
     computed here in code — the model is never asked to diff two
     reports, only to judge what the diff means. */
  const priorCoach = (metrics, over = {}) => ({
    at: 1_000, history: [{ at: 1_000, note: 'Fajr slipped — check the earlier reminder held.',
      actions: ['Set Fajr reminder 15 minutes earlier'], metrics, ...over }],
  });

  test('the digest carries what was advised and what has since moved', () => {
    const state = {
      habits: [{ id: 'h1', name: 'Fajr', days: EVERY_DAY }],
      logs: logsFor('h1', range(30)),
      coach: priorCoach({ habitsPct: 40, recentPct: 20, tasksOpen: 9, overdue: 6, focusSessions: 2 }),
    };
    const since = buildDigest(state, TODAY).sinceLastReview;

    expect(since.actions).toContain('Set Fajr reminder 15 minutes earlier');
    expect(since.note).toMatch(/Fajr slipped/);
    expect(since.changes.habitsPct).toMatchObject({ from: 40, to: 100, delta: 60 });
    expect(since.changes.overdue).toMatchObject({ from: 6, to: 0, delta: -6 });
  });

  test('a first review has nothing to measure against and says so with null', () => {
    // Not zeros — a zero delta reads as "nothing changed", which is a
    // different and false claim.
    expect(buildDigest({ habits: [], logs: {} }, TODAY).sinceLastReview).toBeNull();
    expect(buildDigest({ coach: { at: 1, history: [] } }, TODAY).sinceLastReview).toBeNull();
  });

  test('advice that failed is visible as a negative delta, not hidden', () => {
    const state = {
      habits: [{ id: 'h1', name: 'Fajr', days: EVERY_DAY }],
      logs: {},
      coach: priorCoach({ habitsPct: 80, recentPct: 80, tasksOpen: 2, overdue: 0, focusSessions: 10 }),
    };
    const since = buildDigest(state, TODAY).sinceLastReview;
    expect(since.changes.habitsPct.delta).toBeLessThan(0);
  });

  test('the digest reports how often the automatic filing was overruled', () => {
    const t = (id, quadrant, aiQuadrant) => ({ id, title: 'x', quadrant, created: at(TODAY), ai: { quadrant: aiQuadrant, raw: 'x' } });
    const d = buildDigest({ tasks: [t('t1', 'do', 'delegate'), t('t2', 'plan', 'plan'), t('t3', 'do', 'eliminate')] }, TODAY);
    expect(d.filing).toMatchObject({ filed: 3, corrected: 2 });
    expect(d.filing.byField.quadrant).toBe(2);
  });

  test('the metrics snapshot carries exactly what the next delta needs', () => {
    const d = buildDigest({ habits: [{ id: 'h1', name: 'A', days: EVERY_DAY }], logs: logsFor('h1', range(10)) }, TODAY);
    const m = metricsOf(d);
    expect(Object.keys(m).sort()).toEqual(['focusSessions', 'habitsPct', 'overdue', 'recentPct', 'tasksOpen']);
    expect(m.habitsPct).toBe(d.habits.pct);
  });
});

test.describe('reading the model reply', () => {
  /* Workers AI does not document structured outputs on the Anthropic
     pass-through. output_config is still sent — exact when honoured —
     but a review must not 502 because an undocumented parameter was
     dropped and the model replied in prose-wrapped JSON instead. */
  const REVIEW = { headline: 'x', verdict: '', failing: [], actions: [], working: { area: 'a', evidence: 'b' }, note: 'n' };

  test('a clean JSON reply parses', () => {
    expect(extractJson(JSON.stringify(REVIEW))).toMatchObject({ headline: 'x' });
  });

  test('JSON wrapped in a code fence still parses', () => {
    const fenced = ['```json', JSON.stringify(REVIEW), '```'].join('\n');
    expect(extractJson(fenced)).toMatchObject({ headline: 'x' });
  });

  test('JSON with a chatty preamble still parses', () => {
    const chatty = ['Here is your review:', JSON.stringify(REVIEW), 'Hope that helps!'].join('\n');
    expect(extractJson(chatty)).toMatchObject({ note: 'n' });
  });

  test('a reply with no JSON at all fails loudly rather than silently', () => {
    // Better a visible error than a blank review the user cannot explain.
    expect(() => extractJson('I am unable to help with that.')).toThrow(/NO_JSON/);
  });
});
