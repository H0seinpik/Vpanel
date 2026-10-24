/**
 * Path normalisation for path-based transports (ws / http / h2 / httpupgrade).
 *
 * THE BUG THIS FIXES
 * ------------------
 * The node renderer and the share-link generator disagreed about an empty path:
 *
 *   - `buildStreamSettings()` did `path: path || '/'`  → the NODE served `/`.
 *   - `buildQuery()` skips `''` values entirely       → the LINK carried no
 *     `path=` at all.
 *
 * So a configuration saved with an empty path produced a node expecting `/` and
 * a link that said nothing. Some clients happen to default to `/` and work;
 * others send their own default or nothing, the path matches no route, and the
 * port still pings — the classic "connects but no data" report. Observed on the
 * live node 2026-09-28: `params.path === ""`, `wsSettings.path === "/"`, and a
 * share link with no path parameter whatsoever.
 *
 * The fix is to normalise the path ONCE, at validation time, so every consumer
 * (node renderer, share link, QR payload, client config file) reads the same
 * non-empty value. It is better still to refuse a path that cannot work at all.
 *
 * Pure and dependency-free so it is unit-testable.
 */

/** Transports that route on a request path and therefore need one set. */
export const PATH_BASED_NETWORKS = ['ws', 'http', 'h2', 'httpupgrade'] as const;

/** The path used when a path-based transport is configured without one. */
export const DEFAULT_PATH = '/';

/** A path the certificate-fingerprint trap produces: 16+ hex characters. */
const FINGERPRINT_LIKE = /^\/?[0-9a-fA-F]{16,}$/;

export type PathProblem =
  | { ok: true; value: string }
  | { ok: false; reason: string; fix: string };

/**
 * Normalise a path for `network`.
 *
 * Returns the value to store, or a refusal when the value cannot work. An empty
 * or whitespace-only path is accepted for a path-based transport and becomes
 * `DEFAULT_PATH` — that is the case that used to produce a link with no path.
 * For a transport with no path concept the value is dropped entirely.
 */
export function normalizePath(network: string, raw: unknown): PathProblem {
  const isPathBased = (PATH_BASED_NETWORKS as readonly string[]).includes(network);

  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!isPathBased) {
    // `tcp`, `grpc`, `kcp`, `quic` have no path. Keeping a stale one would only
    // confuse the next reader, so drop it.
    return { ok: true, value: '' };
  }

  if (value === '' || value === '/') {
    return { ok: true, value: DEFAULT_PATH };
  }

  if (FINGERPRINT_LIKE.test(value)) {
    return {
      ok: false,
      reason:
        'this looks like a certificate fingerprint, not a path. The wizard shows the ' +
        'pin in a green box and it is easy to copy the wrong value.',
      fix: `Use a short path such as ${DEFAULT_PATH}vp-main`,
    };
  }

  if (!value.startsWith('/')) {
    return {
      ok: false,
      reason: 'a path must start with "/" (for example /vp-main)',
      fix: `Add the leading slash: /${value}`,
    };
  }

  if (value.includes(' ') || value.includes('#')) {
    return {
      ok: false,
      reason: 'a path cannot contain spaces or "#"',
      fix: 'Use only letters, digits, "-", "_" and "/"',
    };
  }

  return { ok: true, value };
}

/**
 * Does this configuration's path survive a round trip through the share link?
 *
 * `buildQuery()` drops empty values, so a path that normalises to `''` while the
 * node still needs one is precisely the mismatch above. Provided so the wizard
 * and the diagnostics can assert "what the phone will read equals what the node
 * serves".
 */
export function pathSurvivesLink(network: string, normalizedPath: string): boolean {
  const isPathBased = (PATH_BASED_NETWORKS as readonly string[]).includes(network);
  if (!isPathBased) return true;
  return normalizedPath !== '';
}
