# Deployment guide (Linux VPS)

This guide deploys VPanel on a fresh Ubuntu 22.04 / 24.04 or Debian 12 VPS using
Docker Compose and nginx with automatic TLS.

**Prerequisites:** a VPS with ≥ 2 GB RAM, root or sudo access, and a domain whose
A/AAAA record already points at the server.

---

## 1. Server preparation

```bash
# Update the system
sudo apt update && sudo apt upgrade -y

# Essential tooling
sudo apt install -y ca-certificates curl gnupg git ufw

# Create an unprivileged deployment user
sudo adduser --disabled-password --gecos "" vpanel
sudo usermod -aG sudo vpanel
sudo su - vpanel
```

### Firewall

Only SSH, HTTP and HTTPS should be reachable. The database and Redis stay on the
internal Docker network.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

### Time synchronisation

Accurate clocks matter for session expiry and traffic windows.

```bash
sudo timedatectl set-timezone UTC
sudo timedatectl set-ntp true
timedatectl status
```

---

## 2. Install Docker

```bash
# Official Docker repository
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Run docker without sudo
sudo usermod -aG docker $USER
newgrp docker

docker --version && docker compose version
```

---

## 3. Get the code and configure the environment

```bash
sudo mkdir -p /opt/vpanel && sudo chown $USER:$USER /opt/vpanel
cd /opt/vpanel

git clone <your-repo-url> .
# or: upload the project and `cd /opt/vpanel`

cp .env.example .env
chmod 600 .env
```

### Generate secrets

Never reuse the placeholder values. Generate fresh, independent secrets:

```bash
ACCESS=$(openssl rand -base64 48)
REFRESH=$(openssl rand -base64 48)
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=${ACCESS}|"  .env
sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=${REFRESH}|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DB_PASS}|"   .env
```

Add the remaining values with your editor:

```bash
nano .env
```

Required:

```ini
APP_URL=https://panel.example.com
APP_NAME=VPanel

POSTGRES_USER=vpanel
POSTGRES_PASSWORD=<generated above>
POSTGRES_DB=vpanel

JWT_ACCESS_SECRET=<generated above>
JWT_REFRESH_SECRET=<generated above>

SEED_ADMIN_EMAIL=you@example.com
SEED_ADMIN_PASSWORD=<a strong, unique password>

NODE_PROVIDER=local        # switch to `agent` once your nodes run the agent
HTTP_PORT=80
HTTPS_PORT=443
```

> `APP_URL` must match the public origin exactly — it is used for cookie
> behaviour and subscription links.

---

## 4. Database initialisation

The web container applies migrations automatically on boot (see
`docker/entrypoint.sh`). To do it manually:

```bash
docker compose up -d postgres
docker compose run --rm web node node_modules/prisma/build/index.js migrate deploy
```

Create the baseline data and the bootstrap administrator:

```bash
docker compose run --rm seed
```

`seed` is a one-off tooling container built from the worker image (it ships the
Prisma CLI, `tsx` and the source tree). It is excluded from `docker compose up`
via a profile, so it never starts on its own.

The seed is idempotent: it creates the role catalog, protocol catalog, the three
default plans and the administrator, and skips anything that already exists.

> **Alternative — generate migrations locally.** If `prisma/migrations/` is empty
> in your checkout, run `npx prisma migrate dev --name init` on a development
> machine against a scratch database and commit the generated SQL before
> deploying.

---

## 5. Start the application

```bash
docker compose up -d --build

# Watch the services come up
docker compose ps
docker compose logs -f web
```

Verify:

```bash
curl -s http://localhost/api/health | jq
# { "status": "ok", "checks": { "database": "ok" }, … }
```

---

## 6. Reverse proxy

nginx runs as a container using `docker/nginx/nginx.conf`, which already provides:

- TLS termination and HTTP→HTTPS redirect
- HSTS, CSP and the other security headers
- Edge rate limiting (30 r/s general, 5/min on auth endpoints)
- WebSocket upgrade headers, gzip, and immutable caching for `/_next/static`

Nothing further is required for the default setup.

---

## 7. HTTPS

### Option A — Let's Encrypt (recommended)

Certbot needs to answer an HTTP-01 challenge, so start with plain HTTP only:

```bash
# Comment out the 443 block in docker/nginx/nginx.conf temporarily, or
# start just the web container on port 80 for the challenge.
sudo apt install -y certbot

# Stop nginx so certbot can bind port 80
docker compose stop nginx

sudo certbot certonly --standalone \
  -d panel.example.com \
  --email you@example.com \
  --agree-tos --no-eff-email
```

Copy the certificates into the mounted directory and restart:

```bash
sudo mkdir -p docker/nginx/certs
sudo cp /etc/letsencrypt/live/panel.example.com/fullchain.pem docker/nginx/certs/
sudo cp /etc/letsencrypt/live/panel.example.com/privkey.pem   docker/nginx/certs/
sudo chown -R $USER:$USER docker/nginx/certs
chmod 600 docker/nginx/certs/privkey.pem

docker compose up -d nginx
```

