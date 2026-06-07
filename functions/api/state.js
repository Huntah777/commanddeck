/* ============================================================
   Madinah · Command Deck — /api/state
   ------------------------------------------------------------
   Cloudflare Pages Function. Lives at:
     <project-root>/functions/api/state.js
   and is auto-routed to /api/state by Cloudflare Pages.

   Bindings (configured in Pages → Settings):
     env.DB           D1 database binding (binding name: DB)
     env.SYNC_TOKEN   secret (environment variable, encrypted)

   Endpoints:
     GET  /api/state   → returns the stored state JSON (or {} on first run)
     PUT  /api/state   → replaces the stored state JSON

   All requests require:
     Authorization: Bearer <SYNC_TOKEN>
   ============================================================ */

const MAX_BODY = 1_048_576; // 1 MB

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/* Constant-time token comparison via HMAC.
   HMAC output is always 32 bytes regardless of input length, so the
   final XOR loop never leaks the expected token's length via timing. */
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
      const row = await env.DB.prepare(
        'SELECT data FROM state WHERE id = 1'
      ).first();
      if (!row || !row.data) return json({});
      try { return json(JSON.parse(row.data)); }
      catch { return json({}); }
    }

    if (request.method === 'PUT') {
      const ct = Number(request.headers.get('Content-Length') || 0);
      if (ct > MAX_BODY) return json({ error: 'Payload too large' }, 413);

      const body       = await request.json();
      const serialised = JSON.stringify(body);
      if (serialised.length > MAX_BODY) return json({ error: 'Payload too large' }, 413);

      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO state (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      ).bind(serialised, now).run();
      return json({ ok: true, updated_at: now });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('state handler error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
