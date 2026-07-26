/**
 * Madinah Command Deck — Web Push Cron Worker
 *
 * Two Cron Triggers drive this Worker (add both in wrangler.toml / the
 * Cloudflare dashboard) — see the CRON_RECOMPUTE constant below for the
 * exact expression:
 *   every 1 minute  — fireDueNotifications: sends whatever is due right now
 *                      from each push_subs row's schedule.
 *   every 15 min    — recomputeServerSchedule: re-derives "today's"
 *                      notifications straight from the shared D1 state row
 *                      (salah times, blocks, habits, tasks, goals) and tops
 *                      up every push_subs row. This is what keeps
 *                      notifications firing even if the app isn't opened for
 *                      days — previously a push_subs row's schedule only
 *                      ever got refreshed by the client itself.
 *
 * Required secrets (set via wrangler secret put):
 *   VAPID_PRIVATE_KEY  — base64url P-256 private scalar
 *   VAPID_SUBJECT      — mailto: contact URI (e.g. mailto:you@example.com)
 *
 * Required D1 binding: DB (same database as the Pages project)
 */

const VAPID_PUBLIC_KEY = 'BFbFmnxVUcx5X_6pUxHKVv-n8aX78p73b8vbe8WCLqLPSmq9ydXMWdBtKjjDCceMju1CerMDVsRWkzJiM6jrvYo';

/* Must exactly match the second Cron Trigger expression configured in
   wrangler.toml / the Cloudflare dashboard for this Worker. */
const CRON_RECOMPUTE = '*/15 * * * *';

/* ── helpers ─────────────────────────────────────────────────── */

function fromB64u(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function toB64u(buf) {
  return btoa(Array.from(new Uint8Array(buf), c => String.fromCharCode(c)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

const te = s => new TextEncoder().encode(s);

/* HKDF-SHA-256: extract then expand (single OKM block, length ≤ 32) */
async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk     = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const prkKey  = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const okm     = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, concat(info, new Uint8Array([1]))));
  return okm.slice(0, length);
}

/* ── VAPID JWT ────────────────────────────────────────────────── */

async function makeVapidJWT(endpoint, privateKeyB64u, subject) {
  const audience = new URL(endpoint).origin;
  const claims   = { aud: audience, exp: Math.floor(Date.now() / 1000) + 43200 };
  if (subject) claims.sub = subject;

  const hdr      = toB64u(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pay      = toB64u(te(JSON.stringify(claims)));
  const unsigned = `${hdr}.${pay}`;

  /* Derive x/y from the raw public key — avoids hardcoded split values */
  const pubKeyRaw = fromB64u(VAPID_PUBLIC_KEY);
  const pubKeyObj = await crypto.subtle.importKey(
    'raw', pubKeyRaw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
  );
  const { x, y } = await crypto.subtle.exportKey('jwk', pubKeyObj);

  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: privateKeyB64u, x, y,
    key_ops: ['sign'], ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te(unsigned)));
  return `${unsigned}.${toB64u(sig)}`;
}

/* ── RFC 8291 / 8188  aes128gcm encryption ───────────────────── */

async function encryptWebPush(plaintext, subscription) {
  const { keys: { p256dh, auth } } = subscription;

  const receiverPub = fromB64u(p256dh);
  const authSecret  = fromB64u(auth);

  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );

  const senderKP = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const senderPub = new Uint8Array(await crypto.subtle.exportKey('raw', senderKP.publicKey));

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, senderKP.privateKey, 256,
  ));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const ikm = await hkdf(authSecret, ecdhSecret,
    concat(te('WebPush: info\x00'), receiverPub, senderPub), 32);

  const cek   = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\x00'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const msg    = concat(te(plaintext), new Uint8Array([0x02]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, msg));

  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([senderPub.length]), senderPub, cipher);
}

/* ── Send one Web Push ────────────────────────────────────────── */

async function sendPush(subscription, payload, privateKeyB64u, subject) {
  const jwt  = await makeVapidJWT(subscription.endpoint, privateKeyB64u, subject);
  const body = await encryptWebPush(JSON.stringify(payload), subscription);

  const r = await fetch(subscription.endpoint, {
    method:  'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Urgency':          'high',
    },
    body,
  });
  return r.status;
}

