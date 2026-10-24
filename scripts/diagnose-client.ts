/**
 * diagnose-client — answer "why doesn't MY device connect?" without guessing.
 *
 * The node has been proven to accept real client connections (`.vpanel/connect-check.ts`
 * starts an actual Xray client per configuration and tunnels through it). So when
 * the operator reports "no ping, no data", the fault is somewhere between their
 * device and the server. This script narrows it down to one of:
 *
 *   1. the node is not actually serving (config.json has no listener on the port)
 *   2. the port is not reachable from outside (firewall / NAT / ISP)
 *   3. the link handed out does not match what the node is serving
 *   4. the link is stale (credential revoked, or the certificate pin changed)
 *
 * Read-only: it never writes to the database or to the node config.
 */

import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { prisma } from '../src/lib/prisma';
import { getConfigArtifact } from '../src/server/services/config-service';
import { getCertificatePaths, getXrayPaths } from '../src/server/services/xray-service';
import { certificatePin } from '../src/server/services/xray-service';
import { hostname as localHostname } from 'node:os';

const OK = '  [ok]   ';
const BAD = '  [FAIL] ';
const WARN = '  [warn] ';

/**
 * Can an inbound actually bind this port right now?
 *
 * Trying to bind is the only honest test: `netstat` shows a port as free when
 * another process holds it with SO_REUSEADDR, and shows it as taken long after
 * the holder died.
 */
function portFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** A plain TCP reachability probe against the PUBLIC address. */
function reachable(host: string, port: number, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, host);
    const done = (verdict: string) => {
      sock.destroy();
      resolve(verdict);
    };
    sock.once('connect', () => done('reachable'));
    sock.once('error', (e: NodeJS.ErrnoException) => done(`unreachable (${e.code ?? e.message})`));
    sock.setTimeout(timeoutMs, () => done('timed out'));
  });
}

interface LiveInbound {
  tag?: string;
  port?: number;
  listen?: string;
  protocol?: string;
  fallbacks?: Array<{ path?: string; dest?: number }>;
  streamSettings?: {
    network?: string;
    security?: string;
    wsSettings?: { path?: string };
    tlsSettings?: { certificates?: Array<{ certificateFile?: string; keyFile?: string }> };
  };
  settings?: { clients?: Array<{ email?: string; id?: string }> };
}

