/**
 * doctor — one command that answers "is my panel actually working?".
 *
 *   npm run doctor            status + counters + config health
 *   npm run doctor -- --connect   also opens a real connection through every
 *                                 active configuration
 *
 * It is deliberately read-only apart from the connectivity probe, which starts
 * a temporary client process and kills it again. Nothing here writes to the
 * database or to the node config.
 *
 * Why it exists: the three symptoms that are hardest to diagnose from the UI —
 * "it will not connect", "the limit never fires", "traffic is not counted" —
 * all have silent failure modes. This prints the evidence for each.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { getEnv } from '../src/lib/env';
import { getConfigArtifact } from '../src/server/services/config-service';
import {
  certificatePin,
  getCertificatePaths,
  getLastStatsError,
  getXrayPaths,
  getXrayStatus,
  queryUserStats,
  renderXrayConfig,
} from '../src/server/services/xray-service';

const OK = '  [ok]   ';
const BAD = '  [FAIL] ';
const WARN = '  [warn] ';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The watchdog rewrites `.vpanel/watchdog.pid` on every loop (a heartbeat), so a
 * pid file that has not been touched for three intervals means the watchdog is
 * gone — the same rule `scripts/watchdog.mjs` uses to take over from a dead one.
 */
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_STALE_MS = WATCHDOG_INTERVAL_MS * 3;
/** The worker rewrites its heartbeat after every job; 4 minutes means wedged. */
const WORKER_STALE_MS = 240_000;

/** Is a process id alive? (EPERM means it exists but belongs to another user.) */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Does an HTTP endpoint answer 200? Used to prove the panel itself is up. */
function httpOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(url, { timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function formatBytes(bytes: bigint | number): string {
  const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** Minimal SOCKS5 CONNECT, used only to prove a configuration is reachable. */
function probeConnection(socksPort: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(socksPort, '127.0.0.1');
    let stage = 0;

    sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('data', (buf) => {
      if (stage === 0) {
        stage = 1;
        // TEST-NET-1: unroutable on purpose, so the probe never depends on
        // internet access. Reaching the reply is what proves the tunnel works.
        sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 192, 0, 2, 1, 0, 80]));
      } else if (stage === 1) {
        stage = 2;
        sock.write(Buffer.from('GET / HTTP/1.1\r\nHost: 192.0.2.1\r\nConnection: close\r\n\r\n'));
        setTimeout(() => {
          sock.destroy();
          resolve(buf[1] === 0x00 ? 'connected' : `refused (socks rep=0x${buf[1]?.toString(16)})`);
        }, 900);
      }
    });
    sock.on('error', (e) => resolve(`error: ${e.message}`));
    sock.setTimeout(7000, () => {
      sock.destroy();
      resolve('timed out');
    });
  });
}

/**
 * Are the three long-lived processes alive? The panel (web) answers HTTP; the
 * worker proves itself with a heartbeat file; the watchdog with its pid file.
 *
 * None of these is visible in the panel UI, and all three fail silently: a dead
 * panel looks like "cannot reach this page", a dead worker stops accounting and
 * ceiling enforcement, and a dead watchdog means nothing revives either one.
 */
