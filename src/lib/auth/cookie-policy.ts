import { getEnv } from '@/lib/env';

/**
 * Cookie policy.
 *
 * Lives in its own module (rather than inside `session.ts`) so it stays pure and
 * unit-testable — `session.ts` pulls in `next/headers`, which cannot be imported
 * outside a request context.
 */

/**
 * Should auth cookies carry the `Secure` flag?
 *
 * Derived from how the panel is actually served, not from `NODE_ENV`. A
 * production build served over plain HTTP on a private LAN must NOT set
 * `Secure`: browsers drop such cookies on non-localhost http origins, which
 * presents to the user as "login succeeds but I am bounced back to /login".
 */
export function shouldUseSecureCookies(): boolean {
  const env = getEnv();

  if (env.COOKIE_SECURE === 'true') return true;
  if (env.COOKIE_SECURE === 'false') return false;

  // auto
  return env.APP_URL.startsWith('https://');
}

export interface AuthCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
}

export function authCookieOptions(maxAgeSeconds: number): AuthCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
