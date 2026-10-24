import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { readJson, withPublic } from '@/lib/api/handler';
import { ForbiddenError, UnauthorizedError } from '@/lib/api/errors';
import { jsonOk } from '@/lib/api/response';
import { loginSchema } from '@/lib/validation';
import { verifyPassword } from '@/lib/auth/password';
import {
  createSession,
  isLoginAllowed,
  requestMeta,
  setAuthCookies,
} from '@/lib/auth/session';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { serializeUser } from '@/server/serializers';

/**
 * POST /api/auth/login
 *
 * Authenticates by username OR email. Always performs a password comparison —
 * even for unknown accounts — so response timing does not reveal which usernames
 * exist. On success issues an httpOnly access + refresh cookie pair.
 */
export const POST = withPublic(
  async (req) => {
    const body = await readJson(req);
    const input = loginSchema.parse(body);
    const meta = requestMeta(req);

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: input.identifier.toLowerCase() }, { username: input.identifier }],
      },
    });

    // A syntactically valid but unusable hash keeps the timing consistent.
    const passwordHash =
      user?.passwordHash ??
      '$2a$12$0000000000000000000000000000000000000000000000000000';
    const passwordValid = await verifyPassword(input.password, passwordHash);

    if (!user || !passwordValid) {
      await recordAudit({
        actorId: user?.id ?? null,
        actorName: user?.username ?? input.identifier,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        targetType: 'user',
        targetId: user?.id ?? null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { identifier: input.identifier },
      });
      throw new UnauthorizedError('Invalid username or password.');
    }

    if (!isLoginAllowed(user.status)) {
      await recordAudit({
        actorId: user.id,
        actorName: user.username,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        targetType: 'user',
        targetId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { reason: `status:${user.status}` },
      });
      throw new ForbiddenError(
        user.status === 'DISABLED'
          ? 'This account has been disabled.'
          : 'This account is suspended. Please contact an administrator.',
      );
    }

    const tokens = await createSession(
      { id: user.id, role: user.role, username: user.username },
      meta,
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastSeenAt: new Date() },
    });

    await recordAudit({
      actorId: user.id,
      actorName: user.username,
      action: AUDIT_ACTIONS.LOGIN,
      targetType: 'user',
      targetId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { role: user.role },
    });

    const response = jsonOk({ user: serializeUser(user) }) as NextResponse;
    setAuthCookies(response, tokens);
    return response;
  },
  { rate: 'login' },
);
