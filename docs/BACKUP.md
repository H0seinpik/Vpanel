# Backup & recovery

VPanel stores everything that matters in PostgreSQL. The application is stateless
and can be rebuilt from source at any time — **the database is the only thing you
must back up.**

---

## What to back up

| Item | Criticality | Notes |
| --- | --- | --- |
| PostgreSQL database | **Critical** | Users, servers, configurations, credentials, traffic history, audit log |
| `.env` file | **Critical** | Contains `JWT_*_SECRET` and the DB password. Without it, existing sessions are invalid and encrypted agent tokens cannot be decrypted |
| nginx TLS certificates | Important | Re-issuable, but restoring them is faster |
| Source code | Low | In version control |

> **Encrypted agent tokens depend on `JWT_REFRESH_SECRET`.** Restoring the
> database without the matching `.env` means every stored agent token must be
> re-entered. Back the two up together, and store the `.env` in a secret manager
> rather than alongside the dump.

---

## Automated backups

`scripts/backup.sh` produces a compressed custom-format dump with a SHA-256
checksum, then prunes old files.

```bash
./scripts/backup.sh

# Custom location and retention
BACKUP_DIR=/mnt/backups RETENTION_DAYS=30 ./scripts/backup.sh
```

Output:

```
backups/vpanel-20260926T023000Z.dump          (12M)
backups/vpanel-20260926T023000Z.dump.sha256
```

### Schedule it

```bash
crontab -e
```

```cron
# Daily at 02:30 UTC, 14-day retention, logged
30 2 * * * cd /opt/vpanel && BACKUP_DIR=/var/backups/vpanel RETENTION_DAYS=14 ./scripts/backup.sh >> /var/log/vpanel-backup.log 2>&1

# Weekly, longer retention, to a second location
30 3 * * 0 cd /opt/vpanel && BACKUP_DIR=/mnt/backups/vpanel RETENTION_DAYS=90 ./scripts/backup.sh >> /var/log/vpanel-backup.log 2>&1
```

### Retention policy

| Tier | Frequency | Keep | Location |
| --- | --- | --- | --- |
| Daily | Every day 02:30 | 14 days | `/var/backups/vpanel` (local disk) |
| Weekly | Sundays 03:30 | 90 days | Secondary disk or mounted volume |
| Monthly | 1st of the month | 12 months | Off-host (encrypted object storage) |

A common approach for off-host copies is `restic` or `borg` pointed at encrypted
object storage:

```bash
restic -r s3:s3.example.com/vpanel-backups backup /var/backups/vpanel
restic -r s3:s3.example.com/vpanel-backups forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```

---

## Security of backups

Backups contain credentials and the full audit trail.

- **Never** place them inside a web-served directory. `docker/nginx/nginx.conf`
  denies dotfiles, but a stray `backups/` directory would still be reachable.
- The script writes `chmod 600` files inside a `chmod 700` directory.
- Encrypt off-host copies (`restic`, `borg`, or `gpg -c`).
- Restrict who can read the backup directory.
- Back up the `.env` separately, into a secret manager.

Verify permissions:

```bash
ls -ld /var/backups/vpanel        # drwx------
ls -l  /var/backups/vpanel        # -rw-------  for every file
```

---

## Manual backup

```bash
# Custom format (recommended — supports parallel and selective restore)
docker compose exec -T postgres pg_dump -U vpanel -d vpanel -Fc --no-owner > vpanel-$(date -u +%Y%m%dT%H%M%SZ).dump

# Plain SQL (human-readable, good for small databases)
docker compose exec -T postgres pg_dump -U vpanel -d vpanel --no-owner > vpanel-$(date -u +%Y%m%dT%H%M%SZ).sql

# Schema only
docker compose exec -T postgres pg_dump -U vpanel -d vpanel --schema-only > vpanel-schema.sql
```

---

## Restore

`scripts/restore.sh` verifies the checksum, confirms interactively, stops the
application, restores, reapplies migrations and restarts.

