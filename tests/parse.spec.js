import { test, expect } from '@playwright/test';
import { classify, resolveDue, matchPerson, matchList, markers, fallbackExtract, daysBetween } from '../functions/api/parse.js';

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
    expect(file('renew the car insurance tomorrow').quadrant).toBe('do');
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
