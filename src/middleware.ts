import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware — ROUTING ONLY.
 *
 * It performs a cheap cookie-presence check to decide whether to bounce a
 * visitor to /login, which keeps unauthenticated users from seeing a flash of
 * the app shell. It deliberately does NOT verify the JWT here:
 *
 *   - the edge runtime has no access to the database, so it cannot validate the
 *     session record, and
 *   - authorization must never depend on middleware alone.
 *
 * Real authentication and authorization happen in every route handler and
 * server component (see `src/lib/api/handler.ts` and `src/lib/auth/session.ts`).
 */

const ACCESS_COOKIE = 'vpanel_at';
const REFRESH_COOKIE = 'vpanel_rt';

/** Routes that require an authenticated session. */
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/servers',
  '/users',
  '/configs',
  '/subscriptions',
  '/traffic',
  '/monitoring',
  '/logs',
  '/settings',
  '/profile',
];

/** Routes a signed-in user should be redirected away from. */
const AUTH_ROUTES = ['/login'];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const hasSession =
    Boolean(req.cookies.get(ACCESS_COOKIE)?.value) ||
    Boolean(req.cookies.get(REFRESH_COOKIE)?.value);

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isProtected && !hasSession) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (AUTH_ROUTES.includes(pathname) && hasSession) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  const response = NextResponse.next();

  // Baseline security headers for every response (nginx adds HSTS in production).
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-DNS-Prefetch-Control', 'off');

  return response;
}

export const config = {
  // Skip static assets and the API (route handlers do their own auth).
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|txt)$).*)'],
};