```bash
./scripts/restore.sh /var/backups/vpanel/vpanel-20260926T023000Z.dump
```

You will be asked to type `restore` to proceed.

### Manual restore

```bash
# 1. Stop the application (leave the database running)
docker compose stop web worker nginx

# 2. Reset the schema so the restore is clean
docker compose exec -T postgres psql -U vpanel -d vpanel \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# 3. Restore
docker compose exec -T postgres pg_restore -U vpanel -d vpanel \
  --no-owner --no-privileges --clean --if-exists < vpanel-20260926T023000Z.dump

# 4. Apply any migrations added since the backup
docker compose run --rm web npx prisma migrate deploy

# 5. Restart
docker compose up -d

# 6. Verify
curl -s http://localhost/api/health | jq
```

### Restoring to a different host

```bash
# On the new host, after starting postgres
docker compose up -d postgres
docker compose exec -T postgres psql -U vpanel -d vpanel \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker compose exec -T postgres pg_restore -U vpanel -d vpanel \
  --no-owner --no-privileges < /path/to/dump
docker compose up -d

# Copy the matching .env first — otherwise encrypted agent tokens cannot be read
```

### Selective restore (single table)

```bash
docker compose exec -T postgres pg_restore -U vpanel -d vpanel \
  --no-owner --table=users --data-only < vpanel-20260926T023000Z.dump
```

---

## Verifying a backup actually restores

An unverified backup is not a backup. Test quarterly:

```bash
# Spin up a throwaway database
docker run -d --name vpanel-restore-test \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=vpanel_test -p 55432:5432 postgres:16-alpine
sleep 5

# Restore into it
PGPASSWORD=test pg_restore -h localhost -p 55432 -U postgres -d vpanel_test \
  --no-owner --no-privileges vpanel-20260926T023000Z.dump

# Sanity-check the row counts
PGPASSWORD=test psql -h localhost -p 55432 -U postgres -d vpanel_test -c "
  SELECT 'users' AS table, COUNT(*) FROM users
  UNION ALL SELECT 'servers', COUNT(*) FROM servers
  UNION ALL SELECT 'configurations', COUNT(*) FROM configurations
  UNION ALL SELECT 'config_assignments', COUNT(*) FROM config_assignments
  UNION ALL SELECT 'traffic_usage', COUNT(*) FROM traffic_usage
  UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs;"

# Clean up
docker rm -f vpanel-restore-test
```

Record the outcome with the date and the backup file used.

---

## Recovery scenarios

| Scenario | Action |
| --- | --- |
| **Accidental row deletion** | Restore to a temporary database, then copy the affected rows across |
| **Corrupted database** | Stop the app, drop and recreate the schema, restore the most recent dump |
| **Lost host** | Provision a new VPS, follow `DEPLOYMENT.md`, restore the dump, restore `.env` and certificates |
| **Ransomware / compromise** | Restore from the most recent *off-host* backup; rotate `JWT_*_SECRET` and all user passwords afterwards (changing a password revokes that user's sessions) |
| **Failed migration** | `npx prisma migrate resolve --rolled-back <migration>` then restore if the data is affected |

### After a security incident

1. Restore from a known-good off-host backup.
2. Rotate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` — this invalidates every
   session and requires re-entering agent tokens.
3. Rotate `POSTGRES_PASSWORD`.
4. Force password resets for all accounts.
5. Review the audit log for the intrusion window (`/logs`, filter by
   `auth.login_failed` and `settings.security_update`).

---

## Disaster recovery targets

| Metric | Target | How |
| --- | --- | --- |
| **RPO** (max data loss) | ≤ 24 hours | Daily automated backups |
| **RTO** (time to restore) | ≤ 1 hour | Scripted restore + documented procedure |

Tighten the RPO by increasing the backup frequency — dumps are incremental in
cost only if you also enable WAL archiving. For sub-hour RPO, configure
PostgreSQL continuous archiving (`archive_mode = on` + `archive_command`) and
take periodic base backups, then replay WAL to the desired point in time.
