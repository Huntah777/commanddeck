import { test, expect } from '@playwright/test';
import { onRequest } from '../functions/api/suggest.js';

/* /api/suggest is pure computation over client-supplied data (see
   learn.spec.js for the rules themselves) — but "pure" doesn't mean
   "can't throw": arbitrary-shaped tasks from a client of unknown age
   feed straight into it. Same class of bug as coach.js: an uncaught
   throw returns a bare error page instead of JSON, and the caller
   can't tell a real failure from a dead network. */

const request = (body, token = 'test-token') => new Request('https://x/api/suggest', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const env = { SYNC_TOKEN: 'test-token' };

test.describe('the handler itself never throws', () => {
  test('a well-formed request succeeds', async () => {
    const res = await onRequest({ request: request({ filedTasks: [], lists: [], people: [] }), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ keywords: [], weights: [] });
  });

  test('a null in filedTasks, lists or people is tolerated, not just caught', async () => {
    // Every field this reads comes straight from the client's own synced
    // state, of unknown age and shape. A null used to reach l.keywords
    // (and, separately, p.id) unguarded and throw — silently swallowing
    // that into a 500 would leave suggestions permanently broken for
    // this account rather than actually degrading gracefully.
    const res = await onRequest({
      request: request({
        filedTasks: [
          { id: 't1', quadrant: 'do', listId: 'l1', ai: { quadrant: 'delegate', listId: 'l2', raw: 'x' } },
          null,
          { title: 123 },
        ],
        lists: [{ id: 'l1' }, null],
        people: 'not-an-array',
      }),
      env,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keywords)).toBe(true);
    expect(Array.isArray(body.weights)).toBe(true);
  });

  test('a missing body comes back as a clean 400, not a crash', async () => {
    const req = new Request('https://x/api/suggest', {
      method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: 'not json',
    });
    const res = await onRequest({ request: req, env });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  test('an unauthenticated request is rejected before any computation', async () => {
    const res = await onRequest({ request: request({}, 'wrong-token'), env });
    expect(res.status).toBe(401);
  });
});
