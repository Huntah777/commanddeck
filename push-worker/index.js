/**
 * Madinah Command Deck — Web Push Cron Worker
 *
 * Runs every 2 minutes. Reads push_subs from D1, finds notifications
 * due in the current window, sends RFC 8291 encrypted Web Push to each device.
 *
 * Required secrets (set via wrangler secret put):
 *   VAPID_PRIVATE_KEY  — base64url P-256 private scalar
 *
 * Required D1 binding: DB (same database as the Pages project)
 */

const VAPID_PUBLIC_KEY = 'BMg79Dc4KgbVAa253omi5oER5VpB3ErcDnjaR5lgmIinGMVlUpe4-LUgfuQrTb9a3urAaLnDZgQ_vtE4OvVLcPA';
const VAPID_PUBLIC_X   = 'yDv0NzgqBtUBrbneiaLmgRHlWkHcStwOeNpHmWCYiKc';
const VAPID_PUBLIC_Y   = 'GMVlUpe4-LUgfuQrTb9a3urAaLnDZgQ_vtE4OvVLcPA';
const VAPID_SUBJECT    = 'mailto:abdul-malik@huntah.co.uk';

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

async function makeVapidJWT(endpoint, privateKeyB64u) {
  const audience = new URL(endpoint).origin;
  const hdr = toB64u(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pay = toB64u(te(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 43200, sub: VAPID_SUBJECT })));
  const unsigned = `${hdr}.${pay}`;

  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: privateKeyB64u, x: VAPID_PUBLIC_X, y: VAPID_PUBLIC_Y,
    key_ops: ['sign'], ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te(unsigned)));
  return `${unsigned}.${toB64u(sig)}`;
}

/* ── RFC 8291 / 8188  aes128gcm encryption ───────────────────── */

async function encryptWebPush(plaintext, subscription) {
  const { keys: { p256dh, auth } } = subscription;

  const receiverPub = fromB64u(p256dh);   // 65-byte uncompressed P-256 point
  const authSecret  = fromB64u(auth);     // 16-byte auth secret

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

  /* IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0" || receiverPub || senderPub, 32) */
  const ikm = await hkdf(authSecret, ecdhSecret,
    concat(te('WebPush: info\x00'), receiverPub, senderPub), 32);

  const cek   = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\x00'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const msg    = concat(te(plaintext), new Uint8Array([0x02])); /* delimiter */
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, msg));

  /* aes128gcm record header: salt(16) + rs(4,BE) + keyid_len(1) + senderPub(65) */
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([senderPub.length]), senderPub, cipher);
}

/* ── Send one Web Push ────────────────────────────────────────── */

async function sendPush(subscription, payload, privateKeyB64u) {
  const jwt  = await makeVapidJWT(subscription.endpoint, privateKeyB64u);
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
    const now    = Date.now();
    const window = 10 * 60 * 1000; /* 10-min catch-up window (cron fires every 5 min) */

    /* Only load rows that have an upcoming notification in the current window.
       next_fire_at = 0 means no upcoming notifications — skip entirely. */
    const rows = await env.DB.prepare(
      'SELECT id, subscription, schedule FROM push_subs WHERE next_fire_at > 0 AND next_fire_at <= ?'
    ).bind(now + 30_000).all();

    await Promise.all((rows.results || []).map(async row => {
      try {
        const sub      = JSON.parse(row.subscription);
        const schedule = JSON.parse(row.schedule || '[]');

        const due = schedule.filter(n => n.fireAt >= now - window && n.fireAt <= now + 30_000);
        if (!due.length) return;

        await Promise.all(due.map(async n => {
          const status = await sendPush(sub, {
            title:   n.title,
            body:    n.body || '',
            tag:     n.id,
            isSalah: n.id.startsWith('salah-'),
          }, env.VAPID_PRIVATE_KEY);
          console.log(`push → ${row.id} [${n.title}] → HTTP ${status}`);
        }));
      } catch (e) {
        console.error(`push error for ${row.id}:`, e.message);
      }
    }));
  },

  /* HTTP handler — used only for health check */
  async fetch(_req, _env) {
    return new Response('Command Deck Push Worker', { status: 200 });
  },
};
