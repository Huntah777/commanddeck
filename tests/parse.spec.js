import { test, expect } from '@playwright/test';
import { classify, resolveDue, matchPerson, matchList, markers, fallbackExtract, daysBetween, tokensOf,
         roomOn, firstDayWithRoom, place, fmtMins } from '../functions/api/parse.js';

/* Unit tests for natural-language task capture. No browser and no model:
   everything asserted here is the deterministic half of /api/parse — the
   half that decides priority. The model only ever extracts, so its output
   is supplied directly as a fixture.

   The point of the split is that these outcomes cannot drift. If a weight
   stops mapping to a quadrant the way it does below, that is a behaviour
   change, not a model having an off day. */

const TODAY = '2026-07-29';   // a Wednesday
const WED = TODAY, THU = '2026-07-30', FRI = '2026-07-31', NEXT_FRI = '2026-08-07';

const PEOPLE = [
  { id: 'pp-wife', name: 'Aisha', aliases: ['wife', 'the wife'], weight: 5 },
  { id: 'pp-mgr',  name: 'Dave',  aliases: ['manager', 'my boss'], weight: 2 },
  { id: 'pp-dave2', name: 'Dave Smith', aliases: [], weight: 5 },
];
const LISTS = [
  { id: 'l-inbox', name: 'Inbox', keywords: [] },
  { id: 'l-work',  name: 'Work',  keywords: ['meeting', 'invoice', 'client'] },
  { id: 'l-deen',  name: 'Deen',  keywords: ['prayer', 'quran', 'salah'] },
  { id: 'l-life',  name: 'Life',  keywords: ['groceries', 'kids'] },
];

/* Shorthand: run the rules-only path, exactly as /api/parse does when the
   model is unavailable. */
const file = (text, over = {}) =>
  classify({ ...fallbackExtract(text), ...over }, { today: TODAY, people: PEOPLE, lists: LISTS });

test.describe('date resolution', () => {
  /* Models are unreliable at date arithmetic, so these phrasings are
     resolved in code and the model's own guess is only ever a fallback. */
  test('relative phrases resolve against the client\'s own today', () => {
    expect(resolveDue('call the bank today', TODAY)).toBe(WED);
    expect(resolveDue('call the bank tomorrow', TODAY)).toBe(THU);
    expect(resolveDue('pay it in 3 days', TODAY)).toBe('2026-08-01');
    expect(resolveDue('review in 2 weeks', TODAY)).toBe('2026-08-12');
    expect(resolveDue('sort it next week', TODAY)).toBe('2026-08-05');
  });

  test('a weekday means the next one, never the day you are standing in', () => {
    expect(resolveDue('deck by friday', TODAY)).toBe(FRI);
    // Said on a Wednesday, "wednesday" is a week out — not today.
    expect(resolveDue('gym wednesday', TODAY)).toBe('2026-08-05');
  });

  test('"next friday" is a week past the coming friday', () => {
    expect(resolveDue('deck by next friday', TODAY)).toBe(NEXT_FRI);
    // ...but said ON a Friday the plain reading is already a week away,
    // so it must not be pushed out to a fortnight.
    expect(resolveDue('deck by next friday', FRI)).toBe(NEXT_FRI);
  });

  test('an explicit date is taken literally', () => {
    expect(resolveDue('renew on 2026-09-14', TODAY)).toBe('2026-09-14');
  });

  test('no date phrase means no date — never a guess', () => {
    expect(resolveDue('read the strategy doc', TODAY)).toBeNull();
    expect(file('read the strategy doc').due).toBeNull();
  });

  test('the model cannot invent a date the code did not find', () => {
    // A hallucinated far-future date is rejected; a plausible one is kept.
    expect(file('read the doc', { due: '2099-01-01' }).due).toBeNull();
    expect(file('read the doc', { due: '2026-08-20' }).due).toBe('2026-08-20');
  });

  test('code\'s reading of a date beats the model\'s', () => {
    expect(file('call the bank tomorrow', { due: '2026-12-25' }).due).toBe(THU);
  });
});

