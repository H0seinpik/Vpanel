/**
 * Client identity.
 *
 * Every credential the panel writes into a node config carries a stable
 * `email`, and that email is the ONLY key the node reports traffic back with.
 * It must therefore be:
 *
 *   - derived from the ConfigAssignment (not the user), because a user may hold
 *     several configurations and each must be accounted separately;
 *   - unambiguous, so `assignmentId` is used in full rather than a suffix;
 *   - prefixed, so panel-managed clients are distinguishable from anything else
 *     an operator might have configured on the node by hand.
 *
 * Lives here (rather than in the worker) so both the traffic worker and the
 * Xray supervisor can share it without a layering violation.
 */

export const CLIENT_EMAIL_PREFIX = 'vp-';

export function clientEmailFor(assignmentId: string): string {
  return `${CLIENT_EMAIL_PREFIX}${assignmentId}`;
}

/** Reverse of `clientEmailFor`. Returns null for anything not ours. */
export function assignmentIdFromEmail(email: string | null | undefined): string | null {
  if (!email || !email.startsWith(CLIENT_EMAIL_PREFIX)) return null;
  const id = email.slice(CLIENT_EMAIL_PREFIX.length);
  return id.length > 0 ? id : null;
}
