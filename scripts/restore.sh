#!/usr/bin/env bash
# =============================================================================
# VPanel — PostgreSQL restore
#
# DESTRUCTIVE: this replaces the contents of the target database.
#
# Usage:
#   ./scripts/restore.sh backups/vpanel-20260926T023000Z.dump
#
# The script verifies the checksum (when present), asks for confirmation, then
# stops the application containers, restores, and restarts them.
# =============================================================================

set -euo pipefail

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <path-to-.dump>" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

DB_NAME="${POSTGRES_DB:-vpanel}"
DB_USER="${POSTGRES_USER:-vpanel}"
CONTAINER="${POSTGRES_CONTAINER:-vpanel-postgres-1}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# --- Verify checksum ----------------------------------------------------------
if [ -f "${BACKUP_FILE}.sha256" ]; then
  log "verifying checksum"
  if ! sha256sum -c "${BACKUP_FILE}.sha256" >/dev/null 2>&1; then
    echo "ERROR: checksum mismatch — the backup may be corrupted. Aborting." >&2
    exit 1
  fi
  log "checksum OK"
else
  log "WARNING: no checksum file found; skipping integrity verification."
fi

# --- Confirm ------------------------------------------------------------------
echo
echo "  ⚠  This will REPLACE the contents of database '${DB_NAME}'."
echo "     Backup file: ${BACKUP_FILE}"
echo
read -r -p "Type 'restore' to continue: " CONFIRM
if [ "$CONFIRM" != "restore" ]; then
  log "aborted by user."
  exit 1
fi

# --- Stop the application -----------------------------------------------------
log "stopping application containers (database is left running)"
docker compose stop web worker nginx >/dev/null 2>&1 || true

# --- Restore ------------------------------------------------------------------
log "restoring into '${DB_NAME}'"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  # Drop and recreate the schema so the restore is clean.
  docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
  docker exec -i -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
    pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges --clean --if-exists \
    < "$BACKUP_FILE"
elif command -v pg_restore >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  pg_restore --dbname="$DATABASE_URL" --no-owner --no-privileges --clean --if-exists "$BACKUP_FILE"
else
  echo "ERROR: neither the '${CONTAINER}' container nor a usable DATABASE_URL was found." >&2
  exit 1
fi

# --- Reapply migrations -------------------------------------------------------
# A backup taken before a schema change may need the latest migrations applied.
log "applying any pending migrations"
docker compose run --rm --no-deps web node node_modules/prisma/build/index.js migrate deploy || \
  log "WARNING: could not apply migrations automatically — run them manually."

# --- Restart ------------------------------------------------------------------
log "restarting application containers"
docker compose start web worker nginx >/dev/null 2>&1 || true

log "restore complete. Verify the application at /api/health."
