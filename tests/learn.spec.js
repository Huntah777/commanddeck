import { test, expect } from '@playwright/test';
import { corrections, correctionSummary, suggestKeywords, suggestWeights, learningExamples, aiSnapshot } from '../functions/api/learn.js';

/* Learning from being overruled. Every assertion here is about a fact —
   "the parser said Inbox, the task is in Life" — never an inference about
   why. The suggestions built on those facts become deterministic policy
   the user can see and edit, which is the whole point of doing it this
   way rather than letting a model quietly drift. */

const LISTS = [
  { id: 'l-inbox', name: 'Inbox', keywords: [] },
  { id: 'l-work',  name: 'Work',  keywords: ['meeting'] },
  { id: 'l-life',  name: 'Life',  keywords: [] },
];
const PEOPLE = [
  { id: 'pp-mgr',  name: 'Dave',  weight: 2 },
  { id: 'pp-wife', name: 'Aisha', weight: 5 },
];

/* A task as the parser filed it, then as the user left it. */
const filed = (over = {}) => ({
  id: 't1', title: 'Book the dentist', due: null, listId: 'l-inbox',
  personId: null, quadrant: 'plan', modifiedAt: 1_000,
  ai: { raw: 'book the dentist', title: 'Book the dentist', due: null, listId: 'l-inbox', personId: null, quadrant: 'plan' },
  ...over,
});

test.describe('what counts as a correction', () => {
  test('an untouched task is not a correction', () => {
    expect(corrections([filed()])).toHaveLength(0);
  });

  test('a re-filed quadrant, a moved list and a rewritten title all count', () => {
    const out = corrections([
      filed({ id: 't1', quadrant: 'do' }),
      filed({ id: 't2', listId: 'l-life' }),
      filed({ id: 't3', title: 'Ring the dentist about the crown' }),
    ]);
    expect(out.map(c => c.field).sort()).toEqual(['list', 'quadrant', 'title']);
  });

  test('a changed due date counts, including one the user cleared', () => {
    const withDate = { ...filed().ai, due: '2026-08-01' };
    expect(corrections([filed({ ai: withDate, due: '2026-08-05' })])[0]).toMatchObject({ field: 'due', from: '2026-08-01', to: '2026-08-05' });
    expect(corrections([filed({ ai: withDate, due: null })])[0]).toMatchObject({ field: 'due', to: null });
  });

  test('a field the parser never set is not a disagreement', () => {
    // Adding a due date the parser never claimed is the user filling a
    // gap, not overruling a decision.
    const noDue = { raw: 'x', title: 'Book the dentist', quadrant: 'plan' };
    expect(corrections([filed({ ai: noDue, due: '2026-08-05' })])).toHaveLength(0);
  });

  test('a task the parser never touched is ignored entirely', () => {
    expect(corrections([{ id: 't9', title: 'Typed by hand', quadrant: 'do' }])).toHaveLength(0);
  });

  test('tasks filed before the full snapshot existed still yield quadrant corrections', () => {
    // Back-compat: older tasks carry only aiQuadrant.
    const legacy = { id: 't1', title: 'x', quadrant: 'do', aiQuadrant: 'delegate' };
    expect(aiSnapshot(legacy)).toMatchObject({ quadrant: 'delegate' });
    expect(corrections([legacy])[0]).toMatchObject({ field: 'quadrant', from: 'delegate', to: 'do' });
  });
});

test.describe('correction summary for the coach', () => {
  test('counts how often filing was overruled, and out of which quadrants', () => {
    const s = correctionSummary([
      filed({ id: 't1', quadrant: 'plan' }),                       // untouched
      filed({ id: 't2', quadrant: 'do' }),
      filed({ id: 't3', quadrant: 'do' }),
      filed({ id: 't4', listId: 'l-life' }),
    ]);
    expect(s.filed).toBe(4);
    expect(s.corrected).toBe(3);
    expect(s.byField).toMatchObject({ quadrant: 2, list: 1 });
    expect(s.movedOutOf).toMatchObject({ plan: 2 });
  });

  test('a task corrected in two fields counts once as corrected', () => {
    const s = correctionSummary([filed({ quadrant: 'do', listId: 'l-life' })]);
    expect(s.corrected).toBe(1);
    expect(s.byField).toMatchObject({ quadrant: 1, list: 1 });
  });
});

