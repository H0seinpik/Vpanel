#!/bin/sh
# =============================================================================
# Container entrypoint: apply database migrations, then start the server.
#
# `prisma migrate deploy` is idempotent and safe to run on every boot. If the
# database is not yet reachable we retry a few times before giving up, which
# avoids a race with a freshly started Postgres container.
#
# The Prisma CLI is invoked through its build entrypoint directly (rather than
# via `npx`) because the standalone runtime image does not ship node_modules/.bin
# symlinks.
# =============================================================================
set -e

PRISMA_CLI="./node_modules/prisma/build/index.js"

echo "[entrypoint] applying database migrations…"

ATTEMPTS=0
MAX_ATTEMPTS=20

until node "$PRISMA_CLI" migrate deploy; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo "[entrypoint] database unreachable after ${MAX_ATTEMPTS} attempts — aborting." >&2
    exit 1
  fi
  echo "[entrypoint] migration failed (attempt ${ATTEMPTS}/${MAX_ATTEMPTS}); retrying in 3s…"
  sleep 3
done

echo "[entrypoint] migrations applied."
echo "[entrypoint] starting: $*"
exec "$@"
