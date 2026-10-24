import type { NextRequest } from 'next/server';
import { can, type Capability } from '@/lib/auth/rbac';
import {
  getSessionUserFromRequest,
  requestMeta,
  type RequestMeta,
  type SessionUser,
} from '@/lib/auth/session';
import { RATE_LIMITS, rateLimit } from '@/lib/rate-limit';
import { ForbiddenError, RateLimitError, UnauthorizedError } from './errors';
import { jsonError } from './response';

/**
 * Route handler wrappers.
 *
 * `withAuth` performs, in order: rate limiting → authentication → authorization.
 * Authorization happens on the SERVER for every protected route; the frontend
 * never decides what a user may do.
 */

export interface AuthedContext<P> {
  user: SessionUser;
  params: P;
  meta: RequestMeta;
}

export interface RouteOptions {
  /** Single capability required to run the handler. */
  capability?: Capability;
  /** All of these capabilities are required. */
  capabilities?: Capability[];
  /**
   * At least ONE of these capabilities is required. Used where two different
   * roles legitimately reach the same endpoint through different grants — e.g.
   * `configs:read` (staff) OR `self:configs` (the owning user).
   */
  anyOf?: Capability[];
  /** Rate limit preset or explicit budget. */
  rate?: keyof typeof RATE_LIMITS | { limit: number; windowMs: number };
  /** Extra key material for the rate-limit bucket (e.g. the target user id). */
  rateKey?: (req: NextRequest, params: unknown) => string;
}

type AuthedHandler<P> = (
  req: NextRequest,
  ctx: AuthedContext<P>,
) => Promise<Response> | Response;

type PublicHandler<P> = (req: NextRequest, params: P) => Promise<Response> | Response;

function resolveRate(rate: RouteOptions['rate']) {
  if (!rate) return null;
  return typeof rate === 'string' ? RATE_LIMITS[rate] : rate;
}

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
}

/** Wrap a protected route handler with auth + RBAC + rate limiting. */
export function withAuth<P = Record<string, string>>(
  handler: AuthedHandler<P>,
  options: RouteOptions = {},
) {
  return async (req: NextRequest, ctx: { params: P }): Promise<Response> => {
    try {
      const params = (ctx?.params ?? {}) as P;

      const budget = resolveRate(options.rate);
      if (budget) {
        const key = options.rateKey
          ? options.rateKey(req, params)
          : `${req.nextUrl.pathname}:${clientKey(req)}`;
        const result = await rateLimit(`rl:${key}`, budget);
        if (!result.success) {
          throw new RateLimitError('Too many requests', result.retryAfterSeconds);
        }
      }

      const user = await getSessionUserFromRequest(req);
      if (!user) throw new UnauthorizedError();

      const required = [
        ...(options.capability ? [options.capability] : []),
        ...(options.capabilities ?? []),
      ];
      for (const capability of required) {
        if (!can(user.role, capability)) {
          throw new ForbiddenError(`Missing capability: ${capability}`);
        }
      }

      if (options.anyOf?.length) {
        const granted = options.anyOf.some((capability) => can(user.role, capability));
        if (!granted) {
          throw new ForbiddenError(`Requires one of: ${options.anyOf.join(', ')}`);
        }
      }

      return await handler(req, { user, params, meta: requestMeta(req) });
    } catch (error) {
      return jsonError(error);
    }
  };
}

/** Wrap a public route handler (login, refresh, health) with rate limiting. */
export function withPublic<P = Record<string, string>>(
  handler: PublicHandler<P>,
  options: RouteOptions = {},
) {
  return async (req: NextRequest, ctx: { params: P }): Promise<Response> => {
    try {
      const params = (ctx?.params ?? {}) as P;

      const budget = resolveRate(options.rate);
      if (budget) {
        const key = options.rateKey
          ? options.rateKey(req, params)
          : `${req.nextUrl.pathname}:${clientKey(req)}`;
        const result = await rateLimit(`rl:${key}`, budget);
        if (!result.success) {
          throw new RateLimitError('Too many requests', result.retryAfterSeconds);
        }
      }

      return await handler(req, params);
    } catch (error) {
      return jsonError(error);
    }
  };
}

/** Read + parse a JSON body with a size guard. */
export async function readJson<T = unknown>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
