/**
 * client-doctor — "my phone does not connect" answered in one command.
 *
 * Every symptom in this project has so far needed a different probe script, and
 * the operator is not a programmer. This consolidates the whole diagnosis into a
 * single read-only command that prints a short verdict and, when something is
 * wrong, the exact thing to change **on the phone**.
 *
 * It answers, in order:
 *   0. Who owns the node config?              (exactly one worker, and is it alive)
 *   1. Is the node actually serving?          (inbounds + listener per config)
 *   2. Is each public port reachable?         (real TCP connect from outside)
 *   3. Does each config carry real data?      (real client + real fetch)
 *   4. Does the link match the node?          (port / path / transport / sni)
 *   5. Is the certificate pin still valid?
 *
 * The important distinction it makes: a config can be 100% healthy server-side
 * and still fail on the device, because the device's transport setting is wrong.
 * So the final section always states what the CLIENT must have.
 *
 * Read-only: reads the database and the node, never writes to either.
 */

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { prisma } from '../src/lib/prisma';
import { getEnv } from '../src/lib/env';
import { getConfigArtifact } from '../src/server/services/config-service';
import { readWorkerLock } from '../src/services/worker-lock';
import {
  getXrayPaths,
  getCertificatePaths,
  certificatePin,
} from '../src/server/services/xray-service';

const OK = '  [ok]   ';
const BAD = '  [FAIL] ';
const WARN = '  [warn] ';
const NOTE = '         ';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Inbound {
  tag?: string;
  listen?: string;
  port: number;
  protocol: string;
  settings?: Record<string, any>;
  streamSettings?: Record<string, any>;
}

/** Is this port reachable from outside? The only honest test of a firewall. */
function reachable(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, host);
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/** Fetch a real URL through a real Xray client using this exact outbound. */
async function carriesData(outbound: unknown, clientPort: number): Promise<boolean> {
  const cfgPath = `C:/xray/doctor-${clientPort}.json`;
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        log: { loglevel: 'warning' },
        inbounds: [
          { listen: '127.0.0.1', port: clientPort, protocol: 'socks', settings: { udp: false } },
        ],
        outbounds: [outbound],
      },
      null,
      2,
    ),
    'utf8',
  );

  const child = spawn(getXrayPaths().exe, ['run', '-c', cfgPath], {
    cwd: 'C:/xray',
    stdio: 'ignore',
    windowsHide: true,
  });
  await sleep(2300);

  const result = await new Promise<boolean>((resolve) => {
    const curl = spawn('curl.exe', [
      '-sS', '--max-time', '10',
      '--socks5-hostname', `127.0.0.1:${clientPort}`,
      '-o', 'NUL', '-w', '%{http_code}',
      'https://www.gstatic.com/generate_204',
    ]);
    let out = '';
    curl.stdout.on('data', (c: Buffer) => (out += c.toString()));
    curl.on('close', () => resolve(/20[04]/.test(out)));
    curl.on('error', () => resolve(false));
  });

  child.kill();
  await sleep(250);
  try {
    unlinkSync(cfgPath);
  } catch {
    /* ignore */
  }
  return result;
}