/* ── Timezone helpers (Worker has no implicit local timezone) ──── */
/* Standard "double-format" technique: derive the UTC offset for a given
   instant by re-formatting it in the target IANA zone. DST-correct because
   it re-derives the offset from the actual date in question each time. */

const DEFAULT_TZ = 'Europe/London';

function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

function zonedPartsNow(tz) {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(dtf.formatToParts(now).map(x => [x.type, x.value]));
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, d: +p.day, dow: WD[p.weekday], key: `${p.year}-${p.month}-${p.day}` };
}

/* "HH:MM on y-mo-d in tz" → UTC epoch ms */
function zonedHmToUtcMs(y, mo, d, hh, mm, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  return guess - tzOffsetMs(new Date(guess), tz);
}

/* ── Server-side replica of index.html's scheduleNotifications ─── */

const SALAH_NAMES = { // kept in sync by hand with index.html's SALAH_NAMES
  Fajr:    { en: 'Fajr',    ar: 'الفجر'  },
  Dhuhr:   { en: 'Dhuhr',   ar: 'الظهر'  },
  Asr:     { en: 'Asr',     ar: 'العصر'  },
  Maghrib: { en: 'Maghrib', ar: 'المغرب' },
  Isha:    { en: 'Isha',    ar: 'العشاء' },
};

async function buildTodaysSchedule(state) {
  const schedule = [];
  if (!state?.ui?.notif) return { schedule, ok: true };

  const tz  = state.ui?.timezone || DEFAULT_TZ;
  const now = Date.now();
  const { y, mo, d, dow, key: todayKey } = zonedPartsNow(tz);

  const push = (id, title, body, fireAt) => { if (fireAt > now) schedule.push({ id, title, body, fireAt }); };

  /* Salah times — same unauthenticated Aladhan endpoint the client uses.
     A prayer-time fetch failure is NOT the same as "no location configured"
     — signal it distinctly (ok:false) so the caller can skip writing an
     incomplete schedule (which would silently drop all remaining prayer
     notifications for the day) and just retry on the next tick instead. */
  const loc = state.ui?.salahLoc;
  let salahOk = true;
  if (loc?.lat != null && loc?.lon != null) {
    try {
      const method = state.ui.salahMethod ?? 3, school = state.ui.salahSchool ?? 0;
      const dd = String(d).padStart(2, '0'), mm2 = String(mo).padStart(2, '0');
      const r = await fetch(`https://api.aladhan.com/v1/timings/${dd}-${mm2}-${y}?latitude=${loc.lat}&longitude=${loc.lon}&method=${method}&school=${school}`);
      if (r.ok) {
        const timings = (await r.json())?.data?.timings || {};
        for (const [key, names] of Object.entries(SALAH_NAMES)) {
          const raw = timings[key];
          if (!raw) continue;
          const [hh, mm] = raw.split(' ')[0].split(':').map(Number);
          push(`salah-${key}`, names.en, `${names.ar} · Time to pray`, zonedHmToUtcMs(y, mo, d, hh, mm, tz));
        }
      } else {
        salahOk = false;
        console.error('salah fetch failed: HTTP', r.status);
      }
    } catch (e) { salahOk = false; console.error('salah fetch failed:', e.message); }
  }

  /* Calendar blocks — 3 notifications each, end anchored to next day if the
     block crosses midnight (end <= start) */
  for (const b of state.blocks || []) {
    if (!b.every?.includes(dow)) continue;
    const s = zonedHmToUtcMs(y, mo, d, Math.floor(b.start / 60), b.start % 60, tz);
    let   e = zonedHmToUtcMs(y, mo, d, Math.floor(b.end   / 60), b.end   % 60, tz);
    if (b.end <= b.start) e += 24 * 60 * 60 * 1000;
    push(`b-${b.id}-15`,  'Starting in 15 min', b.title, s - 15 * 60000);
    push(`b-${b.id}-5`,   'Starting in 5 min',  b.title, s -  5 * 60000);
    push(`b-${b.id}-end`, 'Ending in 5 min',    b.title, e -  5 * 60000);
  }

  /* Habit reminders — skip if already logged today */
  for (const h of state.habits || []) {
    if (!h.reminder || !h.days?.includes(dow) || state.logs?.[todayKey]?.[h.id]) continue;
    const [hh, mm] = h.reminder.split(':').map(Number);
    push(`h-${h.id}`, 'Habit reminder', h.name, zonedHmToUtcMs(y, mo, d, hh, mm, tz));
  }

  /* Task reminders — already an absolute timestamp */
  for (const t of state.tasks || []) {
    if (!t.reminder || t.done) continue;
    push(`t-${t.id}`, 'Task reminder', t.title, new Date(t.reminder).getTime());
  }

  /* Goal reminders — quarterly, then yearly, then lifetime. Can fire twice a
     day: once in the morning, once in the evening (mirrors index.html). */
  const gr = state.ui?.goalsReminder;
  if (gr) {
    const active = (state.goals || []).filter(g => g.status !== 'completed');
    const qKey = `${y}-Q${Math.ceil(mo / 3)}`;
    const titles = arr => arr.map(g => g.title).join(' · ');

    const quarterly = active.filter(g => g.horizon === 'quarter' && g.quarter === qKey);
    const yearly    = active.filter(g => g.horizon === '1year');
    const lifetime  = active.filter(g => g.horizon === 'lifetime');

    const fireGoalReminders = (idPrefix, time) => {
      if (!time) return;
      const [gh, gm] = time.split(':').map(Number);
      const base = zonedHmToUtcMs(y, mo, d, gh, gm, tz);
      if (quarterly.length) push(`${idPrefix}-quarter`,  `This quarter's goals (${qKey})`, titles(quarterly), base);
      if (yearly.length)    push(`${idPrefix}-year`,     "This year's goals",              titles(yearly),    base + 2 * 60000);
      if (lifetime.length)  push(`${idPrefix}-lifetime`, 'Your lifetime mission',          titles(lifetime),  base + 4 * 60000);
    };

    if (gr.on)        fireGoalReminders('goals-am', gr.time);
    if (gr.eveningOn) fireGoalReminders('goals-pm', gr.eveningTime);
  }

  return { schedule, ok: salahOk };
}

