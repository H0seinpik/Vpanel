/**
 * xray-sync — apply the panel's configurations to the local Xray instance.
 *
 *   npm run xray:sync
 *   XRAY_DIR=D:\xray npm run xray:sync
 *
 * This is now a thin wrapper around the supervisor in
 * `src/server/services/xray-service.ts`, which the background worker also uses.
 * The panel keeps the node in sync automatically, so this script exists for
 * applying a change immediately (or after editing the database by hand) rather
 * than as a required manual step.
 *
 * What it does
 *   1. Renders every ACTIVE configuration into a node config.
 *   2. Compares it with the one currently applied.
 *   3. Writes and restarts Xray only if it actually changed.
 *
 * It also prints a status summary so a failed apply is obvious.
 */

import { prisma } from '../src/lib/prisma';
import { getEnv } from '../src/lib/env';
import { getXrayStatus, syncXray } from '../src/server/services/xray-service';

async function main() {
  const env = getEnv();

  console.log('Xray supervisor');
  console.log(`  dir      : ${env.XRAY_DIR}`);
  console.log(`  api port : ${env.XRAY_API_PORT} (loopback only)`);
  console.log(`  provider : ${env.NODE_PROVIDER}`);
  console.log('');

  if (env.XRAY_ENABLED !== 'true') {
    console.log('XRAY_ENABLED is not "true" - nothing to do.');
    console.log('Set XRAY_ENABLED=true in .env to let the panel manage Xray.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const result = await syncXray({ force: true });

  console.log(`  ${result.changed ? 'applied' : 'no change'}: ${result.message}`);
  console.log(`  inbounds : ${result.inbounds}`);
  console.log(`  ports    : ${result.ports.length > 0 ? result.ports.join(', ') : '(none)'}`);

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  skipped configurations:');
    for (const entry of result.skipped) console.log(`    - ${entry}`);
  }

  if (!result.enabled) {
    console.log('');
    console.log(`  ! ${result.message}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const status = await getXrayStatus();
  console.log('');
  console.log(`  running  : ${status.running ? 'yes' : 'NO'}`);
  console.log(`  drifted  : ${status.drifted ? 'yes (run again)' : 'no'}`);

  if (!status.running && status.inbounds > 0) {
    console.log('');
    console.log('  ! Xray is not running. Check the log:');
    console.log(`      ${env.XRAY_DIR}\\xray.log`);
    await prisma.$disconnect();
    process.exit(1);
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('xray-sync failed:', error);
  await prisma.$disconnect();
  process.exit(1);
});
