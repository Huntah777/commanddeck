/* ============================================================
   Madinah · Command Deck — /api/parse
   ------------------------------------------------------------
   POST /api/parse  { text, today, people, lists }
        → { title, due, quadrant, listId, personId, why[], source }

   Turns a line of natural language ("dave needs the deck by friday")
   into a filed task. Same auth as /api/state — an unauthenticated
   endpoint here would be a free LLM billed to this account.

   Bindings (Cloudflare Pages → Settings):
     env.SYNC_TOKEN   secret (same token as /api/state)
     env.AI           Workers AI binding (binding name: AI)

   ── The split that matters ────────────────────────────────────
   The model does LANGUAGE. This file does POLICY.

   The model is only ever asked to extract what was written: the task,
   whose name appears, the date phrase, the list. It is never asked
   whether your partner outranks your manager — that is a fact about
   your life, it lives in the `people` table you control, and it is
   applied by the arithmetic below. So the same person always yields
   the same weight, the weights are editable without touching a
   prompt, and swapping or losing the model changes nothing about how
   tasks are prioritised.

   Everything here degrades: no AI binding, a model error, or a
   timeout all fall through to `fallbackExtract` (regex only), which
   still resolves dates, people and — via keyword matching against your
   configured lists — which list a task belongs in. Capture never fails.
   ============================================================ */

import { learningExamples } from './learn.js';

const MAX_TEXT       = 500;
const MODEL          = '@cf/meta/llama-3.1-8b-instruct-fast';
const AI_TIMEOUT_MS  = 6_000;

/* Importance is a 1–5 scale. 3 is "no one in particular" — your own
   tasks count as important by default, and it takes an explicitly
   de-prioritised person to fall below the line. That is what makes
   "partner (5) vs manager (2)" land the way you'd expect. */
const DEFAULT_WEIGHT     = 3;
const IMPORTANT_AT       = 3;
const URGENT_WITHIN_DAYS = 3; // a deadline inside the next few days is pressure

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

  /* Keyword hits are policy you configured (Configuration → Task lists),
     same standing as a person's weight — they beat the model's own
     semantic guess. Only when nothing configured matches does the
     model's reading of the list get used at all. */
  const listHit = matchList(raw, ctx.lists);
  const listId  = listHit?.list.id ?? extract?.listId ?? null;

  const importance = Math.max(1, Math.min(5,
    weight + (mark.important ? 1 : 0) - (mark.trivial ? 1 : 0)));

  /* Code's date reading beats the model's; the model only covers
     phrasings the regexes above don't know. */
  const modelDue = isDateKey(extract?.due) && Math.abs(daysBetween(today, extract.due)) <= 730
    ? extract.due : null;
  const due  = resolveDue(raw, today) ?? modelDue;
  const days = due ? daysBetween(today, due) : null;

  const urgent    = mark.urgent || (days !== null && days <= URGENT_WITHIN_DAYS);
  const important = importance >= IMPORTANT_AT;

  /* Do has to be earned. A near date is a fact about the calendar, not
     evidence that something outranks everything else — and weight 3 is
     what a task gets for naming nobody, which is the absence of a
     signal rather than the presence of one. So Do needs the capture to
     have actually said this is pressing: someone weighted above
     neutral, or your own words. With neither, the parser is guessing,
     and a guess belongs in Schedule — still visible, still dated, just
     not jumping the queue ahead of the things you did call urgent. */
  const stated = mark.urgent || mark.important || importance > DEFAULT_WEIGHT;

  /* Eliminate is a verdict too — it says "cut this without guilt".
     Nothing the user gave a deadline to should land there
     automatically, however little weight the person carries: stating a
     date is stating a commitment. A far-off low-priority ask is
     something to pass on, not something to bin. */
  const quadrant = important
    ? (urgent && stated ? 'do' : 'plan')
    : (urgent || due ? 'delegate' : 'eliminate');

  /* Say why, in the same terms the settings screen uses. A filing you
     can't audit is one you stop trusting. */
  const why = [];
  if (hit) why.push(`${hit.person.name} · weight ${weight}`);
  else     why.push('no one named · default weight 3');
  if (listHit)               why.push(`filed under ${listHit.list.name}`);
  else if (extract?.listId)  why.push('filed by AI guess');
  if (mark.important) why.push('flagged important');
  if (mark.trivial)   why.push('flagged low priority');
  why.push(important ? 'important' : 'not important');
  if (mark.urgent)        why.push('urgent wording');
  else if (days === null) why.push('no deadline');
  else if (days < 0)      why.push(`overdue by ${Math.abs(days)}d`);
  else if (days === 0)    why.push('due today');
  else if (days === 1)    why.push('due tomorrow');
  else                    why.push(`due in ${days}d`);
  /* Say when the date alone was what stopped it reaching Do, so the
     demotion reads as a rule rather than as the parser losing track. */
  if (important && urgent && !stated) why.push('nothing marked it urgent · scheduled');

  return {
    title: extract?.title || raw,
    due, quadrant, importance, important, urgent,
    personId:   hit?.person.id   ?? null,
    personName: hit?.person.name ?? null,
    listId,
    why,
  };
}

