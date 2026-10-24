import { randomBytes } from 'node:crypto';

/**
 * REALITY — the transport security that needs no certificate at all.
 *
 * Why this exists: the node's TLS certificate is self-signed, so every client
 * that verifies a certificate against the system trust store rejects it. v2rayNG
 * works because the share link carries `pinnedPeerCertSha256`, an Xray-26-only
 * field — but the sing-box family (NekoBox, NekoRay, v2raybox) ignores that field
 * and fails with `x509: certificate signed by unknown authority`.
 *
 * REALITY removes the problem at the source: the client never verifies a
 * certificate against a CA. It authenticates the server with an x25519 public
 * key carried in the link, which Xray-core AND sing-box both support natively —
 * so one link works in every app with no client-side tweaks.
 *
 * Pure helpers only; the one thing that needs a process (`xray x25519`) lives in
 * xray-service next to the other external-binary calls.
 */

/** Where unauthenticated probes are forwarded, and the SNI they must present. */
export const REALITY_DEFAULTS = {
  /** Must speak TLS 1.3 with H2 and be reachable from the node. */
  dest: 'www.samsung.com:443',
  serverName: 'www.samsung.com',
} as const;

/**
 * Parse the output of `xray x25519`.
 *
 * Xray prints three lines and the wording has changed between versions, so match
 * loosely on the first token rather than the whole line:
 *
 *   PrivateKey: GJ72qeRe5P5VfatmnM6gcZPmUF8Cb59UJCV9Fr-pG04
 *   Password (PublicKey): wsvAk8IhkWdJ1KjukhPhctavmeR9nJDUggwl3MJaT3s
 *
 * Returns null when either value is missing, so the caller can report a real
 * error instead of persisting an unusable half-key.
 */
export function parseX25519Output(stdout: string): { privateKey: string; publicKey: string } | null {
  const privateKey = stdout.match(/PrivateKey\s*:\s*([A-Za-z0-9_-]+)/)?.[1];
  const publicKey = stdout.match(/PublicKey\s*\)?\s*:\s*([A-Za-z0-9_-]+)/)?.[1];

  if (!privateKey || !publicKey) return null;
  return { privateKey, publicKey };
}

/**
 * A REALITY short ID: 8 hex characters, as Xray expects (1-16 hex chars).
 *
 * Sent in every client hello; an empty one is legal but a random value makes the
 * handshake harder to fingerprint.
 */
export function randomShortId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * The `realitySettings` object for the SERVER inbound.
 *
 * Client and server carry different halves of the same keypair: the client link
 * holds `publicKey` (and Xray's own generator renders it), while only the server
 * may hold `privateKey`. `dest` is where unauthenticated probes are forwarded, so
 * a censor that connects without the key sees a genuine page from a real site.
 *
 * Returns null when there is no private key, because a REALITY inbound without
 * one cannot start at all — the caller turns that into an actionable skip reason
 * rather than publishing a config that takes the whole node down with it.
 */
export function serverRealitySettings(params: Record<string, unknown>): Record<string, unknown> | null {
  const privateKey = typeof params.privateKey === 'string' ? params.privateKey.trim() : '';
  if (!privateKey) return null;

  const dest = typeof params.realityDest === 'string' && params.realityDest.trim()
    ? params.realityDest.trim()
    : REALITY_DEFAULTS.dest;
  const serverName = typeof params.sni === 'string' && params.sni.trim()
    ? params.sni.trim()
    : REALITY_DEFAULTS.serverName;
  const shortId = typeof params.shortId === 'string' ? params.shortId.trim() : '';

  return {
    show: false,
    dest,
    xver: 0,
    serverNames: [serverName],
    privateKey,
    shortIds: shortId ? [shortId] : [''],
  };
}
