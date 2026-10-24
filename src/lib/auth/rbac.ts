import type { UserRole } from '@prisma/client';

/**
 * Role-based access control.
 *
 * Authorization is enforced on the SERVER for every API route and every server
 * component. Frontend checks are cosmetic only and must never be trusted.
 *
 * The capability matrix is intentionally explicit so a reviewer can read the
 * entire permission model in one place.
 */

export type Capability =
  // Own data (any authenticated user)
  | 'self:read'
  | 'self:configs'
  | 'self:traffic'
  | 'self:devices'
  | 'self:profile'
  // Users
  | 'users:read'
  | 'users:write'
  | 'users:delete'
  | 'users:reset-password'
  // Servers
  | 'servers:read'
  | 'servers:write'
  | 'servers:delete'
  // Configurations
  | 'configs:read'
  | 'configs:write'
  | 'configs:delete'
  // Tunnels (credential-less port forwarding)
  | 'tunnels:read'
  | 'tunnels:write'
  | 'tunnels:delete'
  // Plans & subscriptions
  | 'plans:read'
  | 'plans:write'
  | 'subscriptions:read'
  | 'subscriptions:write'
  // Monitoring & accounting
  | 'traffic:read'
  | 'monitoring:read'
  | 'logs:read'
  // Settings — split so operators cannot touch security or admin accounts
  | 'settings:read'
  | 'settings:write'
  | 'settings:security:write'
  // Administrator-only
  | 'admins:manage'
  | 'audit:export';

const ALL_CAPABILITIES: Capability[] = [
  'self:read',
  'self:configs',
  'self:traffic',
  'self:devices',
  'self:profile',
  'users:read',
  'users:write',
  'users:delete',
  'users:reset-password',
  'servers:read',
  'servers:write',
  'servers:delete',
  'configs:read',
  'configs:write',
  'configs:delete',
  'tunnels:read',
  'tunnels:write',
  'tunnels:delete',
  'plans:read',
  'plans:write',
  'subscriptions:read',
  'subscriptions:write',
  'traffic:read',
  'monitoring:read',
  'logs:read',
  'settings:read',
  'settings:write',
  'settings:security:write',
  'admins:manage',
  'audit:export',
];

/** OPERATOR: day-to-day operations, but NOT security settings or admin accounts. */
const OPERATOR_CAPABILITIES: Capability[] = [
  'self:read',
  'self:profile',
  'users:read',
  'users:write',
  'users:reset-password',
  'servers:read',
  'servers:write',
  'configs:read',
  'configs:write',
  'configs:delete',
  'tunnels:read',
  'tunnels:write',
  'tunnels:delete',
  'plans:read',
  'plans:write',
  'subscriptions:read',
  'subscriptions:write',
  'traffic:read',
  'monitoring:read',
  'logs:read',
  'settings:read',
];

/** USER: strictly their own resources. */
const USER_CAPABILITIES: Capability[] = [
  'self:read',
  'self:configs',
  'self:traffic',
  'self:devices',
  'self:profile',
];

export const ROLE_CAPABILITIES: Record<UserRole, Capability[]> = {
  ADMIN: ALL_CAPABILITIES,
  OPERATOR: OPERATOR_CAPABILITIES,
  USER: USER_CAPABILITIES,
};

/** Human-readable role descriptions used by the admin UI + seed. */
export const ROLE_DESCRIPTIONS: Record<UserRole, { name: string; description: string }> = {
  ADMIN: {
    name: 'Administrator',
    description: 'Full access including security settings and administrator accounts.',
  },
  OPERATOR: {
    name: 'Operator',
    description:
      'Manages users, servers, configurations and traffic. Cannot change security settings or admin accounts.',
  },
  USER: {
    name: 'User',
    description: 'Access to their own dashboard, configurations, traffic and profile only.',
  },
};

export function capabilitiesFor(role: UserRole | undefined | null): Capability[] {
  if (!role) return [];
  return ROLE_CAPABILITIES[role] ?? [];
}

export function can(role: UserRole | undefined | null, capability: Capability): boolean {
  return capabilitiesFor(role).includes(capability);
}

/** True when the role is a privileged (staff) role. */
export function isStaff(role: UserRole | undefined | null): boolean {
  return role === 'ADMIN' || role === 'OPERATOR';
}

export function isAdmin(role: UserRole | undefined | null): boolean {
  return role === 'ADMIN';
}

/**
 * Guard used by services that operate on a *specific* user's resources.
 * A USER may only touch their own rows; staff may touch anyone's.
 */
export function canAccessUser(
  actor: { id: string; role: UserRole },
  targetUserId: string,
): boolean {
  if (isStaff(actor.role)) return true;
  return actor.id === targetUserId;
}
