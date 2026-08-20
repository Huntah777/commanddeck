import { test, expect } from '@playwright/test';

/* The focus timer. Two things are being protected here.

   One: the countdown is a DEADLINE, not a number something decrements.
   Playwright's clock.fastForward is precisely the case that used to
   break it — "user closed the laptop lid and reopened it later", where
   due timers fire at most once. A decrementing counter loses the whole
   interval; a deadline is simply past.

   Two: the engine lives at the app root, not in the Focus view, so
   moving to another tab inside the app can't unmount the session. */

const STATE = {
  habits: [
    { id: 'h-fajr',  name: 'Fajr',   pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1 },
    { id: 'h-quran', name: 'Qur\'an', pillar: 'deen', days: [0,1,2,3,4,5,6], created: 1 },
    { id: 'h-lift',  name: 'Lift',   pillar: 'combat', days: [1,3,5], created: 1 },
  ],
  tasks: [{ id: 't-1', title: 'Write the deck', quadrant: 'plan', listId: 'l-inbox', done: false, created: 1 }],
  blocks: [], logs: {}, people: [], pomodoroLogs: [],
  lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }],
  pomodoro: { workMins: 25, shortMins: 5, longMins: 15, longAfter: 4 },
  ui: { view: 'focus' },
};

/* Seeded only if nothing is there: addInitScript runs again on reload,
   and a test about surviving a reload is worthless if the reload
   silently restores the fixture underneath it. */
const boot = async (page, { at = '2026-07-29T09:00:00', state = STATE, timer = null } = {}) => {
  /* Paused, not merely installed. An unpaused fake clock still advances
     with real time, so the seconds a page reload takes leak into the
     countdown and the assertions have to be fuzzy. Time here moves only
     when a test says it does. */
  await page.clock.install({ time: new Date(at) });
  await page.clock.pauseAt(new Date(at));
  await page.addInitScript(([s, t]) => {
    if (!localStorage.getItem('madinah_v1')) localStorage.setItem('madinah_v1', JSON.stringify(s));
    if (t) localStorage.setItem('madinah_timer_v1', JSON.stringify(t));
  }, [state, timer]);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

const clock    = (page) => page.getByTestId('pomodoro-clock');
const start    = (page) => page.getByRole('button', { name: 'Start' });
const pause    = (page) => page.getByRole('button', { name: 'Pause' });
const skip     = (page) => page.getByTitle('Skip to next phase');
const sessions = (page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem('madinah_v1') || '{}').pomodoroLogs || []);
const goTab = (page, name) =>
  page.locator('nav button').filter({ hasText: new RegExp(`^${name}$`) }).first().click();

test.describe('the countdown is a deadline', () => {
  test('time that passed while the tab was frozen is time that passed', async ({ page }) => {
    await boot(page);
    await expect(clock(page)).toHaveText('25:00');
    await start(page).click();

    // The laptop lid case: due timers fire at most once, whatever the
    // interval was meant to be doing.
    await page.clock.fastForward('10:00');
    await expect(clock(page)).toHaveText('15:00', { timeout: 5_000 });
  });

  test('a phase that ended while nothing was ticking is ended', async ({ page }) => {
    await boot(page);
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const [log] = await sessions(page);
    expect(log.mins).toBe(25);
    expect(log.date).toBe('2026-07-29');
    // It advanced to the break rather than sitting on 00:00.
    await expect(clock(page)).toHaveText('05:00');
  });

  test('a session survives a reload mid-run', async ({ page }) => {
    await boot(page);
    await start(page).click();
    await page.clock.fastForward('05:00');

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    // Not 25:00 — the deadline outlives the page that set it.
    await expect(clock(page)).toHaveText('20:00', { timeout: 5_000 });
  });

  test('a session that ended while the app was closed is settled on the way back in', async ({ page }) => {
    /* The PWA-was-killed case: a stored session whose deadline is
       already in the past when the app starts. Nothing was running to
       notice it pass, so startup has to. */
    await boot(page, {
      at: '2026-07-29T09:30:00',
      timer: {
        phase: 0, running: true, leftMs: null, doneCount: 0, target: null,
        endsAt: new Date('2026-07-29T09:25:00').getTime(),
      },
    });

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const [log] = await sessions(page);
    // Banked against the minute it actually ended, not the minute we noticed.
    expect(log.completedAt).toBe(new Date('2026-07-29T09:25:00').getTime());
    expect(log.mins).toBe(25);
  });

  test('pausing banks the remainder rather than the wall clock', async ({ page }) => {
    await boot(page);
    await start(page).click();
    await page.clock.fastForward('04:00');
    await pause(page).click();
    await expect(clock(page)).toHaveText('21:00');

    // Paused means paused: an hour later it is still 21:00.
    await page.clock.fastForward('01:00:00');
    await expect(clock(page)).toHaveText('21:00');

    await start(page).click();
    await page.clock.fastForward('01:00');
    await expect(clock(page)).toHaveText('20:00', { timeout: 5_000 });
  });
});