async function checkSupervisors(): Promise<void> {
  console.log('\n--- Supervisors (panel / worker / watchdog) ------------------------');

  // Panel — the web server itself. Everything else is moot if this is down.
  const port = Number(process.env.PORT ?? 3000);
  const panelUp = await httpOk(`http://127.0.0.1:${port}/api/health`);
  console.log(
    `${panelUp ? OK : BAD} panel (web server) on port ${port}: ${panelUp ? 'answering' : 'NOT answering'}`,
  );

  // Worker — the ONLY writer of config.json and traffic_usage.
  const workerHeartbeat = join(getXrayPaths().dir, '.vpanel-worker.heartbeat');
  if (!existsSync(workerHeartbeat)) {
    console.log(`${WARN} worker heartbeat missing (${workerHeartbeat}) - is the worker running?`);
  } else {
    try {
      const hb = JSON.parse(readFileSync(workerHeartbeat, 'utf8')) as {
        pid?: number;
        updatedAt?: string;
      };
      const pid = Number(hb.pid);
      const ageMs = Date.now() - new Date(String(hb.updatedAt)).getTime();
      const alive = pidAlive(pid);
      const fresh = Number.isFinite(ageMs) && ageMs < WORKER_STALE_MS;
      if (alive && fresh) {
        console.log(`${OK} worker alive (pid ${pid}, heartbeat ${Math.round(ageMs / 1000)}s ago)`);
      } else {
        const when = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s ago` : 'unreadable';
        console.log(`${BAD} worker ${alive ? 'WEDGED' : 'DEAD'} (pid ${pid}, heartbeat ${when})`);
        console.log('        No accounting, no ceiling enforcement, no config updates.');
      }
    } catch {
      console.log(`${WARN} worker heartbeat unreadable (${workerHeartbeat})`);
    }
  }

  // Watchdog — keeps the panel, worker and Xray alive; started at sign-in.
  const watchdogPidFile = join(process.cwd(), '.vpanel', 'watchdog.pid');
  if (!existsSync(watchdogPidFile)) {
    console.log(`${WARN} watchdog NOT running (no ${watchdogPidFile})`);
    console.log('        Nothing will restart the panel if it stops.');
    console.log('        Start it with watchdog.bat, or reboot - it starts at sign-in.');
  } else {
    const pid = Number(readFileSync(watchdogPidFile, 'utf8').trim());
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - statSync(watchdogPidFile).mtimeMs;
    } catch {
      /* leave ageMs as Infinity */
    }
    const alive = pidAlive(pid);
    const fresh = ageMs < WATCHDOG_STALE_MS;
    if (alive && fresh) {
      console.log(`${OK} watchdog alive (pid ${pid}, heartbeat ${Math.round(ageMs / 1000)}s ago)`);
    } else {
      const when = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s ago` : 'unknown';
      console.log(`${BAD} watchdog ${alive ? 'STALE' : 'DEAD'} (pid ${pid}, heartbeat ${when})`);
      console.log('        Start it with watchdog.bat, or reboot - it starts at sign-in.');
    }
  }
}

async function checkConfigHealth(): Promise<void> {
  console.log('\n--- Rendered node config -------------------------------------------');

  const status = await getXrayStatus();
  console.log(`${status.running ? OK : BAD} Xray running: ${status.running ? 'yes' : 'NO'}`);
  console.log(`        directory: ${status.dir}`);
  console.log(`        inbounds : ${status.inbounds}  ports: ${status.ports.join(', ') || '(none)'}`);

  // Actually query the node rather than trusting cached state: the point of the
  // check is to prove the counters are reachable *now*.
  const counters = await queryUserStats();
  const statsError = getLastStatsError();

  if (statsError) {
    console.log(`${BAD} traffic counters unreadable: ${statsError}`);
    console.log('        Traffic cannot be counted while this persists.');
  } else if (!status.running) {
    console.log(`${WARN} node not running, so there is nothing to count yet`);
  } else {
    console.log(`${OK} traffic counters readable (${counters.size} client(s) tracked)`);
  }

  const paths = getXrayPaths();
  if (!existsSync(paths.config)) {
    console.log(`${WARN} no config.json at ${paths.config} yet`);
    return;
  }

  // Every TLS configuration — Trojan, VLESS+TLS, and anything sharing a port —
  // is skipped without a certificate pair. That is a silent, total failure for
  // those protocols, so check for it explicitly rather than letting the panel
  // report the configurations as merely "not serving".
  const certPaths = getCertificatePaths();
  const hasCert = existsSync(certPaths.cert);
  const hasKey = existsSync(certPaths.key);

  if (hasCert && hasKey) {
    const pin = certificatePin();
    console.log(`${OK} TLS certificate present (pin ${pin?.slice(0, 16) ?? '?'}...)`);
  } else {
    console.log(`${BAD} TLS certificate missing — every TLS configuration will be skipped`);
    console.log(`        cert: ${certPaths.cert} ${hasCert ? '' : '(MISSING)'}`);
    console.log(`        key : ${certPaths.key} ${hasKey ? '' : '(MISSING)'}`);
    console.log('        fix : run xray-gencert.bat to create the pair');
  }

  const raw = readFileSync(paths.config, 'utf8');

  // Xray 26 removed `allowInsecure`; a config carrying it fails to load at all.
  if (raw.includes('allowInsecure')) {
    console.log(`${BAD} config.json still contains "allowInsecure" - Xray 26 rejects this`);
  } else {
    console.log(`${OK} no legacy "allowInsecure" in config.json`);
  }

  let parsed: { inbounds?: Array<{ tag?: string; port?: number; protocol?: string }> } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    console.log(`${BAD} config.json is not valid JSON`);
    return;
  }

  const tags = (parsed.inbounds ?? []).map((i) => i.tag).filter((t): t is string => Boolean(t));
  const duplicates = tags.filter((tag, index) => tags.indexOf(tag) !== index);

  if (duplicates.length > 0) {
    // Xray refuses to start on a duplicate tag, which takes every inbound down.
    console.log(`${BAD} duplicate inbound tags: ${[...new Set(duplicates)].join(', ')}`);
  } else {
    console.log(`${OK} inbound tags unique (${tags.length})`);
  }

  const rendered = await renderXrayConfig();
  if (rendered.skipped.length > 0) {
    console.log(`${WARN} configurations not being served:`);
    for (const entry of rendered.skipped) console.log(`          - ${entry}`);
  }
}

