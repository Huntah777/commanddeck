/* Dynamic Client Registration (RFC 7591)
   Claude.ai POSTs here when adding the integration.
   We accept any client without storing anything — the
   client_id is fixed; validation happens at token time. */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await request.json().catch(() => ({}));

  return new Response(
    JSON.stringify({
      client_id:                   'commanddeck-claude',
      redirect_uris:               body.redirect_uris || [],
      grant_types:                 ['authorization_code'],
      response_types:              ['code'],
      token_endpoint_auth_method:  'none',
    }),
    { status: 201, headers: { 'Content-Type': 'application/json', ...CORS } }
  );
}
