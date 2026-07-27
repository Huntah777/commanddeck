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

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
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
   around the same time, so a PUT never blindly overwrites; it merges with
   whatever's currently stored. Proportionate to a few personal devices,
   not a general CRDT: same-item-different-field 3-way conflicts are
   resolved by newer modifiedAt winning the whole item (never a deep
   per-field diff), and 3+ devices are handled fine since the algorithm
   below only ever reasons about "this one incoming PUT vs. current
   storage" — it doesn't assume exactly two writers.

   Every destructive intent (deleting an item, un-ticking a habit) is
   carried explicitly as a timestamped tombstone. Absence is never read as
   a delete: a device that simply hasn't heard about an item yet pushes a
   payload without it, and that must not destroy another device's work. ── */

const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/* Merge the id → deletedAt tombstone map. Newest delete wins; anything
   past the TTL is dropped, on the assumption that every device has long
   since seen it. (A device offline for longer than the TTL can resurrect
   the item — the standard trade-off for not keeping tombstones forever.) */
function mergeDeleted(existing, incoming, now) {
  const out = {};
  const cutoff = now - TOMBSTONE_TTL_MS;
  for (const src of [existing, incoming]) {
    for (const [id, at] of Object.entries(src || {})) {
      const t = Number(at) || 0;
      if (t < cutoff) continue;
      if (t > (out[id] || 0)) out[id] = t;
    }
  }
  return out;
}

const stampOf = (item) => item?.modifiedAt ?? item?.created ?? 0;

/* Merge one id-keyed collection (habits/tasks/lists/blocks/goals).
   - An id in both: newer modifiedAt (falling back to created) wins.
   - An id only on one side: kept — absence carries no meaning.
   - A tombstone removes the item unless the item was edited after the
     delete, in which case the edit wins and the item comes back. */
function mergeCollection(existingArr, incomingArr, deleted) {
  const byId = new Map();
  for (const item of existingArr || []) byId.set(item.id, item);
  for (const item of incomingArr || []) {
    const cur = byId.get(item.id);
    byId.set(item.id, !cur || stampOf(item) >= stampOf(cur) ? item : cur);
  }
  const result = [];
  for (const item of byId.values()) {
    const tomb = deleted[item.id] || 0;
    if (tomb && tomb >= stampOf(item)) continue;
    result.push(item);
  }
  return result;
}

/* pomodoroLogs is append-only/immutable — plain union by id. */
const unionById = (a, b) => [...new Map([...(a || []), ...(b || [])].map(x => [x.id, x])).values()];

/* logs: { 'YYYY-MM-DD': { [habitId]: <ms when ticked> }; logsOff mirrors it
   with the time of an un-tick. A bare `true` is a legacy entry from before
   ticks were timestamped — it reads as done but ranks below any real
   timestamp, so a genuine un-tick always beats it.

   Presence alone used to mean "done", which made un-ticking impossible to
   sync: the merge unioned the stored `true` back over the omission and the
   box re-ticked itself on the next round-trip. */
const LEGACY_DONE = 1;
const doneStamp = (v) => (v === true ? LEGACY_DONE : Number(v) > 0 ? Number(v) : 0);

