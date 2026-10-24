# VPanel

An administrative panel for managing **authorized** V2Ray/Xray proxy
configurations, users, traffic quotas and infrastructure.

VPanel is a management interface for servers **you own and register yourself**.
It never scans arbitrary hosts, never attacks third parties, and only ever
contacts nodes an administrator has explicitly added to the database.

---

## What it does

| Area | Capability |
| --- | --- |
| **Servers** | Register nodes, test connectivity, monitor CPU/RAM/connections/bandwidth, enable/disable, heartbeat tracking |
| **Configurations** | Wizard-driven generation for VLESS, VMess, Trojan and Shadowsocks with a modular backend engine |
| **Tunnels** | Credential-less port forwarding (Xray `tunnel` / formerly `dokodemo-door`) with TCP/UDP, enable/disable, conflict checks and live traffic counters |
| **Delivery** | Import links, QR codes and downloadable client configs (NekoBox, v2rayN, Shadowrocket, sing-box) |
| **Users** | Accounts with roles, quotas, expiry dates, device limits and independent per-configuration credentials |
| **Traffic** | Server-side ledger with per-user / per-server / per-configuration accounting, charts and leaderboards |
| **Monitoring** | Fleet health, per-node metrics history, online/offline/warning states |
| **Plans** | Reusable plan templates (allowance + duration + device limit + allowed protocols/servers) |
| **Audit** | Every security-relevant and state-changing action is logged and filterable |
| **Notifications** | Threshold alerts (80% / 90% / 100% traffic, expiry warnings, server offline/online) |
| **Settings** | General, security, server, traffic, notification and branding configuration |

---

## Technology

**Frontend** — Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS ·
shadcn-style Radix UI primitives · Recharts · Lucide icons

**Backend** — Node.js · TypeScript · REST route handlers · PostgreSQL · Prisma ORM

**Auth** — JWT access + refresh tokens in httpOnly cookies · bcrypt password
hashing · server-side RBAC · refresh-token rotation with reuse detection

**Infrastructure** — Docker · Docker Compose · nginx reverse proxy · PostgreSQL ·
optional Redis (rate limiting, distributed worker locks)

**Workers** — standalone process for traffic collection, monitoring heartbeats
and quota enforcement

---

## Quick start

### Docker (recommended)

```bash
git clone <your-repo> vpanel && cd vpanel

# 1. Create your environment file
cp .env.example .env

# 2. Generate real secrets — never reuse the placeholders
#    (Linux/macOS; on Windows use PowerShell equivalent)
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env

# 3. Set a strong database password and bootstrap admin password
#    POSTGRES_PASSWORD=...
#    SEED_ADMIN_PASSWORD=...
$EDITOR .env

# 4. Start everything
docker compose up -d --build

# 5. Create the bootstrap administrator and baseline data
docker compose run --rm seed

# 6. Open the panel
#    http://localhost  → sign in with SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
```

> Change the bootstrap administrator password immediately after the first login.

### Local development

```bash
npm install

# A local PostgreSQL is required
export DATABASE_URL="postgresql://vpanel:vpanel@localhost:5432/vpanel"

npx prisma migrate dev      # create the schema
npm run db:seed             # roles, protocols, plans, bootstrap admin
npm run dev                 # http://localhost:3000

# In a second terminal — background jobs
npm run worker
```

### Windows — run it as a home server

If you are hosting the panel on a Windows PC and want to drive it from a
browser rather than a terminal, use the scripts in the project root:

```
install.bat     first-time setup (env, dependencies, database, admin account)
db-setup.bat    creates the PostgreSQL role + database for you (native mode)
start.bat       start the panel and open your browser
stop.bat        stop it
restart.bat     stop + start (use after editing .env)
status.bat      is it running, is it healthy, which URL do I use?
logs.bat        web + worker output
backup.bat      database dump into .\backups
repair.bat      fix a broken node_modules (missing npm bin shims, missing Prisma client)
autostart.bat   start automatically when you sign in
firewall.bat    let other devices on your LAN reach it (run as administrator)
```

`start.bat` auto-detects the runtime: **Docker** when a working Docker engine is
present, otherwise **native** mode (Node.js + a PostgreSQL you provide). On a
low-RAM machine native mode is the better fit — PostgreSQL costs ~200 MB where
Docker Desktop costs ~1.5 GB before the stack even starts. See
[`windows/README.md`](windows/README.md) for the setup sequence, the LAN-access
walkthrough, and the `APP_URL` gotcha that causes "login works but I get bounced
back to /login".

---

## Project structure

