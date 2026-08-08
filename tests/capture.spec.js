import { test, expect } from '@playwright/test';

/* End-to-end natural-language capture. The parse itself is unit-tested in
   parse.spec.js; what matters here is the contract between the input box
   and the endpoint:

     - the task exists locally before the network is touched, so capture
       never blocks and never depends on the parse arriving;
     - a field the user set by hand is never overwritten by the parser;
     - the filing is shown, with its reasoning, and can be undone.

   /api/parse is mocked throughout — these assert the client's behaviour,
   not the model's. */

const boot = async (page) => {
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, { timeout: 10_000 });
};

/* A synced device with one demoted person registered.

   The state endpoint is a stateful echo rather than a fixed body: the app
   treats an empty `habits` from the server as a first run and replaces
   local state with a fresh seed, and a PUT whose reply doesn't look like
   a real one gets applied over the state that was just captured. Both
   would quietly undo the thing under test. */
async function seed(page, extra = {}) {
  const STATE = {
    habits: [{ id: 'h-1', title: 'Fajr', pillar: 'deen', days: [0, 1, 2, 3, 4, 5, 6], created: 1 }],
    tasks: [], blocks: [], logs: {},
    lists: [{ id: 'l-inbox', name: 'Inbox', color: '#9a9788' }, { id: 'l-work', name: 'Work', color: '#22d3ee' }],
    people: [{ id: 'pp-mgr', name: 'Dave', aliases: ['manager'], weight: 2 }],
    /* The Tasks view, not Today — Today lists only what's due today, and
       a parsed due date would filter the task straight off the screen. */
    ui: { view: 'tasks' },
    ...extra,
  };
  await page.addInitScript((state) => {
    localStorage.setItem('madinah_token', 'test-token');
    localStorage.setItem('madinah_v1', JSON.stringify(state));
  }, STATE);

  let stored = STATE, version = 1;
  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'PUT') {
      stored = { ...stored, ...JSON.parse(route.request().postData() || '{}') };
      version++;
      return route.fulfill({
        status: 200, headers: { 'Content-Type': 'application/json', ETag: `"v${version}"` },
        body: JSON.stringify({ ok: true, updated_at: version, data: stored }),
      });
    }
    await route.fulfill({
      status: 200, headers: { 'Content-Type': 'application/json', ETag: `"v${version}"` },
      body: JSON.stringify(stored),
    });
  });
}

/* Mock /api/parse. `hold` delays the reply so the pre-parse state is
   observable; `fail` makes the endpoint unavailable. */
function mockParse(page, reply, opts = {}) {
  const api = { calls: 0, lastBody: null, release: null };
  const gate = opts.hold ? new Promise(res => { api.release = res; }) : null;
  page.route('**/api/parse', async (route) => {
    api.calls++;
    try { api.lastBody = JSON.parse(route.request().postData() || '{}'); } catch {}
    if (gate) await gate;
    if (opts.fail) return route.fulfill({ status: 500, body: '{}' });
    await route.fulfill({
      status: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reply),
    });
  });
  return api;
}

const capture = async (page, text) => {
  const box = page.getByPlaceholder('Capture a task…').first();
  await box.fill(text);
  await box.press('Enter');
};

const tasks = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('madinah_v1') || '{}').tasks || []);

const FILED = {
  title: 'Send Dave the deck', due: '2026-07-31', quadrant: 'delegate',
  listId: 'l-inbox', personId: 'pp-mgr', personName: 'Dave',
  why: ['Dave · weight 2', 'not important', 'due in 2d'], source: 'ai',
};

