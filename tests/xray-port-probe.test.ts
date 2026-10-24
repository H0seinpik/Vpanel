import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The 2026-09-28 flapping outage: on the 15 s reconcile tick, every port was
 * bind-probed, including the ports Xray itself was already listening on. On
 * Windows the probe sometimes reported EADDRINUSE for our own listener, which
 * dropped the whole port group, changed the rendered hash, and restarted Xray —
 * so clients were disconnected every 1–2 minutes.
 *
 * `renderXrayConfig()` now takes the set of ports the running node already holds
 * and skips the probe for them.
 *
 * This is asserted against the source because `renderXrayConfig` touches Prisma
 * and the test environment has no database — the same technique used for the
 * login-form regression, where the bug lived in the generated output rather than
 * in a pure helper.
 */
const SRC = readFileSync(
  join(process.cwd(), 'src/server/services/xray-service.ts'),
  'utf8',
);

describe('renderXrayConfig — already-held ports are never probed', () => {
  it('accepts an `alreadyHeld` option', () => {
    expect(SRC).toMatch(/export async function renderXrayConfig\(/);
    expect(SRC).toMatch(/options:\s*\{\s*alreadyHeld\?:\s*readonly number\[\]\s*\}\s*=\s*\{\}/);
  });

  it('skips the bind probe for a port the running node already holds', () => {
    // The probe must be conditioned on `alreadyHeld`, never called blindly.
    expect(SRC).toMatch(/alreadyHeld\.has\(port\)\s*\?\s*null\s*:\s*await probePortBindable\(port\)/);
    expect(SRC).not.toMatch(/const liveConflict = await probePortBindable\(port\);/);
  });

  it('persists the applied ports so the next tick knows what is ours', () => {
    expect(SRC).toMatch(/appliedPorts\?:\s*number\[\]/);
    // Every successful apply records them.
    const writes = SRC.match(/writtenState|writeState\(\{/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(SRC).toMatch(/appliedPorts:\s*rendered\.ports/);
  });

  it('clears the recorded ports when nothing is served', () => {
    // Both the confirmed-empty wipe and the "Xray failed to start" path must
    // drop the claim, or a stale entry would let a contested port through.
    const clears = SRC.match(/appliedPorts:\s*\[\]/g) ?? [];
    expect(clears.length).toBe(2);
  });

  it('only treats ports as ours while the node is actually running', () => {
    expect(SRC).toMatch(/const alreadyHeld = nodeRunning \? previous\.appliedPorts \?\? \[\] : \[\]/);
  });
});