```
.
├── prisma/
│   ├── schema.prisma          # 12+ models, indexes, cascades
│   ├── migrations/            # versioned SQL migrations
│   └── seed.ts                # roles, protocols, plans, bootstrap admin
├── src/
│   ├── app/
│   │   ├── (app)/             # authenticated shell + all admin/user pages
│   │   ├── api/               # REST route handlers
│   │   ├── login/             # public sign-in
│   │   ├── layout.tsx         # root layout (theme, toasts, metadata)
│   │   └── globals.css        # design tokens (light + dark)
│   ├── components/
│   │   ├── ui/                # shadcn-style primitives
│   │   ├── layout/            # sidebar, topbar, theme
│   │   ├── dashboard/         # admin + user dashboards
│   │   ├── configs/           # delivery actions (copy / QR / download)
│   │   ├── charts/            # Recharts wrappers
│   │   └── common/            # page header, stat card, toolbar, pagination
│   ├── hooks/                 # data-fetching hooks
│   ├── lib/
│   │   ├── auth/              # password, tokens, session, RBAC
│   │   ├── api/               # handler wrappers, errors, responses
│   │   ├── validation/        # zod schemas + sanitisation
│   │   ├── env.ts             # validated environment
│   │   ├── prisma.ts          # client singleton
│   │   ├── rate-limit.ts      # Redis + in-memory limiter
│   │   ├── audit.ts           # audit log writer
│   │   ├── qr.ts              # QR generation
│   │   └── api-client.ts      # browser fetch wrapper with token refresh
│   ├── server/
│   │   ├── services/          # business logic (users, servers, configs…)
│   │   └── serializers.ts     # JSON-safe DTOs (BigInt, secret redaction)
│   ├── services/
│   │   ├── config-generator/  # protocol engine (vless/vmess/trojan/ss)
│   │   └── providers/         # NodeProvider, TrafficProvider, … (local + agent)
│   └── middleware.ts          # routing guard (auth enforced server-side)
├── workers/                   # traffic, monitoring, enforcement jobs
├── tests/                     # vitest suites
├── docker/                    # entrypoint + nginx
├── scripts/                   # backup + restore
└── docs/                      # architecture, deployment, API, backup
```

---

## Security model

VPanel is built on the assumption that **the frontend is untrusted**.

- **Authentication** — short-lived access tokens plus rotated refresh tokens,
  both in `httpOnly` / `SameSite=Lax` / `Secure` cookies. Refresh tokens are
  stored as SHA-256 hashes; presenting a rotated token revokes the whole session
  chain (reuse detection).
- **Passwords** — bcrypt with cost 12, server-side strength policy, timing-safe
  comparison on login so unknown accounts are indistinguishable.
- **Authorisation** — an explicit capability matrix enforced in every route
  handler *and* re-checked inside services. Middleware only handles redirects.
- **Credential isolation** — `Configuration.params` never contains a credential.
  Credentials live in `ConfigAssignment`, one row per user, so a shared
  configuration still gives every user an independent secret.
- **Secrets at rest** — agent tokens are encrypted with AES-256-GCM. Passwords
  and tokens are never returned by any API endpoint.
- **Input handling** — every request body passes a Zod schema; free text is
  stripped of control characters. Prisma parameterises all SQL.
- **Rate limiting** — per-route budgets (login is 8 attempts / 5 minutes),
  shared through Redis when available, plus coarse limits at nginx.
- **Audit logging** — logins, failures, CRUD, quota and status changes, password
  resets and settings changes, each with actor, IP and metadata.

### What VPanel deliberately does **not** do

No credential theft, no malware, no botnet behaviour, no unauthorised access, no
exploitation of third-party servers, no scanning of arbitrary Internet targets,
no authentication bypass, no stealth persistence, no malicious traffic
generation. The provider layer can only ever act on servers registered by an
administrator.

---

## Common commands

```bash
npm run dev              # development server
npm run build            # prisma generate + next build
npm run start            # production server
npm run worker           # background jobs (daemon)
npm run worker -- all    # run every job once, then exit
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm test                 # vitest
npm run db:seed          # seed roles / protocols / plans / admin
npm run prisma:migrate   # apply migrations (deploy)
npm run prisma:studio    # browse the database
```

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, data model, provider abstractions, request lifecycle |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | VPS deployment: preparation, Docker, HTTPS, updates |
| [`docs/API.md`](docs/API.md) | Every REST endpoint with permissions and payloads |
| [`docs/BACKUP.md`](docs/BACKUP.md) | Backup, retention and restore procedures |

---

## Health check

```bash
curl -s http://localhost/api/health | jq
```

Reports database connectivity, the active node provider, worker intervals and
uptime. Returns `503` when the database is unreachable, so it doubles as a
container/orchestrator readiness probe.

---

## License

Provided as-is for managing infrastructure you are authorised to operate. You are
responsible for complying with all applicable laws and the terms of service of
any provider you use.
