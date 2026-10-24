/**
 * TLS certificate status.
 *
 * There is exactly ONE certificate for the whole node, and the panel attaches it
 * to every TLS configuration automatically — the operator never enters it. The
 * only thing worth surfacing is whether it exists, because without it the
 * renderer silently skips every TLS configuration (Trojan, VLESS+TLS, anything
 * sharing a port) and the operator is left with a configuration that was created
 * successfully but never connects.
 *
 * This lives in a service rather than the route file because a Next.js route
 * module may only export request handlers.
 */

/** What the panel needs to know about the node's TLS certificate. */
export interface CertificateStatus {
  /** True only when BOTH halves of the pair are present. */
  present: boolean;
  certExists: boolean;
  keyExists: boolean;
  /** The certificate's SHA-256 — the value pinned into every TLS client. */
  pin: string | null;
  /** Short form for display; a full pin is unreadable in a form field. */
  pinShort: string | null;
  certPath: string;
  keyPath: string;
  /**
   * Whether TLS configurations will actually be served. A missing pair means
   * they are skipped, however healthy everything else looks.
   */
  tlsConfigsWillServe: boolean;
  nodeRunning: boolean;
  /** The fix, phrased for a non-programmer. Null when nothing is wrong. */
  fix: string | null;
}

/**
 * Build the certificate status from the filesystem and the node's state.
 *
 * Dependencies are injected so this is unit-testable — which is what keeps the
 * endpoint's shape honest. The panel once crashed because this payload was
 * declared as an envelope the API client had already unwrapped, and TypeScript
 * could not catch it (the annotation was a lie, not a mismatch).
 */
export function buildCertificateStatus(
  paths: { cert: string; key: string },
  options: {
    fileExists: (path: string) => boolean;
    readPin: () => string | null;
    nodeRunning: boolean;
  },
): CertificateStatus {
  const certExists = options.fileExists(paths.cert);
  const keyExists = options.fileExists(paths.key);
  const present = certExists && keyExists;
  const pin = certExists ? options.readPin() : null;

  return {
    present,
    certExists,
    keyExists,
    pin,
    pinShort: pin ? `${pin.slice(0, 16)}…` : null,
    certPath: paths.cert,
    keyPath: paths.key,
    tlsConfigsWillServe: present,
    nodeRunning: options.nodeRunning,
    fix: present ? null : 'Run xray-gencert.bat to create the certificate.',
  };
}
