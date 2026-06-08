/* Token endpoint.
   Exchanges a signed authorization code (+ PKCE verifier) for an access token.
   The issued access_token equals SYNC_TOKEN so the MCP endpoint accepts it as-is. */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const enc = new TextEncoder();

const b64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

const fromB64url = (str) => {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function timingSafeEqual(a, b) {
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const ua = new Uint8Array(sa), ub = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

const errResp = (error, description, status = 400) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const ct = request.headers.get('Content-Type') || '';
  let params;
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    params = Object.fromEntries(new URLSearchParams(text));
  } else {
    params = await request.json().catch(() => ({}));
  }

  const { grant_type, code, code_verifier } = params;

  if (grant_type !== 'authorization_code') {
    return errResp('unsupported_grant_type', 'Only authorization_code is supported.');
  }
  if (!code) return errResp('invalid_request', 'Missing code.');

  // Split and verify the signed code
  const dot = code.lastIndexOf('.');
  if (dot < 0) return errResp('invalid_grant', 'Malformed code.');
  const payloadB64 = code.slice(0, dot);
  const sigGiven   = code.slice(dot + 1);

  const sigExpected = await hmacSign(payloadB64, env.SYNC_TOKEN || '');
  if (!await timingSafeEqual(sigGiven, sigExpected)) {
    return errResp('invalid_grant', 'Code signature invalid.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(payloadB64)));
  } catch {
    return errResp('invalid_grant', 'Malformed code payload.');
  }

  if (Date.now() > payload.e) {
    return errResp('invalid_grant', 'Code has expired.');
  }

  // PKCE verification (required when code_challenge was set)
  if (payload.c) {
    if (!code_verifier) return errResp('invalid_grant', 'Missing code_verifier.');
    const digest    = await crypto.subtle.digest('SHA-256', enc.encode(code_verifier));
    const challenge = b64url(digest);
    if (!await timingSafeEqual(challenge, payload.c)) {
      return errResp('invalid_grant', 'code_verifier mismatch.');
    }
  }

  return new Response(
    JSON.stringify({
      access_token: env.SYNC_TOKEN,
      token_type:   'Bearer',
      expires_in:   315_360_000, // 10 years — no expiry for personal use
    }),
    { headers: { 'Content-Type': 'application/json', ...CORS } }
  );
}
