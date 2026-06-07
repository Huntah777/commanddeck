/* ============================================================
   Madinah · Command Deck — /api/push
   ------------------------------------------------------------
   POST /api/push  → upsert push subscription + notification schedule
   DELETE /api/push → remove subscription (unsubscribe)

   Same auth as /api/state: Authorization: Bearer <SYNC_TOKEN>
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
    if (request.method === 'POST') {
      const { id, subscription, schedule } = await request.json();
      if (!id || !subscription) return json({ error: 'Missing id or subscription' }, 400);

      const now        = Date.now();
      const upcoming   = (schedule || []).map(n => n.fireAt).filter(t => t > now);
      const nextFireAt = upcoming.length ? Math.min(...upcoming) : 0;

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
