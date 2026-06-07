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

const tokenOk = (request, env) => {
  const header = request.headers.get('Authorization') || '';
  const given  = header.replace(/^Bearer\s+/i, '').trim();
  const expect = env.SYNC_TOKEN || '';
  if (!given || !expect || given.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
};

export async function onRequest({ request, env }) {
  if (!tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);

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
    return json({ error: String(err?.message || err) }, 500);
  }
}
