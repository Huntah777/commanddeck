/* ============================================================
   Madinah · Command Deck — /api/parse
   ------------------------------------------------------------
   POST /api/parse  { text, today, people, lists }
        → { title, due, quadrant, listId, personId, why[], source }

   Turns a line of natural language ("dave needs the deck by friday")
   into a filed task. Same auth as /api/state.

   Bindings (Cloudflare Pages → Settings):
     env.SYNC_TOKEN   secret (same token as /api/state)

   No model is involved: this is rules only, so a capture costs nothing
   and the endpoint does not need an AI binding.

   ── What the rules read ──────────────────────────────────────
   The date, the person (and their weight), the list (by the keywords
   you configured) and urgency wording are all read by code you can
   audit — see resolveDue, matchPerson, matchList and markers below.
   `classify` then turns those into a quadrant, and `place` decides
   whether the work fits the day.

   ── Reading the calendar ──────────────────────────────────────
   `days` arrives from the client: for today and the fortnight after
   it, how many minutes are actually free once blocks, prayer and
   scheduled habits are subtracted, plus what is already due. The
   client computes it because the client already resolves all of that
   to draw the timeline — re-deriving it in a Worker would be a third
   implementation of the same rules to keep in step (there is already
   a second, in push-worker/index.js).

   Given that, "can this be done now?" becomes arithmetic: does the
   work fit in what is left of today, and if not, which is the first
   day it does fit? A date you stated yourself is never moved.

   A client too old to send `days` simply gets no scheduling.
   Capture never fails.
   ============================================================ */

const MAX_TEXT       = 500;

/* Importance is a 1–5 scale. 3 is "no one in particular" — your own
   tasks count as important by default, and it takes an explicitly
   de-prioritised person to fall below the line. That is what makes
   "partner (5) vs manager (2)" land the way you'd expect. */
const DEFAULT_WEIGHT     = 3;
const IMPORTANT_AT       = 3;
const URGENT_WITHIN_DAYS = 3; // a deadline inside the next few days is pressure

/* ── Fitting work into a day ──────────────────────────────────────
   A note that says nothing about its own size is assumed to be a
   half-hour job — long enough that a genuinely full day says no,
   short enough that an ordinary one says yes. Clamped at both ends
   because a model that answers 0 or 5000 must not be able to make
   every task fit, or none of them. */
const DEFAULT_TASK_MINS = 30;
const MIN_TASK_MINS     = 5;
const MAX_TASK_MINS     = 480;

/* Time a day owes to things that aren't on the calendar. A habit
   scheduled for today with no slot on the timeline still gets done,
   and a task already due today still wants doing — neither shows up
   in the free-minutes figure, so both are charged for here. Reserves
   rather than measurements: the honest claim is "this day is more
   committed than the timeline admits", not a precise number. */
const HABIT_RESERVE_MINS = 15;
const DUE_TASK_RESERVE_MINS = 20;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/* Constant-time token comparison via HMAC — see state.js for rationale */
const tokenOk = async (request, env) => {
  const header = request.headers.get('Authorization') || '';
  const given  = header.replace(/^Bearer\s+/i, '').trim();
  const expect = env.SYNC_TOKEN || '';
  if (!given || !expect) return false;

  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(given)),
    crypto.subtle.sign('HMAC', key, enc.encode(expect)),
  ]);
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
};

/* ── Dates ────────────────────────────────────────────────────────
   The client sends its own local YYYY-MM-DD as `today`, so there is
   no timezone maths to get wrong here — all arithmetic is on date
   keys. Anchoring at noon UTC keeps ±1h DST shifts from rounding a
   day boundary the wrong way. ── */

const DAY = 86_400_000;
export const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const toMs   = (key) => Date.parse(`${key}T12:00:00Z`);
const keyOf  = (ms)  => new Date(ms).toISOString().slice(0, 10);
const addDays = (key, n) => keyOf(toMs(key) + n * DAY);
export const daysBetween = (from, to) => Math.round((toMs(to) - toMs(from)) / DAY);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const weekdayOf = (key) => new Date(toMs(key)).getUTCDay();