test.describe('natural-language capture', () => {
  test('the task exists before the parse comes back', async ({ page }) => {
    // Capture is a foreground interaction. If it waited on the network it
    // would fail on a train, and the parse is only ever an enhancement.
    const api = mockParse(page, FILED, { hold: true });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect(page.getByText('dave needs the deck by friday')).toBeVisible();
    expect((await tasks(page))[0].title).toBe('dave needs the deck by friday');

    api.release();
    await expect(page.getByTestId('parse-receipt')).toBeVisible({ timeout: 10_000 });
  });

  test('the parse files the task and shows what it decided', async ({ page }) => {
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');

    await expect.poll(async () => (await tasks(page))[0], { timeout: 10_000 })
      .toMatchObject({ title: 'Send Dave the deck', due: '2026-07-31', quadrant: 'delegate', personId: 'pp-mgr' });

    const receipt = page.getByTestId('parse-receipt');
    await expect(receipt).toContainText('Delegate');   // the quadrant's own label
    await expect(receipt).toContainText('Dave');
    await expect(receipt).toContainText('due in 2d');  // and why
  });

  test('a captured task can move off the default list, and the receipt says where it went', async ({ page }) => {
    // Not everything should stay in Inbox — a keyword match on the server
    // routes the task, and the receipt is where that becomes visible.
    // `why` deliberately omits the word "Work" so the badge is the only
    // possible source of that text — otherwise this test can't tell a
    // real list badge from the reasoning line mentioning it in passing.
    mockParse(page, { ...FILED, listId: 'l-work' });
    await seed(page); // captured with the default listId of 'l-inbox'
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');

    await expect.poll(async () => (await tasks(page))[0]?.listId, { timeout: 10_000 }).toBe('l-work');
    const receipt = page.getByTestId('parse-receipt');
    await expect(receipt).toContainText('Work');
    // Specifically the summary line (styled with the list's own colour),
    // not just anywhere in the receipt's free-text reasoning.
    await expect(receipt.locator('span').filter({ hasText: '· Work' })).toBeVisible();
  });

  test('undo restores exactly what was captured', async ({ page }) => {
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect(page.getByTestId('parse-receipt')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('parse-receipt').getByText('UNDO').click();

    await expect.poll(async () => (await tasks(page))[0], { timeout: 5_000 })
      .toMatchObject({ title: 'dave needs the deck by friday', quadrant: 'plan', personId: null });
  });

  test('Today is pure capture — one text box, no pickers', async ({ page }) => {
    // Capturing on the fly should not ask you to file. Today and the
    // Matrix stay a single box; the parser does the filing.
    mockParse(page, FILED);
    await seed(page, { ui: { view: 'today' } });
    await page.goto('/');
    await boot(page);

    const box = page.getByPlaceholder('Capture a task…').first();
    await box.click();
    await box.fill('dave needs the deck by friday');
    await expect(page.getByTestId('capture-picker')).toHaveCount(0);
  });

  test('Tasks offers a date and list picker for deliberate filing', async ({ page }) => {
    mockParse(page, FILED);
    await seed(page); // seeded into the Tasks view
    await page.goto('/');
    await boot(page);

    await page.getByPlaceholder('Capture a task…').first().click();
    const picker = page.getByTestId('capture-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByLabel('Due date')).toBeVisible();
    await expect(picker.getByLabel('List')).toBeVisible();
  });

  test('a hand-set date and list survive the parse', async ({ page }) => {
    // Stated beats inferred: the parser still runs and still assigns the
    // quadrant and person, it just does not argue with what you typed.
    mockParse(page, FILED); // wants due 2026-07-31 and l-inbox
    await seed(page);
    await page.goto('/');
    await boot(page);

    const box = page.getByPlaceholder('Capture a task…').first();
    await box.click();
    await box.fill('dave needs the deck by friday');
    await page.getByTestId('capture-picker').getByLabel('Due date').fill('2026-09-15');
    await page.getByTestId('capture-picker').getByLabel('List').selectOption('l-work');
    await box.press('Enter');

    await expect.poll(async () => (await tasks(page))[0], { timeout: 10_000 }).toMatchObject({
      due: '2026-09-15',        // not the parser's 2026-07-31
      listId: 'l-work',         // not the parser's l-inbox
      quadrant: 'delegate',     // still parsed
      personId: 'pp-mgr',       // still parsed
    });
  });

  test('a field set by hand is not recorded as a correction', async ({ page }) => {
    // The user pre-empted the parser rather than disagreeing with it.
    // Recording a disagreement that never happened would teach the
    // system a rule from a conversation it never had.
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    const box = page.getByPlaceholder('Capture a task…').first();
    await box.click();
    await box.fill('dave needs the deck by friday');
    await page.getByTestId('capture-picker').getByLabel('Due date').fill('2026-09-15');
    await box.press('Enter');

    await expect.poll(async () => (await tasks(page))[0]?.ai, { timeout: 10_000 }).toBeTruthy();
    const ai = (await tasks(page))[0].ai;
    expect(ai).not.toHaveProperty('due');   // never claimed, so never a disagreement
    expect(ai.quadrant).toBe('delegate');   // the fields it did decide are still recorded
  });

  test('the pickers reset after each capture', async ({ page }) => {
    // A date left over from the last task would silently attach to the
    // next one.
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    const box = page.getByPlaceholder('Capture a task…').first();
    await box.click();
    await page.getByTestId('capture-picker').getByLabel('Due date').fill('2026-09-15');
    await box.fill('first task');
    await box.press('Enter');

    await box.click();
    await expect(page.getByTestId('capture-picker').getByLabel('Due date')).toHaveValue('');
  });

  test('the contextual default still applies before the parse lands', async ({ page }) => {
    // Losing the dropdowns must not lose the context: capturing from a
    // given list still starts the task there, the parser just refines it.
    mockParse(page, FILED, { hold: true });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'something with no list in the words');
    expect((await tasks(page))[0]).toMatchObject({ listId: 'l-inbox', quadrant: 'plan' });
  });

  test('a failed parse leaves the task exactly as captured', async ({ page }) => {
    mockParse(page, null, { fail: true });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await page.waitForTimeout(1_500);

    expect((await tasks(page))[0]).toMatchObject({ title: 'dave needs the deck by friday', quadrant: 'plan' });
    await expect(page.getByTestId('parse-receipt')).toHaveCount(0);
  });

  test('capture works with no sync configured and never calls the endpoint', async ({ page }) => {
    // No token means no server, so there is nothing to authenticate with
    // and no reason to try.
    const api = mockParse(page, FILED);
    await page.addInitScript(() => localStorage.setItem('madinah_v1', JSON.stringify({
      habits: [], tasks: [], blocks: [], logs: {},
      lists: [{ id: 'l-inbox', name: 'Inbox' }], ui: { view: 'tasks' },
    })));
    await page.goto('/');
    await boot(page);

    await capture(page, 'buy milk');
    await page.waitForTimeout(1_000);
    expect(api.calls).toBe(0);
    expect((await tasks(page))[0].title).toBe('buy milk');
  });

  test('the endpoint is sent the people table and the device\'s own today', async ({ page }) => {
    // Weights are policy and live on the client; the date has to be the
    // user's local one, or every relative phrase resolves off by a day.
    const api = mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(() => api.lastBody, { timeout: 10_000 }).toBeTruthy();

    expect(api.lastBody.text).toBe('dave needs the deck by friday');
    expect(api.lastBody.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(api.lastBody.people).toContainEqual(expect.objectContaining({ name: 'Dave', weight: 2 }));
  });

  test('the request is authenticated', async ({ page }) => {
    // An unauthenticated parse endpoint on a public domain is a free LLM
    // billed to this account.
    let auth = null;
    await page.route('**/api/parse', async (route) => {
      auth = route.request().headers()['authorization'];
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FILED) });
    });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(() => auth, { timeout: 10_000 }).toBe('Bearer test-token');
  });

  test('the parser\'s whole decision is kept, including the original text', async ({ page }) => {
    // Corrections are the only training signal this app has, so the full
    // filing has to survive alongside whatever the task becomes — and the
    // raw capture with it, or there is no input to learn from.
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(async () => (await tasks(page))[0]?.ai, { timeout: 10_000 }).toMatchObject({
      raw: 'dave needs the deck by friday',
      title: 'Send Dave the deck',
      quadrant: 'delegate',
      due: '2026-07-31',
      personId: 'pp-mgr',
    });
  });

  test('what the call cost is kept with the task that caused it', async ({ page }) => {
    /* The AI spend figure in Admin is a sum over calls this app made,
       so each call has to leave its token count behind. Without this
       the card can only ever estimate. */
    mockParse(page, { ...FILED, usage: { i: 412, o: 58 } });
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(async () => (await tasks(page))[0]?.ai?.tok, { timeout: 10_000 })
      .toEqual({ i: 412, o: 58 });
  });

  test('a model that reports no usage leaves no invented figure', async ({ page }) => {
    // A missing token count and a free call are not the same claim.
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(async () => (await tasks(page))[0]?.ai?.raw, { timeout: 10_000 }).toBeTruthy();
    expect((await tasks(page))[0]?.ai?.tok).toBeUndefined();
  });

  test('editing a filed task leaves the disagreement legible', async ({ page }) => {
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(async () => (await tasks(page))[0]?.ai?.quadrant, { timeout: 10_000 }).toBe('delegate');

    await page.getByText('Send Dave the deck').click();
    await page.locator('select').filter({ hasText: 'Delegate' }).first().selectOption('do');
    await page.getByRole('button', { name: /save/i }).first().click();

    const t = (await tasks(page))[0];
    expect(t.quadrant).toBe('do');
    expect(t.ai.quadrant).toBe('delegate');
  });

  test('a rewritten title is captured as a correction too', async ({ page }) => {
    // Title is the one field only the model produces, so a rewrite is the
    // only way to teach it how this person words things.
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect.poll(async () => (await tasks(page))[0]?.ai?.title, { timeout: 10_000 }).toBe('Send Dave the deck');

    await page.getByText('Send Dave the deck').click();
    // The Title field: the div holding the TITLE label, then its input.
    await page.locator('div').filter({ hasText: /^TITLE$/ }).locator('..').locator('input').first()
      .fill('Email Dave the Q3 deck');
    await page.getByRole('button', { name: /save/i }).first().click();

    const t = (await tasks(page))[0];
    expect(t.title).toBe('Email Dave the Q3 deck');
    expect(t.ai.title).toBe('Send Dave the deck'); // what it said, still there to learn from
  });

  test('undo clears the filing rather than recording it as a correction', async ({ page }) => {
    // Rejecting the whole parse is not a rule to learn — it would poison
    // the examples with a title the user never actually wanted.
    mockParse(page, FILED);
    await seed(page);
    await page.goto('/');
    await boot(page);

    await capture(page, 'dave needs the deck by friday');
    await expect(page.getByTestId('parse-receipt')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('parse-receipt').getByText('UNDO').click();

    await expect.poll(async () => (await tasks(page))[0]?.ai, { timeout: 5_000 }).toBeNull();
  });
});

