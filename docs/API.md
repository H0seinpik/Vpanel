# REST API reference

Base URL: `https://<your-host>/api`

## Conventions

**Response envelope.** Success responses carry the payload under `data`:

```json
{ "data": { … } }
```

Paginated responses add `pagination`:

```json
{
  "data": [ … ],
  "pagination": {
    "page": 1, "pageSize": 20, "total": 45,
    "totalPages": 3, "hasNext": true, "hasPrev": false
  }
}
```

Errors are uniform:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Validation failed",
    "details": [{ "path": "email", "message": "A valid email is required" }]
  }
}
```

**Error codes:** `unauthorized` (401) · `forbidden` (403) · `not_found` (404) ·
`conflict` (409) · `validation_error` (422) · `rate_limited` (429) ·
`provider_error` (502) · `internal_error` (500)

**Authentication.** Access and refresh tokens are `httpOnly` cookies
(`vpanel_at`, `vpanel_rt`) set by `/auth/login`. Non-browser clients may send the
refresh token in the body of `/auth/refresh`. An expired access token is
refreshed transparently by the bundled client; raw clients should retry once
after `POST /auth/refresh`.

**Pagination.** `?page=1&pageSize=20` (max 100).

**Rate limits.** Login: 8 / 5 min per IP. Refresh: 60 / 5 min. Writes: 120 / min.
Reads: 600 / min. Sensitive operations: 10 / min. Responses include
`Retry-After` when limited.

---

## Authentication

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/login` | public | `{ identifier, password, remember? }` — accepts username or email |
| `POST` | `/auth/logout` | authenticated | Revokes every session for the user |
| `POST` | `/auth/refresh` | public | Rotates the refresh token; replay revokes the session chain |
| `GET` | `/auth/me` | authenticated | Profile + capability list + app branding |
| `POST` | `/auth/password` | authenticated | `{ currentPassword, newPassword, confirmPassword }` — revokes sessions |

```bash
curl -c cookies.txt -X POST https://panel.example.com/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"admin@example.com","password":"…"}'
```

---

## Users

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/users` | `users:read` |
| `POST` | `/users` | `users:write` |
| `GET` | `/users/:id` | `users:read` |
| `PATCH` | `/users/:id` | `users:write` |
| `DELETE` | `/users/:id` | `users:delete` |
| `POST` | `/users/:id/password` | `users:reset-password` |
| `GET` | `/users/:id/configs` | `users:read` |

**Query (GET /users):** `search`, `status`, `role`, `serverId`, `sort`
(`createdAt|username|trafficUsedBytes|expirationDate`), `order`, `page`, `pageSize`.

**Create body:**

```json
{
  "username": "jdoe",
  "displayName": "John Doe",
  "email": "jdoe@example.com",
  "password": "Str0ng_Password",
  "role": "USER",
  "status": "ACTIVE",
  "planId": null,
  "trafficLimitGb": 100,
  "expirationDays": 30,
  "notes": "Optional"
}
```

**Update body** (all optional): `displayName`, `email`, `role`, `status`, `notes`,
`planId`, `trafficLimitGb` (null = unlimited), `expirationDate`, `extendDays`,
`resetTraffic`.

> Only an ADMIN may create, modify or delete an ADMIN account, and the last
> administrator cannot be deleted or demoted. Disabling an account revokes its
> live sessions immediately.

---

## Servers

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/servers` | `servers:read` |
| `POST` | `/servers` | `servers:write` |
| `GET` | `/servers/:id` | `servers:read` |
| `PATCH` | `/servers/:id` | `servers:write` |
| `DELETE` | `/servers/:id` | `servers:delete` |
| `POST` | `/servers/:id/test` | `servers:write` |
| `POST` | `/servers/:id/refresh` | `servers:read` |
| `GET` | `/servers/:id/metrics` | `servers:read` |

**Create body:**

```json
{
  "name": "Germany Node 01",
  "hostname": "node01.example.com",
  "ipAddress": "203.0.113.10",
  "port": 443,
  "protocol": "VLESS",
  "type": "XRAY",
  "location": "Frankfurt, DE",
  "description": "Optional",
  "monitoringEnabled": true,
  "agentEndpoint": "https://node01.example.com:8443",
  "agentToken": "…"
}
```