/* Lowercase, punctuation → spaces, collapse. Used for every regex and
   every alias comparison so "Dave's" and "dave" are the same token. */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/* Resolve a date phrase deterministically. Models are unreliable at
   date arithmetic and this covers the phrasings that actually occur,
   so it is tried FIRST and the model's own guess is only a fallback. */
export function resolveDue(text, today) {
  if (!isDateKey(today)) return null;
  const t = ` ${norm(text)} `;

  if (/ (today|tonight|this evening|this afternoon|this morning) /.test(t)) return today;
  if (/ tomorrow /.test(t)) return addDays(today, /day after tomorrow/.test(t) ? 2 : 1);

  const inDays  = t.match(/ in (\d{1,3}) (day|days) /);
  if (inDays)  return addDays(today, Math.min(365, Number(inDays[1])));
  const inWeeks = t.match(/ in (\d{1,2}) (week|weeks) /);
  if (inWeeks) return addDays(today, Math.min(52, Number(inWeeks[1])) * 7);

  /* An explicit date written out, e.g. "2026-08-03". */
  const iso = String(text).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && isDateKey(iso[1])) return iso[1];

  for (let i = 0; i < 7; i++) {
    const m = t.match(new RegExp(` (next |this )?${WEEKDAYS[i]} `));
    if (!m) continue;
    /* Always the NEXT occurrence — "friday" said on a Friday means the
       one coming, not the day you're standing in. */
    let delta = (i - weekdayOf(today) + 7) % 7 || 7;
    /* "next friday" on a Wednesday is 9 days out; said on a Friday the
       plain reading is already a week away, so don't push it to two. */
    if (m[1]?.trim() === 'next' && delta < 7) delta += 7;
    return addDays(today, delta);
  }

  if (/ next week /.test(t)) return addDays(today, 7);
  return null;
}

/* ── Signals read straight off the text ───────────────────────── */

const URGENT_RE    = / (urgent|urgently|asap|right away|straight away|immediately|emergency|deadline|by (today|tonight|tomorrow)) /;
const IMPORTANT_RE = / (important|critical|crucial|essential|must|priority) /;
const TRIVIAL_RE   = / (sometime|some time|someday|whenever|no rush|eventually|low priority|if i get a chance|when i get a chance) /;

export function markers(text) {
  const t = ` ${norm(text)} `;
  return { urgent: URGENT_RE.test(t), important: IMPORTANT_RE.test(t), trivial: TRIVIAL_RE.test(t) };
}

/* Longest alias wins, so "dave smith" beats a bare "dave" when both
   are registered. Matching is on whole normalised words — "mo" must
   not fire on "moving". */
export function matchPerson(text, people) {
  const hay = ` ${norm(text)} `;
  let best = null;
  for (const p of people || []) {
    if (!p?.id) continue;
    for (const term of [p.name, ...(Array.isArray(p.aliases) ? p.aliases : [])]) {
      const n = norm(term);
      if (n.length < 2) continue;
      if (!hay.includes(` ${n} `)) continue;
      if (!best || n.length > best.length) best = { person: p, length: n.length, matched: term };
    }
  }
  return best;
}

/* Same shape as matchPerson: longest hit wins across a list's own name
   plus its configured keywords, so a list named "Work" with "meeting" as
   a keyword catches both "add to work" and "book the client meeting"
   without the text ever saying "work". A list with no keywords (Inbox,
   by default) is only ever reached by its own name or as the code-side
   catch-all below — never guessed at. */
export function matchList(text, lists) {
  const hay = ` ${norm(text)} `;
  let best = null;
  for (const l of lists || []) {
    if (!l?.id) continue;
    for (const term of [l.name, ...(Array.isArray(l.keywords) ? l.keywords : [])]) {
      const n = norm(term);
      if (n.length < 2) continue;
      if (!hay.includes(` ${n} `)) continue;
      if (!best || n.length > best.length) best = { list: l, length: n.length };
    }
  }
  return best;
}

const clampWeight = (w) => {
  const n = Number(w);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : DEFAULT_WEIGHT;
};

