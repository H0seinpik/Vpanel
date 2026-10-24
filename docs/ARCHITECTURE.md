# Architecture

## 1. Overview

VPanel is a single Next.js application (App Router) backed by PostgreSQL, plus a
standalone worker process. There is no separate API server: route handlers under
`src/app/api/**` **are** the REST API, and server components read directly
through the service layer for page rendering.

```
                    ┌──────────────────────────────┐
   Browser ────────▶│  nginx  (TLS, rate limit)     │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  Next.js (web container)     │
                    │  ├─ RSC pages                │
                    │  ├─ /api/** route handlers   │
                    │  └─ services + providers     │
                    └───────┬──────────────┬───────┘
                            │              │
             ┌──────────────▼───┐   ┌──────▼─────────────┐
             │  PostgreSQL      │   │  Redis (optional)  │
             │  (source of      │   │  rate limit +      │
             │   truth)         │   │  worker locks      │
             └──────────────▲───┘   └──────▲─────────────┘
                            │              │
                    ┌───────┴──────────────┴───────┐
                    │  Worker (separate container) │
                    │  traffic · monitoring ·      │
                    │  enforcement                 │
                    └──────────────┬───────────────┘
                                   │ provider layer
                    ┌──────────────▼───────────────┐
                    │  Registered nodes only       │
                    │  (local simulation OR agent) │
                    └──────────────────────────────┘
```

**Key principle:** the database is the single source of truth. The browser never
computes authoritative figures; the worker is the only writer of traffic data.

---

## 2. Layering

| Layer | Location | Responsibility |
| --- | --- | --- |
| **UI** | `src/app/(app)`, `src/components` | Rendering, local interaction state. No authorisation decisions. |
| **API** | `src/app/api/**/route.ts` | HTTP contract: parse → authorise → delegate → serialise. |
| **Business logic** | `src/server/services` | Rules, invariants, side effects, audit writes. |
| **Data access** | `src/lib/prisma.ts` + Prisma schema | Queries and constraints. |
| **Protocol engine** | `src/services/config-generator` | Pure functions that turn parameters into artefacts. |
| **Integrations** | `src/services/providers` | Pluggable node/traffic/server/configuration backends. |
| **Jobs** | `workers/` | Scheduled collection, monitoring and enforcement. |
| **Cross-cutting** | `src/lib/{auth,api,validation,audit,rate-limit}` | Auth, errors, validation, logging, throttling. |

A request flows: **route handler → `withAuth` (rate limit → authenticate →
authorise) → service → Prisma → serialiser → JSON**. Errors bubble up as typed
`AppError`s and are converted to safe HTTP responses in one place
(`src/lib/api/response.ts`).

---

## 3. Data model

Twelve models, all with foreign keys, indexes and cascade rules.

| Model | Purpose | Notable constraints |
| --- | --- | --- |
| `User` | Accounts, quota, expiry, role | unique `username` + `email`; indexed on `status`, `role`, `expirationDate` |
| `Role` | Role catalog with capability descriptions | unique `key` |
| `Session` | Refresh-token records | unique `tokenHash`; cascade on user delete |
| `Server` | Registered nodes + cached metrics | unique `(hostname, port)`; indexed on `status`, `type` |
| `ServerMetric` | Metric time series | indexed `(serverId, sampledAt)`; cascades with the server |
| `Protocol` | Protocol catalog driving the generator | unique `type` |
| `Configuration` | Transport parameters (no credentials) | indexed on `serverId`, `type`, `status`, `ownerId` |
| `Tunnel` | Credential-less port forward (`listen` → `target`) | unique `(serverId, listenPort)`; indexed on `enabled` |
| `ConfigAssignment` | Per-user credential binding | unique `(configId, userId)` — the multi-user model |
| `Plan` | Reusable plan templates | unique `name` |
| `Subscription` | Quota + validity window for a user | indexed on `userId`, `status`, `endsAt` |
| `Device` | Client registrations | unique `(userId, deviceKey)` |
| `TrafficUsage` | Append-only usage ledger | unique `(serverId, userId, configId, windowKey)`; indexed on each id + `timestamp` |
| `AuditLog` | Audit trail | indexed on `(actorId, createdAt)`, `(action, createdAt)`, `(targetType, targetId)` |
| `Notification` | Alerts | unique `dedupeKey`; indexed on `(userId, isRead)` |
| `SystemSetting` | Overrides over code defaults | unique `key` |

### Why credentials live in `ConfigAssignment`