/* ============================================================
   What the capture box tells the parser about the day
   ------------------------------------------------------------
   "Can this be done now?" is answered server-side (parse.spec.js has
   the policy), but only from figures measured here — the client is
   the only side that has the blocks, habits and prayer times already
   resolved. These assert the measurement, which is the half that
   could silently drift out of step with the timeline.
   ============================================================ */

const DAILY = [0, 1, 2, 3, 4, 5, 6];

/* Wednesday, 09:00. The waking window the client counts against is
   07:00–22:00, so a capture made now has six hours of afternoon left
   before anything is subtracted. */
const NOON_WED = '2026-07-29T09:00:00';
const WED_KEY  = '2026-07-29';
const FULL_DAY = (22 - 7) * 60;          // 900, an untouched day
const FROM_9AM = (22 - 9) * 60;          // 780, what is left at 09:00

/* The `days` array the client sent with the last capture, by date. */
const dayIn = (api, key) => (api.lastBody?.days || []).find(d => d.d === key);

/* Never hands the mocked server an empty `habits` — the app reads that
   as a first run and replaces local state with a fresh seed, taking the
   fixture's blocks with it. Where a test needs specific habits it says
   so; otherwise seed()'s single unslotted Fajr stands, which costs the
   day no calendar time. */
const withCalendar = async (page, extra) => {
  await page.clock.install({ time: new Date(NOON_WED) });
  await seed(page, extra);
  await page.goto('/');
  await boot(page);
};

