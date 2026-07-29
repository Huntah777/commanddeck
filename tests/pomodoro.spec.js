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
