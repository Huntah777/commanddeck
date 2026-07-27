import { test, expect } from '@playwright/test';
import { mergeState } from '../functions/api/state.js';

/* Unit tests for the server-side merge — the most safety-critical code in the
   app, since every multi-device write goes through it and a mistake here is
   silent data loss. No browser needed. */

const NOW = 1_800_000_000_000; // fixed "now" so tests read deterministically
const ago = (ms) => NOW - ms;

test.describe('mergeState — habit logs', () => {
  test('un-checking a habit sticks instead of being resurrected by the merge', () => {
    // Device checked h1 earlier, then un-checked it. The PUT body carries the
    // un-check; the merged result must not put it back.
    const existing = { logs: { '2026-07-25': { h1: ago(60_000) } } };
    const incoming = { logs: { '2026-07-25': {} }, logsOff: { '2026-07-25': { h1: NOW } } };

    const merged = mergeState(existing, incoming);
    expect(merged.logs['2026-07-25']?.h1).toBeFalsy();
  });

  test('re-checking after an un-check wins again', () => {
    const existing = { logs: {}, logsOff: { '2026-07-25': { h1: ago(60_000) } } };
    const incoming = { logs: { '2026-07-25': { h1: NOW } } };

    const merged = mergeState(existing, incoming);
    expect(merged.logs['2026-07-25'].h1).toBeTruthy();
  });

  test('a stale device cannot resurrect a newer un-check', () => {
    // Device B still believes h1 is done (checked long ago) and pushes that.
    // Device A un-checked it a moment ago. Newest intent wins.
    const existing = { logs: {}, logsOff: { '2026-07-25': { h1: ago(1_000) } } };
    const incoming = { logs: { '2026-07-25': { h1: ago(86_400_000) } } };

    const merged = mergeState(existing, incoming);
    expect(merged.logs['2026-07-25']?.h1).toBeFalsy();
  });

  test('legacy `true` log entries still read as done', () => {
    const existing = { logs: { '2026-07-20': { h1: true } } };
    const merged = mergeState(existing, { logs: {} });
    expect(merged.logs['2026-07-20'].h1).toBeTruthy();
  });

  test('a legacy `true` never outranks a real un-check', () => {
    const existing = { logs: { '2026-07-20': { h1: true } } };
    const incoming = { logs: {}, logsOff: { '2026-07-20': { h1: NOW } } };
    const merged = mergeState(existing, incoming);
    expect(merged.logs['2026-07-20']?.h1).toBeFalsy();
  });

  test('independent devices ticking different habits both survive', () => {
    const existing = { logs: { '2026-07-25': { h1: ago(5_000) } } };
    const incoming = { logs: { '2026-07-25': { h2: NOW } } };
    const merged = mergeState(existing, incoming);
    expect(merged.logs['2026-07-25'].h1).toBeTruthy();
    expect(merged.logs['2026-07-25'].h2).toBeTruthy();
  });
});

test.describe('mergeState — deletes', () => {
  test('a deleted item stays deleted', () => {
    const existing = { tasks: [{ id: 't1', title: 'Old', modifiedAt: ago(10_000) }] };
    const incoming = { tasks: [], deleted: { t1: NOW } };
    const merged = mergeState(existing, incoming);
    expect(merged.tasks.find(t => t.id === 't1')).toBeUndefined();
  });

  test('an item merely absent from a stale push is NOT deleted', () => {
    // The core hazard of inferring deletes from omission: a device that never
    // saw t2 pushes without it. That must not delete another device's work.
    const existing = { tasks: [{ id: 't2', title: 'Made elsewhere', modifiedAt: ago(10_000) }] };
    const incoming = { tasks: [{ id: 't1', title: 'Mine', modifiedAt: NOW }] };
    const merged = mergeState(existing, incoming);
    expect(merged.tasks.map(t => t.id).sort()).toEqual(['t1', 't2']);
  });

  test('an edit newer than the delete wins (undelete by concurrent edit)', () => {
    const existing = { tasks: [], deleted: { t1: ago(10_000) } };
    const incoming = { tasks: [{ id: 't1', title: 'Still wanted', modifiedAt: NOW }] };
    const merged = mergeState(existing, incoming);
    expect(merged.tasks.find(t => t.id === 't1')).toBeDefined();
  });

  test('a delete newer than a concurrent edit wins', () => {
    const existing = { tasks: [{ id: 't1', title: 'Edited', modifiedAt: ago(10_000) }] };
    const incoming = { tasks: [], deleted: { t1: NOW } };
    const merged = mergeState(existing, incoming);
    expect(merged.tasks.find(t => t.id === 't1')).toBeUndefined();
  });

  test('tombstones survive the round-trip so other devices learn the delete', () => {
    const merged = mergeState({ tasks: [] }, { tasks: [], deleted: { t1: NOW } });
    expect(merged.deleted.t1).toBe(NOW);
  });

  test('ancient tombstones are garbage-collected', () => {
    const old = Date.now() - 200 * 86_400_000;
    const merged = mergeState({ deleted: { t1: old } }, {});
    expect(merged.deleted.t1).toBeUndefined();
  });
});