Renewal — add to root's crontab (`sudo crontab -e`):

```cron
0 3 * * * certbot renew --quiet --deploy-hook "cp /etc/letsencrypt/live/panel.example.com/*.pem /opt/vpanel/docker/nginx/certs/ && docker compose -f /opt/vpanel/docker-compose.yml restart nginx"
```

### Option B — Existing certificates

Place `fullchain.pem` and `privkey.pem` in `docker/nginx/certs/` and restart
nginx. No configuration change is needed.

### Verify

```bash
curl -I https://panel.example.com
# Strict-Transport-Security, X-Frame-Options: DENY, …

# Grade the configuration
# https://www.ssllabs.com/ssltest/analyze.html?d=panel.example.com
```

---

## 8. Post-installation hardening

1. **Sign in and change the administrator password immediately** (Profile →
   Change password). Changing it revokes every session.
2. **Create operator accounts** for day-to-day work instead of sharing the admin
   login.
3. **Configure settings** (Settings → General / Traffic / Security): default
   quotas, monitoring interval, warning thresholds, session timeout.
4. **Register your first server** and test the connection.
5. **Enable backups** (§10) before you have data you care about.
6. **Verify no secrets are world-readable:**

```bash
ls -l .env                       # -rw------- 
docker compose exec web env | grep -c SECRET   # values exist, but never logged
```

---

## 9. Updating the application

```bash
cd /opt/vpanel

# 0. Always take a backup first
./scripts/backup.sh

# 1. Fetch the new code
git pull

# 2. Rebuild and recreate
docker compose build --pull
docker compose up -d

# 3. Migrations run automatically on boot; verify:
docker compose logs web | grep -i migrat

# 4. Confirm health
curl -s https://panel.example.com/api/health | jq
```

### Rollback

```bash
git checkout <previous-tag-or-commit>
docker compose build && docker compose up -d
./scripts/restore.sh backups/<most-recent>.dump   # only if the schema changed
```

---

## 10. Backups

See [`BACKUP.md`](BACKUP.md) for the full procedure. Minimal setup:

```bash
sudo mkdir -p /var/backups/vpanel && sudo chown $USER:$USER /var/backups/vpanel

crontab -e
```

```cron
# Daily database backup at 02:30, 14-day retention
30 2 * * * cd /opt/vpanel && BACKUP_DIR=/var/backups/vpanel RETENTION_DAYS=14 ./scripts/backup.sh >> /var/log/vpanel-backup.log 2>&1
```

Backups must never live inside a web-served directory. Store them off-host
(another server, object storage with encryption) as soon as practical.

---

## 11. Operations reference

### Logs

```bash
docker compose logs -f web          # application
docker compose logs -f worker       # background jobs
docker compose logs -f nginx        # edge / TLS
docker compose logs -f postgres     # database
```

### Restart a single service

```bash
docker compose restart web
docker compose restart worker
```

### Run a job immediately

```bash
docker compose exec worker npx tsx workers/index.ts traffic
docker compose exec worker npx tsx workers/index.ts monitor
docker compose exec worker npx tsx workers/index.ts enforce
```

### Database shell

```bash
docker compose exec postgres psql -U vpanel -d vpanel
```

### Resource usage

```bash
docker stats --no-stream
docker compose exec postgres psql -U vpanel -d vpanel -c "\dt+"
```

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `web` restarts in a loop | Migrations failing or the DB is unreachable | `docker compose logs web`; confirm `POSTGRES_PASSWORD` matches on both services |
| Redirected to `/login` in a loop | Cookies rejected — `APP_URL` or scheme mismatch | Set `APP_URL=https://…` and confirm the certificate is valid |
| `502` from nginx | The web container is not listening yet | `docker compose logs web`; wait for the health check to pass |
| No traffic recorded | Worker not running, or the server has no assignments | `docker compose logs worker`; check Monitoring → server status |
| `Invalid environment configuration` at boot | A required variable is missing or a secret is under 32 characters | Compare `.env` against `.env.example` |
| Login blocked after several attempts | Rate limiter (8 attempts / 5 min) | Wait five minutes, or flush Redis: `docker compose exec redis redis-cli FLUSHDB` |

---

## 13. Scaling notes

- **Vertical first.** PostgreSQL and the traffic aggregations are the bottleneck;
  give the database adequate RAM and confirm it is using indexes
  (`EXPLAIN ANALYZE` on the traffic queries).
- **Multiple web replicas.** Safe: sessions live in the database, and the app is
  stateless. Set `ENABLE_INLINE_WORKER=false` and keep exactly one worker
  container, or rely on the Redis lock to serialise job execution.
- **Redis is optional but recommended** beyond one instance — it shares rate
  limit counters and worker locks across replicas.
- **Metric retention.** `ServerMetric` rows are pruned after 30 days by the
  monitoring worker; adjust `METRIC_RETENTION_DAYS` in `workers/monitor-worker.ts`
  if you need a longer history.
