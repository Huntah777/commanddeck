/* ============================================================
   Madinah · Command Deck — learning from corrections
   ------------------------------------------------------------
   Every task the parser files carries a snapshot of what it
   decided (`task.ai`). Whenever the stored task and that snapshot
   disagree, the user has overruled the parser — and that
   disagreement is the only honest training signal this app has.

   Nothing here guesses at intent. A correction is a fact: the
   parser said Inbox, the task is in Life. This module turns those
   facts into two things:

     1. suggestKeywords  — words that keep appearing in titles you
                           move to a list, offered as routing rules
     2. suggestWeights   — people whose tasks you keep re-filing,
                           offered as a weight change

   Both become deterministic policy you can see and edit, applied
   by code forever after.
   ============================================================ */

/* Ignore the scaffolding of a sentence — only content words can
   meaningfully route a task. */
const STOPWORDS = new Set(`a an and are as at be been before but by call can did do does
for from get go got had has have her him his how i if in into is it its me my need needs
of on or our out she should so some that the their them then there these they this to too
up us was we were what when where which who will with would you your about after again
all also am any because been being both each few more most no nor not now off once only
other over own same than through under until very just make made take get put see`.split(/\s+/));

const words = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter(w => w.length >= 3 && !STOPWORDS.has(w));

/* The parser's own output, however it was recorded. Tasks filed before
   the full snapshot existed carry only `aiQuadrant`. */
export function aiSnapshot(task) {
  if (task?.ai && typeof task.ai === 'object') return task.ai;
  if (task?.aiQuadrant) return { quadrant: task.aiQuadrant };
  return null;
}

/* Every field where the stored task disagrees with what the parser
   produced. Fields the parser never set are not corrections — leaving
   a null due date alone is not a disagreement. */
export function corrections(tasks = []) {
  const out = [];
  for (const t of tasks) {
    const ai = aiSnapshot(t);
    if (!ai) continue;
    const at = Number(t.modifiedAt) || 0;
    const add = (field, from, to) => out.push({ taskId: t.id, field, from, to, title: t.title, raw: ai.raw || null, at });

    if (ai.quadrant && (t.quadrant || null) !== ai.quadrant) add('quadrant', ai.quadrant, t.quadrant || null);
    if ('listId'   in ai && (t.listId   || null) !== (ai.listId   || null)) add('list',   ai.listId   || null, t.listId   || null);
    if ('due'      in ai && (t.due      || null) !== (ai.due      || null)) add('due',    ai.due      || null, t.due      || null);
    if ('personId' in ai && (t.personId || null) !== (ai.personId || null)) add('person', ai.personId || null, t.personId || null);
    if (ai.title && String(t.title || '').trim() !== String(ai.title).trim()) add('title', ai.title, t.title || null);
  }
  return out;
}

const MIN_EVIDENCE = 2; // one move is a one-off; twice is a pattern

/* This module reads whatever a client sent, spanning every version of
   the app that has ever synced — a stray null in an array is real
   production risk, not a hypothetical. corrections() already tolerates
   it via aiSnapshot's optional chaining; the two functions below don't
   run every task through that, so they guard directly. */
const isRecord = (x) => x !== null && typeof x === 'object';

/* Words that keep showing up in titles moved to a given list. Skips
   anything already routing somewhere — a word that means two lists
   means neither. */
export function suggestKeywords(tasks = [], lists = []) {
  const claimed = new Map();
  for (const l of lists.filter(isRecord)) for (const k of l.keywords || []) claimed.set(String(k).toLowerCase(), l.id);

  const tally = new Map(); // `${listId} ${word}` → { count, titles }
  for (const c of corrections(tasks)) {
    if (c.field !== 'list' || !c.to) continue;
    for (const w of new Set(words(c.title))) {
      if (claimed.has(w)) continue;
      const key = `${c.to} ${w}`;
      const cur = tally.get(key) || { listId: c.to, keyword: w, count: 0, titles: [] };
      cur.count++;
      if (cur.titles.length < 3) cur.titles.push(c.title);
      tally.set(key, cur);
    }
  }

  /* A word that would route to more than one list is ambiguous — drop
     it rather than pick a winner. */
  const perWord = new Map();
  for (const v of tally.values()) perWord.set(v.keyword, (perWord.get(v.keyword) || 0) + 1);

  return [...tally.values()]
    .filter(v => v.count >= MIN_EVIDENCE && perWord.get(v.keyword) === 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

/* Which side of the importance line a quadrant sits on. Person weight
   drives exactly this axis, so a re-file across it is a statement
   about the person, not the task. */
const IMPORTANT_QUADS = new Set(['do', 'plan']);
const isImportant = (q) => IMPORTANT_QUADS.has(q);

/* People whose tasks are repeatedly pulled across the importance line.
   Consistently promoted → the weight is too low, and vice versa. */
export function suggestWeights(tasks = [], people = []) {
  const records = tasks.filter(isRecord);
  const byPerson = new Map();
  for (const c of corrections(tasks)) {
    if (c.field !== 'quadrant' || !c.from || !c.to) continue;
    const task = records.find(t => t.id === c.taskId);
    const personId = task?.personId;
    if (!personId) continue;
    if (isImportant(c.from) === isImportant(c.to)) continue; // same side of the line

    const cur = byPerson.get(personId) || { personId, up: 0, down: 0 };
    isImportant(c.to) ? cur.up++ : cur.down++;
    byPerson.set(personId, cur);
  }

  const out = [];
  for (const { personId, up, down } of byPerson.values()) {
    const person = people.filter(isRecord).find(p => p.id === personId);
    if (!person) continue;
    const net = up - down;
    if (Math.abs(net) < MIN_EVIDENCE) continue;
    const from = Number(person.weight) || 3;
    const to = Math.max(1, Math.min(5, from + (net > 0 ? 1 : -1)));
    if (to === from) continue; // already at the ceiling or floor
    out.push({ personId, name: person.name, from, to, moves: Math.abs(net), direction: net > 0 ? 'up' : 'down' });
  }
  return out.sort((a, b) => b.moves - a.moves).slice(0, 5);
}