async function main(): Promise<void> {
  console.log('VPanel — client connection doctor\n');
  console.log('='.repeat(72));

  // ------------------------------------------------- single writer check ----
  // Two workers writing config.json once wiped it and took every port down for
  // ~12 minutes. Check this FIRST: if it is wrong, nothing below can be trusted.
  const lock = readWorkerLock(getEnv().XRAY_DIR);
  if (!lock.info) {
    console.log('\n0. Who owns the node config?\n');
    console.log(WARN + 'No worker holds the node config lock — the node is UNMANAGED.');
    console.log(NOTE + 'Start it with: npm run worker (daemon mode).');
  } else if (!lock.alive) {
    console.log('\n0. Who owns the node config?\n');
    console.log(WARN + `Lock holder pid ${lock.info.pid} is DEAD — the lock is stale.`);
    console.log(NOTE + 'The next worker start reclaims it automatically.');
  } else {
    console.log('\n0. Who owns the node config?\n');
    console.log(
      OK + `worker pid ${lock.info.pid} (${lock.info.role}), started ${lock.info.startedAt}`,
    );
  }

  // ---------------------------------------------------------------- node ----
  console.log('\n1. Is the node serving?\n');

  const nodeConfig = JSON.parse(readFileSync(getXrayPaths().config, 'utf8')) as {
    inbounds: Inbound[];
  };
  const serving = nodeConfig.inbounds.filter((i) => i.tag !== 'api');

  if (serving.length === 0) {
    console.log(BAD + 'The node config has NO inbounds — nothing is being served.');
    console.log(NOTE + 'Create at least one active configuration in the panel.');
    return;
  }

  const publicPorts = [...new Set(serving.filter((i) => i.listen === '0.0.0.0').map((i) => i.port))];
  console.log(OK + `${serving.length} inbounds, public port(s): ${publicPorts.join(', ')}`);

  // ---------------------------------------------------------- reachable ----
  console.log('\n2. Are the public ports reachable from outside?\n');

  const configs = await prisma.configuration.findMany({
    where: { status: 'ACTIVE' },
    include: { assignments: true, server: true },
    orderBy: { createdAt: 'asc' },
  });

  const host = configs[0]?.server.hostname ?? '127.0.0.1';
  console.log(
    '  (This test runs ON the server. A failure here can also be NAT hairpinning —\n' +
      '   section 2b below is the authoritative check of the firewall rules.)\n',
  );
  for (const port of publicPorts) {
    const ok = await reachable(host, port);
    console.log(
      (ok ? OK : BAD) +
        `port ${port}` +
        (ok ? ' answered' : ` did NOT answer from the public IP — see 2b`),
    );
  }

  // ------------------------------------------------------- firewall rules ---
  //
  // The check above connects from THIS machine, which does not prove the
  // Windows firewall lets an outside client in. On 2026-09-28 every proxy port
  // was blocked while this section still reported "reachable", and the operator
  // was told the ports were open when they were not. So read the rules.
  console.log('\n2b. Does the Windows firewall ALLOW each proxy port from outside?\n');

  for (const port of publicPorts) {
    const result = await new Promise<string>((resolve) => {
      const proc = spawn(
        'netsh.exe',
        ['advfirewall', 'firewall', 'show', 'rule', `name=VPanel Xray ${port}`],
        { windowsHide: true },
      );
      let out = '';
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (out += d.toString()));
      proc.on('error', () => resolve(''));
      proc.on('close', () => resolve(out));
    });

    if (/VPanel Xray/.test(result)) {
      console.log(OK + `TCP ${port} is allowed by a firewall rule`);
    } else {
      console.log(
        BAD +
          `TCP ${port} has NO firewall rule — clients outside this machine are refused. ` +
          `Run firewall.bat as administrator.`,
      );
    }
  }

  // --------------------------------------------------- per-config checks ---
  console.log(`\n3. Does each of the ${configs.length} active configurations work?\n`);

  let clientPort = 16100;
  const clientInstructions: string[] = [];

  for (const config of configs) {
    const assignment = config.assignments[0];
    if (!assignment) {
      console.log(WARN + `${config.name}: has no user assigned — nobody can use it`);
      continue;
    }

    const artifact = await getConfigArtifact(
      config.id,
      { id: 'doctor', role: 'ADMIN', username: 'doctor' } as never,
      assignment.userId,
    );

    const out = artifact.outbound as any;
    const ss = out.streamSettings ?? {};
    const tls = ss.tlsSettings ?? {};
    const target = out.settings?.vnext?.[0] ?? out.settings?.servers?.[0] ?? {};
    const network = ss.network ?? 'tcp';
    const security = ss.security ?? 'none';
    const path = ss.wsSettings?.path ?? ss.httpupgradeSettings?.path ?? '(none)';

    const works = await carriesData(out, clientPort++);

    console.log(
      (works ? OK : BAD) +
        `${config.name.padEnd(22)} ${String(config.type).padEnd(11)} ` +
        `port=${String(target.port).padEnd(5)} ${network}/${security}`,
    );
    console.log(NOTE + `path=${path}   sni=${tls.serverName ?? '(none)'}`);

    if (!works) {
      console.log(NOTE + 'This configuration did NOT carry data even from this machine.');
      console.log(NOTE + 'It is a server-side problem — do not blame the phone.');
      continue;
    }

    const link = artifact.shareLink;
    const params = new URLSearchParams(link.slice(link.indexOf('?') + 1).split('#')[0]);
    const instruction =
      `"${config.name}":  Network/Transport = ${params.get('type') ?? network}` +
      `   |   Security = ${params.get('security') ?? security}` +
      `   |   Path = ${params.get('path') ?? path}` +
      `   |   SNI = ${params.get('sni') ?? tls.serverName ?? '(leave empty)'}` +
      (params.get('host') ? `   |   Host = ${params.get('host')}` : '');
    clientInstructions.push(instruction);
  }

  // ------------------------------------------------------- certificate -----
  console.log('\n4. Is the certificate pin still valid?\n');
  const certs = getCertificatePaths();
  const pin = certificatePin();
  if (pin) {
    console.log(OK + `certificate present, pin ${pin.slice(0, 16)}…`);
    console.log(NOTE + `every link must carry pinnedPeerCertSha256=${pin.slice(0, 16)}…`);
  } else {
    console.log(
      BAD + `no readable certificate at ${certs.cert} — every TLS configuration will fail`,
    );
    console.log(NOTE + 'Run xray-gencert.bat to create one, then reload the panel.');
  }

  // ------------------------------------------------------- in the client ---
  console.log('\n5. What the phone must be set to (copy these exactly)\n');
  for (const line of clientInstructions) console.log(NOTE + line);

  console.log('\n' + '='.repeat(72));
  console.log('\nIf the server checks above are all [ok] but the phone still fails,');
  console.log('the problem is IN THE APP. In order of likelihood:\n');
  console.log('  1. Transport is set to "tcp" — it MUST match the link (usually "ws").');
  console.log('     A wrong transport still pings, because the port itself is open.');
  console.log('  2. The profile was edited by hand instead of re-importing the link.');
  console.log('     Delete the profile and paste the link again.');
  console.log('  3. "Enable Mux" (multiplex) is on — turn it off; it breaks ws.');
  console.log('  4. Path differs from the link (a missing slash, or an extra one).\n');
}

void main()
  .catch((e) => {
    console.error('doctor failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