test.describe('who it concerns', () => {
  test('a person is matched by name or by alias', () => {
    expect(matchPerson('ring aisha about the flights', PEOPLE)?.person.id).toBe('pp-wife');
    expect(matchPerson('the wife needs the car booked', PEOPLE)?.person.id).toBe('pp-wife');
    expect(matchPerson('my boss wants the deck', PEOPLE)?.person.id).toBe('pp-mgr');
  });

  test('the longest alias wins so a shared first name is not stolen', () => {
    expect(matchPerson('dave smith needs the numbers', PEOPLE)?.person.id).toBe('pp-dave2');
    expect(matchPerson('dave needs the numbers', PEOPLE)?.person.id).toBe('pp-mgr');
  });

  test('matching is on whole words', () => {
    // "the wife" must not fire on "wifi", and a name inside a longer word
    // is not a mention.
    expect(matchPerson('fix the wifi', PEOPLE)).toBeFalsy();
    expect(matchPerson('davenport delivery', PEOPLE)).toBeFalsy();
  });

  test('a name the model resolved still counts when the text used an alias', () => {
    // The model maps "her" → "Aisha"; the raw text has no registered term.
    const out = classify({ raw: 'book her a taxi', title: 'Book her a taxi', person: 'Aisha' },
      { today: TODAY, people: PEOPLE });
    expect(out.personId).toBe('pp-wife');
  });
});

test.describe('which list', () => {
  /* Not everything should default to Inbox. A keyword configured on a
     list (Configuration → Task lists) routes a task there without the
     text ever naming the list — same standing as a person's weight. */

  test('a keyword routes the task without the list ever being named', () => {
    expect(matchList('book the client meeting for thursday', LISTS)?.list.id).toBe('l-work');
    expect(file('book the client meeting for thursday').listId).toBe('l-work');
  });

  test("the list's own name is itself always a match", () => {
    expect(matchList('add this to deen', LISTS)?.list.id).toBe('l-deen');
  });

  test('matching is on whole words — "workshop" does not fire "work"', () => {
    const workish = [{ id: 'l-work', name: 'Work', keywords: [] }];
    expect(matchList('book the workshop', workish)).toBeFalsy();
  });

  test('the longer, more specific hit wins over a shorter one', () => {
    const lists = [
      { id: 'l-a', name: 'A', keywords: ['pray'] },
      { id: 'l-b', name: 'B', keywords: ['pray for the trip'] },
    ];
    expect(matchList('remember to pray for the trip', lists)?.list.id).toBe('l-b');
  });

  test('nothing configured, nothing named → no match, not a guess', () => {
    expect(matchList('sort out the loft', LISTS)).toBeFalsy();
    expect(file('sort out the loft').listId).toBeNull();
  });

  test('a keyword match overrides the model\'s own guess', () => {
    // Configured policy beats the model's judgement, same as person weight
    // beating the model's sense of importance.
    const out = classify(
      { raw: 'sort the quran study plan', title: 'Sort the quran study plan', listId: 'l-work' },
      { today: TODAY, people: PEOPLE, lists: LISTS },
    );
    expect(out.listId).toBe('l-deen');
  });

  test('the model\'s guess is used only when nothing configured matches', () => {
    const out = classify(
      { raw: 'sort the loft out', title: 'Sort the loft out', listId: 'l-life' },
      { today: TODAY, people: PEOPLE, lists: LISTS },
    );
    expect(out.listId).toBe('l-life');
  });
});

