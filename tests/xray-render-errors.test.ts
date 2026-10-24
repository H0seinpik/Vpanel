import { describe, expect, it } from 'vitest';
import { describeRenderFailure } from '../src/server/services/xray-service';

/**
 * The "skipped configurations" list is the only place an operator finds out why
 * a configuration is not being served. It has to read like a sentence, not like
 * a JSON dump.
 */
describe('describeRenderFailure', () => {
  it('turns a Zod issue list into a readable reason', () => {
    const zodLike = {
      issues: [
        { path: ['address'], message: 'Required' },
        { path: ['port'], message: 'Expected number, received string' },
      ],
    };

    expect(describeRenderFailure(zodLike)).toBe(
      'address Required; port Expected number, received string',
    );
  });

  it('caps the number of reported issues', () => {
    const zodLike = {
      issues: Array.from({ length: 10 }, (_, i) => ({ path: [`field${i}`], message: 'bad' })),
    };

    const result = describeRenderFailure(zodLike);
    expect(result.split(';')).toHaveLength(3);
  });

  it('collapses a multi-line error message onto one line', () => {
    const error = new Error('something went\n  wrong\n  here');
    expect(describeRenderFailure(error)).toBe('something went wrong here');
  });

  it('handles a thrown non-Error', () => {
    expect(describeRenderFailure('just a string')).toBe('just a string');
  });

  it('truncates a very long message', () => {
    const result = describeRenderFailure(new Error('x'.repeat(500)));
    expect(result.length).toBeLessThanOrEqual(160);
  });
});
