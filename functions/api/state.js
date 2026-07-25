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
     PUT  /api/state   → merges the incoming state into the stored state
                         (see mergeState below) and returns the merged result

   All requests require:
     Authorization: Bearer <SYNC_TOKEN>
   ============================================================ */

const MAX_BODY = 1_048_576; // 1 MB
const MAX_WRITE_ATTEMPTS = 3; // optimistic-concurrency retries — see PUT handler

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

/* ── Merge logic ──────────────────────────────────────────────────
   This app has no per-user accounts — a handful of personal devices share
   one SYNC_TOKEN and one state row. Two devices can legitimately edit
   around the same time, so a PUT no longer blindly overwrites; it merges
   with whatever's currently stored. Proportionate to a few personal
   devices, not a general CRDT: same-item-different-field 3-way conflicts
   are resolved by newer modifiedAt winning the whole item (never a deep
   per-field diff), and 3+ devices are handled fine since the algorithm
   below only ever reasons about "this one incoming PUT vs. current
   storage" — it doesn't assume exactly two writers. ── */

/* Merge one id-keyed collection (habits/tasks/lists/blocks/goals).
   - An id in both: newer modifiedAt (falling back to created) wins.
   - An id only in incoming: it's new, keep it.
   - An id only in existing (stored) but missing from incoming: only treat
     that as a real delete if the stored item's modifiedAt is <= the
     client's clientKnownAt — i.e. the client had already pulled a version
     at least that fresh and chose to drop it. Otherwise it's just an
     omission (created/edited elsewhere after this client's last pull) and
     is kept. clientKnownAt=0 (first sync / fresh device) never deletes. */
function mergeCollection(existingArr, incomingArr, clientKnownAt) {
  const byId = new Map();
  for (const item of existingArr || []) byId.set(item.id, { fromIncoming: false, item });
  for (const item of incomingArr || []) {
    const cur = byId.get(item.id);
    if (!cur) { byId.set(item.id, { fromIncoming: true, item }); continue; }
    const exM = cur.item.modifiedAt ?? cur.item.created ?? 0;
    const inM = item.modifiedAt ?? item.created ?? 0;
    byId.set(item.id, { fromIncoming: true, item: inM >= exM ? item : cur.item });
  }
  const result = [];
  for (const { fromIncoming, item } of byId.values()) {
    if (!fromIncoming) {
      const m = item.modifiedAt ?? item.created ?? 0;
      if (clientKnownAt > 0 && m <= clientKnownAt) continue; // deletion honored
    }
    result.push(item);
  }
  return result;
}

/* pomodoroLogs is append-only/immutable — plain union by id. */
const unionById = (a, b) => [...new Map([...(a || []), ...(b || [])].map(x => [x.id, x])).values()];

/* logs: { 'YYYY-MM-DD': { [habitId]: true } }, presence = done, no per-entry
   timestamp exists or is worth adding — union-of-true per date. Accepts one
   rare, self-correcting failure mode (an old "done" can resurrect over an
   intentional un-check from another device) in exchange for needing zero
   new timestamp plumbing on a plain boolean map. */
function mergeLogs(existing, incoming) {
  const out = { ...(existing || {}) };
  for (const [date, entries] of Object.entries(incoming || {})) {
    out[date] = { ...(out[date] || {}), ...entries };
  }
  return out;
}

/* admin.pillars/quads are small override maps keyed by fixed ids — shallow
   per-key merge so edits to different pillars/quads on different devices
   don't clobber each other. fastingDays/pomodoro/ui are flat, low-edit-
   frequency settings — whole-value last-write-wins is proportionate. */
function mergeAdmin(existing, incoming) {
  return {
    pillars:     { ...(existing?.pillars || {}), ...(incoming?.pillars || {}) },
    quads:       { ...(existing?.quads   || {}), ...(incoming?.quads   || {}) },
    fastingDays: incoming?.fastingDays ?? existing?.fastingDays,
  };
}

function mergeState(existing, body) {
  const { clientKnownAt, ...incoming } = body;
  const cka = Number(clientKnownAt) || 0;
  return {
    ...existing, ...incoming, // catch-all default for any key not listed below
    habits: mergeCollection(existing.habits, incoming.habits, cka),
    tasks:  mergeCollection(existing.tasks,  incoming.tasks,  cka),
    lists:  mergeCollection(existing.lists,  incoming.lists,  cka),
    blocks: mergeCollection(existing.blocks, incoming.blocks, cka),
    goals:  mergeCollection(existing.goals,  incoming.goals,  cka),
    pomodoroLogs: unionById(existing.pomodoroLogs, incoming.pomodoroLogs),
    logs:     mergeLogs(existing.logs, incoming.logs),
    admin:    mergeAdmin(existing.admin, incoming.admin),
    pomodoro: incoming.pomodoro ?? existing.pomodoro,
    ui:       incoming.ui ?? existing.ui,
  };
}

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

      const body = await request.json();
      if (JSON.stringify(body).length > MAX_BODY) return json({ error: 'Payload too large' }, 413);

      /* Read → merge → conditionally write, retrying if another device wrote
         in between (optimistic concurrency — matters more with several
         personal devices syncing than it did with just one or two). */
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const existingRow = await env.DB.prepare(
          'SELECT data, updated_at FROM state WHERE id = 1'
        ).first();

        let existingData = {};
        try { existingData = existingRow?.data ? JSON.parse(existingRow.data) : {}; } catch {}
        const existingUpdatedAt = existingRow?.updated_at ?? 0;

        const merged     = mergeState(existingData, body);
        const serialised  = JSON.stringify(merged);
        if (serialised.length > MAX_BODY) return json({ error: 'Payload too large' }, 413);
        const now = Date.now();

        if (!existingRow) {
          /* Defensive only — schema.sql seeds this row on setup, so this
             path is normally unreachable. */
          try {
            await env.DB.prepare(
              'INSERT INTO state (id, data, updated_at) VALUES (1, ?, ?)'
            ).bind(serialised, now).run();
            return json({ ok: true, updated_at: now, data: merged });
          } catch {
            continue; // someone else inserted concurrently — retry as an update
          }
        }

        const result = await env.DB.prepare(
          'UPDATE state SET data = ?, updated_at = ? WHERE id = 1 AND updated_at = ?'
        ).bind(serialised, now, existingUpdatedAt).run();

        if (result.meta.changes > 0) {
          return json({ ok: true, updated_at: now, data: merged });
        }
        /* Someone else wrote between our read and write — loop and retry
           against a fresh read. */
      }

      return json({ error: 'Too many concurrent writes, please retry' }, 409);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('state handler error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}