const clampMins = (m) => {
  const n = Number(m);
  return Number.isFinite(n) && n > 0
    ? Math.max(MIN_TASK_MINS, Math.min(MAX_TASK_MINS, Math.round(n)))
    : DEFAULT_TASK_MINS;
};

/* ── What a day actually has left ─────────────────────────────────
   `free` is what the client measured off the timeline; the reserves
   are what the timeline doesn't know about. Never negative — a day
   that is already over-committed has no room, not negative room. ── */
export function roomOn(day) {
  const free   = Number(day?.free)   || 0;
  const habits = Number(day?.habits) || 0;
  const due    = Number(day?.due)    || 0;
  return Math.max(0, free - habits * HABIT_RESERVE_MINS - due * DUE_TASK_RESERVE_MINS);
}

/* The first day in the window with room for a job this size. */
export function firstDayWithRoom(days, minutes) {
  for (const day of days || []) {
    if (isDateKey(day?.d) && roomOn(day) >= minutes) return day;
  }
  return null;
}

/* "45m", "2h", "1h30" — for the receipt, which is one line and read
   at a glance. */
export function fmtMins(n) {
  const m = Math.max(0, Math.round(Number(n) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h}h${String(rest).padStart(2, '0')}` : `${h}h`;
}

/* ── Now, or later? ───────────────────────────────────────────────
   The question the capture box could never answer before. Six
   outcomes, and each one is a different thing to tell the user:

     stated     you named a day — it stands, whatever the day holds
     someday    nothing here should be given a date at all (see
                `noDate`) — putting one on would be words in your mouth
     today      there is room for it in what's left of today
     squeezed   there isn't, but it can't wait, so today anyway
     scheduled  there isn't, and it can, so the first day there is
     full       nothing in the window has room; left undated rather
                than dropped on an arbitrary day

   Only reached when the client sent `days`. Without it there is no
   calendar to read and the date stands as extracted — which is
   exactly how this endpoint behaved before. ── */
export function place({ due, minutes, urgent, noDate, days }) {
  if (!Array.isArray(days) || !days.length || !isDateKey(days[0]?.d)) return { due, fit: null };

  const today = days[0];
  const room  = roomOn(today);
  const base  = { minutes, roomToday: room };

  if (due)    return { due,       fit: { when: 'stated',  ...base } };
  if (noDate) return { due: null, fit: { when: 'someday', ...base } };
  if (urgent) return { due: today.d, fit: { when: room >= minutes ? 'today' : 'squeezed', ...base } };

  const slot = firstDayWithRoom(days, minutes);
  if (!slot) return { due: null, fit: { when: 'full', ...base } };
  return { due: slot.d, fit: { when: slot.d === today.d ? 'today' : 'scheduled', ...base, roomThen: roomOn(slot) } };
}

/* ── The classifier ───────────────────────────────────────────────
   Two independent axes, crossed. Importance comes from who it
   concerns; urgency comes from when it is due. Because they are
   independent, a request from someone who matters with no deadline
   lands in Schedule rather than being crowded out by whoever shouted
   most recently — which is the entire point of the matrix.

   Schedule is the resting place. Do and Eliminate are both verdicts —
   "drop everything" and "cut this without guilt" — and neither is
   something the parser should reach by default. Where the text gives
   it nothing to go on, it files to Schedule: visible, actionable, and
   not pretending to a certainty it doesn't have. ── */

export function classify(extract, ctx = {}) {
  const today = isDateKey(ctx.today) ? ctx.today : keyOf(Date.now());
  const raw   = String(extract?.raw || '');

  /* Match against the raw text AND whatever name the model resolved,
     so "the wife" registers whether the alias list holds "wife" or the
     model already mapped it to her name. */
  const hit    = matchPerson(`${raw} ${extract?.person || ''}`, ctx.people);
  const weight = hit ? clampWeight(hit.person.weight) : DEFAULT_WEIGHT;
  const mark   = markers(raw);

  /* What the sentence itself says is at stake, and how long it sounds.
     Absent on the rules-only path, where they fall to neutral defaults
     and this whole paragraph is a no-op. */
  const consequence  = clampWeight(extract?.consequence);
  const minutes      = clampMins(extract?.minutes);
  const timeCritical = !!extract?.timeCritical;

  /* Keyword hits are policy you configured (Configuration → Task lists),
     same standing as a person's weight — they beat the model's own
     semantic guess. Only when nothing configured matches does the
     model's reading of the list get used at all. */
  const listHit = matchList(raw, ctx.lists);
  const listId  = listHit?.list.id ?? extract?.listId ?? null;

  /* What the sentence stakes can PROMOTE a task; it can never demote
     one. Two reasons, both deliberate:

     Promotion is the gap this fills. "The boiler is leaking through
     the kitchen ceiling" names nobody, so it takes the neutral weight
     3 and used to sit in Schedule with everything else. Read as a 5
     it lifts two places, and a weight-2 manager saying "the server is
     down" lifts by the same two — because a person's weight describes
     their ordinary asks, not a ceiling on what can happen to them.

     Demotion is withheld because Eliminate is a verdict, and one the
     model should not be able to reach. A note it reads as idle still
     gets its owner's weight; only YOUR words ("no rush", "sometime")
     take a task below the line. Nothing you configured can be
     overruled downwards by a sentence a model misread. */
  const bump = Math.max(0, consequence - DEFAULT_WEIGHT);
  const importance = Math.max(1, Math.min(5,
    weight + bump + (mark.important ? 1 : 0) - (mark.trivial ? 1 : 0)));

  /* Code's date reading beats the model's; the model only covers
     phrasings the regexes above don't know. */
  const modelDue = isDateKey(extract?.due) && Math.abs(daysBetween(today, extract.due)) <= 730
    ? extract.due : null;
  /* The date the CAPTURE named, as against the one the scheduler may
     propose below. Everything that reads a date as evidence — urgency,
     the commitment that keeps a task out of Eliminate — reads this
     one. A day the parser picked because the calendar had a gap is
     not a deadline, and must never be mistaken for one. */
  const namedDue  = resolveDue(raw, today) ?? modelDue;
  const namedDays = namedDue ? daysBetween(today, namedDue) : null;

  /* Wording that means "this cannot wait" counts the same as a near
     deadline — that is what it is saying. */
  const urgent    = mark.urgent || timeCritical || (namedDays !== null && namedDays <= URGENT_WITHIN_DAYS);
  const important = importance >= IMPORTANT_AT;

  /* Do has to be earned. A near date is a fact about the calendar, not
     evidence that something outranks everything else — and weight 3 is
     what a task gets for naming nobody, which is the absence of a
     signal rather than the presence of one. So Do needs the capture to
     have actually said this is pressing: someone weighted above
     neutral, or your own words. With neither, the parser is guessing,
     and a guess belongs in Schedule — still visible, still dated, just
     not jumping the queue ahead of the things you did call urgent.

     Wording that stakes something counts here too. It is not a guess:
     the note said the ceiling is coming down. What is still excluded
     is the parser's own arithmetic — a gap in the calendar is never
     evidence that anything is pressing. */
  const stated = mark.urgent || mark.important || timeCritical || importance > DEFAULT_WEIGHT;

  /* Eliminate is a verdict too — it says "cut this without guilt".
     Nothing the user gave a deadline to should land there
     automatically, however little weight the person carries: stating a
     date is stating a commitment. A far-off low-priority ask is
     something to pass on, not something to bin.

     `namedDue`, not `due`: the day the scheduler found a gap on is not
     a commitment anyone made, and must not quietly rescue a task from
     Eliminate. */
  const quadrant = important
    ? (urgent && stated ? 'do' : 'plan')
    : (urgent || namedDue ? 'delegate' : 'eliminate');

  /* Now, or later. Last, because it needs the verdict: booking time
     this week for something just filed under "cut this without guilt"
     would be the parser arguing with itself. A date you named yourself
     still comes back untouched — Eliminate is about what to do with
     the task, not licence to forget a deadline you set. */
  const { due, fit } = place({
    due: namedDue, minutes, days: ctx.days,
    urgent: mark.urgent || timeCritical,
    noDate: mark.trivial || quadrant === 'eliminate',
  });

  /* Say why, in the same terms the settings screen uses. A filing you
     can't audit is one you stop trusting. */
  const why = [];
  if (hit) why.push(`${hit.person.name} · weight ${weight}`);
  else     why.push('no one named · default weight 3');
  /* Where the wording, rather than a person, is what carried it. Said
     only when it actually moved the task — a note read as ordinary
     has nothing to report. */
  if (bump > 0) why.push(`wording reads ${consequence}/5 at stake`);
  if (listHit)               why.push(`filed under ${listHit.list.name}`);
  else if (extract?.listId)  why.push('filed by AI guess');
  if (mark.important) why.push('flagged important');
  if (mark.trivial)   why.push('flagged low priority');
  why.push(important ? 'important' : 'not important');
  if (mark.urgent)             why.push('urgent wording');
  else if (timeCritical)       why.push('wording says it cannot wait');
  else if (namedDays === null) why.push('no deadline');
  else if (namedDays < 0)      why.push(`overdue by ${Math.abs(namedDays)}d`);
  else if (namedDays === 0)    why.push('due today');
  else if (namedDays === 1)    why.push('due tomorrow');
  else                         why.push(`due in ${namedDays}d`);
  /* Say when the date alone was what stopped it reaching Do, so the
     demotion reads as a rule rather than as the parser losing track. */
  if (important && urgent && !stated) why.push('nothing marked it urgent · scheduled');

  /* What the calendar had to say. One line, in the same voice — the
     receipt is a single row of text. */
  if (fit) {
    const room = fmtMins(fit.roomToday), work = fmtMins(fit.minutes);
    if (fit.when === 'today')     why.push(`${work} of work · ${room} free today`);
    if (fit.when === 'squeezed')  why.push(`today only has ${room} free · doing it anyway`);
    if (fit.when === 'scheduled') why.push(`only ${room} free today · booked for ${due}`);
    if (fit.when === 'full')      why.push(`${work} of work · nothing free in the next fortnight`);
  }

  return {
    title: extract?.title || raw,
    due, quadrant, importance, important, urgent,
    personId:   hit?.person.id   ?? null,
    personName: hit?.person.name ?? null,
    listId,
    /* How long the work looked, and how the day was read. Reported
       rather than acted on: the receipt shows it, and it is what makes
       a scheduling decision auditable instead of a date appearing from
       nowhere. */
    minutes, fit,
    why,
  };
}

/* ── Extraction ───────────────────────────────────────────────────
   Produces the `{ raw, title, person, due, listId }` shape that
   `classify` reads. ── */

/* Strip the parts we resolve ourselves out of the title and hand back
   the rest. */
export function fallbackExtract(text, ctx = {}) {
  const raw = String(text).trim();
  return { raw, title: tidyTitle(raw), person: '', due: null, listId: null };
}

/* Trim the leading noise a spoken capture picks up, and drop a
   trailing date phrase — the date is a field now, not prose. */
function tidyTitle(raw) {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/[\s,]*\b(?:on|by|due|before)?\s*(?:today|tonight|tomorrow|next week|(?:next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day)\s*$/i, '');
  t = t.replace(/[\s,]*\bin \d{1,3} (?:day|days|week|weeks)\s*$/i, '');
  return (t.trim() || raw).replace(/^./, c => c.toUpperCase());
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const text = String(body?.text || '').trim().slice(0, MAX_TEXT);
  if (!text) return json({ error: 'Missing text' }, 400);

  const ctx = {
    today:  isDateKey(body?.today) ? body.today : keyOf(Date.now()),
    people: Array.isArray(body?.people) ? body.people.slice(0, 200) : [],
    lists:  Array.isArray(body?.lists)  ? body.lists.slice(0, 50)   : [],
    /* Free minutes per day, from today forward — see `place`. Absent
       from an older client, which simply gets no scheduling. Trimmed to
       date-keyed entries so a malformed one can't be read as a day with
       infinite room. */
    days: (Array.isArray(body?.days) ? body.days : [])
      .filter(d => isDateKey(d?.d))
      .slice(0, 31),
  };
  const extract = fallbackExtract(text, ctx);

  return json({ ...classify(extract, ctx), source: 'rules' });
}
