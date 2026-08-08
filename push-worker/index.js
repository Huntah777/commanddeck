/**
 * Madinah Command Deck — Web Push Cron Worker
 *
 * ONE Cron Trigger drives this Worker — every minute:
 *
 *   crons = ["* * * * *"]
 *
 * Every tick is a single idempotent pass:
 *   1. Re-derive today's FULL notification plan from the shared D1 state row
 *      (salah times, blocks, habits, tasks, goals).
 *   2. Write that plan onto every push_subs row, so notifications keep firing
 *      even if the app is never opened.
 *   3. Send anything now due that this device has not already been sent.
 *
 * Design notes — why it looks like this:
 *   · The plan is the whole day and is rebuilt from scratch every tick; it is
 *     never consumed. Delivery is tracked separately in the `sent` column, so
 *     rebuilding can never resurrect an already-delivered notification, and a
 *     delayed or skipped cron tick can never permanently lose one.
 *   · Cloudflare cron triggers are best-effort and routinely drift by minutes.
 *     A notification that came due while ticks were delayed is still sent,
 *     late, up to staleAfter(id). Past that it is retired without sending — a
 *     three-hours-late "time to pray" is worse than none.
 *   · Behaviour is deliberately NOT keyed off the cron expression string. Any
 *     trigger firing at least once a minute drives the whole system. Keying
 *     features off an exact string silently disables them whenever the
 *     deployed schedule doesn't match the constant in this file.
 *
 * Required secrets (set via wrangler secret put):
 *   VAPID_PRIVATE_KEY  — base64url P-256 private scalar
 *   VAPID_SUBJECT      — mailto: contact URI (e.g. mailto:you@example.com)
 *   SYNC_TOKEN         — same value as the Pages project; guards POST /run
 *
 * Required D1 binding: DB (same database as the Pages project)
 */

const VAPID_PUBLIC_KEY = 'BFbFmnxVUcx5X_6pUxHKVv-n8aX78p73b8vbe8WCLqLPSmq9ydXMWdBtKjjDCceMju1CerMDVsRWkzJiM6jrvYo';

/* How late a notification may still be delivered before it is retired as
   stale. Sized to absorb several consecutive missed or delayed cron ticks.

   Split by kind, because "too late to be useful" is not one number. A prayer
   time or a "starting in 5 min" warning is worse than useless once the moment
   has passed. A habit, task or goal reminder is still actionable later, and
   silently dropping one because the phone spent eleven minutes in a tunnel is
   a miss — that is the case this split exists for. */
const URGENT_LATE_MS  = 10 * 60_000;
const RELAXED_LATE_MS = 2 * 60 * 60_000;

/* A habit given a slot in the day is stored as an ordinary block carrying a
   `habitId` and nothing else of its own. Title, pillar and days are read back
   off the habit rather than copied at save time, so a renamed or rescheduled
   habit can't leave a stale twin in the plan; a block whose habit is gone
   resolves to nothing.

   A task given a slot works the same way, with one difference: a task happens
   once, so its block names a `date` instead of inheriting weekdays, and its
   title and done-ness are read back off the task.

   MIRRORED from index.html, which builds the same plan client-side and must
   reach identical conclusions. Change both. */
export const resolveBlocks = (state) => {
  const habits = state?.habits || [];
  const tasks  = state?.tasks  || [];
  return (state?.blocks || []).flatMap(b => {
    if (b?.habitId) {
      const h = habits.find(x => x.id === b.habitId);
      if (!h) return [];
      return [{ ...b, title: h.name, pillar: h.pillar, every: Array.isArray(h.days) ? h.days : [] }];
    }
    if (b?.taskId) {
      const t = tasks.find(x => x.id === b.taskId);
      if (!t) return [];
      /* `every: []` clears any weekday list a stale block arrived with — a
         task must never start recurring. The due date is the fallback for a
         block that somehow lost its own. */
      return [{ ...b, title: t.title, listId: t.listId, done: !!t.done, date: b.date || t.due || null, every: [] }];
    }
    return b ? [b] : [];
  });
};

