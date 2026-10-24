import { describe, expect, it } from 'vitest';
import {
  CLIENT_EMAIL_PREFIX,
  assignmentIdFromEmail,
  clientEmailFor,
} from '@/services/providers/identity';

/**
 * Client identity tests.
 *
 * The email written into a node config is the ONLY key the node reports traffic
 * back with, so these properties are load-bearing: if the email is not unique
 * per assignment, or cannot be reversed, traffic is attributed to the wrong
 * account (or to nobody at all).
 */

describe('clientEmailFor', () => {
  it('prefixes the assignment id', () => {
    expect(clientEmailFor('abc123')).toBe('vp-abc123');
    expect(CLIENT_EMAIL_PREFIX).toBe('vp-');
  });

  it('uses the FULL assignment id, not a suffix', () => {
    // A suffix would collide for ids that happen to end the same way, which is
    // exactly how traffic ends up on the wrong account.
    const first = clientEmailFor('cmuj8p57a000tik1y9b9oa5h5');
    const second = clientEmailFor('cmuj9zzzz000tik1y9b9oa5h5');
    expect(first).not.toBe(second);
    expect(first).toContain('cmuj8p57a000tik1y9b9oa5h5');
  });
});

describe('assignmentIdFromEmail', () => {
  it('round-trips a generated email', () => {
    const id = 'cmuj8p57a000tik1y9b9oa5h5';
    expect(assignmentIdFromEmail(clientEmailFor(id))).toBe(id);
  });

  it('returns null for emails that are not ours', () => {
    expect(assignmentIdFromEmail('someone@example.com')).toBeNull();
    expect(assignmentIdFromEmail('admin')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(assignmentIdFromEmail('')).toBeNull();
    expect(assignmentIdFromEmail(null)).toBeNull();
    expect(assignmentIdFromEmail(undefined)).toBeNull();
  });

  it('returns null for the bare prefix', () => {
    expect(assignmentIdFromEmail(CLIENT_EMAIL_PREFIX)).toBeNull();
  });
});
