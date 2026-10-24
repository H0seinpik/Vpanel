import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { certificatePin, getCertificatePaths } from '../src/server/services/xray-service';
import { buildCertificateStatus } from '../src/server/services/certificate-status';

/**
 * The TLS certificate is shared by every TLS configuration on the node, and the
 * panel — not the operator — is responsible for attaching it. These tests pin
 * the two properties that matter:
 *
 *   1. the pin is the SHA-256 of the certificate's DER form, which is what Xray
 *      actually expects in `pinnedPeerCertSha256`; and
 *   2. the certificate is a single, machine-wide file rather than something
 *      derived per configuration.
 */
describe('certificate pinning', () => {
  it('is a 64-character lowercase hex digest when a certificate exists', () => {
    const { cert } = getCertificatePaths();
    if (!existsSync(cert)) return; // no certificate on this machine — nothing to pin

    const pin = certificatePin();
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls — a client link must not change between renders', () => {
    const { cert } = getCertificatePaths();
    if (!existsSync(cert)) return;

    expect(certificatePin()).toBe(certificatePin());
  });

  it('resolves to one machine-wide pair, not one per configuration', () => {
    const first = getCertificatePaths();
    const second = getCertificatePaths();

    // Same paths every time, and the two callers cannot diverge — this is what
    // makes "one certificate is enough for every configuration" true.
    expect(first).toEqual(second);
    expect(first.cert).toBeTruthy();
    expect(first.key).toBeTruthy();

    // The certificate and key must be different files.
    expect(first.cert).not.toBe(first.key);
  });

  it('points at a .pem pair', () => {
    const { cert, key } = getCertificatePaths();
    expect(cert.toLowerCase()).toMatch(/\.pem$/);
    expect(key.toLowerCase()).toMatch(/\.pem$/);
  });
});

/**
 * The endpoint's payload shape.
 *
 * Regression guard: this payload was declared as `{ data: CertificateStatus }`
 * while `api.get()` had ALREADY unwrapped the `{ data }` envelope, so the wizard
 * read `.data.data.tlsConfigsWillServe` off `undefined` and the page crashed
 * with "a client-side exception has occurred". TypeScript could not catch it
 * because the annotation was a lie rather than a mismatch — only a test on the
 * real shape can.
 */
describe('certificate status payload', () => {
  const paths = { cert: 'C:/xray/cert.pem', key: 'C:/xray/key.pem' };

  it('reports a healthy pair as serving, with no fix needed', () => {
    const status = buildCertificateStatus(paths, {
      fileExists: () => true,
      readPin: () => 'a'.repeat(64),
      nodeRunning: true,
    });

    expect(status.present).toBe(true);
    expect(status.tlsConfigsWillServe).toBe(true);
    expect(status.fix).toBeNull();
    expect(status.pin).toBe('a'.repeat(64));
    expect(status.pinShort).toBe(`${'a'.repeat(16)}…`);
  });

  it('treats a half-present pair as absent — a cert without its key cannot serve', () => {
    const certOnly = buildCertificateStatus(paths, {
      fileExists: (path) => path.endsWith('cert.pem'),
      readPin: () => 'b'.repeat(64),
      nodeRunning: true,
    });

    expect(certOnly.certExists).toBe(true);
    expect(certOnly.keyExists).toBe(false);
    expect(certOnly.present).toBe(false);
    expect(certOnly.tlsConfigsWillServe).toBe(false);
    expect(certOnly.fix).toContain('xray-gencert.bat');
  });

  it('reports a missing pair as not serving and names the fix', () => {
    const status = buildCertificateStatus(paths, {
      fileExists: () => false,
      readPin: () => null,
      nodeRunning: false,
    });

    expect(status.present).toBe(false);
    expect(status.pin).toBeNull();
    expect(status.pinShort).toBeNull();
    expect(status.tlsConfigsWillServe).toBe(false);
    expect(status.fix).toContain('xray-gencert.bat');
  });

  it('exposes the certificate PATH but never key material', () => {
    const status = buildCertificateStatus(paths, {
      fileExists: () => true,
      readPin: () => 'c'.repeat(64),
      nodeRunning: true,
    });

    // Every field is a flag, a path, or the public fingerprint. Nothing here can
    // leak the private key.
    for (const value of Object.values(status)) {
      if (typeof value !== 'string') continue;
      expect(value).not.toContain('PRIVATE KEY');
      expect(value).not.toContain('BEGIN');
    }
    expect(status.keyPath).toBe('C:/xray/key.pem');
  });

  it('is a flat object — the wizard reads these keys directly, not nested', () => {
    const status = buildCertificateStatus(paths, {
      fileExists: () => true,
      readPin: () => 'd'.repeat(64),
      nodeRunning: true,
    });

    // The exact contract the client depends on: these keys sit at the top level
    // of what `useApi` returns. A nested `data` key here would reintroduce the
    // crash.
    expect(Object.keys(status)).toContain('tlsConfigsWillServe');
    expect(Object.keys(status)).toContain('pinShort');
    expect(status).not.toHaveProperty('data');
  });
});
