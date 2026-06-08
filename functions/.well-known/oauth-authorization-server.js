/* MCP OAuth discovery — RFC 8414
   Consumed by claude.ai when it registers the custom integration. */

export async function onRequest({ request }) {
  const base = new URL(request.url).origin;
  return new Response(
    JSON.stringify({
      issuer:                                base,
      authorization_endpoint:               `${base}/oauth/authorize`,
      token_endpoint:                        `${base}/oauth/token`,
      registration_endpoint:                 `${base}/oauth/register`,
      response_types_supported:              ['code'],
      grant_types_supported:                 ['authorization_code'],
      code_challenge_methods_supported:      ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    }),
    { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
  );
}
