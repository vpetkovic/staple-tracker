/**
 * What a request from ANOTHER SITE can carry: a foreign `Origin`, and never the
 * `X-Staple-Token` header.
 *
 * The UI server's write rule (`writeAllowed` in src/ui/server.ts) accepts a foreign Origin
 * only with the token in that header, because a cross-site page cannot set a custom header
 * without a CORS preflight, which the server never grants. So a test that models "a
 * cross-origin write is refused" must model the attacker faithfully: the token (if the test
 * wants the read gate open, to prove the refusal is the write rule's) rides as
 * `Authorization: Bearer`, which opens reads and does not stand in for the header.
 *
 * A request whose Origin is absent or `serverOrigin` itself is left untouched.
 */
export function asForeignPage(headers: Record<string, string>, serverOrigin: string): Record<string, string> {
  const origin = headers.origin;
  if (!origin || origin === serverOrigin) return headers;
  const { "x-staple-token": token, ...rest } = headers;
  return token ? { ...rest, authorization: `Bearer ${token}` } : rest;
}
