import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { authCookieOptions, shouldUseSecureCookies } from '@/lib/auth/cookie-policy';

/**
 * Cookie policy tests.
 *
 * These pin down a bug that is easy to reintroduce and hard to diagnose: marking
 * auth cookies `Secure` whenever NODE_ENV is production. Browsers refuse to
 * store such cookies over plain HTTP on anything except localhost, so a panel
 * served to a LAN over http:// would accept the login and then bounce the user
 * straight back to /login.
 */

const ORIGINAL = {
  NODE_ENV: process.env.NODE_ENV,
  APP_URL: process.env.APP_URL,
  COOKIE_SECURE: process.env.COOKIE_SECURE,
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
};

/** Apply env vars, then drop the memoised environment so they take effect. */
function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
}

/** A production environment that satisfies the required-secret validation. */
function productionEnv(overrides: Record<string, string | undefined>) {
  setEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/vpanel',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    COOKIE_SECURE: undefined,
    APP_URL: undefined,
    ...overrides,
  });
}

afterEach(() => {
  setEnv(ORIGINAL);
});

describe('shouldUseSecureCookies', () => {
  it('does NOT set Secure in production over plain HTTP on a LAN address', () => {
    productionEnv({ APP_URL: 'http://192.168.1.50' });
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it('does NOT set Secure in production over http://localhost', () => {
    productionEnv({ APP_URL: 'http://localhost:3000' });
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it('sets Secure in production behind HTTPS', () => {
    productionEnv({ APP_URL: 'https://panel.example.com' });
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it('honours COOKIE_SECURE=true even over HTTP', () => {
    productionEnv({ APP_URL: 'http://192.168.1.50', COOKIE_SECURE: 'true' });
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it('honours COOKIE_SECURE=false even over HTTPS', () => {
    productionEnv({ APP_URL: 'https://panel.example.com', COOKIE_SECURE: 'false' });
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it('defaults to auto when COOKIE_SECURE is unset', () => {
    productionEnv({ APP_URL: 'http://10.0.0.5:8080', COOKIE_SECURE: undefined });
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it('is not influenced by NODE_ENV alone', () => {
    // Development over HTTPS should still be Secure, and vice versa.
    setEnv({
      NODE_ENV: 'test',
      APP_URL: 'https://localhost',
      COOKIE_SECURE: undefined,
    });
    expect(shouldUseSecureCookies()).toBe(true);
  });
});

describe('authCookieOptions', () => {
  it('always marks cookies httpOnly with SameSite=Lax', () => {
    productionEnv({ APP_URL: 'http://192.168.1.50' });
    const options = authCookieOptions(900);

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(900);
  });

  it('omits Secure for a LAN HTTP origin', () => {
    productionEnv({ APP_URL: 'http://192.168.1.50' });
    expect(authCookieOptions(900).secure).toBe(false);
  });

  it('includes Secure for an HTTPS origin', () => {
    productionEnv({ APP_URL: 'https://panel.example.com' });
    expect(authCookieOptions(900).secure).toBe(true);
  });

  it('supports a zero maxAge for cookie clearing', () => {
    productionEnv({ APP_URL: 'http://192.168.1.50' });
    expect(authCookieOptions(0).maxAge).toBe(0);
  });
});