/* Not every stretch of work is a Pomodoro. Some is one session and then
   the school run, or a meeting, or the day is just over — and forcing a
   break onto the end of that is something to dismiss, not something
   useful. `breakAfter` (the BREAK AFTER / NO BREAK AFTER pill next to the
   phase tabs) is the escape hatch: off, a finished Focus session goes
   straight back to a fresh one instead of into a break. */
test.describe('a session that owes no break', () => {
  const breakToggle = (page) => page.getByTestId('break-after-toggle');

  test('defaults to keeping the break — existing behaviour, untouched', async ({ page }) => {
    await boot(page);
    await expect(breakToggle(page)).toHaveText('BREAK AFTER');
    await expect(breakToggle(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('turning it off sends a finished Focus session straight back to Focus', async ({ page }) => {
    await boot(page);
    await breakToggle(page).click();
    await expect(breakToggle(page)).toHaveText('NO BREAK AFTER');
    await expect(breakToggle(page)).toHaveAttribute('aria-pressed', 'true');

    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    // Not the 5-minute break this exact fixture lands on with the toggle
    // left alone (see "a phase that ended while nothing was ticking is
    // ended", above) — straight back to a fresh 25-minute Focus phase.
    await expect(clock(page)).toHaveText('25:00');
    expect((await sessions(page))[0].mins).toBe(25);
  });

  test('the same holds when the session is skipped rather than run out', async ({ page }) => {
    await boot(page);
    await breakToggle(page).click();
    await start(page).click();
    await page.clock.fastForward('10:00');
    await skip(page).click();

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    expect((await sessions(page))[0].mins).toBe(10);
    await expect(clock(page)).toHaveText('25:00');
  });

  test('a break already earned is not retroactively cancelled', async ({ page }) => {
    /* Off is forward-looking. Flipping it mid-break must not do
       something stranger than the ordinary "a break always returns to
       Focus" rule that already applies regardless of the toggle. */
    await boot(page);
    await start(page).click();
    await page.clock.fastForward('25:00');
    await expect(clock(page)).toHaveText('05:00'); // the break, as normal

    await breakToggle(page).click();
    await start(page).click();
    await page.clock.fastForward('05:00');
    await expect(clock(page)).toHaveText('25:00');
  });

  test('persists across a reload, same as every other session choice', async ({ page }) => {
    await boot(page);
    await breakToggle(page).click();

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
    await expect(breakToggle(page)).toHaveText('NO BREAK AFTER');
  });

  test('the running banner says so, and only while a Focus session is actually running', async ({ page }) => {
    await boot(page);
    await breakToggle(page).click();
    await expect(page.getByText('NO BREAK AFTER THIS ONE')).toHaveCount(0);

    await start(page).click();
    await expect(page.getByText('NO BREAK AFTER THIS ONE')).toBeVisible();
  });

  test('the break phases stay reachable by hand — off only cancels the automatic hand-off', async ({ page }) => {
    await boot(page);
    await breakToggle(page).click();
    await page.getByRole('button', { name: 'SHORT BREAK' }).click();
    await expect(clock(page)).toHaveText('05:00');
  });

  test('a session persisted before this setting existed still gets its break, not silence', async ({ page }) => {
    /* Anything stored before breakAfter existed has no opinion on it —
       and no opinion has to read as "cycle exactly as it always did",
       never as "skip the break", or every pre-existing install goes
       quiet on breaks the moment this ships. */
    await boot(page, {
      at: '2026-07-29T09:00:00',
      timer: {
        phase: 0, running: true, leftMs: null, doneCount: 0, target: null,
        endsAt: new Date('2026-07-29T08:59:00').getTime(),
        // no breakAfter field at all
      },
    });

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    await expect(clock(page)).toHaveText('05:00');
    await expect(breakToggle(page)).toHaveText('BREAK AFTER');
  });
});

test.describe('the timer outlives the view', () => {
  test('switching to another tab in the app does not stop it', async ({ page }) => {
    await boot(page);
    await start(page).click();
    await goTab(page, 'Today');
    await expect(page.getByTestId('pomodoro-clock')).toHaveCount(0); // view really is gone

    await page.clock.fastForward('25:00');
    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
  });

  test('a running session is visible from wherever you are', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('timer-pill').first()).toHaveCount(0); // nothing running
    await start(page).click();
    await goTab(page, 'Today');

    const pill = page.getByTestId('timer-pill').first();
    await expect(pill).toBeVisible();
    await page.clock.fastForward('10:00');
    await expect(pill).toContainText('15:0', { timeout: 5_000 });

    // And it is the way back.
    await pill.click();
    await expect(clock(page)).toBeVisible();
  });
});

test.describe('what the session is aimed at', () => {
  test('a pillar, and then a habit inside it', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'PILLAR', exact: true }).click();
    await page.getByTestId('pillar-choice').filter({ hasText: 'Deen' }).click();
    await expect(page.getByTestId('focus-target')).toHaveText('Deen');

    // The habit list is the pillar's own, not every habit there is.
    const habits = page.getByLabel('Habit');
    await expect(habits.locator('option')).toHaveText(['Whole pillar', 'Fajr', 'Qur\'an']);

    await habits.selectOption({ label: 'Fajr' });
    await expect(page.getByTestId('focus-target')).toHaveText('Fajr');
  });

  test('a habit session counts towards its pillar as well as itself', async ({ page }) => {
    // An hour on Fajr is an hour on Deen — otherwise the pillar roll-up
    // would only ever see sessions aimed at a whole pillar.
    await boot(page);
    await page.getByRole('button', { name: 'PILLAR', exact: true }).click();
    await page.getByTestId('pillar-choice').filter({ hasText: 'Deen' }).click();
    await page.getByLabel('Habit').selectOption({ label: 'Fajr' });
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const [log] = await sessions(page);
    expect(log.habitId).toBe('h-fajr');
    expect(log.pillarId).toBe('deen');
    expect(log.label).toBe('Fajr');

    await expect(page.getByTestId('focus-by-pillar')).toContainText('Deen');
    await expect(page.getByTestId('focus-by-pillar')).toContainText('25m');
  });

  test('a whole pillar carries no habit', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'PILLAR', exact: true }).click();
    await page.getByTestId('pillar-choice').filter({ hasText: 'Combat' }).click();
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const [log] = await sessions(page);
    expect(log.pillarId).toBe('combat');
    expect(log.habitId).toBe(null);
  });

  test('a task still logs the way it always did', async ({ page }) => {
    /* Every stored log and the coaching digest read taskId/taskTitle.
       Pillars and habits are additional, not a replacement. */
    await boot(page);
    await page.getByRole('button', { name: 'TASK', exact: true }).click();
    await page.getByLabel('Task').selectOption({ label: 'Write the deck' });
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const [log] = await sessions(page);
    expect(log.taskId).toBe('t-1');
    expect(log.taskTitle).toBe('Write the deck');
  });

  test('the target survives moving away and coming back', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'PILLAR', exact: true }).click();
    await page.getByTestId('pillar-choice').filter({ hasText: 'Deen' }).click();
    await start(page).click();

    await goTab(page, 'Habits');
    await goTab(page, 'Focus');
    await expect(page.getByTestId('focus-target')).toHaveText('Deen');
  });
});