test.describe('quadrant assignment', () => {
  /* The two axes are independent: who it concerns sets importance, the
     due date sets urgency. Crossing them is the whole matrix. */

  test('someone who matters, with a deadline → Do', () => {
    expect(file('aisha needs the passports tomorrow').quadrant).toBe('do');
  });

  test('someone who matters, no deadline → Schedule, not Eliminate', () => {
    // The failure mode the matrix exists to prevent: relationship work
    // has no deadline, so it loses to whoever shouted most recently.
    // Weighting people on the importance axis is what stops that.
    const out = file('talk to aisha about the house');
    expect(out.quadrant).toBe('plan');
    expect(out.important).toBe(true);
    expect(out.urgent).toBe(false);
  });

  test('a demoted person with a deadline → Delegate', () => {
    const out = file('dave needs the deck by friday');
    expect(out.quadrant).toBe('delegate');
    expect(out.due).toBe(FRI);
  });

  test('a demoted person with no deadline → Eliminate', () => {
    expect(file('dave wants me to look over the wiki sometime').quadrant).toBe('eliminate');
  });

  test('nothing with a deadline is ever auto-filed as Eliminate', () => {
    // Eliminate says "cut this without guilt" — too strong a verdict to
    // reach on the strength of a date being far off. Stating a date is
    // stating a commitment, so a low-weight ask with one gets passed on.
    const out = file('dave needs the audit numbers on 2026-09-30');
    expect(out.important).toBe(false);
    expect(out.urgent).toBe(false);
    expect(out.quadrant).toBe('delegate');
  });

  test('naming nobody is important by default — your own work is not background', () => {
    expect(file('write the quarterly plan').quadrant).toBe('plan');
    expect(file('renew the car insurance tomorrow').important).toBe(true);
  });

  test('a date on its own schedules rather than promotes to Do', () => {
    /* Do says "drop everything". A date is a fact about the calendar,
       and weight 3 is what a task gets for naming nobody — the absence
       of a signal, not the presence of one. With neither, the parser is
       guessing, and Schedule is where a guess belongs. */
    const out = file('renew the car insurance tomorrow');
    expect(out.important).toBe(true);
    expect(out.urgent).toBe(true);      // the date still reads as urgent
    expect(out.quadrant).toBe('plan');  // it just isn't enough on its own
    expect(out.due).toBe(THU);          // and the date is not lost
  });

  test('the demotion is stated in the receipt, not silent', () => {
    // A filing you can't audit is one you stop trusting.
    expect(file('renew the car insurance tomorrow').why.join(' ')).toContain('nothing marked it urgent');
    expect(file('aisha needs the passports tomorrow').why.join(' ')).not.toContain('nothing marked it urgent');
  });

  test('saying it is urgent is enough on its own', () => {
    // The parser is not guessing here — you said so.
    expect(file('sort the invoices asap').quadrant).toBe('do');
    expect(file('renew the car insurance tomorrow, this is critical').quadrant).toBe('do');
  });

  test('someone weighted above neutral is enough on its own', () => {
    // Aisha is 5. The deadline supplies urgency, she supplies the reason.
    expect(file('aisha needs the passports tomorrow').quadrant).toBe('do');
  });

  test('a deadline nobody vouched for still shows up on the day', () => {
    /* The demotion is about priority, not visibility: Schedule is a
       quadrant, the due date is what puts it in front of you. */
    const out = file('renew the car insurance today');
    expect(out.quadrant).toBe('plan');
    expect(out.due).toBe(WED);
  });

  test('the same person always produces the same filing', () => {
    // The property that makes weights worth having: this is arithmetic on
    // a table you control, not a judgement re-derived per capture.
    const a = file('dave needs the deck by friday');
    const b = file('deck for dave by friday');
    expect(b.quadrant).toBe(a.quadrant);
    expect(b.personId).toBe(a.personId);
  });

  test('changing a weight changes the quadrant and nothing else', () => {
    const ctx = (weight) => ({ today: TODAY, people: [{ id: 'pp-x', name: 'Sam', aliases: [], weight }] });
    const at = (w) => classify(fallbackExtract('sam needs the report by friday'), ctx(w));
    expect(at(2).quadrant).toBe('delegate');
    expect(at(4).quadrant).toBe('do');
    expect(at(4).due).toBe(at(2).due);
  });
});

