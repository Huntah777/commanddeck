/* ============================================================
   Madinah · Command Deck — coaching digest
   ------------------------------------------------------------
   Turns the whole synced state into a small, factual summary of
   how the last 30 days actually went.

   Deliberately separate from coach.js, and deliberately pure: every
   number a coaching review is built on is computed HERE, in code,
   and unit-tested. The model is handed finished arithmetic and asked
   only to prioritise and phrase it.

   That split is the same one parse.js makes, for the same reason —
   but it matters more here, because a model asked to eyeball raw
   logs will confidently invent a percentage, and a coaching report
   built on invented numbers is worse than no coaching at all.

   No RAG, no vector store: the entire state is capped at 1 MB by the
   sync limit and this digest is a couple of KB, so there is nothing
   to retrieve — it already fits in the prompt many times over.
   ============================================================ */

import { correctionSummary } from './learn.js';

const DAY = 86_400_000;
export const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const toMs  = (key) => Date.parse(`${key}T12:00:00Z`);
const keyOf = (ms)  => new Date(ms).toISOString().slice(0, 10);
const addDays = (key, n) => keyOf(toMs(key) + n * DAY);
const dowOf = (key) => new Date(toMs(key)).getUTCDay();
const pct = (done, scheduled) => (scheduled > 0 ? Math.round((done / scheduled) * 100) : null);

export const WINDOW_DAYS = 30;
export const RECENT_DAYS = 7;   // "lately" — compared against the rest of the window
const STALE_TASK_DAYS   = 21;   // open this long without being done is a signal
const MIN_SCHEDULED     = 4;    // below this a percentage is noise, not a trend

/* Walk back `days` from `today` (inclusive), yielding date keys. */
function windowKeys(today, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(addDays(today, -i));
  return out;
}

/* Scheduled/done for one habit across a set of date keys. A habit only
   counts on the weekdays it is scheduled for — completion against days
   it was never meant to run on would read as failure. */
function tally(habit, keys, logs) {
  let scheduled = 0, done = 0;
  const days = Array.isArray(habit.days) ? habit.days : [];
  for (const k of keys) {
    if (!days.includes(dowOf(k))) continue;
    scheduled++;
    if ((logs?.[k] || {})[habit.id]) done++;
  }
  return { scheduled, done };
}

/* Days since a habit was last ticked, walking back from today. null when
   it has not been done inside the window at all. */
function daysSinceDone(habit, today, logs, limit) {
  for (let i = 0; i < limit; i++) {
    const k = addDays(today, -i);
    if ((logs?.[k] || {})[habit.id]) return i;
  }
  return null;
}