test.describe('keyword suggestions', () => {
  const movedToLife = (id, title) => filed({ id, title, listId: 'l-life', ai: { raw: title.toLowerCase(), title, listId: 'l-inbox', quadrant: 'plan' } });

  test('a word that repeatedly lands in a list is offered as a routing rule', () => {
    const out = suggestKeywords([
      movedToLife('t1', 'Book dentist appointment'),
      movedToLife('t2', 'Dentist follow up'),
    ], LISTS);
    expect(out.find(s => s.keyword === 'dentist')).toMatchObject({ listId: 'l-life', count: 2 });
  });

  test('one move is a one-off, not a pattern', () => {
    const out = suggestKeywords([movedToLife('t1', 'Book dentist appointment')], LISTS);
    expect(out).toHaveLength(0);
  });

  test('a word already routing somewhere is never re-suggested', () => {
    const out = suggestKeywords([
      movedToLife('t1', 'Prep the meeting notes'),
      movedToLife('t2', 'Meeting with the school'),
    ], LISTS);
    expect(out.find(s => s.keyword === 'meeting')).toBeUndefined();
  });

  test('a word pulling towards two different lists is dropped as ambiguous', () => {
    const movedTo = (id, list, title) => filed({ id, title, listId: list, ai: { raw: title, title, listId: 'l-inbox', quadrant: 'plan' } });
    const out = suggestKeywords([
      movedTo('t1', 'l-life', 'Review the plan'), movedTo('t2', 'l-life', 'Review the budget'),
      movedTo('t3', 'l-work', 'Review the deck'), movedTo('t4', 'l-work', 'Review the specs'),
    ], LISTS);
    expect(out.find(s => s.keyword === 'review')).toBeUndefined();
  });

  test('filler words are never suggested', () => {
    const out = suggestKeywords([
      movedToLife('t1', 'Do the thing with the stuff'),
      movedToLife('t2', 'Do the other thing with the stuff'),
    ], LISTS);
    expect(out.map(s => s.keyword)).not.toContain('the');
    expect(out.map(s => s.keyword)).not.toContain('with');
  });

  test('suggestions carry the evidence that produced them', () => {
    const out = suggestKeywords([
      movedToLife('t1', 'Book dentist appointment'),
      movedToLife('t2', 'Dentist follow up'),
    ], LISTS);
    expect(out.find(s => s.keyword === 'dentist').titles).toContain('Book dentist appointment');
  });
});

test.describe('weight suggestions', () => {
  /* Person weight drives the importance axis, so only a re-file that
     crosses that line says anything about the person. */
  const forPerson = (id, personId, from, to) => filed({
    id, personId, quadrant: to,
    ai: { raw: 'x', title: 'x', quadrant: from, listId: 'l-inbox', personId },
  });

  test('repeatedly promoting someone\'s tasks suggests raising their weight', () => {
    const out = suggestWeights([
      forPerson('t1', 'pp-mgr', 'delegate', 'do'),
      forPerson('t2', 'pp-mgr', 'eliminate', 'plan'),
    ], PEOPLE);
    expect(out[0]).toMatchObject({ personId: 'pp-mgr', from: 2, to: 3, direction: 'up' });
  });

  test('repeatedly demoting someone suggests lowering it', () => {
    const out = suggestWeights([
      forPerson('t1', 'pp-wife', 'do', 'delegate'),
      forPerson('t2', 'pp-wife', 'plan', 'eliminate'),
    ], PEOPLE);
    expect(out[0]).toMatchObject({ personId: 'pp-wife', from: 5, to: 4, direction: 'down' });
  });

  test('a move within the same side of the line says nothing about the person', () => {
    // do → plan is a change of urgency, not importance.
    const out = suggestWeights([
      forPerson('t1', 'pp-mgr', 'do', 'plan'),
      forPerson('t2', 'pp-mgr', 'plan', 'do'),
    ], PEOPLE);
    expect(out).toHaveLength(0);
  });

  test('contradictory moves cancel rather than compound', () => {
    const out = suggestWeights([
      forPerson('t1', 'pp-mgr', 'delegate', 'do'),
      forPerson('t2', 'pp-mgr', 'do', 'delegate'),
    ], PEOPLE);
    expect(out).toHaveLength(0);
  });

  test('one move is not enough to change a weight', () => {
    expect(suggestWeights([forPerson('t1', 'pp-mgr', 'delegate', 'do')], PEOPLE)).toHaveLength(0);
  });

  test('a weight already at the ceiling is not suggested again', () => {
    const maxed = [{ id: 'pp-x', name: 'Max', weight: 5 }];
    const out = suggestWeights([
      forPerson('t1', 'pp-x', 'delegate', 'do'),
      forPerson('t2', 'pp-x', 'eliminate', 'plan'),
    ], maxed);
    expect(out).toHaveLength(0);
  });
});

test.describe('few-shot examples for the parser', () => {
  test('a corrected capture becomes an input → corrected-output pair', () => {
    const t = filed({ title: 'Ring the dentist', listId: 'l-life', due: '2026-08-01',
      ai: { raw: 'need to sort the dentist thing', title: 'Sort the dentist thing', listId: 'l-inbox', due: null, quadrant: 'plan' } });
    const [ex] = learningExamples([t], LISTS);
    expect(ex.input).toBe('need to sort the dentist thing');
    expect(ex.corrected).toMatchObject({ title: 'Ring the dentist', list: 'Life', due: '2026-08-01' });
    expect(ex.changed.sort()).toEqual(['due', 'list', 'title']);
  });

  test('a capture whose original text was not kept is unusable and skipped', () => {
    // Without the raw input there is no pair to learn from.
    const t = filed({ quadrant: 'do', ai: { title: 'x', quadrant: 'plan' } });
    expect(learningExamples([t], LISTS)).toHaveLength(0);
  });

  test('the newest corrections win, and the count is capped', () => {
    const mk = (id, at) => filed({ id, modifiedAt: at, title: `Title ${id}`,
      ai: { raw: `raw ${id}`, title: 'Other', listId: 'l-inbox', quadrant: 'plan' } });
    const out = learningExamples([mk('a', 1), mk('b', 2), mk('c', 3), mk('d', 4)], LISTS, 2);
    expect(out).toHaveLength(2);
    expect(out.map(e => e.input)).toEqual(['raw d', 'raw c']);
  });

  test('uncorrected captures are never used as examples', () => {
    expect(learningExamples([filed()], LISTS)).toHaveLength(0);
  });
});