function mergeLogState(existing, incoming, now) {
  const dateCutoff = new Date(now - TOMBSTONE_TTL_MS).toISOString().slice(0, 10);
  const dates = new Set([
    ...Object.keys(existing.logs || {}),    ...Object.keys(incoming.logs || {}),
    ...Object.keys(existing.logsOff || {}), ...Object.keys(incoming.logsOff || {}),
  ]);

  const logs = {}, logsOff = {};
  for (const date of dates) {
    /* Latest tick and latest un-tick per habit, across both sides. */
    const on = { ...(existing.logs?.[date] || {}) };
    for (const [id, v] of Object.entries(incoming.logs?.[date] || {})) {
      if (doneStamp(v) >= doneStamp(on[id])) on[id] = v;
    }
    const off = { ...(existing.logsOff?.[date] || {}) };
    for (const [id, v] of Object.entries(incoming.logsOff?.[date] || {})) {
      if ((Number(v) || 0) >= (Number(off[id]) || 0)) off[id] = Number(v) || 0;
    }

    const dayOn = {}, dayOff = {};
    for (const id of new Set([...Object.keys(on), ...Object.keys(off)])) {
      const d = doneStamp(on[id]);
      const o = Number(off[id]) || 0;
      if (d > o) dayOn[id] = on[id];               // preserve legacy `true` as-is
      else if (o > 0 && date >= dateCutoff) dayOff[id] = o; // old un-ticks GC'd
    }
    if (Object.keys(dayOn).length)  logs[date]    = dayOn;
    if (Object.keys(dayOff).length) logsOff[date] = dayOff;
  }
  return { logs, logsOff };
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

export function mergeState(existing, body, now = Date.now()) {
  /* clientKnownAt is no longer consulted — deletes are explicit tombstones
     now, so the merge never has to guess whether an omission meant "gone"
     or "not heard about yet". Still destructured out so a legacy client
     sending it can't write it into the stored blob. */
  const { clientKnownAt, ...incoming } = body;
  const deleted = mergeDeleted(existing.deleted, incoming.deleted, now);
  const { logs, logsOff } = mergeLogState(existing, incoming, now);
  return {
    ...existing, ...incoming, // catch-all default for any key not listed below
    habits: mergeCollection(existing.habits, incoming.habits, deleted),
    tasks:  mergeCollection(existing.tasks,  incoming.tasks,  deleted),
    lists:  mergeCollection(existing.lists,  incoming.lists,  deleted),
    blocks: mergeCollection(existing.blocks, incoming.blocks, deleted),
    goals:  mergeCollection(existing.goals,  incoming.goals,  deleted),
    pomodoroLogs: unionById(existing.pomodoroLogs, incoming.pomodoroLogs),
    deleted, logs, logsOff,
    admin:    mergeAdmin(existing.admin, incoming.admin),
    /* Shallow per-key merge, not a whole-object swap — a device that pushes
       a partial/stale ui or pomodoro object (e.g. recovered from a failed
       load) must not be able to wipe unrelated settings like salahLoc or
       notif just because its own copy didn't have them. */
    pomodoro: { ...(existing.pomodoro || {}), ...(incoming.pomodoro || {}) },
    ui:       { ...(existing.ui       || {}), ...(incoming.ui       || {}) },
  };
}

export async function onRequest({ request, env }) {
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);

  try {
    if (request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT data, updated_at FROM state WHERE id = 1'
      ).first();
      if (!row || !row.data) return json({});

      /* Version the row so a foreground refresh on an unchanged state costs
         one 304 instead of re-downloading (and re-applying) the whole blob. */
      const etag = `"v${row.updated_at ?? 0}"`;
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      try {
        return json(JSON.parse(row.data), 200, { ETag: etag });
      } catch { return json({}); }
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
        /* Strictly monotonic: two writes inside the same millisecond would
           otherwise land on the same updated_at, and the ETag built from it
           would tell a client "unchanged" about a state that did change. */
        const now = Math.max(Date.now(), existingUpdatedAt + 1);
        const tag = (v) => ({ ETag: `"v${v}"` });

        if (!existingRow) {
          /* Defensive only — schema.sql seeds this row on setup, so this
             path is normally unreachable. */
          try {
            await env.DB.prepare(
              'INSERT INTO state (id, data, updated_at) VALUES (1, ?, ?)'
            ).bind(serialised, now).run();
            return json({ ok: true, updated_at: now, data: merged }, 200, tag(now));
          } catch {
            continue; // someone else inserted concurrently — retry as an update
          }
        }

        const result = await env.DB.prepare(
          'UPDATE state SET data = ?, updated_at = ? WHERE id = 1 AND updated_at = ?'
        ).bind(serialised, now, existingUpdatedAt).run();

        if (result.meta.changes > 0) {
          return json({ ok: true, updated_at: now, data: merged }, 200, tag(now));
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