/* A session aimed at a HABIT specifically (not just its pillar) is the
   habit — finishing it is doing the thing, so it should not also have to
   be found and ticked by hand afterwards. Aimed at a whole pillar, a
   task, or nothing, there is no single habit to tick and none of this
   applies. */
test.describe('a session aimed at a habit ticks it off', () => {
  const logs = (page) => page.evaluate(() =>
    JSON.parse(localStorage.getItem('madinah_v1') || '{}').logs || {});
  const aimAtFajr = async (page) => {
    await page.getByRole('button', { name: 'PILLAR', exact: true }).click();
    await page.getByTestId('pillar-choice').filter({ hasText: 'Deen' }).click();
    await page.getByLabel('Habit').selectOption({ label: 'Fajr' });
  };

  test('finishing the session ticks it, visibly, on the Today checklist too', async ({ page }) => {
    await boot(page);
    await aimAtFajr(page);
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(async () => (await logs(page))['2026-07-29']?.['h-fajr'], { timeout: 10_000 }).toBeTruthy();

    /* Scoped to the checklist rather than the whole tab — the agenda's
       habit chips carry the same "Untick Fajr" label, and this is
       specifically about the checklist agreeing. */
    await goTab(page, 'Today');
    await expect(page.getByTestId('checklist-habit').getByRole('button', { name: 'Untick Fajr' })).toBeVisible();
  });

  test('aimed at the whole pillar, there is no single habit to tick', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'PILLAR', exact: true }).click();
    await page.getByTestId('pillar-choice').filter({ hasText: 'Deen' }).click();
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    expect((await logs(page))['2026-07-29']).toBeUndefined();
  });

  test('a task or a free session ticks nothing', async ({ page }) => {
    await boot(page);
    await start(page).click(); // Free, the default target
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    expect((await logs(page))['2026-07-29']).toBeUndefined();
  });

  test('skipping out early still ticks it, at the same one-minute threshold as the log', async ({ page }) => {
    await boot(page);
    await aimAtFajr(page);
    await start(page).click();
    await page.clock.fastForward('04:00');
    await skip(page).click();

    await expect.poll(async () => (await logs(page))['2026-07-29']?.['h-fajr'], { timeout: 10_000 }).toBeTruthy();
  });

  test('skipping immediately ticks nothing, same as it logs nothing', async ({ page }) => {
    await boot(page);
    await aimAtFajr(page);
    await start(page).click();
    await skip(page).click();
    await page.waitForTimeout(200);
    expect((await logs(page))['2026-07-29']).toBeUndefined();
  });

  test('a habit already ticked keeps its original timestamp — this never unticks', async ({ page }) => {
    /* tickHabit is a tick, never a toggle: finishing a session must not
       fight a box that got ticked (or unticked) some other way before
       the timer caught up. */
    const tickedAt = new Date('2026-07-29T07:00:00').getTime();
    await boot(page, { state: { ...STATE, logs: { '2026-07-29': { 'h-fajr': tickedAt } } } });
    await aimAtFajr(page);
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    expect((await logs(page))['2026-07-29']['h-fajr']).toBe(tickedAt);
  });

  test('a completion noticed late still ticks as of when the session actually ended', async ({ page }) => {
    /* The device-asleep case: the deadline passed before the app was
       there to see it. The tick lands on the moment the session really
       finished, matching its pomodoroLogs entry — not the moment this
       device happened to wake up and notice. */
    await boot(page, {
      at: '2026-07-29T23:59:00',
      timer: {
        phase: 0, running: true, leftMs: null, doneCount: 0,
        target: { kind: 'habit', id: 'h-fajr', pillarId: 'deen', label: 'Fajr', color: '#10b981' },
        endsAt: new Date('2026-07-29T23:58:00').getTime(),
      },
    });

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const day = await logs(page);
    expect(day['2026-07-29']?.['h-fajr']).toBe(new Date('2026-07-29T23:58:00').getTime());
  });
});

