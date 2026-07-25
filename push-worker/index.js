/**
 * Madinah Command Deck — Web Push Cron Worker
 *
 * Runs every 1 minute. Reads push_subs from D1, finds notifications
 * due in the current window, sends RFC 8291 encrypted Web Push to each device.
 *
 * Required secrets (set via wrangler secret put):
 *   VAPID_PRIVATE_KEY  — base64url P-256 private scalar
 *   VAPID_SUBJECT      — mailto: contact URI (e.g. mailto:you@example.com)
 *
 * Required D1 binding: DB (same database as the Pages project)
 */

const VAPID_PUBLIC_KEY = 'BFbFmnxVUcx5X_6pUxHKVv-n8aX78p73b8vbe8WCLqLPSmq9ydXMWdBtKjjDCceMju1CerMDVsRWkzJiM6jrvYo';

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

/* ── Cron handler ─────────────────────────────────────────────── */

export default {
  async scheduled(_event, env, _ctx) {
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
        const retry = [];
        due.forEach((n, i) => {
          const r = results[i];
          if (r.status === 'fulfilled') {
            const s = r.value;
            console.log(`push → ${row.id} [${n.title}] → HTTP ${s}`);
            if (s === 404 || s === 410) { subscriptionGone = true; return; } /* expired sub */
            if (s >= 200 && s < 300) return; /* delivered */
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
        await env.DB.prepare(
          'UPDATE push_subs SET schedule = ?, next_fire_at = ? WHERE id = ?'
        ).bind(JSON.stringify(remain), nextFireAt, row.id).run();

      } catch (e) {
        console.error(`push error for ${row.id}:`, e.message);
      }
    }));
  },

  async fetch(_req, _env) {
    return new Response('OK', { status: 200 });
  },
};