/* Re-derive "today's" notification schedule from the single shared state row
   and top up every push_subs row with it (single household, no per-device
   personalization). Runs on the CRON_RECOMPUTE trigger. */
async function recomputeServerSchedule(env) {
  const row = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
  if (!row?.data) return;
  let state;
  try { state = JSON.parse(row.data); } catch { return; }

  const { schedule, ok } = await buildTodaysSchedule(state);
  if (!ok) {
    /* Prayer-time fetch failed this tick — do NOT overwrite push_subs with
       an incomplete schedule missing salah entries. Leave whatever's
       already stored untouched and just retry on the next tick. */
    console.error('recomputeServerSchedule: skipping write, salah fetch failed this tick');
    return;
  }

  const scheduleJson = JSON.stringify(schedule);
  const nextFireAt   = schedule.length ? Math.min(...schedule.map(n => n.fireAt)) : 0;

  const subs  = await env.DB.prepare('SELECT id FROM push_subs').all();
  const stmts = (subs.results || []).map(r =>
    env.DB.prepare('UPDATE push_subs SET schedule = ?, next_fire_at = ? WHERE id = ?')
      .bind(scheduleJson, nextFireAt, r.id));
  if (stmts.length) await env.DB.batch(stmts);
}

/* ── Cron: send whatever's due right now (unchanged from before) ─ */

