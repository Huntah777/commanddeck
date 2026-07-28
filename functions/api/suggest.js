/* ============================================================
   Madinah · Command Deck — /api/suggest
   ------------------------------------------------------------
   POST /api/suggest { filedTasks, lists, people }
        → { keywords: [...], weights: [...] }

   What the system has learned from being overruled, offered back as
   one-tap changes to the rules it files by.

   No model, no binding, no cost — this is pure computation over
   corrections. It is an endpoint rather than browser code only so
   that the rules for what counts as a correction live in exactly one
   place (learn.js), shared with /api/parse and the coaching digest,
   instead of being reimplemented against the same data twice.

   Stateless like /api/parse: the caller sends the slice of its own
   state that matters, and nothing is stored.

   Bindings: env.SYNC_TOKEN (same token as /api/state)
   ============================================================ */

import { suggestKeywords, suggestWeights } from './learn.js';

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

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  /* Client-supplied data of arbitrary age and shape feeds straight into
     learn.js — an uncaught throw here would return a bare error page
     instead of JSON, same failure mode fixed in coach.js. */
  try {
    const tasks  = Array.isArray(body?.filedTasks) ? body.filedTasks.slice(0, 500) : [];
    const lists  = Array.isArray(body?.lists)  ? body.lists.slice(0, 50)   : [];
    const people = Array.isArray(body?.people) ? body.people.slice(0, 200) : [];

    return json({
      keywords: suggestKeywords(tasks, lists),
      weights:  suggestWeights(tasks, people),
    });
  } catch (err) {
    console.error('suggest handler error:', err);
    return json({ error: 'internal_error', detail: String(err?.message || err).slice(0, 200) }, 500);
  }
}