A configuration can serve one user or many. If credentials lived on
`Configuration`, every user would share one secret — a single leak would
compromise them all. Instead:

```
Configuration.params   →  { address, port, network, security, path, sni, … }
ConfigAssignment       →  { configId, userId, credential: { uuid | password } }
```

Rendering a link always merges `params` with **that user's** credential. The API
therefore cannot accidentally return someone else's secret, because the secret
is not part of the shared row.

### Traffic indexing

The heaviest queries are aggregations over `traffic_usage`. The composite index
on `(userId, timestamp)`, `(serverId, timestamp)` and `(configId, timestamp)`
keeps time-bucketed `SUM`/`COUNT DISTINCT` queries fast, and the unique
`windowKey` constraint makes collection idempotent.

---

## 4. Configuration generation engine

`src/services/config-generator/` is pure and has no database dependency.

```
types.ts         schemas (Zod) + the Generator contract
utils.ts         base64, query building, streamSettings mapping, client config
vless.ts         vless://  · XTLS-Vision · REALITY
vmess.ts         vmess://  (base64 JSON, v2rayN-compatible)
trojan.ts        trojan:// (TLS forced)
shadowsocks.ts   ss://     (SIP002)
index.ts         registry, credential generation, UI field descriptors
```

Every generator returns the same shape:

```ts
{
  protocol, params,
  outbound,        // client outbound for an Xray `outbounds` array
  clientConfig,    // full config with SOCKS + HTTP inbounds
  serverInbound,   // inbound template for the node
  shareLink,       // import URL
  qrPayload,       // string rendered as a QR code
  filename, fileContent,
  warnings,        // non-fatal advisories
}
```

Adding a protocol means: write one generator file, register it in `index.ts`,
add its field descriptors. Nothing else changes — including the UI, which renders
itself from `getProtocolFields()`.

### Tunnels are not configurations

A **tunnel** is Xray's credential-less port forwarder (`tunnel`, formerly
`dokodemo-door`): every byte arriving on `listenPort` is sent to
`targetHost:targetPort`. It has no users, share links or per-user accounting, so
it lives in its own `Tunnel` table and `/tunnels` page rather than becoming a
fifth `ProtocolType`. `renderXrayConfig()` merges tunnels and configurations into
one node config, rejects a tunnel whose port is already claimed, gives tunnel
inbounds a routing rule that bypasses the private-IP block, and records
`inbound>>>tunnel-<id>>>>traffic>>>uplink/downlink` counters into the row.

---

## 5. Provider abstraction

The panel cannot know how every node exposes metrics, so all external
interaction goes through interfaces (`src/services/providers/types.ts`):

| Interface | Responsibility | Implementations |
| --- | --- | --- |
| `NodeProvider` | Transport to one node: test, status, apply/remove client | `LocalNodeProvider`, `AgentNodeProvider` |
| `TrafficProvider` | Per-node usage collection | `LocalTrafficProvider`, `AgentTrafficProvider` |
| `ServerProvider` | Health aggregation | `LocalServerProvider`, `AgentServerProvider` |
| `ConfigurationProvider` | Render delivered artefacts | `LocalConfigurationProvider` |

`getProviders()` selects the set from `NODE_PROVIDER` (`local` | `agent`).

**Local** performs no network calls at all — it derives deterministic simulated
metrics so the whole application runs without a node agent. **Agent** speaks
HTTPS to a per-server endpoint, authenticated with an encrypted-at-rest token,
and is the production path.

The agent contract (implement on the node side):

```
GET    {endpoint}/health              → { version, uptimeSeconds }
GET    {endpoint}/status              → { online, cpuPercent, memPercent, … }
POST   {endpoint}/clients             → add/refresh a credential
DELETE {endpoint}/clients             → revoke a credential
GET    {endpoint}/traffic?since=<iso> → [{ email, uploadBytes, downloadBytes }]
```

Nodes report usage keyed by client `email` — the same value VPanel writes into
the inbound client config — so a node never needs VPanel's internal ids.

---

## 6. Background jobs

`workers/index.ts` runs three jobs on independent intervals.

| Job | Default interval | Work |
| --- | --- | --- |
| **traffic** | 120 s | For each monitored server: build the attribution table, collect deltas, resolve emails → user/config, write to the ledger, update derived counters |
| **monitor** | 60 s | Health-check each server, persist status/metrics, append a `ServerMetric` sample, raise online/offline notifications, prune samples older than 30 days |
| **enforce** | ≥ 300 s | Re-derive every account's status, expire subscriptions, reset monthly quotas, raise threshold notifications |