export function buildDigest(state = {}, today = keyOf(Date.now())) {
  if (!isDateKey(today)) today = keyOf(Date.now());

  /* Guards the array itself, not what's in it — a stray null (a bad
     merge, a client bug, a hand-edited D1 row) is real production risk
     since this reads whatever is actually stored, spanning every
     version of the app that has ever synced. */
  const isRecord = (x) => x !== null && typeof x === 'object';
  const habits = (Array.isArray(state.habits) ? state.habits : []).filter(isRecord);
  const tasks  = (Array.isArray(state.tasks)  ? state.tasks  : []).filter(isRecord);
  const logs   = state.logs || {};

  const allKeys    = windowKeys(today, WINDOW_DAYS);
  const recentKeys = windowKeys(today, RECENT_DAYS);
  const priorKeys  = allKeys.slice(RECENT_DAYS);

  /* ── Habits ───────────────────────────────────────────────── */
  const perHabit = habits.map(h => {
    const all    = tally(h, allKeys, logs);
    const recent = tally(h, recentKeys, logs);
    const prior  = tally(h, priorKeys, logs);
    return {
      name: h.name || h.title || 'Untitled',
      pillar: h.pillar || null,
      scheduled: all.scheduled,
      done: all.done,
      pct: pct(all.done, all.scheduled),
      recentPct: pct(recent.done, recent.scheduled),
      priorPct: pct(prior.done, prior.scheduled),
      daysSinceDone: daysSinceDone(h, today, logs, WINDOW_DAYS),
    };
  }).filter(h => h.scheduled > 0);

  const rated = perHabit.filter(h => h.scheduled >= MIN_SCHEDULED);
  const totals = perHabit.reduce((a, h) => ({ scheduled: a.scheduled + h.scheduled, done: a.done + h.done }), { scheduled: 0, done: 0 });

  /* Completion across every habit at once, for one slice of the window. */
  const overallPct = (keys) => {
    const t = habits.reduce((a, h) => {
      const x = tally(h, keys, logs);
      return { done: a.done + x.done, scheduled: a.scheduled + x.scheduled };
    }, { done: 0, scheduled: 0 });
    return pct(t.done, t.scheduled);
  };

  /* A drop only counts when both halves of the window had enough
     scheduled days to mean anything — otherwise a habit added on
     Friday reads as a collapse. */
  const slipping = rated
    .filter(h => h.recentPct !== null && h.priorPct !== null && h.priorPct - h.recentPct >= 25)
    .map(h => ({ name: h.name, recentPct: h.recentPct, priorPct: h.priorPct, drop: h.priorPct - h.recentPct }))
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 3);

  /* Scheduled recently but not done at all — the ones quietly abandoned
     rather than merely patchy. */
  const abandoned = rated
    .filter(h => h.daysSinceDone === null || h.daysSinceDone >= RECENT_DAYS)
    .map(h => ({ name: h.name, daysSinceDone: h.daysSinceDone, pct: h.pct }))
    .sort((a, b) => (b.daysSinceDone ?? WINDOW_DAYS) - (a.daysSinceDone ?? WINDOW_DAYS))
    .slice(0, 3);

  /* ── Pillars ──────────────────────────────────────────────── */
  const pillarMap = {};
  for (const h of habits) {
    const id = h.pillar || 'unassigned';
    const t = tally(h, allKeys, logs);
    if (!pillarMap[id]) pillarMap[id] = { pillar: id, scheduled: 0, done: 0 };
    pillarMap[id].scheduled += t.scheduled;
    pillarMap[id].done += t.done;
  }
  const pillars = Object.values(pillarMap)
    .filter(p => p.scheduled > 0)
    .map(p => ({ pillar: p.pillar, scheduled: p.scheduled, done: p.done, pct: pct(p.done, p.scheduled) }))
    .sort((a, b) => a.pct - b.pct);

  /* ── Tasks ────────────────────────────────────────────────── */
  const cutoffMs = toMs(addDays(today, -WINDOW_DAYS));
  const open = tasks.filter(t => !t.done);
  const byQuadrant = (list) => list.reduce((a, t) => {
    const q = t.quadrant || 'plan';
    a[q] = (a[q] || 0) + 1;
    return a;
  }, {});

  const doneInWindow = tasks.filter(t => t.done && Number(t.doneAt) >= cutoffMs);
  const madeInWindow = tasks.filter(t => Number(t.created) >= cutoffMs);
  const overdue = open.filter(t => t.due && t.due < today);

  const stale = open
    .filter(t => Number(t.created) > 0 && (toMs(today) - Number(t.created)) / DAY >= STALE_TASK_DAYS)
    .map(t => ({ title: t.title, quadrant: t.quadrant || 'plan', ageDays: Math.floor((toMs(today) - Number(t.created)) / DAY) }))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, 5);

  /* ── Focus & goals ────────────────────────────────────────── */
  const pomo = (Array.isArray(state.pomodoroLogs) ? state.pomodoroLogs : [])
    .filter(p => isDateKey(p.date) && p.date > addDays(today, -WINDOW_DAYS));
  const goals = (Array.isArray(state.goals) ? state.goals : []).filter(g => g.status !== 'completed');

  return {
    window: { days: WINDOW_DAYS, from: addDays(today, -(WINDOW_DAYS - 1)), to: today, recentDays: RECENT_DAYS },
    habits: {
      tracked: perHabit.length,
      scheduled: totals.scheduled,
      done: totals.done,
      pct: pct(totals.done, totals.scheduled),
      recentPct: overallPct(recentKeys),
      priorPct:  overallPct(priorKeys),
      weakest: [...rated].sort((a, b) => a.pct - b.pct).slice(0, 3).map(h => ({ name: h.name, pct: h.pct, scheduled: h.scheduled })),
      strongest: [...rated].sort((a, b) => b.pct - a.pct).slice(0, 3).map(h => ({ name: h.name, pct: h.pct, scheduled: h.scheduled })),
      slipping,
      abandoned,
    },
    pillars,
    tasks: {
      open: open.length,
      openByQuadrant: byQuadrant(open),
      completed: doneInWindow.length,
      completedByQuadrant: byQuadrant(doneInWindow),
      created: madeInWindow.length,
      overdue: overdue.length,
      oldestOverdue: overdue.map(t => t.due).sort()[0] || null,
      stale,
    },
    focus: {
      sessions: pomo.length,
      minutes: pomo.reduce((a, p) => a + (Number(p.mins) || 0), 0),
    },
    goals: {
      active: goals.length,
      byHorizon: goals.reduce((a, g) => { const h = g.horizon || 'unset'; a[h] = (a[h] || 0) + 1; return a; }, {}),
    },
    /* How often the automatic filing is being overruled. A high
       correction rate is itself a finding — it means capture is
       fighting the user rather than serving them. */
    filing: correctionSummary(tasks),
    /* Movement since the last review, so advice can be checked against
       what actually happened rather than reissued verbatim. Computed
       here, in code — the model is never asked to diff two reports. */
    sinceLastReview: deltasFrom(state.coach, {
      habitsPct: pct(totals.done, totals.scheduled),
      recentPct: overallPct(recentKeys),
      tasksOpen: open.length,
      overdue: overdue.length,
      focusSessions: pomo.length,
    }),
  };
}

/* Metrics worth tracking review-to-review, snapshotted with each one. */
export const metricsOf = (digest) => ({
  habitsPct: digest.habits.pct,
  recentPct: digest.habits.recentPct,
  tasksOpen: digest.tasks.open,
  overdue: digest.tasks.overdue,
  focusSessions: digest.focus.sessions,
});

/* Compare now against the snapshot stored with the previous review.
   null when there is no previous review to compare against — the model
   must not be handed a delta it can read as "no change". */
function deltasFrom(coach, now) {
  const prev = coach?.history?.length ? coach.history[coach.history.length - 1] : null;
  if (!prev?.metrics) return null;
  const out = { at: prev.at, note: prev.note || null, actions: prev.actions || [], changes: {} };
  for (const [k, v] of Object.entries(now)) {
    const was = prev.metrics[k];
    if (typeof was !== 'number' || typeof v !== 'number') continue;
    out.changes[k] = { from: was, to: v, delta: v - was };
  }
  return out;
}

/* A cheap fingerprint of the numbers that would change a review. Used to
   skip a paid call when nothing has actually moved since the last one. */
export function digestFingerprint(d) {
  return JSON.stringify([
    d.habits.pct, d.habits.recentPct, d.habits.done,
    d.tasks.open, d.tasks.completed, d.tasks.overdue,
    d.focus.sessions, d.goals.active,
  ]);
}