/* Same story, aimed at a task instead of a habit — completeTask is
   tickHabit's twin, with the same idempotency and the same instant-of-
   completion rules. */
test.describe('a session aimed at a task completes it', () => {
  const tasks = (page) => page.evaluate(() =>
    JSON.parse(localStorage.getItem('madinah_v1') || '{}').tasks || []);
  const findT1 = async (page) => (await tasks(page)).find(t => t.id === 't-1');
  const aimAtTask = async (page) => {
    await page.getByRole('button', { name: 'TASK', exact: true }).click();
    await page.getByLabel('Task').selectOption({ label: 'Write the deck' });
  };

  test("finishing the session completes it, and it drops off Today's list", async ({ page }) => {
    await boot(page);
    await aimAtTask(page);
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(async () => (await findT1(page))?.done, { timeout: 10_000 }).toBe(true);

    await goTab(page, 'Today');
    await expect(page.getByText('TODAY · 0')).toBeVisible();
    await expect(page.getByText('Inbox zero. Add the next move.')).toBeVisible();
  });

  test('aimed at anything else, no task is completed', async ({ page }) => {
    await boot(page);
    await start(page).click(); // Free, the default target
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    expect((await findT1(page)).done).toBe(false);
  });

  test('skipping out early still completes it, at the same one-minute threshold as the log', async ({ page }) => {
    await boot(page);
    await aimAtTask(page);
    await start(page).click();
    await page.clock.fastForward('04:00');
    await skip(page).click();

    await expect.poll(async () => (await findT1(page))?.done, { timeout: 10_000 }).toBe(true);
  });

  test('skipping immediately completes nothing, same as it logs nothing', async ({ page }) => {
    await boot(page);
    await aimAtTask(page);
    await start(page).click();
    await skip(page).click();
    await page.waitForTimeout(200);
    expect((await findT1(page)).done).toBe(false);
  });

  test('a task already done keeps its original completion time — this never reopens it', async ({ page }) => {
    /* completeTask must only ever complete: finishing a session must not
       fight a task someone reopened, or overwrite doneAt on one that was
       already ticked off some other way before the timer caught up —
       here, completed on another device and synced in mid-session.

       The target is seeded straight into the session rather than picked
       through the UI: the picker only ever offers OPEN tasks (see
       focusTargets), so a session aimed at one that's already done can
       only arise from having been aimed at it before it was completed
       elsewhere — exactly the case this is testing. */
    const doneAt = new Date('2026-07-29T07:00:00').getTime();
    await boot(page, {
      state: {
        ...STATE,
        tasks: STATE.tasks.map(t => t.id === 't-1' ? { ...t, done: true, doneAt } : t),
      },
      timer: {
        phase: 0, running: false, leftMs: null, doneCount: 0,
        target: { kind: 'task', id: 't-1', label: 'Write the deck', color: '#ef4444' },
      },
    });
    await start(page).click();
    await page.clock.fastForward('25:00');

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const t1 = await findT1(page);
    expect(t1.done).toBe(true);
    expect(t1.doneAt).toBe(doneAt);
  });

  test('a completion noticed late lands on when the session actually ended, not when it was noticed', async ({ page }) => {
    /* doneAt is the historical instant (matches the pomodoroLogs entry
       and tickHabit's own tick); modifiedAt is the ordinary "this device
       touched the record now" instant every other write already gives
       it. The two diverge on exactly this device-asleep path. */
    await boot(page, {
      at: '2026-07-29T23:59:00',
      timer: {
        phase: 0, running: true, leftMs: null, doneCount: 0,
        target: { kind: 'task', id: 't-1', label: 'Write the deck', color: '#ef4444' },
        endsAt: new Date('2026-07-29T23:58:00').getTime(),
      },
    });

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    const t1 = await findT1(page);
    expect(t1.doneAt).toBe(new Date('2026-07-29T23:58:00').getTime());
    expect(t1.modifiedAt).toBe(new Date('2026-07-29T23:59:00').getTime());
  });
});

