import { test, expect } from '@playwright/test';
import { onRequest } from '../functions/api/push.js';

/* GET /api/push — the server's own view of a device's registration.

   It exists because background push fails silently: the browser goes on
   reporting a healthy subscription object long after the row behind it
   is gone, and from inside the app "delivering fine" and "dead for three
   weeks" are both just an absence of notifications. This is the half the
   client cannot see, so it has to be exactly right about the difference
   between "no row", "a row" and "couldn't ask". */

const TOKEN = 'test-token';

/* A fake D1 that records what it was asked and answers with one row. */
function fakeD1(row) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const c = { sql, args: null };
      calls.push(c);
      return {
        bind: (...args) => { c.args = args; return { first: async () => row, run: async () => ({ meta: { changes: 1 } }) }; },
        first: async () => row,
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
}

const get = (id, { token = TOKEN, row = null, db } = {}) => onRequest({
  request: new Request(`https://x/api/push${id === undefined ? '' : `?id=${encodeURIComponent(id)}`}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }),
  env: { SYNC_TOKEN: TOKEN, DB: db || fakeD1(row) },
});

const body = async (res) => JSON.parse(await res.text());

test.describe('reading a registration back', () => {
  test('a device the server has never seen is an answer, not an error', async () => {
    /* This is the case the reconnect flow acts on, so it has to arrive as
       data. A 404 would be indistinguishable from the endpoint being
       missing on an older deployment. */
    const res = await get('abc123');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ registered: false });
  });

  test('a live registration reports what is actually planned', async () => {
    const now = Date.now();
    const res = await get('abc123', {
      row: {
        schedule: JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
        sent: JSON.stringify(['a']),
        plan_day: '2026-07-29',
        next_fire_at: now + 60_000,
        updated_at: now,
      },
    });
    expect(await body(res)).toEqual({
      registered: true,
      updatedAt: now,
      nextFireAt: now + 60_000,
      planDay: '2026-07-29',
      scheduled: 3,
      delivered: 1,
    });
  });

  test('it looks up the id it was given', async () => {
    const db = fakeD1(null);
    await get('deadbeef', { db });
    expect(db.calls[0].args).toEqual(['deadbeef']);
    expect(db.calls[0].sql).toContain('FROM push_subs WHERE id = ?');
  });

  test('a corrupt row degrades to zero counts rather than a 500', async () => {
    /* The columns are JSON text written by two different processes. A
       diagnostic endpoint that itself falls over is worse than useless —
       it reads as "the server is down" when the server is fine. */
    const res = await get('abc123', {
      row: { schedule: 'not json', sent: '{"not":"an array"}', plan_day: '', next_fire_at: null, updated_at: null },
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ registered: true, scheduled: 0, delivered: 0, planDay: null, updatedAt: 0 });
  });

  test('no id is a bad request, not a scan of every device', async () => {
    const res = await get(undefined);
    expect(res.status).toBe(400);
  });

  test('it is behind the same token as everything else', async () => {
    // The row names a push endpoint; anything that can read it can work
    // out which devices exist.
    const res = await get('abc123', { token: null });
    expect(res.status).toBe(401);
    const wrong = await get('abc123', { token: 'not-the-token' });
    expect(wrong.status).toBe(401);
  });

  test('a database that throws is reported, not swallowed into a false answer', async () => {
    const db = { prepare() { throw new Error('D1_DOWN'); } };
    const res = await get('abc123', { db });
    expect(res.status).toBe(500);
    // Specifically NOT { registered: false } — that would trigger a
    // pointless re-registration every time the database hiccups.
    expect(await body(res)).not.toMatchObject({ registered: false });
  });
});
