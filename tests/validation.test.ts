import { describe, expect, it } from 'vitest';
import {
  assignConfigSchema,
  createConfigSchema,
  createServerSchema,
  createUserSchema,
  loginSchema,
  trafficQuerySchema,
  updateUserSchema,
} from '@/lib/validation';

/**
 * Validation tests.
 *
 * Request bodies are the primary attack surface, so every schema is exercised
 * with both valid and hostile input: oversized strings, control characters,
 * injection attempts and type confusion.
 */

describe('loginSchema', () => {
  it('accepts a valid payload', () => {
    const result = loginSchema.parse({ identifier: 'admin@example.com', password: 'secret123' });
    expect(result.identifier).toBe('admin@example.com');
    expect(result.remember).toBe(false);
  });

  it('trims surrounding whitespace from the identifier', () => {
    expect(loginSchema.parse({ identifier: '  admin  ', password: 'x' }).identifier).toBe('admin');
  });

  it('rejects an empty identifier', () => {
    expect(loginSchema.safeParse({ identifier: '', password: 'x' }).success).toBe(false);
  });

  it('rejects a missing password', () => {
    expect(loginSchema.safeParse({ identifier: 'a@b.com' }).success).toBe(false);
  });

  it('rejects an oversized identifier', () => {
    expect(
      loginSchema.safeParse({ identifier: 'a'.repeat(500), password: 'x' }).success,
    ).toBe(false);
  });
});

describe('createUserSchema', () => {
  const valid = {
    username: 'jdoe',
    email: 'jdoe@example.com',
    password: 'Str0ng_Password',
  };

  it('accepts a valid payload and applies defaults', () => {
    const result = createUserSchema.parse(valid);
    expect(result.role).toBe('USER');
    expect(result.status).toBe('ACTIVE');
  });

  it('rejects usernames with unsafe characters', () => {
    expect(createUserSchema.safeParse({ ...valid, username: 'admin; DROP TABLE users' }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...valid, username: '<script>' }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...valid, username: 'ab' }).success).toBe(false);
  });

  it('allows dot, dash and underscore in usernames', () => {
    expect(createUserSchema.safeParse({ ...valid, username: 'john.doe_01-x' }).success).toBe(true);
  });

  it('rejects a malformed email', () => {
    expect(createUserSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a short password', () => {
    expect(createUserSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(createUserSchema.safeParse({ ...valid, role: 'SUPERADMIN' }).success).toBe(false);
  });

  it('strips control characters from free text', () => {
    const result = createUserSchema.parse({ ...valid, displayName: 'John\u0000Doe' });
    expect(result.displayName).toBe('JohnDoe');
  });

  it('accepts a null traffic limit (unlimited)', () => {
    expect(createUserSchema.safeParse({ ...valid, trafficLimitGb: null }).success).toBe(true);
  });

  it('rejects a negative traffic limit', () => {
    expect(createUserSchema.safeParse({ ...valid, trafficLimitGb: -5 }).success).toBe(false);
  });
});

describe('updateUserSchema', () => {
  it('accepts a partial update', () => {
    expect(updateUserSchema.safeParse({ status: 'SUSPENDED' }).success).toBe(true);
  });

  it('accepts an empty object (no-op update)', () => {
    expect(updateUserSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an invalid status', () => {
    expect(updateUserSchema.safeParse({ status: 'DELETED' }).success).toBe(false);
  });

  it('accepts the extend and reset flags', () => {
    const result = updateUserSchema.parse({ extendDays: 30, resetTraffic: true });
    expect(result.extendDays).toBe(30);
    expect(result.resetTraffic).toBe(true);
  });
});

describe('createServerSchema', () => {
  const valid = {
    name: 'Germany Node 01',
    hostname: 'node01.example.com',
    ipAddress: '203.0.113.10',
  };

  it('accepts a valid payload and defaults the port', () => {
    const result = createServerSchema.parse(valid);
    expect(result.port).toBe(443);
    expect(result.type).toBe('XRAY');
  });

  it('accepts IPv4, IPv6 and hostnames', () => {
    expect(createServerSchema.safeParse({ ...valid, ipAddress: '2001:db8::1' }).success).toBe(true);
    expect(createServerSchema.safeParse({ ...valid, hostname: 'a-b.example.co.uk' }).success).toBe(true);
  });

  it('rejects a hostname containing spaces or shell metacharacters', () => {
    expect(createServerSchema.safeParse({ ...valid, hostname: 'bad host' }).success).toBe(false);
    expect(createServerSchema.safeParse({ ...valid, hostname: 'host;rm -rf /' }).success).toBe(false);
    expect(createServerSchema.safeParse({ ...valid, hostname: '$(whoami)' }).success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(createServerSchema.safeParse({ ...valid, port: 70000 }).success).toBe(false);
    expect(createServerSchema.safeParse({ ...valid, port: 0 }).success).toBe(false);
  });

  it('validates the agent endpoint as a URL', () => {
    expect(createServerSchema.safeParse({ ...valid, agentEndpoint: 'not-a-url' }).success).toBe(false);
    expect(
      createServerSchema.safeParse({ ...valid, agentEndpoint: 'https://node01.example.com:8443' }).success,
    ).toBe(true);
  });
});

describe('createConfigSchema', () => {
  const valid = {
    name: 'Germany Node 01',
    serverId: 'clx1234567890',
    protocol: 'VLESS',
    params: { uuid: '11111111-1111-4111-8111-111111111111' },
  };

  it('accepts a valid payload and defaults userIds', () => {
    const result = createConfigSchema.parse(valid);
    expect(result.userIds).toEqual([]);
  });

  it('rejects an unsupported protocol', () => {
    expect(createConfigSchema.safeParse({ ...valid, protocol: 'WIREGUARD' }).success).toBe(false);
  });

  it('requires a server', () => {
    expect(createConfigSchema.safeParse({ ...valid, serverId: '' }).success).toBe(false);
  });

  it('accepts a multi-user assignment list', () => {
    const result = createConfigSchema.parse({ ...valid, userIds: ['u1', 'u2', 'u3'] });
    expect(result.userIds).toHaveLength(3);
  });
});

describe('assignConfigSchema', () => {
  it('requires at least one user', () => {
    expect(assignConfigSchema.safeParse({ userIds: [] }).success).toBe(false);
    expect(assignConfigSchema.safeParse({ userIds: ['u1'] }).success).toBe(true);
  });
});

describe('trafficQuerySchema', () => {
  it('defaults the granularity to day', () => {
    expect(trafficQuerySchema.parse({}).granularity).toBe('day');
  });

  it('coerces ISO date strings', () => {
    const result = trafficQuerySchema.parse({ from: '2026-01-01T00:00:00.000Z' });
    expect(result.from).toBeInstanceOf(Date);
  });

  it('rejects an unknown granularity', () => {
    expect(trafficQuerySchema.safeParse({ granularity: 'week' }).success).toBe(false);
  });
});
