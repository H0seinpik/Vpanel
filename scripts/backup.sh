#!/usr/bin/env bash
# =============================================================================
# VPanel — PostgreSQL backup
#
# Creates a compressed, checksummed custom-format dump and prunes old backups.
# Designed to be run from cron. Backups are written with 0600 permissions and
# must NEVER be placed in a publicly served directory.
#
# Usage:
#   ./scripts/backup.sh
#   BACKUP_DIR=/mnt/backups RETENTION_DAYS=30 ./scripts/backup.sh
#
# Cron (daily at 02:30):
#   30 2 * * * cd /opt/vpanel && ./scripts/backup.sh >> /var/log/vpanel-backup.log 2>&1
# =============================================================================

set -euo pipefail

# --- Configuration ------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONTAINER="${POSTGRES_CONTAINER:-vpanel-postgres-1}"

# Connection details. Prefer an explicit DATABASE_URL, else compose defaults.
DB_NAME="${POSTGRES_DB:-vpanel}"
DB_USER="${POSTGRES_USER:-vpanel}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

FILE="${BACKUP_DIR}/vpanel-${STAMP}.dump"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

log "starting backup of database '${DB_NAME}'"

# --- Dump ---------------------------------------------------------------------
# `-Fc` (custom format) supports parallel restore and selective table restore.
# If the postgres container is running we exec inside it; otherwise we use a
# local pg_dump against DATABASE_URL.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  log "dumping via docker exec ${CONTAINER}"
  docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$CONTAINER" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner --no-privileges \
    > "$FILE"
elif command -v pg_dump >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  log "dumping via local pg_dump"
  pg_dump --dbname="$DATABASE_URL" -Fc --no-owner --no-privileges > "$FILE"
else
  log "ERROR: neither the '${CONTAINER}' container nor a usable DATABASE_URL was found."
  exit 1
fi

chmod 600 "$FILE"

# --- Verify -------------------------------------------------------------------
SIZE="$(du -h "$FILE" | cut -f1)"
if [ ! -s "$FILE" ]; then
  log "ERROR: the dump is empty — aborting and removing the file."
  rm -f "$FILE"
  exit 1
fi

# Integrity checksum so a restore can detect corruption.
sha256sum "$FILE" > "${FILE}.sha256"
chmod 600 "${FILE}.sha256"

log "backup complete: ${FILE} (${SIZE})"
log "checksum: $(cat "${FILE}.sha256")"

# --- Retention ----------------------------------------------------------------
log "pruning backups older than ${RETENTION_DAYS} days"
DELETED="$(find "$BACKUP_DIR" -maxdepth 1 -name 'vpanel-*.dump*' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
log "pruned ${DELETED} old file(s)"

# --- Summary ------------------------------------------------------------------
log "current backups:"
ls -lh "$BACKUP_DIR" | tail -n +2 || true

log "done."
