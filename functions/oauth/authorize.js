/* Authorization endpoint.
   GET  → renders a form asking for the CommandDeck sync token.
   POST → validates the token, signs an auth code, redirects to redirect_uri. */

// ── Crypto helpers ────────────────────────────────────────────────────────────

const enc = new TextEncoder();

const b64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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

// ── HTML ──────────────────────────────────────────────────────────────────────

const page = (params, error = '') => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Command Deck · Authorise Claude</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f1117;color:#e2e8f0;font-family:system-ui,sans-serif;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
    .card{background:#1a1d2e;border:1px solid #2d3148;border-radius:1rem;padding:2rem;width:100%;max-width:400px;display:flex;flex-direction:column;gap:1.25rem}
    .logo{display:flex;align-items:center;gap:.6rem;font-size:1.1rem;font-weight:700;color:#a78bfa}
    .logo svg{width:28px;height:28px}
    h1{font-size:1rem;font-weight:600;color:#e2e8f0}
    p{font-size:.85rem;color:#94a3b8;line-height:1.5}
    label{font-size:.8rem;color:#94a3b8;font-weight:500}
    input[type=password]{width:100%;background:#0f1117;border:1px solid #2d3148;border-radius:.5rem;padding:.65rem .85rem;color:#e2e8f0;font-size:.9rem;outline:none;transition:border-color .15s}
    input[type=password]:focus{border-color:#7c3aed}
    .error{font-size:.8rem;color:#f87171;background:#2d1b1b;border:1px solid #7f1d1d;padding:.5rem .75rem;border-radius:.4rem}
    button{background:#7c3aed;color:#fff;border:none;border-radius:.5rem;padding:.7rem 1.25rem;font-size:.9rem;font-weight:600;cursor:pointer;width:100%;transition:background .15s}
    button:hover{background:#6d28d9}
  </style>
</head>
<body>
<form class="card" method="POST">
  <div class="logo">
    <svg viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#7c3aed"/><path d="M8 10h16M8 16h10M8 22h13" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>
    Command Deck
  </div>
  <div>
    <h1>Authorise Claude</h1>
    <p style="margin-top:.4rem">Claude needs read access to your habits, calendar, and tasks. Enter your sync token to continue.</p>
  </div>
  ${error ? `<div class="error">${error}</div>` : ''}
  <div style="display:flex;flex-direction:column;gap:.4rem">
    <label for="tok">Sync token</label>
    <input id="tok" name="sync_token" type="password" placeholder="Paste your token" autocomplete="off" required>
  </div>
  ${Object.entries(params).map(([k, v]) => `<input type="hidden" name="${k}" value="${escHtml(v)}">`).join('')}
  <button type="submit">Authorise</button>
</form>
</body>
</html>`;

const escHtml = (s) => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const params = {
      response_type:         url.searchParams.get('response_type') || '',
      client_id:             url.searchParams.get('client_id') || '',
      redirect_uri:          url.searchParams.get('redirect_uri') || '',
      state:                 url.searchParams.get('state') || '',
      code_challenge:        url.searchParams.get('code_challenge') || '',
      code_challenge_method: url.searchParams.get('code_challenge_method') || '',
    };
    return new Response(page(params), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (request.method === 'POST') {
    const fd          = await request.formData();
    const syncToken   = (fd.get('sync_token') || '').trim();
    const redirectUri = fd.get('redirect_uri') || '';
    const state       = fd.get('state') || '';
    const codeChallenge       = fd.get('code_challenge') || '';
    const codeChallengeMethod = fd.get('code_challenge_method') || '';

    // Re-collect params for re-rendering the form on error
    const params = { redirect_uri: redirectUri, state, client_id: fd.get('client_id') || '',
                     response_type: 'code', code_challenge: codeChallenge,
                     code_challenge_method: codeChallengeMethod };

    if (!redirectUri) {
      return new Response(page(params, 'Missing redirect_uri.'), {
        status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Validate sync token (constant-time)
    const valid = await timingSafeEqual(syncToken, env.SYNC_TOKEN || '');
    if (!valid || !syncToken) {
      return new Response(page(params, 'Invalid sync token. Check Settings › Sync in the app.'), {
        status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Build a signed auth code (expires in 5 minutes)
    const payload = JSON.stringify({
      r: redirectUri,
      s: state,
      c: codeChallenge,
      m: codeChallengeMethod,
      e: Date.now() + 300_000,
    });
    const payloadB64 = b64url(enc.encode(payload));
    const sig        = await hmacSign(payloadB64, env.SYNC_TOKEN);
    const code       = `${payloadB64}.${sig}`;

    const dest = new URL(redirectUri);
    dest.searchParams.set('code', code);
    if (state) dest.searchParams.set('state', state);
    return Response.redirect(dest.toString(), 302);
  }

  return new Response('Method Not Allowed', { status: 405 });
}