async function checkConfigs(connectivity: boolean): Promise<void> {
  const configs = await prisma.configuration.findMany({
    include: { assignments: true, server: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log('\n--- Configurations -------------------------------------------------');
  console.log('  name                     type    status             port   used / limit');

  for (const config of configs) {
    const params = (config.params ?? {}) as Record<string, unknown>;
    const port = Number(params.port ?? config.server.port);
    const limit =
      config.trafficLimitBytes === null ? 'unlimited' : formatBytes(config.trafficLimitBytes);

    const usage = `${formatBytes(config.trafficUsedBytes)} / ${limit}`;
    const label = config.name.length > 22 ? `${config.name.slice(0, 21)}~` : config.name;

    console.log(
      `  ${label.padEnd(24)} ${config.type.padEnd(7)} ${config.status.padEnd(18)} ${String(port).padEnd(6)} ${usage}`,
    );
  }

  if (!connectivity) return;

  console.log('\n--- Connectivity test ----------------------------------------------');
  console.log('  (a temporary client is started for each ACTIVE configuration)');

  let socksPort = 10950;
  for (const config of configs) {
    if (config.status !== 'ACTIVE') continue;

    const assignment = config.assignments[0];
    if (!assignment) {
      console.log(`${WARN} ${config.name}: no assigned user, cannot render a client`);
      continue;
    }

    let artifact;
    try {
      artifact = await getConfigArtifact(
        config.id,
        { id: 'doctor', role: 'ADMIN', username: 'doctor' } as never,
        assignment.userId,
      );
    } catch (error) {
      console.log(`${BAD} ${config.name}: could not render a client - ${(error as Error).message}`);
      continue;
    }

    const clientConfigPath = join(getXrayPaths().dir, `doctor-client-${socksPort}.json`);
    writeFileSync(
      clientConfigPath,
      JSON.stringify(
        {
          log: { loglevel: 'warning' },
          inbounds: [
            { listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: false } },
          ],
          outbounds: [artifact.outbound],
        },
        null,
        2,
      ),
      'utf8',
    );

    const client = spawn(getXrayPaths().exe, ['run', '-c', clientConfigPath], {
      cwd: getXrayPaths().dir,
      stdio: 'ignore',
      windowsHide: true,
    });

    await sleep(2200);
    const result = await probeConnection(socksPort);
    client.kill();

    console.log(`${result === 'connected' ? OK : BAD} ${config.name}: ${result}`);
    socksPort += 1;
    await sleep(400);
  }
}

async function main(): Promise<void> {
  const connectivity = process.argv.includes('--connect');
  const env = getEnv();

  console.log('VPanel doctor');
  console.log('===================================================================');
  console.log(`  provider      : ${env.NODE_PROVIDER}`);
  console.log(`  xray enabled  : ${env.XRAY_ENABLED}`);
  console.log(`  xray dir      : ${env.XRAY_DIR}`);
  console.log(`  stats api     : 127.0.0.1:${env.XRAY_API_PORT} (loopback only)`);

  await checkSupervisors();
  await checkConfigHealth();
  await checkConfigs(connectivity);

  const users = await prisma.user.count();
  const ledger = await prisma.trafficUsage.count();
  console.log('\n--- Data -----------------------------------------------------------');
  console.log(`  users            : ${users}`);
  console.log(`  traffic records  : ${ledger}`);

  if (!connectivity) {
    console.log('\n  Tip: run "npm run doctor -- --connect" to test each config.');
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('\ndoctor failed:', error);
  await prisma.$disconnect();
  process.exit(1);
});