test.describe('wording signals', () => {
  test('explicit urgency beats the absence of a date', () => {
    expect(markers('this is urgent').urgent).toBe(true);
    expect(file('dave needs this asap').quadrant).toBe('delegate');
    expect(file('sort the invoices asap').quadrant).toBe('do');
  });

  test('"sometime" demotes a task below the line', () => {
    expect(file('sort the loft sometime').quadrant).toBe('eliminate');
  });

  test('"important" promotes a demoted person back over it', () => {
    expect(file('dave says this one is important').quadrant).toBe('plan');
  });

  test('weights are clamped, so a bad value cannot invert the grid', () => {
    const at = (weight) => classify(fallbackExtract('sam needs it'), { today: TODAY, people: [{ id: 'pp-x', name: 'Sam', weight }] });
    expect(at(99).importance).toBe(5);
    expect(at(-4).importance).toBe(1);
    expect(at('nonsense').importance).toBe(3);
  });
});

test.describe('the receipt', () => {
  test('every filing says why, in the terms the settings screen uses', () => {
    const out = file('dave needs the deck by friday');
    const why = out.why.join(' · ');
    expect(why).toContain('Dave');
    expect(why).toContain('weight 2');
    expect(why).toContain('not important');
    expect(why).toContain('due in 2d');
  });

  test('an unattributed task says so rather than naming someone', () => {
    expect(file('write the plan').why.join(' ')).toContain('no one named');
  });
});

test.describe('degrading without the model', () => {
  /* /api/parse falls through to exactly this path when the AI binding is
     missing, errors, or times out. Capture must still improve on nothing. */
  test('the rules path still resolves dates, people and quadrants', () => {
    const out = file('dave needs the deck by friday');
    expect(out.due).toBe(FRI);
    expect(out.personId).toBe('pp-mgr');
    expect(out.quadrant).toBe('delegate');
  });

  test('a trailing date phrase is dropped from the title', () => {
    expect(file('call the bank tomorrow').title).toBe('Call the bank');
    expect(file('send the invoice on friday').title).toBe('Send the invoice');
  });

  test('a title is never emptied by tidying', () => {
    expect(file('tomorrow').title).toBeTruthy();
  });
});

test.describe('date arithmetic', () => {
  test('day counts are stable across a DST boundary', () => {
    // Britain's clocks change on 2026-10-25; anchoring at noon UTC keeps
    // the ±1h shift from rounding a day boundary the wrong way.
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });
});

test.describe('what the call cost', () => {
  /* Feeds the AI spend figure in Admin. Workers AI reports usage on
     some models and not others, and has used more than one field name
     for it, so this is read defensively. */
  test('the two naming conventions both read', () => {
    expect(tokensOf({ usage: { prompt_tokens: 400, completion_tokens: 60 } })).toEqual({ i: 400, o: 60 });
    expect(tokensOf({ usage: { input_tokens: 400, output_tokens: 60 } })).toEqual({ i: 400, o: 60 });
  });

  test('no usage reported is null, not zero', () => {
    // A missing figure and a free call are not the same claim, and a
    // ledger that treats them alike understates the bill.
    expect(tokensOf({ response: 'x' })).toBe(null);
    expect(tokensOf({ usage: {} })).toBe(null);
    expect(tokensOf(null)).toBe(null);
  });

  test('half a reading is still a reading', () => {
    expect(tokensOf({ usage: { prompt_tokens: 400 } })).toEqual({ i: 400, o: 0 });
  });
});

/* ============================================================
   Reading the sentence, not just the names
   ------------------------------------------------------------
   The model reports what the note says is at stake; the code below
   decides what that is worth. These pin the direction of travel: the
   wording can lift a task, and can never sink one.
   ============================================================ */

