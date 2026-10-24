/**
 * VPanel watchdog — keeps the panel, worker and Xray alive.
 *
 *   node scripts/watchdog.mjs
 *
 * Why this exists: VPanel is three long-lived processes (web, worker, xray) and
 * nothing supervises them. When they were started by hand they died with the
 * shell that launched them, and every proxy client lost its connection with no
 * recovery. This loop makes the stack self-healing.
 *
 * Every 60 s it checks:
 *   1. does GET /api/health answer 200?
 *   2. is the worker heartbeat file present, fresh, and its pid alive?
 *
 * After 2 consecutive bad checks it runs windows/start.ps1 (idempotent: it
 * reuses a healthy stack and starts only what is missing). If that does not fix
 * it, it does a full stop.ps1 + start.ps1.
 *
 * Single instance: a live watchdog makes a second one exit immediately.
 *
 * Started at sign-in from the per-user Startup folder; safe to run by hand.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LOG = join(ROOT, '.vpanel', 'watchdog.log');
const PID_FILE = join(ROOT, '.vpanel', 'watchdog.pid');
const START_SCRIPT = join(ROOT, 'windows', 'start.ps1');
const STOP_SCRIPT = join(ROOT, 'windows', 'stop.ps1');
const HEALTH_URL = 'http://127.0.0.1:3000/api/health';

const INTERVAL_MS = 60_000;
const FAILURES_TO_REPAIR = 2;
const STALE_HEARTBEAT_MS = 240_000;

function log(message) {
  const line = `${new Date().toISOString()}  ${message}\n`;
  try {
    writeFileSync(LOG, line, { flag: 'a' });
  } catch {
    /* non-fatal */
  }
}

/** XRAY_DIR from the environment, else .env, else C:\xray. */
function xrayDir() {
  if (process.env.XRAY_DIR) return process.env.XRAY_DIR;
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^\s*XRAY_DIR\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, '');
  }
  return 'C:\\xray';
}

function panelHealthy() {
  return new Promise((resolve) => {
    const req = get(HEALTH_URL, { timeout: 15_000 }, (res) => {
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return error?.code === 'EPERM';
  }
}

function readHeartbeatOnce() {
  const hb = join(xrayDir(), '.vpanel-worker.heartbeat');
  if (!existsSync(hb)) return false;
  const state = JSON.parse(readFileSync(hb, 'utf8'));
  if (!state?.pid || !pidAlive(Number(state.pid))) return false;
  const age = Date.now() - new Date(state.updatedAt).getTime();
  return Number.isFinite(age) && age < STALE_HEARTBEAT_MS;
}

/**
 * Is the worker alive and actually working?
 *
 * Retried once: the worker rewrites the heartbeat after every job, and a read
 * that lands mid-write must never be mistaken for "the worker is down" — that
 * would restart a perfectly healthy stack.
 */
async function workerFresh() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (readHeartbeatOnce()) return true;
    } catch {
      /* fall through to the retry */
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', ...args],
      { windowsHide: true, stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve('timeout');
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(`exit ${code}`);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      resolve(`spawn error ${error.message}`);
    });
  });
}

const runStart = () => runPowerShell(['-File', START_SCRIPT, '-NoBrowser'], 240_000);
const runStop = () => runPowerShell(['-File', STOP_SCRIPT], 90_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Single instance.
  //
  // The pid file alone is not enough: a dead process id can be recycled, and a
  // stale file then makes every new watchdog exit thinking one is already
  // running — which leaves the stack unguarded. So the file is rewritten on
  // every loop (a heartbeat) and a file that has not been touched for three
  // intervals is treated as stale.
  if (existsSync(PID_FILE)) {
    const existing = Number(readFileSync(PID_FILE, 'utf8').trim());
    const ageMs = Date.now() - statSync(PID_FILE).mtimeMs;
    const looksAlive = existing > 0 && pidAlive(existing);
    const looksCurrent = ageMs < INTERVAL_MS * 3;

    if (looksAlive && looksCurrent) {
      log(`another watchdog (pid ${existing}) is already running - exiting`);
      return;
    }
    log(
      `taking over the watchdog role from pid ${existing} ` +
        `(alive=${looksAlive} heartbeat age=${Math.round(ageMs / 1000)}s)`,
    );
  }
  writeFileSync(PID_FILE, String(process.pid), 'utf8');

  log(`watchdog started (pid ${process.pid}, interval ${INTERVAL_MS / 1000}s)`);

  // Bring the stack up on launch.
  //
  // This makes the watchdog a single entry point: start it (or let it start at
  // sign-in) and the panel comes up WITH it, instead of waiting for two failed
  // checks first. start.ps1 is idempotent, so an already-healthy stack is left
  // exactly as it is.
  if (!(await panelHealthy()) || !(await workerFresh())) {
    log('stack not healthy on launch - running start.ps1');
    log(`start.ps1 -> ${await runStart()}`);
    await sleep(20_000);
    log(
      (await panelHealthy()) && (await workerFresh())
        ? 'stack is up after launch'
        : 'stack still down after launch - the loop will keep retrying',
    );
  } else {
    log('stack already healthy on launch');
  }

  let failures = 0;

  for (;;) {
    try {
      // Heartbeat: proves this watchdog is alive to the next one.
      writeFileSync(PID_FILE, String(process.pid), 'utf8');

      const panelOk = await panelHealthy();
      const workerOk = await workerFresh();

      if (panelOk && workerOk) {
        if (failures > 0) log('stack healthy again');
        failures = 0;
      } else {
        failures += 1;
        log(`unhealthy check #${failures} (panel=${panelOk} worker=${workerOk})`);

        if (failures >= FAILURES_TO_REPAIR) {
          log('running start.ps1');
          log(`start.ps1 -> ${await runStart()}`);
          await sleep(25_000);

          if ((await panelHealthy()) && (await workerFresh())) {
            log('recovered after start.ps1');
          } else {
            log('still unhealthy - full restart (stop.ps1 then start.ps1)');
            log(`stop.ps1 -> ${await runStop()}`);
            await sleep(6_000);
            log(`start.ps1 -> ${await runStart()}`);
            await sleep(20_000);
            log(
              (await panelHealthy()) && (await workerFresh())
                ? 'recovered after full restart'
                : 'STILL DOWN after full restart - check worker.log and web.log',
            );
          }
          failures = 0;
        }
      }
    } catch (error) {
      log(`watchdog loop error: ${error?.message ?? error}`);
    }

    await sleep(INTERVAL_MS);
  }
}

void main();