test.describe('the day the parser is shown', () => {
  test('a fortnight is sent, starting today', async ({ page }) => {
    const api = mockParse(page, FILED);
    await withCalendar(page, { blocks: [] });
    await capture(page, 'sort the loft');

    await expect.poll(() => api.lastBody?.days?.length, { timeout: 10_000 }).toBe(14);
    expect(api.lastBody.days[0].d).toBe(WED_KEY);
    expect(api.lastBody.days[13].d).toBe('2026-08-11');
  });

  test('today is measured from now, later days from the top of the window', async ({ page }) => {
    /* Nobody schedules into the morning they have already spent, and
       counting the hours you were asleep for would make every day look
       half empty. */
    const api = mockParse(page, FILED);
    await withCalendar(page, { blocks: [] });
    await capture(page, 'sort the loft');

    await expect.poll(() => dayIn(api, WED_KEY)?.free, { timeout: 10_000 }).toBe(FROM_9AM);
    expect(dayIn(api, '2026-07-30').free).toBe(FULL_DAY);
  });

  test('blocks on the calendar come off the free time, on the days they recur', async ({ page }) => {
    const api = mockParse(page, FILED);
    await withCalendar(page, {
      /* Two hours every day, plus two Wednesdays-only hours. */
      blocks: [
        { id: 'b-1', title: 'Deep work', pillar: 'tech', start: 13 * 60, end: 15 * 60, every: DAILY },
        { id: 'b-2', title: 'Council',   pillar: 'tech', start: 16 * 60, end: 18 * 60, every: [3] },
      ],
    });
    await capture(page, 'sort the loft');

    await expect.poll(() => dayIn(api, WED_KEY)?.free, { timeout: 10_000 }).toBe(FROM_9AM - 240);
    expect(dayIn(api, '2026-07-30').free).toBe(FULL_DAY - 120);   // Thursday: the daily block only
  });

  test('two blocks booked over each other cost the day one slot, not two', async ({ page }) => {
    /* Summed rather than merged, a double-booked hour would report the
       day as more committed than it can possibly be. */
    const api = mockParse(page, FILED);
    await withCalendar(page, {
      blocks: [
        { id: 'b-1', title: 'A', pillar: 'tech', start: 13 * 60, end: 15 * 60, every: DAILY },
        { id: 'b-2', title: 'B', pillar: 'tech', start: 14 * 60, end: 16 * 60, every: DAILY },
      ],
    });
    await capture(page, 'sort the loft');

    // 13:00–16:00 is three hours gone, not four.
    await expect.poll(() => dayIn(api, WED_KEY)?.free, { timeout: 10_000 }).toBe(FROM_9AM - 180);
  });

  test('a block that already finished this morning does not still cost the afternoon', async ({ page }) => {
    const api = mockParse(page, FILED);
    await withCalendar(page, {
      blocks: [{ id: 'b-1', title: 'Gym', pillar: 'tech', start: 7 * 60, end: 8 * 60, every: DAILY }],
    });
    await capture(page, 'sort the loft');

    await expect.poll(() => dayIn(api, WED_KEY)?.free, { timeout: 10_000 }).toBe(FROM_9AM);
    expect(dayIn(api, '2026-07-30').free).toBe(FULL_DAY - 60);   // tomorrow it still costs an hour
  });

  test('habits still owed are counted, and ones already ticked off are not', async ({ page }) => {
    const api = mockParse(page, FILED);
    await withCalendar(page, {
      habits: [
        { id: 'h-1', name: 'Fajr',  pillar: 'deen', days: DAILY, created: 1 },
        { id: 'h-2', name: 'Qur\'an', pillar: 'deen', days: DAILY, created: 1 },
        { id: 'h-3', name: 'Gym',   pillar: 'combat', days: [1], created: 1 },   // Mondays
      ],
      blocks: [],
      logs: { [WED_KEY]: { 'h-1': 1 } },
    });
    await capture(page, 'sort the loft');

    // Fajr is done, Gym isn't scheduled today — one left.
    await expect.poll(() => dayIn(api, WED_KEY)?.habits, { timeout: 10_000 }).toBe(1);
    expect(dayIn(api, '2026-07-30').habits).toBe(2);   // tomorrow, both are owed again
  });

  test('a habit with a slot is charged as time, not counted twice', async ({ page }) => {
    /* It is already a block, so its minutes are already gone from
       `free`. Counting it again would charge the day for it twice. */
    const api = mockParse(page, FILED);
    await withCalendar(page, {
      habits: [{ id: 'h-1', name: 'Qur\'an', pillar: 'deen', days: DAILY, created: 1 }],
      blocks: [{ id: 'b-h-1', habitId: 'h-1', start: 13 * 60, end: 14 * 60 }],
    });
    await capture(page, 'sort the loft');

    await expect.poll(() => dayIn(api, WED_KEY)?.free, { timeout: 10_000 }).toBe(FROM_9AM - 60);
    expect(dayIn(api, WED_KEY).habits).toBe(0);
  });

  test('tasks already due that day are reported, done ones are not', async ({ page }) => {
    const api = mockParse(page, FILED);
    await withCalendar(page, {
      blocks: [],
      tasks: [
        { id: 't-1', title: 'A', due: WED_KEY, done: false, quadrant: 'do', listId: 'l-inbox', created: 1 },
        { id: 't-2', title: 'B', due: WED_KEY, done: false, quadrant: 'do', listId: 'l-inbox', created: 1 },
        { id: 't-3', title: 'C', due: WED_KEY, done: true,  quadrant: 'do', listId: 'l-inbox', created: 1 },
        { id: 't-4', title: 'D', due: '2026-07-30', done: false, quadrant: 'do', listId: 'l-inbox', created: 1 },
      ],
    });
    await capture(page, 'sort the loft');

    await expect.poll(() => dayIn(api, WED_KEY)?.due, { timeout: 10_000 }).toBe(2);
    expect(dayIn(api, '2026-07-30').due).toBe(1);
  });

  test('a day with nothing left reports no free time rather than a negative', async ({ page }) => {
    const api = mockParse(page, FILED);
    await withCalendar(page, {
      blocks: [{ id: 'b-1', title: 'All day', pillar: 'tech', start: 0, end: 23 * 60 + 59, every: DAILY }],
    });
    await capture(page, 'sort the loft');

    await expect.poll(() => dayIn(api, WED_KEY)?.free, { timeout: 10_000 }).toBe(0);
  });
});