test.describe('what gets logged', () => {
  test('skipping banks the minutes actually sat through, not a full session', async ({ page }) => {
    // A 25-minute credit for four minutes of work makes the log lie.
    await boot(page);
    await start(page).click();
    await page.clock.fastForward('04:00');
    await skip(page).click();

    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);
    expect((await sessions(page))[0].mins).toBe(4);
  });

  test('skipping immediately logs nothing at all', async ({ page }) => {
    await boot(page);
    await start(page).click();
    await skip(page).click();
    await page.waitForTimeout(200);
    expect(await sessions(page)).toHaveLength(0);
  });

  test('breaks are not logged as focus', async ({ page }) => {
    await boot(page);
    await start(page).click();
    await page.clock.fastForward('25:00');
    await expect.poll(() => sessions(page), { timeout: 10_000 }).toHaveLength(1);

    await start(page).click();          // the short break
    await page.clock.fastForward('05:00');
    await expect(clock(page)).toHaveText('25:00', { timeout: 5_000 }); // back to work
    expect(await sessions(page)).toHaveLength(1);
  });
});

test.describe('editing the timer settings', () => {
  /* Reported bug: clearing a field to type a new value snapped it to 1,
     then any further typing composed against that resurrected "1"
     instead of what was actually being typed — landing on 10 (the max
     for "long after") and refusing to move past it. Root cause: the
     field clamped on every keystroke, and clamp('') read as 0, and 0 is
     falsy, so `0 || lo` reset it to the minimum before the next digit
     ever landed. */

  const openSettings = async (page) => {
    await page.getByText('TIMER SETTINGS').click();
  };
  const longAfterField = (page) => page.getByLabel('Long after (×)');
  const longBreakField = (page) => page.getByLabel('Long break (min)');
  const applyBtn = (page) => page.getByRole('button', { name: 'Apply settings' });

  test('clearing a field and typing a fresh value keeps exactly what was typed', async ({ page }) => {
    await boot(page);
    await openSettings(page);

    const input = longAfterField(page);
    await input.fill('');
    await input.pressSequentially('6');
    await expect(input).toHaveValue('6');   // not '1', not '16', not clamped mid-edit
  });

  test('a field can be moved through several different values in one sitting', async ({ page }) => {
    // The exact symptom reported: stuck unable to change past a value
    // the clamp had forced it to.
    await boot(page);
    await openSettings(page);
    const input = longAfterField(page);

    for (const v of ['3', '7', '2', '9']) {
      await input.fill('');
      await input.pressSequentially(v);
      await expect(input).toHaveValue(v);
    }
  });

  test('an out-of-range value is only clamped once you leave the field, not while typing', async ({ page }) => {
    // Typing "10" one digit at a time passes through "1" — clamping that
    // intermediate "1" against a max of 10 is harmless, but clamping the
    // final, in-range "10" mid-edit is exactly what broke this.
    await boot(page);
    await openSettings(page);
    const input = longAfterField(page);

    await input.fill('');
    await input.pressSequentially('10');
    await expect(input).toHaveValue('10');

    await input.blur();
    await expect(input).toHaveValue('10'); // still 10 — in range, so blur leaves it alone
  });

  test('blur resets an empty or invalid field to the minimum, not to nothing', async ({ page }) => {
    await boot(page);
    await openSettings(page);
    const input = longAfterField(page);

    await input.fill('');
    await input.blur();
    await expect(input).toHaveValue('1');
  });

  test('blur clamps a value above the maximum back into range', async ({ page }) => {
    await boot(page);
    await openSettings(page);
    const input = longAfterField(page);

    await input.fill('');
    await input.pressSequentially('99');
    await input.blur();
    await expect(input).toHaveValue('10'); // longAfter's max
  });

  test('Apply settings saves the typed value, including one never blurred', async ({ page }) => {
    await boot(page);
    await openSettings(page);

    const input = longBreakField(page);
    await input.fill('');
    await input.pressSequentially('22');
    await applyBtn(page).click();          // clicking Apply blurs the field itself

    await expect.poll(async () => {
      const s = JSON.parse(await page.evaluate(() => localStorage.getItem('madinah_v1')) || '{}');
      return s.pomodoro?.longMins;
    }, { timeout: 10_000 }).toBe(22);
  });

  test('Apply settings clamps rather than saving garbage', async ({ page }) => {
    // Defence in depth: Apply must not trust an unblurred field to
    // already be in range.
    await boot(page);
    await openSettings(page);

    const input = longAfterField(page);
    await input.fill('');
    await input.pressSequentially('500');
    await applyBtn(page).click();

    await expect.poll(async () => {
      const s = JSON.parse(await page.evaluate(() => localStorage.getItem('madinah_v1')) || '{}');
      return s.pomodoro?.longAfter;
    }, { timeout: 10_000 }).toBe(10);
  });
});