/* The AI path, with the model's reading supplied as a fixture — the
   model itself is never called from a test. */
const read = (text, signals = {}, over = {}) =>
  classify({ ...fallbackExtract(text), ...signals, ...over },
    { today: TODAY, people: PEOPLE, lists: LISTS });

test.describe('what the wording is worth', () => {
  test('a note that stakes something is filed on that, with nobody named', () => {
    /* The complaint this answers: no name in the box, no urgency
       keyword, and the boiler still coming through the ceiling. */
    const out = read('the boiler is leaking through the kitchen ceiling',
      { consequence: 5, minutes: 60, timeCritical: true });
    expect(out.quadrant).toBe('do');
    expect(out.importance).toBe(5);
    expect(out.urgent).toBe(true);
    expect(out.personId).toBe(null);
  });

  test('the same note without the model is only Schedule', () => {
    // Which is exactly what it used to be, and why this exists.
    expect(read('the boiler is leaking through the kitchen ceiling').quadrant).toBe('plan');
  });

  test('an ordinary reading changes nothing at all', () => {
    /* 3 is the neutral answer, and the neutral answer must be inert —
       otherwise every task from a demoted person drifts upwards. */
    for (const c of [1, 2, 3]) {
      expect(read('dave wants me to look over the wiki sometime', { consequence: c }).quadrant).toBe('eliminate');
      expect(read('dave needs the deck by friday', { consequence: c }).quadrant).toBe('delegate');
    }
  });

  test('a weight is a floor under that person, not a ceiling on events', () => {
    /* Dave is weighted 2 because his ordinary asks are ordinary. The
       server being down is not an ordinary ask. */
    const ordinary = read('dave wants the deck looked over', { consequence: 3 });
    const outage   = read('dave says the production server is down', { consequence: 5, timeCritical: true });
    expect(ordinary.important).toBe(false);
    expect(outage.important).toBe(true);
    expect(outage.quadrant).toBe('do');
  });

  test('the model can promote but never demote', () => {
    /* Eliminate is a verdict. A sentence the model read as idle still
       gets its owner's weight — only the user's own words go below. */
    const idle = read('talk to aisha about the house', { consequence: 1 });
    expect(idle.importance).toBe(5);
    expect(idle.quadrant).toBe('plan');
    expect(read('talk to aisha about the house sometime', { consequence: 1 }).importance).toBe(4);
  });

  test('"no rush" still pulls back whatever the model thought', () => {
    const out = read('fix the shed roof sometime', { consequence: 5 });
    expect(out.importance).toBe(4);   // 3 + 2 promotion − 1 for the wording
  });

  test('wording that cannot wait is urgent without any date at all', () => {
    const out = read('catch the post office before it shuts', { consequence: 3, timeCritical: true });
    expect(out.urgent).toBe(true);
    expect(out.quadrant).toBe('do');
    expect(out.why.join(' · ')).toContain('cannot wait');
  });

  test('a model shouting 9 or -4 cannot invert the grid', () => {
    /* Clamping bounds how far a reading can move a task, not which way.
       Dave is 2 and "sometime" takes one off, so the loudest possible
       promotion still only reaches 3 — and the quietest reading cannot
       push below the floor of 1. A junk value is simply neutral. */
    expect(read('dave wants the wiki read sometime', { consequence: 99 }).importance).toBe(3);
    expect(read('dave wants the wiki read sometime', { consequence: -4 }).importance).toBe(1);
    expect(read('write the plan', { consequence: 'urgent!!' }).importance).toBe(3);
  });

  test('the promotion is stated in the receipt, not silent', () => {
    const why = read('the roof is coming in', { consequence: 5 }).why.join(' · ');
    expect(why).toContain('wording reads 5/5 at stake');
    expect(read('write the plan', { consequence: 3 }).why.join(' · ')).not.toContain('at stake');
  });
});