/* Does this block belong to this day? Habits and ordinary blocks recur by
   weekday; a task's slot is a one-off and names its date outright. */
export const blockOnDay = (b, dayKey, dow) =>
  b?.date ? b.date === dayKey : (b?.every || []).includes(dow);

/* Ids are stable and prefixed by kind — see buildTodaysSchedule. */
const isUrgent  = (id) => id.startsWith('salah-') || id.startsWith('b-');
export const staleAfter = (id) => (isUrgent(id) ? URGENT_LATE_MS : RELAXED_LATE_MS);

/* A notification due within this window is sent on this tick rather than
   waiting for the next one — keeps sub-minute accuracy despite a 1-min cron. */
const LOOK_AHEAD_MS = 30_000;

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

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/* Constant-time token comparison via HMAC — see functions/api/state.js for the
   rationale. Hashing first also makes the compare length-independent. */
async function tokenOk(given, expect) {
  if (!given || !expect) return false;
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, te(given)),
    crypto.subtle.sign('HMAC', key, te(expect)),
  ]);
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

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

/* The two headers that decide WHEN a push arrives, split out from the send
   so the policy can be tested without a live push service or a keypair.

   TTL — how long the push service should hold this message for a device it
   cannot currently reach. Matches how late we would still be willing to
   deliver this kind of notification: too short and a phone in a tunnel loses
   it outright, while a blanket 24h is what makes a phone that was off
   overnight buzz with the whole of yesterday on wake.

   Urgency — whether to wake a device that IS reachable but asleep. Always
   `high`, because every notification this Worker sends is anchored to a
   wall-clock moment: a prayer time, the start of a block, a reminder set for
   07:00. None of them are still the same notification an hour later.

   Urgency used to follow the TTL split, on the reasoning that the
   non-critical ones could be batched with whatever else the OS was already
   delivering. That is sound everywhere except the one platform that takes it
   completely literally. Chrome delivers Web Push through FCM, and FCM holds
   a normal-priority message for the whole time the device is in Doze,
   releasing it at the next maintenance window — for a phone face-down on a
   desk, hours. Unlocking the phone ends Doze and flushes the queue at once,
   which is why the symptom reads as "notifications only arrive while the app
   is open": they were being held, then delivered in a clump the moment the
   user picked the phone up. Desktop Chrome and iOS Safari have no Doze, so
   the identical schedule behaved correctly on every other install.

   The two are genuinely different questions, and only the second one was
   wrong. */