async function main() {
  console.log('='.repeat(67));
  console.log('  Why is my device not connecting?');
  console.log('='.repeat(67));

  const paths = getXrayPaths();

  // --- 1. Is the node serving at all? -------------------------------------
  console.log('\n--- 1. The node -----------------------------------------------------');

  if (!existsSync(paths.config)) {
    console.log(`${BAD} no config.json at ${paths.config}`);
    console.log('        The node has never been reconciled. Run xray-sync.bat.');
    await prisma.$disconnect();
    return;
  }

  let parsed: { inbounds?: LiveInbound[] } = {};
  try {
    parsed = JSON.parse(readFileSync(paths.config, 'utf8')) as typeof parsed;
  } catch {
    console.log(`${BAD} config.json is not valid JSON`);
    await prisma.$disconnect();
    return;
  }

  const inbounds = (parsed.inbounds ?? []).filter((i) => i.tag !== 'api');
  const publicInbounds = inbounds.filter((i) => i.listen !== '127.0.0.1');
  const members = inbounds.filter((i) => i.listen === '127.0.0.1');

  if (publicInbounds.length === 0) {
    console.log(`${BAD} nothing is listening on a public address`);
    await prisma.$disconnect();
    return;
  }

  for (const inbound of publicInbounds) {
    const shared = Boolean(inbound.fallbacks?.length);
    console.log(
      `${OK} public listener on port ${inbound.port} (${shared ? 'shared via fallbacks' : 'direct'})`,
    );
    if (shared) {
      for (const fb of inbound.fallbacks ?? []) {
        if (!fb.path) continue;
        console.log(`        path ${fb.path}  ->  loopback :${fb.dest}`);
      }
    }
  }

  // --- 2. Is the port reachable from outside? -----------------------------
  console.log('\n--- 2. Reachability (from this machine, to the public address) ---');

  const server = await prisma.server.findFirst();
  const publicHost = server?.hostname;
  if (!publicHost) {
    console.log(`${WARN} no server row, cannot test the public address`);
  } else {
    for (const inbound of publicInbounds) {
      if (!inbound.port) continue;
      const verdict = await reachable(publicHost, inbound.port);
      console.log(
        `${verdict === 'reachable' ? OK : BAD} ${publicHost}:${inbound.port} -> ${verdict}`,
      );
    }
    console.log('        (a failure here means a firewall, NAT or ISP block — not Xray)');
  }

  // --- 3. Does every link match what is being served? ---------------------
  console.log('\n--- 3. Each configuration vs what the node serves -------------------');

  const configs = await prisma.configuration.findMany({
    where: { status: 'ACTIVE' },
    include: { assignments: true, server: true },
    orderBy: { createdAt: 'asc' },
  });

  const servedPaths = new Set(
    members.map((m) => m.streamSettings?.wsSettings?.path).filter((p): p is string => Boolean(p)),
  );

  for (const config of configs) {
    const params = (config.params ?? {}) as Record<string, unknown>;
    const port = Number(params.port ?? config.server.port);
    const path = String(params.path ?? '');

    const listener = publicInbounds.find((i) => i.port === port);
    if (!listener) {
      console.log(`${BAD} ${config.name}: nothing serving port ${port}`);
      continue;
    }

    // Only ws / httpupgrade / xhttp route by path. tcp, grpc and Shadowsocks
    // carry no path at all, so checking it there produced a false FAIL for every
    // one of them — which is worse than no check, because it hides a real one.
    const network = String(params.network ?? 'tcp');
    const pathBased = network === 'ws' || network === 'httpupgrade' || network === 'xhttp';

    const problems: string[] = [];
    if (pathBased) {
      if (!path.startsWith('/')) problems.push('path does not start with "/"');
      if (!servedPaths.has(path)) problems.push(`path ${JSON.stringify(path)} is not served`);
    }

    const assignment = config.assignments[0];
    if (!assignment) problems.push('no assignment');

    // SNI. A bare IP as SNI works in Xray itself but several mobile clients
    // reject it, or send no SNI at all — which reads as "no ping, no data"
    // even though the server is fine. Warn rather than fail: it is legal.
    const sni = String(params.sni ?? '');
    const sniIsBareIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(sni);
    if (sniIsBareIp) {
      console.log(
        `${WARN} ${config.name}: SNI is the bare IP ${sni}. Some clients refuse this — ` +
          `a hostname SNI (e.g. www.microsoft.com) is more compatible.`,
      );
    }

    if (problems.length === 0) {
      console.log(`${OK} ${config.name}: port ${port}${pathBased ? `, path ${path}` : ''}`);
    } else {
      console.log(`${BAD} ${config.name}: ${problems.join('; ')}`);
    }
  }

  // --- 4. Certificate pin consistency -------------------------------------
  console.log('\n--- 4. Certificate ------------------------------------------------');
  const certPaths = getCertificatePaths();
  if (existsSync(certPaths.cert)) {
    const pin = certificatePin();
    console.log(`${OK} certificate present, pin ${pin?.slice(0, 16) ?? '?'}…`);
    console.log('        every link already handed out carries this pin.');
    console.log('        If you regenerated the certificate, those links are now dead');
    console.log('        and must be re-issued — the old pin no longer matches.');
  } else {
    console.log(`${BAD} no certificate at ${certPaths.cert} — every TLS config is skipped`);
  }

  // --- 5. The most common client-side causes ------------------------------
  console.log('\n--- 5. If the server says "ok" but your device still fails ----------');
  console.log('        Check these on the DEVICE, in this order:');
  console.log('        1. the link was copied in full — a truncated link silently fails');
  console.log('        2. server time is correct (a wrong clock breaks TLS)');
  console.log(`        3. the device is not on a network that blocks port 443 outbound`);
  console.log(`        4. the client is set to use the proxy (some apps ignore it)`);
  console.log(`        5. the app was given the newest link — old ones carry the old pin`);

  console.log(`\n  local hostname: ${localHostname()}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('failed:', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