/* ============================================================
   Now, or later
   ------------------------------------------------------------
   `days` is what the client measured off its own timeline. What
   counts as room is policy, and it is all here.
   ============================================================ */

/* A fortnight of days from TODAY, every one of them wide open unless
   `over` says otherwise. */
const openDays = (over = {}) => Array.from({ length: 14 }, (_, i) => ({
  d: i === 0 ? TODAY : daysFrom(i),
  free: 600, habits: 0, due: 0,
  ...(over[i] || {}),
}));
const daysFrom = (n) => {
  const d = new Date(Date.parse(`${TODAY}T12:00:00Z`) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
};

const fileWithDays = (text, days, signals = {}) =>
  classify({ ...fallbackExtract(text), ...signals },
    { today: TODAY, people: PEOPLE, lists: LISTS, days });

test.describe('what a day has left', () => {
  test('habits and tasks already owed are charged against the free time', () => {
    expect(roomOn({ free: 300, habits: 0, due: 0 })).toBe(300);
    expect(roomOn({ free: 300, habits: 4, due: 0 })).toBe(240);   // 4 × 15
    expect(roomOn({ free: 300, habits: 0, due: 3 })).toBe(240);   // 3 × 20
    expect(roomOn({ free: 300, habits: 4, due: 3 })).toBe(180);
  });

  test('an over-committed day has no room, never negative room', () => {
    expect(roomOn({ free: 30, habits: 9, due: 9 })).toBe(0);
    expect(roomOn({})).toBe(0);
    expect(roomOn(null)).toBe(0);
  });

  test('the first day with room is the first one that actually fits', () => {
    const days = openDays({ 0: { free: 20 }, 1: { free: 45 }, 2: { free: 200 } });
    expect(firstDayWithRoom(days, 30)?.d).toBe(daysFrom(1));
    expect(firstDayWithRoom(days, 120)?.d).toBe(daysFrom(2));
    expect(firstDayWithRoom(days, 900)).toBe(null);
  });
});

test.describe('now, or later', () => {
  test('a day with room takes it today', () => {
    const out = fileWithDays('write the quarterly plan', openDays(), { minutes: 60 });
    expect(out.due).toBe(TODAY);
    expect(out.fit.when).toBe('today');
  });

  test('a full day pushes it to the first one that fits', () => {
    const days = openDays({ 0: { free: 15 }, 1: { free: 20 }, 2: { free: 240 } });
    const out = fileWithDays('write the quarterly plan', days, { minutes: 60 });
    expect(out.due).toBe(daysFrom(2));
    expect(out.fit.when).toBe('scheduled');
    expect(out.why.join(' · ')).toContain(`booked for ${daysFrom(2)}`);
  });

  test('a date you named yourself is never moved, however full the day', () => {
    /* The line that has to hold: scheduling is a suggestion, a stated
       deadline is a commitment. */
    const out = fileWithDays('deck by friday', openDays({ 4: { free: 0 } }), { minutes: 240 });
    expect(out.due).toBe(FRI);
    expect(out.fit.when).toBe('stated');
  });

  test('something that cannot wait lands today even with no room', () => {
    const out = fileWithDays('the boiler is pouring water through the ceiling',
      openDays({ 0: { free: 10 } }), { minutes: 90, consequence: 5, timeCritical: true });
    expect(out.due).toBe(TODAY);
    expect(out.fit.when).toBe('squeezed');
    expect(out.quadrant).toBe('do');
    expect(out.why.join(' · ')).toContain('doing it anyway');
  });

  test('"sometime" is left undated rather than booked in', () => {
    // Dating it would be putting words in the user's mouth.
    const out = fileWithDays('read the wiki sometime', openDays(), { minutes: 30 });
    expect(out.due).toBe(null);
    expect(out.fit.when).toBe('someday');
  });

  test('a fortnight with no room leaves it undated rather than guessing a day', () => {
    const days = openDays(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [i, { free: 10 }])));
    const out = fileWithDays('rebuild the deck', days, { minutes: 300 });
    expect(out.due).toBe(null);
    expect(out.fit.when).toBe('full');
    expect(out.why.join(' · ')).toContain('nothing free in the next fortnight');
  });

  test('a day the scheduler picked is not a deadline', () => {
    /* Urgency and the rescue from Eliminate both read the date the
       CAPTURE named. A gap in the calendar is not a commitment, and
       must not be read back as one. */
    const soon = fileWithDays('write the quarterly plan', openDays(), { minutes: 30 });
    expect(soon.due).toBe(TODAY);
    expect(soon.urgent).toBe(false);
    expect(soon.quadrant).toBe('plan');
  });

  test('nothing headed for Eliminate gets time booked for it', () => {
    /* Filing something under "cut this without guilt" and then putting
       it in this afternoon would be the parser arguing with itself. */
    const out = fileWithDays('dave wants the wiki read', openDays(), { minutes: 30 });
    expect(out.quadrant).toBe('eliminate');
    expect(out.due).toBe(null);
    expect(out.fit.when).toBe('someday');
  });

  test('...but a deadline you set yourself survives that verdict', () => {
    // Eliminate is about what to do with the task, not licence to
    // forget a date you stated.
    const out = fileWithDays('dave needs the audit numbers on 2026-09-30', openDays(), { minutes: 30 });
    expect(out.quadrant).toBe('delegate');
    expect(out.due).toBe('2026-09-30');
    expect(out.fit.when).toBe('stated');
  });

  test('a client that sends no calendar gets no scheduling', () => {
    /* An older client, or one with nothing measured yet. The endpoint
       behaves exactly as it did before. */
    for (const days of [undefined, [], [{ free: 500 }]]) {
      const out = classify({ ...fallbackExtract('write the plan'), minutes: 30 },
        { today: TODAY, people: PEOPLE, lists: LISTS, days });
      expect(out.due).toBe(null);
      expect(out.fit).toBe(null);
    }
  });

  test('how long the work looked is reported, clamped, and defaulted', () => {
    expect(fileWithDays('a', openDays(), { minutes: 45 }).minutes).toBe(45);
    expect(fileWithDays('a', openDays(), { minutes: 9000 }).minutes).toBe(480);
    expect(fileWithDays('a', openDays(), { minutes: 0 }).minutes).toBe(30);
    expect(fileWithDays('a', openDays()).minutes).toBe(30);
  });

  test('the receipt says it in minutes and hours, not raw numbers', () => {
    expect(fmtMins(45)).toBe('45m');
    expect(fmtMins(120)).toBe('2h');
    expect(fmtMins(90)).toBe('1h30');
    expect(fmtMins(0)).toBe('0m');
  });
});

test.describe('placement, directly', () => {
  /* place() is the whole now-or-later decision, and it is worth
     pinning without a classify() around it. */
  const days = openDays({ 0: { free: 60 }, 1: { free: 500 } });

  test('every outcome is reachable and says which one it took', () => {
    expect(place({ due: FRI, minutes: 30, days }).fit.when).toBe('stated');
    expect(place({ minutes: 30, noDate: true, days }).fit.when).toBe('someday');
    expect(place({ minutes: 30, days }).fit.when).toBe('today');
    expect(place({ minutes: 300, days }).fit.when).toBe('scheduled');
    expect(place({ minutes: 300, urgent: true, days }).fit.when).toBe('squeezed');
    expect(place({ minutes: 30, days: [] }).fit).toBe(null);
  });

  test('a malformed day is not a day with infinite room', () => {
    expect(place({ minutes: 30, days: [{ free: 999 }] }).fit).toBe(null);
    expect(firstDayWithRoom([{ free: 999 }], 30)).toBe(null);
  });
});