test.describe('mergeState — collections and settings', () => {
  test('newer modifiedAt wins for the same id', () => {
    const existing = { habits: [{ id: 'h1', name: 'Old', modifiedAt: ago(10_000) }] };
    const incoming = { habits: [{ id: 'h1', name: 'New', modifiedAt: NOW }] };
    expect(mergeState(existing, incoming).habits[0].name).toBe('New');
  });

  test('an older push does not clobber a newer stored edit', () => {
    const existing = { habits: [{ id: 'h1', name: 'Newer', modifiedAt: NOW }] };
    const incoming = { habits: [{ id: 'h1', name: 'Older', modifiedAt: ago(10_000) }] };
    expect(mergeState(existing, incoming).habits[0].name).toBe('Newer');
  });

  test('a partial ui push cannot wipe unrelated settings', () => {
    const existing = { ui: { salahLoc: { lat: 1, lon: 2 }, notif: true } };
    const incoming = { ui: { timezone: 'Europe/London' } };
    const merged = mergeState(existing, incoming);
    expect(merged.ui.salahLoc).toEqual({ lat: 1, lon: 2 });
    expect(merged.ui.notif).toBe(true);
    expect(merged.ui.timezone).toBe('Europe/London');
  });

  test('pomodoroLogs union never loses a session from either side', () => {
    const merged = mergeState(
      { pomodoroLogs: [{ id: 'p1' }] },
      { pomodoroLogs: [{ id: 'p2' }] },
    );
    expect(merged.pomodoroLogs.map(p => p.id).sort()).toEqual(['p1', 'p2']);
  });

  test('merging is idempotent — replaying the same PUT changes nothing', () => {
    const existing = {
      habits: [{ id: 'h1', name: 'A', modifiedAt: ago(10_000) }],
      logs: { '2026-07-25': { h1: ago(5_000) } },
      deleted: { t9: ago(1_000) },
    };
    const incoming = {
      habits: [{ id: 'h1', name: 'A', modifiedAt: ago(10_000) }],
      logs: { '2026-07-25': { h1: ago(5_000) } },
      deleted: { t9: ago(1_000) },
    };
    const once  = mergeState(existing, incoming);
    const twice = mergeState(once, incoming);
    expect(twice).toEqual(once);
  });
});

test.describe('mergeState — people', () => {
  /* The people table drives task priority, so it has to survive a
     round-trip like any other collection — a device that hasn't heard
     about someone yet must not be able to delete them, and a weight
     changed on a phone must reach the laptop. */

  test('a person added on one device survives a push from another', () => {
    const existing = { people: [{ id: 'pp-1', name: 'Aisha', weight: 5, modifiedAt: ago(10_000) }] };
    const incoming = { people: [{ id: 'pp-2', name: 'Dave',  weight: 2, modifiedAt: NOW }] };
    const merged = mergeState(existing, incoming);
    expect(merged.people.map(p => p.id).sort()).toEqual(['pp-1', 'pp-2']);
  });

  test('the newer weight wins', () => {
    const existing = { people: [{ id: 'pp-1', name: 'Dave', weight: 2, modifiedAt: ago(60_000) }] };
    const incoming = { people: [{ id: 'pp-1', name: 'Dave', weight: 4, modifiedAt: NOW }] };
    expect(mergeState(existing, incoming).people[0].weight).toBe(4);
  });

  test('a stale device cannot revert a weight it never saw change', () => {
    const existing = { people: [{ id: 'pp-1', name: 'Dave', weight: 4, modifiedAt: NOW }] };
    const incoming = { people: [{ id: 'pp-1', name: 'Dave', weight: 2, modifiedAt: ago(86_400_000) }] };
    expect(mergeState(existing, incoming).people[0].weight).toBe(4);
  });

  test('deleting a person needs a tombstone, not an omission', () => {
    const existing = { people: [{ id: 'pp-1', name: 'Dave', weight: 2, modifiedAt: ago(10_000) }] };
    // Omission alone means "not heard about it" — the person stays.
    expect(mergeState(existing, { people: [] }).people).toHaveLength(1);
    // With a tombstone the delete actually lands.
    expect(mergeState(existing, { people: [], deleted: { 'pp-1': NOW } }).people).toHaveLength(0);
  });
});
