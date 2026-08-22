import { test, expect } from '@playwright/test';
import { onRequest } from '../functions/api/state.js';

/* Who is allowed to do what at /api/state.

   One token, SYNC_TOKEN, and it both reads and writes. This app has no
   per-user accounts — a handful of personal devices share one token and
   one state row — so the whole of authentication is: does the bearer
   match, in constant time. */

const RW = 'sync-token-abc';

/* A D1 stand-in holding one row. Enough for the auth paths — the merge
   itself has its own tests. */
const fakeDB = (state = { habits: [] }, updatedAt = 7) => {
  const store = { data: JSON.stringify(state), updated_at: updatedAt, writes: 0 };
  return {
    store,
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        first: async () => (sql.includes('SELECT') ? { data: store.data, updated_at: store.updated_at } : null),
        run: async () => {
          store.writes++;
          store.data = this.args?.[0] ?? store.data;
          store.updated_at = this.args?.[1] ?? store.updated_at;
          return { meta: { changes: 1 } };
        },
      };
    },
  };
};

const call = (method, token, { env = {}, body = null, headers = {} } = {}) => {
  const db = env.DB || fakeDB();
  const h = new Headers(headers);
  if (token) h.set('Authorization', `Bearer ${token}`);
  const request = new Request('https://example.test/api/state', {
    method, headers: h,
    body: body == null ? undefined : JSON.stringify(body),
  });
  return onRequest({ request, env: { DB: db, SYNC_TOKEN: RW, ...env } })
    .then(res => ({ res, db }));
};

test.describe('the sync token', () => {
  test('reads', async () => {
    const { res } = await call('GET', RW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ habits: [] });
  });

  test('writes', async () => {
    const { res, db } = await call('PUT', RW, { body: { habits: [] } });
    expect(res.status).toBe(200);
    expect(db.store.writes).toBe(1);
  });
});

test.describe('what is refused', () => {
  test('no token at all', async () => {
    expect((await call('GET', null)).res.status).toBe(401);
  });

  test('a wrong token', async () => {
    expect((await call('GET', 'not-the-token')).res.status).toBe(401);
  });

  test('an empty bearer cannot match an unset SYNC_TOKEN', async () => {
    /* The dangerous shape of a secret read from config: unset on the
       server, absent on the request, and the two compare equal. */
    const { res } = await call('GET', '', { env: { SYNC_TOKEN: undefined } });
    expect(res.status).toBe(401);
  });

  test('a method the endpoint does not serve', async () => {
    expect((await call('DELETE', RW)).res.status).toBe(405);
  });
});

test.describe('the cheap refresh', () => {
  test('an unchanged read costs a 304, not the whole blob', async () => {
    /* Every device polls this endpoint on a timer. A poll that finds
       nothing new should cost as close to nothing as possible. */
    const { res } = await call('GET', RW);
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();

    const again = await call('GET', RW, { headers: { 'If-None-Match': etag } });
    expect(again.res.status).toBe(304);
    expect(await again.res.text()).toBe('');
  });
});
