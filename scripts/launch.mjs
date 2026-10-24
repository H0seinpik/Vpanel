/**
 * VPanel launcher — start the panel and the worker as detached processes.
 *
 *   node scripts/launch.mjs [--port 3000] [--no-web] [--no-worker]
 *
 * Why not PowerShell's Start-Process: in this environment the process
 * environment contains BOTH `Path` and `PATH`, and `Start-Process` with
 * `-RedirectStandardOutput` throws
 *   "Item has already been added. Key in dictionary: 'Path' Key being added: 'PATH'"
 * leaving the stack half-started with null pids. Node's `spawn({detached:true})`
 * + `unref()` is the equivalent detach and has no such failure mode, so the
 * launcher lives here and `windows/start.ps1` simply calls it.
 *
 * The children are detached and their stdio is redirected to the project's own
 * log files, so they survive this process exiting — which is the whole point.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STATE_DIR = join(ROOT, '.vpanel');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = value('port', '3000');
const NODE = value('node', process.execPath);
const XRAY_DIR = (() => {
  if (process.env.XRAY_DIR) return process.env.XRAY_DIR;
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^\s*XRAY_DIR\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, '');
  }
  return 'C:\\xray';
})();

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** A live worker already owns the node config — never start a second one. */
function liveWorkerPid() {
  const lock = join(XRAY_DIR, '.vpanel-worker.lock');
  if (!existsSync(lock)) return null;
  try {
    const info = JSON.parse(readFileSync(lock, 'utf8'));
    const pid = Number(info?.pid);
    return pid && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function spawnDetached(label, args, outName) {
  const out = openSync(join(STATE_DIR, `${outName}.log`), 'a');
  const err = openSync(join(STATE_DIR, `${outName}.log.err`), 'a');
  const child = spawn(NODE, args, {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  console.log(`${label} started (pid ${child.pid})`);
  return child.pid;
}

const pids = {};

if (!flag('no-worker')) {
  const existing = liveWorkerPid();
  if (existing) {
    console.log(`worker already running (pid ${existing}) - reusing it`);
    pids.workerPid = existing;
  } else {
    pids.workerPid = spawnDetached('worker', [
      '--env-file=.env', '--import', 'tsx', 'workers/index.ts', 'daemon',
    ], 'worker');
  }
}

if (!flag('no-web')) {
  pids.webPid = spawnDetached('web server', [
    '--env-file=.env', 'node_modules/next/dist/bin/next', 'start', '-p', String(PORT),
  ], 'web');
}

// Merge into runtime.json so stop.ps1 / status.bat keep working.
const statePath = join(STATE_DIR, 'runtime.json');
let previous = {};
try {
  previous = JSON.parse(readFileSync(statePath, 'utf8'));
} catch {
  /* first run */
}
writeFileSync(statePath, JSON.stringify({
  ...previous,
  mode: 'native',
  port: Number(PORT),
  webPid: pids.webPid ?? previous.webPid ?? null,
  workerPid: pids.workerPid ?? previous.workerPid ?? null,
  startedAt: new Date().toISOString(),
}, null, 2), 'utf8');

console.log(`runtime.json updated (web=${pids.webPid ?? 'n/a'} worker=${pids.workerPid ?? 'n/a'})`);