`GET /servers` additionally returns a `counters` object
(`total`, `online`, `offline`, `warning`, `disabled`).

> `agentToken` is encrypted with AES-256-GCM and is **never** returned by any
> endpoint. Responses only expose `hasAgent: true|false`.

**Test response:**

```json
{ "data": { "ok": true, "latencyMs": 42, "message": "Agent reachable (version 1.2.0)." } }
```

---

## Configurations

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/configs` | `configs:read` **or** `self:configs` |
| `POST` | `/configs` | `configs:write` |
| `GET` | `/configs/:id` | `configs:read` **or** `self:configs` |
| `PATCH` | `/configs/:id` | `configs:write` |
| `DELETE` | `/configs/:id` | `configs:delete` |
| `GET` | `/configs/:id/qr` | `configs:read` **or** `self:configs` |
| `GET` | `/configs/:id/download` | `configs:read` **or** `self:configs` |
| `POST` | `/configs/:id/assignments` | `configs:write` |
| `DELETE` | `/configs/:id/assignments?userId=` | `configs:write` |
| `GET` | `/protocols` | `configs:read`/`write` or `self:configs` |

**Create body:**

```json
{
  "name": "Germany Node 01",
  "serverId": "clx…",
  "protocol": "VLESS",
  "ownerId": "clu…",
  "userIds": ["clu…", "clu…"],
  "params": {
    "uuid": "11111111-1111-4111-8111-111111111111",
    "address": "node01.example.com",
    "port": 443,
    "network": "ws",
    "security": "tls",
    "sni": "node01.example.com",
    "host": "node01.example.com",
    "path": "/ray",
    "flow": "xtls-rprx-vision"
  },
  "trafficLimitGb": 100,
  "expirationDays": 30,
  "remarks": "Optional"
}
```

**Create response** includes the rendered artefact for the owner, so the wizard
can show a QR code immediately:

```json
{
  "data": {
    "config": { "id": "…", "name": "…", "type": "VLESS" },
    "assignments": [{ "id": "…", "userId": "…", "shareLink": "vless://…" }],
    "artifact": { "shareLink": "vless://…", "filename": "vless-….json", "warnings": [] }
  }
}
```

### Artefact endpoints

`GET /configs/:id/qr?format=png|svg|json&userId=…`

| `format` | Response |
| --- | --- |
| `png` (default) | `image/png` QR code |
| `svg` | `image/svg+xml` QR code |
| `json` | `{ payload, shareLink, protocol, forUserId }` |

`GET /configs/:id/download?format=json|link|qr&userId=…`

| `format` | Response |
| --- | --- |
| `json` (default) | Full client config (`application/json`) |
| `link` | A `.txt` containing the import URL |
| `qr` | A PNG QR code |

> **Credential isolation.** A regular user calling these endpoints without
> `userId` receives **their own** credential. Passing another user's `userId`
> returns `403`. The check runs inside `getConfigArtifact`, so it cannot be
> bypassed by the client.

---

## Plans & subscriptions

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/plans` | `plans:read` |
| `POST` | `/plans` | `plans:write` |
| `PATCH` | `/plans/:id` | `plans:write` |
| `DELETE` | `/plans/:id` | `plans:write` |
| `GET` | `/subscriptions` | `subscriptions:read` |
| `POST` | `/subscriptions` | `subscriptions:write` |
| `PATCH` | `/subscriptions/:id` | `subscriptions:write` |
| `DELETE` | `/subscriptions/:id` | `subscriptions:write` |

Deleting a plan that still has subscriptions **archives** it instead
(`{ archived: true }`), so existing customers keep their terms.

---

