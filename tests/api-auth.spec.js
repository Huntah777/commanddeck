import { test, expect } from '@playwright/test';
import { onRequest } from '../functions/api/state.js';

/* Who is allowed to do what at /api/state.

   There are two tokens now. SYNC_TOKEN is the app's, and reads and
   writes. READ_TOKEN is for readers that are not the app — the iOS home
   screen widget above all — and can only ever GET.

   The reason is blunt: a widget has to keep its token on the phone, in a
   third-party scripting app. With one token that also writes, a leak
   costs every habit, task and log in a single PUT. With this split it
   costs disclosure and nothing else. */

const RW = 'sync-token-abc';
const RO = 'read-token-xyz';

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
  return onRequest({ request, env: { DB: db, SYNC_TOKEN: RW, READ_TOKEN: RO, ...env } })
    .then(res => ({ res, db }));
};

test.describe('the read-only token', () => {
  test('reads', async () => {
    const { res } = await call('GET', RO);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ habits: [] });
  });

  test('cannot write, and is told so rather than asked to log in again', async () => {
    /* 403, not 401 — the credential is real, it just isn't allowed to do
       this, and a client that retries with fresh ones is wasting its
       time. */
    const { res, db } = await call('PUT', RO, { body: { habits: [{ id: 'h1' }] } });
    expect(res.status).toBe(403);
    expect(db.store.writes).toBe(0);
  });

  test('the app’s own token still does both', async () => {
    expect((await call('GET', RW)).res.status).toBe(200);
    const { res, db } = await call('PUT', RW, { body: { habits: [] } });
    expect(res.status).toBe(200);
    expect(db.store.writes).toBe(1);
  });
});

test.describe('what is still refused', () => {
  test('no token at all', async () => {
    expect((await call('GET', null)).res.status).toBe(401);
  });

  test('a wrong token', async () => {
    expect((await call('GET', 'not-either-of-them')).res.status).toBe(401);
  });

  test('an empty bearer cannot match an unset READ_TOKEN', async () => {
    /* The dangerous shape of an optional secret: unset on the server,
       absent on the request, and the two compare equal. */
    const { res } = await call('GET', '', { env: { READ_TOKEN: undefined } });
    expect(res.status).toBe(401);
  });

  test('with READ_TOKEN unset, the old token is unaffected', async () => {
    const { res } = await call('GET', RW, { env: { READ_TOKEN: undefined } });
    expect(res.status).toBe(200);
  });

  test('a read token is not accepted as a write token by a stray method', async () => {
    const { res } = await call('DELETE', RO);
    expect(res.status).toBe(405);
  });
});

test.describe('the widget’s cheap refresh', () => {
  test('an unchanged read costs a 304, not the whole blob', async () => {
    /* The widget wakes on iOS’s schedule, not ours. Every wake that
       finds nothing new should cost as close to nothing as possible. */
    const { res } = await call('GET', RO);
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();

    const again = await call('GET', RO, { headers: { 'If-None-Match': etag } });
    expect(again.res.status).toBe(304);
    expect(await again.res.text()).toBe('');
  });
});