/* ── Extraction ───────────────────────────────────────────────────
   Everything below produces the same `{ raw, title, person, due,
   listId }` shape, whether it came from the model or from regexes,
   so `classify` cannot tell the difference and neither path is a
   privileged one. ── */

const listIdFor = (name, lists) => {
  const n = norm(name);
  if (!n) return null;
  return (lists || []).find(l => norm(l.name) === n)?.id ?? null;
};

/* No model, or the model failed. Strip the parts we resolved
   ourselves out of the title and hand back the rest. */
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

const SCHEMA = {
  type: 'object',
  properties: {
    title:  { type: 'string', description: 'the task itself, imperative, without the date' },
    person: { type: 'string', description: 'who asked for it or who it concerns; empty if nobody' },
    due:    { type: 'string', description: 'YYYY-MM-DD if the note implies a date; empty otherwise' },
    list:   { type: 'string', description: 'best matching list name; empty if unclear' },
  },
  required: ['title', 'person', 'due', 'list'],
};

/* Captures this user has previously corrected, as input → what they
   actually wanted. Code already learns routing and priority from the
   same corrections (see learn.js); these carry the part code cannot
   express — how this person words a title. */
const examplesBlock = (examples) => !examples?.length ? '' : `
Corrections this user has made to your previous output. Match their
style; do not copy their content:
${examples.map(e => `  in:  ${e.input}\n  out: ${JSON.stringify(e.corrected)}`).join('\n')}
`;

const prompt = (text, today, people, lists, examples) => [
  { role: 'system', content:
`You extract fields from a short task note. Reply with JSON only.
Today is ${today} (${WEEKDAYS[weekdayOf(today)]}).
Known people: ${people.map(p => p.name).filter(Boolean).join(', ') || 'none'}
Lists: ${lists.map(l => l.name).filter(Boolean).join(', ') || 'none'}

title  - the task, imperative, in the writer's own words, with the date phrase removed.
person - the known person the note names or refers to, exactly as spelled above. "" if none.
due    - YYYY-MM-DD only if the note states or implies a date. "" otherwise. Never invent one.
list   - one of the list names above, or "".
${examplesBlock(examples)}
Extract only. Do not judge importance, urgency or priority.` },
  { role: 'user', content: text },
];

/* JSON mode returns the object on some models and a JSON string on
   others; accept either and treat anything else as a failure. */
const asObject = (r) => {
  const v = r?.response ?? r;
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return null; }
};

async function aiExtract(text, ctx, env) {
  const run = env.AI.run(MODEL, { messages: prompt(text, ctx.today, ctx.people, ctx.lists, ctx.examples), response_format: { type: 'json_schema', json_schema: SCHEMA } });
  /* fetch/AI calls have no timeout of their own, and capture is a
     foreground interaction — a stalled model must not hold it open. */
  const out = await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), AI_TIMEOUT_MS)),
  ]);

  const got = asObject(out);
  if (!got) throw new Error('AI_BAD_JSON');

  /* A rewritten title should be a tightening of what was typed. Longer
     than the input means the model elaborated, so keep the original. */
  const title = String(got.title || '').trim();
  return {
    raw: text,
    title: title && title.length <= text.length + 4 ? title : tidyTitle(text),
    person: String(got.person || '').trim(),
    due: isDateKey(got.due) ? got.due : null,
    listId: listIdFor(got.list, ctx.lists),
    /* What the call actually cost, in the only unit the API reports.
       Handed back so the client can keep its own ledger — the running
       total is arithmetic over calls this app made, not a number
       scraped out of a billing dashboard. */
    usage: tokensOf(out),
  };
}

/* Workers AI reports usage on some models and not others, and has used
   more than one field name for it. Anything unrecognised is null rather
   than zero: a missing figure and a free call are not the same claim. */
export function tokensOf(out) {
  const u = out?.usage;
  if (!u || typeof u !== 'object') return null;
  const i = Number(u.prompt_tokens ?? u.input_tokens);
  const o = Number(u.completion_tokens ?? u.output_tokens);
  if (!Number.isFinite(i) && !Number.isFinite(o)) return null;
  return { i: Number.isFinite(i) ? i : 0, o: Number.isFinite(o) ? o : 0 };
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
  };
  /* The client sends the tasks the parser previously filed; the rule for
     what counts as a correction lives here, in learn.js, rather than
     being reimplemented in the browser. Capped so the prompt stays small
     enough for this endpoint to remain inside the free tier. */
  ctx.examples = learningExamples(
    Array.isArray(body?.filedTasks) ? body.filedTasks.slice(0, 40) : [],
    ctx.lists,
    3,
  );

  let extract, source = 'ai';
  try {
    if (!env.AI) throw new Error('NO_AI_BINDING');
    extract = await aiExtract(text, ctx, env);
  } catch (err) {
    /* Not an error path worth failing on — the regex extractor still
       resolves dates and people, so a capture is always better filed
       than it would have been with no parsing at all. */
    console.warn('parse: falling back to rules —', err?.message || err);
    extract = fallbackExtract(text, ctx);
    source = 'rules';
  }

  return json({ ...classify(extract, ctx), source, usage: extract.usage || null });
}