## Traffic

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/traffic` | `traffic:read` |
| `GET` | `/traffic/users/:id` | `traffic:read` **or** `self:traffic` (own id only) |
| `GET` | `/traffic/servers/:id` | `traffic:read` |

**Query:** `userId`, `serverId`, `configId`, `from`, `to`, `granularity`
(`hour|day|month`), `page`, `pageSize`.

**Response:** `{ totals, series, topUsers, topServers, recent, pagination }`

```json
{
  "data": {
    "totals": { "uploadBytes": 0, "downloadBytes": 0, "totalBytes": 0, "recordCount": 0 },
    "series": [{ "bucket": "2026-09-01T00:00:00.000Z", "uploadBytes": 0, "downloadBytes": 0, "totalBytes": 0 }],
    "topUsers": [{ "id": "…", "label": "John Doe", "totalBytes": 0 }],
    "topServers": [{ "id": "…", "label": "Germany Node 01", "totalBytes": 0 }],
    "recent": []
  }
}
```

All byte values are numbers (safe up to 9 PB).

---

## Dashboard

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/dashboard/stats` | `monitoring:read` |
| `GET` | `/dashboard/charts?days=30` | `monitoring:read` |
| `GET` | `/me/dashboard` | authenticated (own data) |
| `GET` | `/me/configs` | authenticated (own data) |
| `PATCH` | `/me/profile` | authenticated (own data) |

`/dashboard/stats` returns `stats`, `userCounters`, `serverCounters` and the
eight most recent audit entries — designed to be polled.

---

## Monitoring, logs, notifications

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/monitoring` | `monitoring:read` |
| `GET` | `/logs` | `logs:read` |
| `GET` | `/notifications` | authenticated |
| `POST` | `/notifications/:id/read` | authenticated |
| `POST` | `/notifications/read-all` | authenticated |

**Query (GET /logs):** `search`, `action`, `actorId`, `targetType`, `from`, `to`,
`page`, `pageSize`. The response also includes a `filters.actions` list for the
UI dropdown.

---

## Devices

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/devices?userId=` | self; `userId` requires staff |
| `POST` | `/devices` | self (or staff on behalf of a user) |
| `DELETE` | `/devices/:id` | self removes; staff revokes (notifies the owner) |

Device limits come from the user's plan and are enforced server-side.

---

## Settings

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/settings` | `settings:read` |
| `PATCH` | `/settings` | `settings:write`; the `security` category additionally requires `settings:security:write` (ADMIN only) |

**Patch body** (any subset of categories):

```json
{
  "general":  { "appName": "VPanel", "defaultTrafficLimitGb": 100, "trafficWarnPercent": 80 },
  "traffic":  { "countingMode": "config", "resetPeriod": "monthly", "autoSuspendOnExceed": true },
  "server":   { "defaultPort": 443, "heartbeatTimeoutSeconds": 180 },
  "security": { "sessionTimeoutMinutes": 60, "maxLoginAttempts": 8 },
  "branding": { "primaryColor": "#4f46e5", "footerText": "© 2026" }
}
```

---

## Health

`GET /health` — **public**, no authentication.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "production",
  "uptimeSeconds": 3600,
  "checks": { "database": "ok", "latencyMs": 3 },
  "providers": { "node": "local", "redis": "configured" },
  "workers": { "trafficIntervalSeconds": 120, "monitorIntervalSeconds": 60, "inlineWorker": false },
  "timestamp": "2026-09-26T12:00:00.000Z"
}
```

Returns `503` with `"status": "degraded"` when the database is unreachable.
Secrets are never included.

---

## Status values

| Enum | Values |
| --- | --- |
| `UserRole` | `ADMIN`, `OPERATOR`, `USER` |
| `UserStatus` | `ACTIVE`, `EXPIRED`, `TRAFFIC_EXCEEDED`, `DISABLED`, `SUSPENDED` |
| `ServerStatus` | `PENDING`, `ONLINE`, `OFFLINE`, `WARNING`, `DISABLED` |
| `ServerType` | `XRAY`, `V2RAY`, `GENERIC` |
| `ProtocolType` | `VLESS`, `VMESS`, `TROJAN`, `SHADOWSOCKS` |
| `ConfigStatus` | `ACTIVE`, `DISABLED`, `EXPIRED` |
| `SubscriptionStatus` | `ACTIVE`, `EXPIRED`, `TRAFFIC_EXCEEDED`, `SUSPENDED`, `CANCELLED` |
| `QuotaType` | `MONTHLY`, `TOTAL`, `UNLIMITED` |
| `DevicePlatform` | `ANDROID`, `WINDOWS`, `LINUX`, `MACOS`, `IOS`, `OTHER` |
| `DeviceStatus` | `ACTIVE`, `REVOKED`, `BLOCKED` |
| `NotificationSeverity` | `INFO`, `WARNING`, `CRITICAL` |