async function fireDueNotifications(env) {
  const now = Date.now();
  /* 90-second look-back — wide enough to survive one missed cron run,
     narrow enough that each notification lands in at most one window. */
  const lookBack = 90_000;

  /* Only load rows that have a notification due imminently */
  const rows = await env.DB.prepare(
    'SELECT id, subscription, schedule FROM push_subs WHERE next_fire_at > 0 AND next_fire_at <= ?'
  ).bind(now + 30_000).all();

  await Promise.all((rows.results || []).map(async row => {
    try {
      const sub      = JSON.parse(row.subscription);
      const schedule = JSON.parse(row.schedule || '[]');

      const due      = schedule.filter(n => n.fireAt >= now - lookBack && n.fireAt <= now + 30_000);
      /* Entries that fell outside every lookback window (a missed/delayed
         cron tick) can never be sent — drop them instead of letting them
         zombie next_fire_at forever. */
      const missed   = schedule.filter(n => n.fireAt < now - lookBack);
      const upcoming = schedule.filter(n => n.fireAt > now + 30_000);

      if (!due.length && !missed.length) return;
      if (missed.length) {
        console.log(`push → ${row.id}: dropping ${missed.length} missed notification(s)`);
      }

      /* allSettled so one throw doesn't take the whole batch down with it —
         each notification's outcome is judged independently below. */
      const results = await Promise.allSettled(due.map(n => sendPush(sub, {
        title:   n.title,
        body:    n.body || '',
        tag:     n.id,
        isSalah: n.id.startsWith('salah-'),
      }, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT)));

      let subscriptionGone = false;
      let anySent = false;
      const retry = [];
      due.forEach((n, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
          const s = r.value;
          console.log(`push → ${row.id} [${n.title}] → HTTP ${s}`);
          if (s === 404 || s === 410) { subscriptionGone = true; return; } /* expired sub */
          if (s >= 200 && s < 300) { anySent = true; return; } /* delivered */
          retry.push(n); /* other non-2xx — try again next tick */
        } else {
          console.error(`push → ${row.id} [${n.title}] threw:`, r.reason?.message);
          retry.push(n); /* network error etc — try again next tick */
        }
      });

      /* A 404/410 means the push service will never accept this
         subscription again — delete it rather than keep re-querying it. */
      if (subscriptionGone) {
        await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(row.id).run();
        return;
      }

      const remain     = [...upcoming, ...retry];
      const nextFireAt = remain.length ? Math.min(...remain.map(n => n.fireAt)) : 0;

      /* Only bump updated_at on an actual successful delivery this tick —
         it's the staleness signal cleanupStaleSubscriptions relies on below,
         so it must reflect "still genuinely working," not just "was queried." */
      if (anySent) {
        await env.DB.prepare(
          'UPDATE push_subs SET schedule = ?, next_fire_at = ?, updated_at = ? WHERE id = ?'
        ).bind(JSON.stringify(remain), nextFireAt, now, row.id).run();
      } else {
        await env.DB.prepare(
          'UPDATE push_subs SET schedule = ?, next_fire_at = ? WHERE id = ?'
        ).bind(JSON.stringify(remain), nextFireAt, row.id).run();
      }

    } catch (e) {
      console.error(`push error for ${row.id}:`, e.message);
    }
  }));
}

/* Safety net: a push subscription that hasn't successfully received a
   notification, nor been re-confirmed by its own client, in this long is
   almost certainly dead (uninstalled PWA, cleared site data, revoked
   permission, a device that no longer exists) — even if it never hit the
   404/410 auto-delete in fireDueNotifications (e.g. because it had nothing
   scheduled to try sending in the first place, so that path never ran for
   it). updated_at is bumped both by the client's own subscribe/re-sync POST
   (functions/api/push.js) and by a successful send here, so this only ever
   catches rows that are genuinely not working — never a device that's just
   quietly receiving background pushes without reopening the app. */
const STALE_SUBSCRIPTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function cleanupStaleSubscriptions(env) {
  try {
    const cutoff = Date.now() - STALE_SUBSCRIPTION_MS;
    const result = await env.DB.prepare('DELETE FROM push_subs WHERE updated_at < ?').bind(cutoff).run();
    if (result.meta?.changes) {
      console.log(`cleanup: removed ${result.meta.changes} stale push subscription(s)`);
    }
  } catch (e) {
    console.error('cleanupStaleSubscriptions failed:', e.message);
  }
}

/* ── Entry point ───────────────────────────────────────────────── */

export default {
  async scheduled(event, env, _ctx) {
    if (event.cron === CRON_RECOMPUTE) {
      await recomputeServerSchedule(env);
      await cleanupStaleSubscriptions(env);
      return;
    }
    await fireDueNotifications(env);
  },

  async fetch(_req, _env) {
    return new Response('OK', { status: 200 });
  },
};