**Idempotency.** Each collection writes a `windowKey` (minute resolution). When a
window is re-processed, only the *difference* between the new and stored totals
is applied to the counters — so a retried run, or a replica that lost the lock
race, can never inflate usage.

**Locking.** `withLock()` uses Redis `SET NX PX` when available and an in-process
guard otherwise, so multiple replicas do not double-run a job.

**Status derivation** (`evaluateUserStatus`), in precedence order:

```
DISABLED / SUSPENDED  (manual, never auto-reverted)
  → EXPIRED           (expirationDate < now)
  → TRAFFIC_EXCEEDED  (used >= limit)
  → ACTIVE
```

---

## 7. Authentication & authorisation

### Sessions

1. `POST /api/auth/login` verifies the password (always running a bcrypt compare,
   even for unknown accounts, so timing does not reveal valid usernames).
2. A session row is created with the SHA-256 hash of the refresh token.
3. Both tokens are set as `httpOnly` cookies; JavaScript never sees them.
4. `POST /api/auth/refresh` rotates the refresh token in place. A stale hash
   means a replay → every session for that user is revoked.
5. Access tokens carry a `typ` claim, so a refresh token cannot be used as an
   access token (and vice versa).

### Capabilities

`src/lib/auth/rbac.ts` defines an explicit matrix:

| Capability group | ADMIN | OPERATOR | USER |
| --- | --- | --- | --- |
| `self:*` | ✔ | ✔ (read/profile) | ✔ |
| `users:read` / `users:write` | ✔ | ✔ | ✖ |
| `users:delete` / `admins:manage` | ✔ | ✖ | ✖ |
| `servers:*`, `configs:*` | ✔ | ✔ | ✖ |
| `plans:*`, `subscriptions:*` | ✔ | ✔ | ✖ |
| `traffic:read`, `monitoring:read`, `logs:read` | ✔ | ✔ | ✖ |
| `settings:write` | ✔ | ✖ | ✖ |
| `settings:security:write` | ✔ | ✖ | ✖ |

`withAuth(handler, { capability })` enforces this before the handler runs;
`anyOf` covers endpoints reachable by two different roles (e.g. `configs:read`
for staff, `self:configs` for the owning user). Services re-check ownership
where a specific row is involved.

---

## 8. Request lifecycle (example)

`POST /api/configs`

```
1. withAuth({ capability: 'configs:write', rate: 'write' })
     → rate limit by path + client IP
     → resolve session from the access cookie, validate the session row
     → check the capability
2. createConfigSchema.parse(body)        zod validation + sanitisation
3. createConfig(input, actor)
     → load + validate the server
     → split credentials out of the parameters
     → validate the parameter set with a probe credential
     → transaction: insert Configuration, one ConfigAssignment per user,
       render each share link, apply quota/expiry if supplied
     → audit log + notification per assignee
4. getConfigArtifact(config.id, actor, ownerId)   render the owner's artefact
5. jsonCreated({ config, assignments, artifact })
```

---

## 9. Frontend architecture

- **Route groups.** `(app)` holds the authenticated shell (server component that
  resolves the session and redirects when absent); `login` is public.
- **Data fetching.** `useApi()` is a dependency-free hook with polling support —
  that is how the dashboard refreshes without a full page reload.
- **API client.** `src/lib/api-client.ts` wraps `fetch`, normalises the
  `{ data }` / `{ error }` envelope, and transparently refreshes an expired
  access token once before replaying the request.
- **Theming.** Design tokens in `globals.css` (`:root` / `.dark`); a blocking
  inline script applies the stored theme before first paint.
- **UI kit.** Radix primitives wrapped in `src/components/ui` with
  `class-variance-authority`. Status colours are centralised in `StatusBadge`
  so a state looks the same everywhere.

---

## 10. Extending VPanel

| Goal | Steps |
| --- | --- |
| **New protocol** | Add a generator in `config-generator/`, register it, add field descriptors. The wizard picks it up automatically. |
| **New node type** | Add a `ServerType` enum value and map it to a provider in `getProviders()`. |
| **New traffic source** | Implement `TrafficProvider` and return `TrafficSample[]`; the worker needs no changes. |
| **New notification channel** | Fill in `dispatchExternal()` in `notification-service.ts`. |
| **New role** | Add the enum value, extend `ROLE_CAPABILITIES`, add a `Role` row in the seed. |
| **New metric** | Add a column to `ServerMetric`, populate it in `refreshServerStatus()`, render it on the monitoring page. |
