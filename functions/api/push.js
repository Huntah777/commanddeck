/* ============================================================
   Madinah · Command Deck — /api/push
   ------------------------------------------------------------
   GET    /api/push?id=…  → what the server actually holds for this device
   POST   /api/push       → upsert push subscription + notification schedule
   DELETE /api/push       → remove subscription (unsubscribe)

   Same auth as /api/state: Authorization: Bearer <SYNC_TOKEN>

   ── Why GET exists ────────────────────────────────────────────
   Background push fails silently by nature. The browser keeps
   reporting a healthy-looking subscription object long after the row
   backing it has gone — cleaned up as stale, dropped on a 404/410,
   lost with a restored database — and the app has no way to tell the
   difference between "delivering fine" and "dead for three weeks",
   because both look like no notifications arriving.

   So the client can't self-diagnose from what the browser tells it.
   This returns the server's own view instead, which is the half it
   cannot see: whether the row exists at all, when it was last
   confirmed working, and how much of today's plan is still pending.
   ============================================================ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
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
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);

  try {
    if (request.method === 'GET') {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return json({ error: 'Missing id' }, 400);

      const row = await env.DB.prepare(
        'SELECT schedule, sent, plan_day, next_fire_at, updated_at FROM push_subs WHERE id = ?'
      ).bind(id).first();

      /* Not an error — "the server has never heard of this device" is a
         perfectly good answer, and the one the reconnect flow acts on. */
      if (!row) return json({ registered: false });

      const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
      const schedule = parse(row.schedule);
      const sent     = parse(row.sent);

      return json({
        registered: true,
        updatedAt:  row.updated_at ?? 0,
        nextFireAt: row.next_fire_at ?? 0,
        planDay:    row.plan_day || null,
        scheduled:  schedule.length,
        delivered:  sent.length,
      });
    }

    if (request.method === 'POST') {
      const { id, subscription, schedule } = await request.json();
      if (!id || !subscription) return json({ error: 'Missing id or subscription' }, 400);

      const now        = Date.now();
      const upcoming   = (schedule || []).map(n => n.fireAt).filter(t => t > now);
      const nextFireAt = upcoming.length ? Math.min(...upcoming) : 0;

      /* `sent` and `plan_day` are deliberately absent from the UPDATE list:
         they are the Cron Worker's delivery ledger. The client re-registers on
         every app open, and clearing the ledger there would re-send every
         notification already delivered today. The posted schedule is only a
         bootstrap for a brand-new device — the Worker replaces it with the
         server-derived plan on its next tick. */
      await env.DB.prepare(
        `INSERT INTO push_subs (id, subscription, schedule, next_fire_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE
           SET subscription = excluded.subscription,
               schedule     = excluded.schedule,
               next_fire_at = excluded.next_fire_at,
               updated_at   = excluded.updated_at`,
      ).bind(id, JSON.stringify(subscription), JSON.stringify(schedule || []), nextFireAt, now).run();

      return json({ ok: true });
    }

    if (request.method === 'DELETE') {
      const { id } = await request.json();
      if (id) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('push handler error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
