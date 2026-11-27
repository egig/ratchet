/**
 * better-auth's session cookie is `<prefix>.session_token` (`__Secure-` prefixed when served over
 * https). Ratchet pins the prefix (src/auth/better-auth.ts's `advanced.cookiePrefix`) so this module
 * can resolve it without a handle on the better-auth instance.
 */
export const COOKIE_PREFIX = 'ratchet';
export const SESSION_COOKIE_NAME = `${COOKIE_PREFIX}.session_token`;

function readCookie(request: Request | undefined, name: string): string | null {
  const header = request?.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** better-auth signs the cookie value as `<token>.<hmac>`; its `set-auth-token` response header
 * (bearer plugin) hands API clients that same signed form. Session tokens themselves never contain
 * a `.`, so everything before the first one is the token stored in `sessions.token`. */
function stripSignature(value: string): string {
  const dot = value.indexOf('.');
  return dot === -1 ? value : value.slice(0, dot);
}

/**
 * The session token on a request: `Authorization: Bearer <token>` first (an explicit header wins if
 * a caller sends both), then the session cookie. Accepts both the raw token (better-auth's sign-in
 * response body) and the signed `<token>.<hmac>` form.
 *
 * The HMAC is not verified here — the token itself is the secret (32 random characters), and every
 * caller looks it up in `sessions` and checks expiry. better-auth's own endpoints still verify it.
 */
export function resolveSessionToken(request: Request | undefined): string | null {
  const header = request?.headers.get('authorization');
  if (header && header.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = header.slice(7).trim();
    if (token.length > 0) return stripSignature(token);
  }
  const cookie = readCookie(request, `__Secure-${SESSION_COOKIE_NAME}`) ?? readCookie(request, SESSION_COOKIE_NAME);
  return cookie ? stripSignature(cookie) : null;
}