export function pushHeaders(jwt, ttlMs) {
  return {
    'Authorization':    `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
    'Content-Type':     'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'TTL':              String(Math.round(ttlMs / 1000)),
    'Urgency':          'high',
  };
}

async function sendPush(subscription, payload, privateKeyB64u, subject, ttlMs = URGENT_LATE_MS) {
  const jwt  = await makeVapidJWT(subscription.endpoint, privateKeyB64u, subject);
  const body = await encryptWebPush(JSON.stringify(payload), subscription);

  const r = await fetch(subscription.endpoint, {
    method:  'POST',
    headers: pushHeaders(jwt, ttlMs),
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

/* Per-prayer offsets, mirroring index.html's salahOffsets/salahMinutes. The
   notification has to land on the same minute the app displays, so these two
   implementations must agree — including the clamping. */
const SALAH_OFFSET_LIMIT = 60;

export function salahOffsets(ui) {
  const out = {};
  for (const key of Object.keys(SALAH_NAMES)) {
    const v = Number(ui?.salahOffsets?.[key]);
    out[key] = Number.isFinite(v) ? Math.max(-SALAH_OFFSET_LIMIT, Math.min(SALAH_OFFSET_LIMIT, Math.round(v))) : 0;
  }
  return out;
}

/* "HH:MM (TZ)" → minutes from midnight with the offset applied, clamped into
   the day so a nudge can never move a prayer onto the wrong date. */
export function salahMinutes(raw, offsetMin) {
  if (!raw) return null;
  const [hh, mm] = String(raw).split(' ')[0].split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return Math.max(0, Math.min(24 * 60 - 1, hh * 60 + mm + (Number(offsetMin) || 0)));
}

/* Builds the FULL plan for today — entries already in the past are included.
   Callers depend on this being a pure function of (state, day), so it can be
   recomputed every tick and compared or replaced safely. What has actually
   been delivered lives in push_subs.sent, never in here. */
export async function buildTodaysSchedule(state, tz, parts) {
  const schedule = [];
  if (!state) return { schedule, ok: true };

  /* Deliberately NOT gated on state.ui.notif. That flag is synced, so one
     device switching notifications off used to empty the plan for every
     device sharing the state. Opting out is already per-device and stronger:
     the toggle unsubscribes and deletes that device's push_subs row, so it
     stops receiving regardless of what any other device does. */

  const { y, mo, d, dow, key: todayKey } = parts;

  const push = (id, title, body, fireAt) => {
    if (Number.isFinite(fireAt)) schedule.push({ id, title, body, fireAt });
  };

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
      /* cacheEverything pins the response at the edge: the timetable for a
         given date and location never changes, so this is roughly one origin
         hit per day instead of one per cron tick. */
      const r = await fetch(
        `https://api.aladhan.com/v1/timings/${dd}-${mm2}-${y}?latitude=${loc.lat}&longitude=${loc.lon}&method=${method}&school=${school}`,
        { cf: { cacheTtl: 21600, cacheEverything: true } },
      );
      if (r.ok) {
        const timings = (await r.json())?.data?.timings || {};
        const offsets = salahOffsets(state.ui);
        for (const [key, names] of Object.entries(SALAH_NAMES)) {
          const mins = salahMinutes(timings[key], offsets[key]);
          if (mins == null) continue;
          push(`salah-${key}`, names.en, `${names.ar} · Time to pray`,
               zonedHmToUtcMs(y, mo, d, Math.floor(mins / 60), mins % 60, tz));
        }
      } else {
        salahOk = false;
        console.error('salah fetch failed: HTTP', r.status);
      }
    } catch (e) { salahOk = false; console.error('salah fetch failed:', e.message); }
  }

  /* Calendar blocks — 3 notifications each, end anchored to next day if the
     block crosses midnight (end <= start).

     A block carrying a habitId is a habit that has been given a slot in the
     day; its title, pillar and days come off the habit rather than being
     copied onto the block (see resolveBlocks). One carrying a taskId is a
     task booked into a particular day. Once that habit or task is ticked the
     alerts are skipped — they exist to get it done, and buzzing about
     something already done is how people learn to ignore the buzzing. */
  const doneToday = state.logs?.[todayKey] || {};
  for (const b of resolveBlocks(state)) {
    if (!blockOnDay(b, todayKey, dow)) continue;
    if (b.habitId && doneToday[b.habitId]) continue;
    if (b.taskId && b.done) continue;
    const s = zonedHmToUtcMs(y, mo, d, Math.floor(b.start / 60), b.start % 60, tz);
    let   e = zonedHmToUtcMs(y, mo, d, Math.floor(b.end   / 60), b.end   % 60, tz);
    if (b.end <= b.start) e += 24 * 60 * 60 * 1000;
    push(`b-${b.id}-15`,  'Starting in 15 min', b.title, s - 15 * 60000);
    push(`b-${b.id}-5`,   'Starting in 5 min',  b.title, s -  5 * 60000);
    push(`b-${b.id}-end`, 'Ending in 5 min',    b.title, e -  5 * 60000);
  }

  /* Habit reminders — the fallback for a habit with no slot in the day. One
     that is on the calendar is already covered by the three alerts above, and
     firing both would mean four notifications for one habit. */
  const scheduled = new Set(
    resolveBlocks(state).filter(b => b.habitId && b.every?.includes(dow)).map(b => b.habitId));
  for (const h of state.habits || []) {
    if (!h.reminder || !h.days?.includes(dow) || doneToday[h.id]) continue;
    if (scheduled.has(h.id)) continue;
    const [hh, mm] = h.reminder.split(':').map(Number);
    push(`h-${h.id}`, 'Habit reminder', h.name, zonedHmToUtcMs(y, mo, d, hh, mm, tz));
  }

  /* Task reminders — already an absolute timestamp. Suppressed only when the
     task's calendar slot falls on the same day the reminder would fire: that
     day already carries the three block alerts. A reminder set for another
     day is a different intention and stands. */
  const taskSlotDate = new Map(
    resolveBlocks(state).filter(b => b.taskId && b.date).map(b => [b.taskId, b.date]));
  for (const t of state.tasks || []) {
    if (!t.reminder || t.done) continue;
    if (taskSlotDate.get(t.id) === String(t.reminder).slice(0, 10)) continue;
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

/* Earliest not-yet-delivered entry, or 0 once the day is fully delivered. */
export function nextFireAt(schedule, sentSet) {
  const pending = schedule.filter(n => !sentSet.has(n.id)).map(n => n.fireAt);
  return pending.length ? Math.min(...pending) : 0;
}

/* One tick: refresh every device's plan, then send whatever is due.
   Refresh and delivery are deliberately in the SAME pass — as two independent
   cron jobs they raced, and a refresh landing just after a send could re-add
   an entry that had already gone out. */
async function tick(env) {
  const now = Date.now();

  /* Today's plan, derived once and shared by every device (single household,
     no per-device personalization). */
  const stateRow = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
  const state    = stateRow?.data ? parseJson(stateRow.data, null) : null;

  const tz    = state?.ui?.timezone || DEFAULT_TZ;
  const parts = zonedPartsNow(tz);

  /* plan === null means "no trustworthy plan this tick" — a missing/corrupt
     state row, or a failed prayer-time fetch. Never overwrite stored plans
     with an incomplete one; deliver from what's already there and retry. */
  let plan = null;
  if (state) {
    const { schedule, ok } = await buildTodaysSchedule(state, tz, parts);
    if (ok) plan = schedule;
    else console.error('tick: salah fetch failed, keeping stored plans this tick');
  } else {
    console.error('tick: state row missing or unparseable, keeping stored plans');
  }

  const rows = await env.DB.prepare(
    'SELECT id, subscription, schedule, sent, plan_day FROM push_subs'
  ).all();

  const writes = [];

  await Promise.all((rows.results || []).map(async row => {
    try {
      const sub = parseJson(row.subscription, null);
      if (!sub?.endpoint) return;

      /* Without a fresh plan we can only work from what's stored, and only if
         it belongs to today — yesterday's plan replayed against a reset `sent`
         would mark today's ids delivered and mute the whole day. */
      if (!plan && row.plan_day !== parts.key) return;

      const schedule = plan ?? parseJson(row.schedule, []);

      /* `sent` is scoped to one local day: block/habit/goal ids repeat daily,
         so carrying yesterday's deliveries over would silence today. */
      const newDay  = row.plan_day !== parts.key;
      const sentSet = new Set(newDay ? [] : parseJson(row.sent, []));

      const due = schedule.filter(n =>
        !sentSet.has(n.id) && n.fireAt <= now + LOOK_AHEAD_MS);

      let subscriptionGone = false;
      let anySent = false;

      /* allSettled so one throw doesn't take the whole batch down with it —
         each notification's outcome is judged independently below. */
      const results = await Promise.allSettled(due.map(async n => {
        /* Too stale to be useful — retire it rather than buzz the user with a
           reminder whose moment has long passed. */
        if (n.fireAt < now - staleAfter(n.id)) return 'stale';
        return sendPush(sub, {
          title:   n.title,
          body:    n.body || '',
          tag:     n.id,
          isSalah: n.id.startsWith('salah-'),
        }, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT, staleAfter(n.id));
      }));

      due.forEach((n, i) => {
        const r = results[i];
        if (r.status !== 'fulfilled') {
          /* Network error — leave unsent so the next tick retries it. */
          console.error(`push → ${row.id} [${n.title}] threw:`, r.reason?.message);
          return;
        }
        if (r.value === 'stale') {
          console.log(`push → ${row.id} [${n.title}]: ${Math.round((now - n.fireAt) / 60000)}m late, retiring`);
          sentSet.add(n.id);
          return;
        }
        const s = r.value;
        console.log(`push → ${row.id} [${n.title}] → HTTP ${s}`);
        /* A 404/410 means the push service will never accept this
           subscription again — delete it rather than keep re-querying it. */
        if (s === 404 || s === 410) { subscriptionGone = true; return; }
        if (s >= 200 && s < 300) { sentSet.add(n.id); anySent = true; return; }
        /* Any other non-2xx: leave unsent, retried every tick until it goes
           stale — see staleAfter. */
      });

      if (subscriptionGone) {
        writes.push(env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(row.id));
        return;
      }

      const scheduleJson = JSON.stringify(schedule);
      const sentJson     = JSON.stringify([...sentSet]);

      /* Skip the write when nothing about this row changed — the common case
         once the day's plan has settled. */
      if (!newDay && !anySent
          && scheduleJson === (row.schedule || '[]')
          && sentJson     === (row.sent     || '[]')) return;

      /* updated_at is the staleness signal cleanupStaleSubscriptions uses, so
         it must mean "still genuinely working", not merely "was queried". */
      writes.push(anySent
        ? env.DB.prepare(
            'UPDATE push_subs SET schedule = ?, sent = ?, plan_day = ?, next_fire_at = ?, updated_at = ? WHERE id = ?'
          ).bind(scheduleJson, sentJson, parts.key, nextFireAt(schedule, sentSet), now, row.id)
        : env.DB.prepare(
            'UPDATE push_subs SET schedule = ?, sent = ?, plan_day = ?, next_fire_at = ? WHERE id = ?'
          ).bind(scheduleJson, sentJson, parts.key, nextFireAt(schedule, sentSet), row.id));

    } catch (e) {
      console.error(`push error for ${row.id}:`, e.message);
    }
  }));

  if (writes.length) await env.DB.batch(writes);
  return { devices: (rows.results || []).length, writes: writes.length, planned: plan?.length ?? null };
}

/* Safety net: a push subscription that hasn't successfully received a
   notification, nor been re-confirmed by its own client, in this long is
   almost certainly dead (uninstalled PWA, cleared site data, revoked
   permission, a device that no longer exists) — even if it never hit the
   404/410 auto-delete in tick() (e.g. because it had nothing scheduled to try
   sending in the first place, so that path never ran for it).
   updated_at is bumped both by the client's own subscribe/re-sync POST
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
  /* Deliberately ignores event.cron — see the design notes at the top of this
     file. Any trigger firing at least once a minute drives the whole system. */
  async scheduled(_event, env, ctx) {
    await tick(env);
    /* Housekeeping only — must never delay or fail a delivery tick. Once an
       hour is plenty for a 30-day cutoff. */
    if (new Date().getUTCMinutes() === 0) {
      ctx.waitUntil(cleanupStaleSubscriptions(env));
    }
  },

  /* POST /run with the sync token forces a tick, so the pipeline can be
     verified end to end without waiting for the next cron. */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/run') {
      const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!await tokenOk(given, env.SYNC_TOKEN)) {
        return new Response('Unauthorized', { status: 401 });
      }
      return Response.json(await tick(env));
    }
    return new Response('OK', { status: 200 });
  },
};
