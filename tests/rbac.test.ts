import { describe, expect, it } from 'vitest';
import { UserRole } from '@prisma/client';
import {
  can,
  canAccessUser,
  capabilitiesFor,
  isAdmin,
  isStaff,
  ROLE_CAPABILITIES,
} from '@/lib/auth/rbac';

/**
 * RBAC tests.
 *
 * The capability matrix is the single source of truth for authorisation. These
 * tests pin down the boundaries that matter most: operators must not reach
 * security settings or administrator accounts, and end users must not reach
 * anything beyond their own resources.
 */

describe('capability matrix', () => {
  it('grants administrators every capability', () => {
    expect(can(UserRole.ADMIN, 'users:write')).toBe(true);
    expect(can(UserRole.ADMIN, 'settings:security:write')).toBe(true);
    expect(can(UserRole.ADMIN, 'admins:manage')).toBe(true);
    expect(can(UserRole.ADMIN, 'audit:export')).toBe(true);
  });

  it('lets operators manage day-to-day resources', () => {
    expect(can(UserRole.OPERATOR, 'users:write')).toBe(true);
    expect(can(UserRole.OPERATOR, 'servers:write')).toBe(true);
    expect(can(UserRole.OPERATOR, 'configs:write')).toBe(true);
    expect(can(UserRole.OPERATOR, 'configs:delete')).toBe(true);
    expect(can(UserRole.OPERATOR, 'traffic:read')).toBe(true);
    expect(can(UserRole.OPERATOR, 'logs:read')).toBe(true);
  });

  it('blocks operators from security settings and administrator accounts', () => {
    expect(can(UserRole.OPERATOR, 'settings:security:write')).toBe(false);
    expect(can(UserRole.OPERATOR, 'admins:manage')).toBe(false);
    expect(can(UserRole.OPERATOR, 'users:delete')).toBe(false);
    expect(can(UserRole.OPERATOR, 'audit:export')).toBe(false);
    expect(can(UserRole.OPERATOR, 'settings:write')).toBe(false);
  });

  it('restricts users to their own resources', () => {
    expect(can(UserRole.USER, 'self:read')).toBe(true);
    expect(can(UserRole.USER, 'self:configs')).toBe(true);
    expect(can(UserRole.USER, 'self:traffic')).toBe(true);
    expect(can(UserRole.USER, 'users:read')).toBe(false);
    expect(can(UserRole.USER, 'servers:read')).toBe(false);
    expect(can(UserRole.USER, 'configs:write')).toBe(false);
    expect(can(UserRole.USER, 'monitoring:read')).toBe(false);
    expect(can(UserRole.USER, 'logs:read')).toBe(false);
  });

  it('returns an empty capability list for an unknown role', () => {
    expect(capabilitiesFor(undefined)).toEqual([]);
    expect(can(null, 'users:read')).toBe(false);
  });

  it('keeps the operator list a strict subset of the administrator list', () => {
    const admin = new Set(ROLE_CAPABILITIES.ADMIN);
    for (const capability of ROLE_CAPABILITIES.OPERATOR) {
      expect(admin.has(capability)).toBe(true);
    }
  });
});

describe('role helpers', () => {
  it('classifies staff correctly', () => {
    expect(isStaff(UserRole.ADMIN)).toBe(true);
    expect(isStaff(UserRole.OPERATOR)).toBe(true);
    expect(isStaff(UserRole.USER)).toBe(false);
    expect(isStaff(undefined)).toBe(false);
  });

  it('classifies administrators correctly', () => {
    expect(isAdmin(UserRole.ADMIN)).toBe(true);
    expect(isAdmin(UserRole.OPERATOR)).toBe(false);
    expect(isAdmin(UserRole.USER)).toBe(false);
  });
});

describe('canAccessUser', () => {
  it('allows staff to access any account', () => {
    expect(canAccessUser({ id: 'admin-1', role: UserRole.ADMIN }, 'someone-else')).toBe(true);
    expect(canAccessUser({ id: 'op-1', role: UserRole.OPERATOR }, 'someone-else')).toBe(true);
  });

  it('allows a user to access only their own account', () => {
    expect(canAccessUser({ id: 'user-1', role: UserRole.USER }, 'user-1')).toBe(true);
    expect(canAccessUser({ id: 'user-1', role: UserRole.USER }, 'user-2')).toBe(false);
  });
});
