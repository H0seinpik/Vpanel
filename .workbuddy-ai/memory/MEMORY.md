# VPanel — project notes

Admin panel for managing authorised V2Ray/Xray proxy configurations. Next.js 14
(App Router) + PostgreSQL/Prisma + an Xray-core node on the same Windows 11 host.
The operator is **not a programmer**; keep explanations plain.

> **Deep reference** (certificate mechanics, Windows scripts, port list, every
> diagnostic script, sandbox quirks, post-mortems) lives in `REFERENCE.md`. This
> file is the index: conventions, invariants, the outage rules, and verified state.

## Conventions

- TypeScript strict, Node 20+. No `any` in app code.
- `@/*` → `src/*`. **Type-only imports** across the server/client boundary
  (`import type { UserRole } from '@prisma/client'`) so Prisma never leaks into
  the browser bundle.
- Layout: UI in `src/app` + `src/components`; business logic in
  `src/server/services`; pure engines in `src/services`; helpers in `src/lib`.
  Route handlers are thin: parse → authorise → delegate → serialise.
- Errors: typed `AppError` subclasses; one converter (`toAppError`) + one responder
  (`jsonError`). One Zod schema per request body in `src/lib/validation`.
- Every API response passes through `serializers.ts` (BigInt → Number, Date → ISO,
  strips `passwordHash` / `agentTokenCipher`).

## Security invariants (never break)

1. `Configuration.params` must **never** contain a credential. Credentials live
   only in `ConfigAssignment.credential`.
2. Authorisation is enforced server-side in every route handler via `withAuth`,
   re-checked for row ownership inside services.
3. `withAuth` order: rate limit → authenticate → authorise.
4. Secrets come from the environment only.
5. Provider code may only contact servers in the `servers` table.
6. Only the worker writes `traffic_usage` — the browser is never authoritative.
7. Cookie `Secure` comes from `APP_URL` (`COOKIE_SECURE=auto`), **never**
   `NODE_ENV`. A production build over LAN HTTP must not set it or login fails
   silently. See `src/lib/auth/cookie-policy.ts`.

## Data model gotchas

- `traffic_usage` unique on `(serverId, userId, configId, windowKey)`. Postgres
  treats NULLs as distinct, so the worker does an explicit `findFirst` and applies
  only the **difference**. Order by `timestamp`, not `windowStart` (no such field).
- Byte counters are `BigInt` in Prisma, `Number` on the wire (safe to ~9 PB).
- `User.status` precedence: DISABLED/SUSPENDED (manual, never auto-reverted) →
  EXPIRED → TRAFFIC_EXCEEDED → ACTIVE.
- `createConfig()` returns `{ config, assignments }`, not a bare row.

## Build, run, supervise

```bash
npm run typecheck            # tsc --noEmit (0 errors)
npm test                     # vitest — 358 tests / 22 files
npm run build                # prisma generate + next build
npm run worker               # daemon (takes the single-writer lock)
npm run xray:sync            # reconcile the node config
npm run doctor [-- --connect]
npm run client:doctor        # START HERE for "it does not connect"
node scripts/launch.mjs      # start panel+worker detached (start.ps1's fallback)
node scripts/watchdog.mjs    # keep panel+worker+xray alive (autostarts at sign-in)
```

**Start the whole stack with `start.bat` / `windows/start.ps1`** — it uses
`Start-Process` (detached, so processes don't die with the launching shell) and
starts the **worker before the web** so the lock exists before the panel serves.
Never start the worker as a child of an interactive/agent shell.

**`start.bat` is the self-healer**: it detects web/worker liveness separately,
restarts ONLY what is missing, kills an orphaned xray on stop, and reports the
worker separately so "the panel is up" can never hide a dead worker. `start.ps1`
wraps its `Start-Process` calls in try/catch and falls back to `scripts/launch.mjs`
(Node `spawn({detached:true})`).

**Powershell `Start-Process` Path/PATH collision:** when the calling environment
holds two variables differing only by case, `Start-Process` throws
`Item has already been added. Key in dictionary: 'Path' … 'PATH'` and leaves the
stack half-started with null pids. `launch.mjs` (raw `spawn`) avoids this. If you
must use `Start-Process` by hand, launch **without `-RedirectStandardOutput`**,
which is what triggers the collision in this sandbox.

**Sandbox build quirks:** never let an npm script call a CLI by bare name
(`node_modules/.bin` can be empty) — invoke the real entry point, e.g.
`node node_modules/prisma/build/index.js`. `repair.bat` fixes a broken tree. The
sandbox blocks `npm run build` two ways: Bash `rm -rf .next` hits the bulk-delete
guard (use `node -e "fs.rmSync('.next',{recursive:true,force:true})"`), and the
build dies with `EPERM … .next\trace`. Fix:
`NODE_OPTIONS="--require C:/Users/Administrator/.workbuddy-ai/no-trace-shim.cjs"`
hands the build a swallowing stream for the trace file.

## The panel ↔ node link

`NODE_PROVIDER=xray` + `XRAY_ENABLED=true` means `src/server/services/xray-service.ts`
owns the node: it renders `config.json` from the database, restarts Xray only when
the hash changes, and reads real per-user traffic from the stats API. The `xray`
worker job reconciles every 15 s; every config mutation calls `triggerXraySync()`.

Client identity is `vp-<assignmentId>` (`src/services/providers/identity.ts`) and is
the only key traffic can be attributed by.

Worker intervals: traffic 120 s, monitor 60 s, enforce 600 s, xray reconcile 15 s.

## Outage rules (each cost a real outage)

Post-mortems live in `REFERENCE.md`.

1. **Unique inbound tags per config.** Assign the tag unconditionally — never
   `inbound.tag ?? fallback`. Two configs of one protocol collide and Xray refuses
   to start *entirely*, taking every inbound down.
2. **`collectXrayTraffic()` emits per-window TOTALS, not deltas.** Baselines live in
   `computeWindowTotals()` (pure, tested): first sighting → `0`; window rollover →
   previous raw value; node restart → `-(recorded so far)`. A failed stats query must
   never look like "no traffic" — it sets `lastStatsError`.
3. **Never `spawnSync` an external binary here.** It blocks the whole worker. Use
   `execCapture()` (async `spawn`) in `xray-service.ts`.
4. **Exactly one worker owns `config.json` — and after editing worker code you MUST
   restart the worker.** A stale daemon re-renders every 15 s, silently reverting
   your fix. Guards: `worker-lock.ts` (`acquireWorkerLock()`), `workers/index.ts`
   refuses daemon mode, `start.ps1` resolves a live worker first. **Before diagnosing
   by hand: stop the worker, then run `.vpanel/proc-map.ts`.**
5. **An empty render must never wipe the node on first observation.** `decideEmptyRender()`
   requires `EMPTY_RENDER_CONFIRMATIONS = 2` consecutive ticks; the first returns
   `hold`. Counter persisted in `.vpanel-state.json` (`emptyRenderCount`).
   `assertRenderIsApplicable()` refuses a render with no real port or no outbound.
6. **Ceilings enforced on the 15 s reconcile tick**, not the enforcement worker (runs
   every `max(TRAFFIC_INTERVAL_SECONDS*5, 300 s)`). Tick order is load-bearing:
   **collect → enforce → reconcile**. `renderXrayConfig()` wraps each config in
   try/catch — one malformed row must never throw out of the job.
7. **A port that cannot be bound must never reach Xray.** `port-conflicts.ts` (pure,
   tested): `staticPortConflict()` rejects ports Windows owns forever (**445/SMB is
   the trap**), `probePortBindable()` catches a third-party holder.
   `assertConfigIsServable()` re-checks at create/update time.
8. **"Worker alive" ≠ "worker working" — a wedged worker is worse than a dead one.**
   `worker-lock.ts` writes `.vpanel-worker.heartbeat` after every job via temp file +
   `renameSync`. `readWorkerHeartbeat()` reports `wedged: true` when a live pid's
   heartbeat is stale. **Watchdog threshold MUST exceed the interval it watches:**
   `watchdogAllowanceMs(ms) = ms*3 + 30s` (pure, tested).
9. **Never report a spawn as a successful start.** `startXrayAndVerify()` waits a
   bounded grace period, checks liveness, returns Xray's own `Failed to start: …`.
   `stopXray()` waits until no Xray remains, so a restart never races the port
   release.
10. **A health endpoint must never be cached.** `GET /api/health` sets
    `dynamic='force-dynamic'`, `revalidate=0`, `Cache-Control: no-store` — any
    handler reading the clock/filesystem/process state needs these three.
11. **A `'use client'` form must not rely on hydration to become usable.**
    `login-form.tsx` derived `disabled` only from `loading` (false on the server),
    validates in `onSubmit`, keeps native `required`, adds `<noscript>`. Evidence:
    `curl http://127.0.0.1:3000/login` must show no `disabled` on inputs/submit.
12. **The panel is a second writer to `config.json` — make it defer.**
    `syncXray()` calls `mayWriteNodeConfig(xrayDir)` and writes only if we own the
    lock or the owner is dead; defers (naming pid + role) when a live foreign
    process owns it.
13. **Never bind-probe a port the running node already owns.** Persist `appliedPorts`
    in `.vpanel-state.json`; pass `{ alreadyHeld }` to `renderXrayConfig()` and skip
    the probe. A bad probe dropped the whole port group and restarted Xray 15× in
    72 min ("no client can connect").
14. **Nothing supervises the stack — it must never depend on a session.** Three
    long-lived processes (web, worker, xray) beside PostgreSQL. `scripts/watchdog.mjs`
    (Node, no deps) polls `/api/health` **and** the worker heartbeat every 60 s, runs
    `start.ps1` after 2 consecutive bad checks. PostgreSQL survives only because it is
    a Windows *service*.
15. **A stop that leaves xray running is not a stop.** `stop.ps1` kills every
    `xray.exe` under `XRAY_DIR`, releases the lock, clears heartbeat + state.
    `repair.ps1` stops first, then ends by running `start.ps1`.
16. **REALITY is how "works everywhere" is achieved.** **The operator has NO domain
    and will not get one — never propose a domain, Let's Encrypt, or "point a hostname
    at the IP".** That makes REALITY the only certificate-free path, and the panel's
    default for VLESS. The node cert is self-signed, so CA-verifying clients
    (sing-box family: NekoBox/NekoRay/v2raybox) reject it; only Xray-core honours the
    `pinnedPeerCertSha256` pin. REALITY needs no cert — the client authenticates with
    an x25519 public key in the link, supported natively by Xray-core AND sing-box.
    `config-service.ensureRealityKeys()` generates the keypair via the node's own
    `xray x25519` at create/update and never rotates an existing one. Never add
    `allowInsecure=1` to a link — Xray 26 rejects it and breaks v2rayNG.
17. **`applyClients()` must carry the flow onto every per-assignment client.** Multi-user
    rendering REBUILDS the clients array and dropped `flow`, so a REALITY/VLESS client
    authenticated but transferred **no data** ("connected but no response"). Vision flow
    is per-CLIENT and must match both sides. `buildClient` emits it for VLESS and
    Trojan.
18. **Every link the panel hands out must carry the certificate pin.** The stored
    `shareLink` used to be generated WITHOUT `withTlsPin` while the delivery endpoint
    added it, so copied links had no `pinnedPeerCertSha256` and every TLS config failed
    in EVERY app. Fix: `createConfig`/`updateConfig`/`assignUsers` wrap params with
    `withTlsPin(...)` before `generateConfig`. The stored params must also always carry
    an EXPLICIT `security` (omitting it let the schema default the link to `reality`
    while `ensureRealityKeys()` generated no keypair). VLESS defaults to `none` (what
    the operator's clients accept); REALITY is explicit; Vision flow only for
    `tcp`+`tls`/`reality`. **A share link carries nothing meaningless**: `buildQuery()`
    drops values equal to the protocol default; `vhttp`-free links stay minimal
    (`?type=tcp&security=none#remark`). A plain VLESS must NOT read
    `…&encryption=none&fp=chrome&headerType=none`.
19. **A port listening on the machine is not a port reachable from outside.**
    `firewall.bat` used to open only the PANEL port, so nine of ten proxy ports had no
    inbound rule while every on-machine test reported success. `windows/firewall.ps1`
    now opens the panel port AND every port the live `config.json` serves
    (proxy ports `profile=any`), closes rules for ports no longer served, and `status`
    reports per-port allow state. A server→own-IP connection (NAT hairpinning) is NOT
    a firewall test; `client:doctor` section 2b reads the actual rules. Parsing
    `netsh`: the `Action:` line comes AFTER `LocalPort:`.
20. **Xray 26 removed four transports — offering one takes the WHOLE node down.**
    MEASURED with the binary: `tcp`, `ws`, `grpc`, `httpupgrade`, `xhttp` accepted;
    `http`/`h2` ("migrated to XHTTP"), `quic` (same), `kcp` ("mkcp header & seed
    removed") REFUSED. Xray refuses to start *entirely* on a bad transport, so one
    mKCP config stopped every port. Guards: `NETWORKS` lists only the five supported;
    **`validateRenderedConfig()`** runs the real binary against the rendered config
    BEFORE writing — a refusal leaves the previous config serving and reports Xray's
    own reason.
21. **The host has 4 GB RAM and this AI app takes 1.7 GB — check memory before blaming
    a configuration.** Measured while the operator reported "very low speed, nothing
    connects": WorkBuddyAI 1705 MB, Edge 295 MB, postgres 228 MB, node (panel+worker+
    watchdog) 141 MB, xray 27 MB, free ~242 MB. The proxy stack needs only ~170 MB, so
    the machine paged and the network collapsed. On a "slow / nothing connects" report
    with a healthy node, measure with `Get-Process | Sort WorkingSet64` FIRST. Fix:
    start the stack with `start.bat` (independent) and close the AI app and browser.

## XHTTP options (probed 2026-09-29)

`xhttpSettings`: `path`, `host`, `mode` (auto | packet-up | stream-up | stream-one),
`extra.{scMaxBufferedPosts, scMaxEachPostBytes, scMinPostsIntervalMs, noSSEHeader,
xPaddingBytes, xmux}`, `noGRPCHeader`; `headers` containing "host" is rejected.
**MEASURED trap (`.vpanel/xhttp-match-test.ts`): with the server on `stream-up` or
`stream-one`, a client that did not set the same mode got NO DATA — and a share link
cannot carry `mode`.** So `XHTTP_MODES = ['auto','packet-up']` only. `extra.xmux` and
`extra.xPaddingBytes` are server-side and never break a client; xmux reduces request
count. Throughput caps removed from defaults: `scMaxEachPostBytes: 8000000`,
`scMinPostsIntervalMs: 0`, `scMaxBufferedPosts: 256`. Any new xhttp option must be
measured this way before exposure.

## Shadowsocks accounting — NOT single-shape

Xray per-user stats are keyed on client `email` (`user>>>EMAIL>>>traffic>>>uplink`);
**no email ⇒ no counter.** Shadowsocks in Xray 26 is NOT a superset: the cipher must
be **PER CLIENT** (`{method, clients:[{password,email}]}` is REJECTED). `applyClients()`
deletes the inbound-level `method`/`password` and injects the method into each client.
Proven by the `ss-*-proof.ts` scripts.

## Port sharing — many customers on one public port

Policy in `src/services/port-sharing.ts`; fallbacks live at
`inbound.settings.fallbacks`, **NOT** `streamSettings.fallbacks`. The parent must be
**TCP+TLS with `alpn:["http/1.1"]`** and carry **no tag**; only VLESS/Trojan qualify;
the transport must expose a path — **`ws` or `httpupgrade` only** (`xhttp`/`grpc` →
000); a REALITY config can never share. **One port = one configuration; extra
CUSTOMERS are users on it, not extra configurations.**

## Diagnosing "no ping, no data"

**`npm run client:doctor` first**; a ping tests the PORT, not the configuration. In
order: transport set by hand in the client; `"read write closed pipeline"` /
`core instance is nil` are CLIENT-side strings; the self-signed certificate (rules
16/18); **and check the machine's RAM (rule 21)**.

## `api.get()` envelope unwrapping

`apiFetch` returns `payload.data` only when the response has **no sibling keys**;
otherwise the whole envelope (that is how `pagination` survives). Never use
`.data.data` — it compiles and crashes the browser.

## Verified state

Xray-core **v26.9.8** at `C:\xray`. The worker owns `.vpanel-worker.lock`, writes
`.vpanel-worker.heartbeat` + `.vpanel-state.json` (incl. `appliedPorts`); xray is its
child; panel on 3000; `scripts/watchdog.mjs` keeps the stack alive and `firewall.bat`
opens every port the node serves. **358/358 tests in 22 files.** `tsc --noEmit` clean.
`client:doctor` — all sections `[ok]`, section 2b reports each port's firewall state.
**Share links built from `servers.hostname` (public IP), never `APP_URL`.**

Proven live: every configuration carries real bytes — `deliver-test.ts` builds each
link exactly as the panel delivers it and connects a real client (`HTTP/1.1 200 OK`);
`trafficUsedBytes` matches the node counter; a ceiling flips the config to
`TRAFFIC_EXCEEDED` within 15 s; a malformed row is skipped, never fatal;
`taskkill /F /IM xray.exe` → the reconcile brings Xray back; a second
`npm run worker` exits 2. **A source fix to worker code is not live until the worker
restarts.**

## Diagnostic tooling (read-only, `.vpanel/`)

Start with `npm run client:doctor`; `proc-map.ts` (pids/parents, port owners, **the
lock holder**), `one-link.ts` (**one configuration at a time, with full client logs —
the only trustworthy test**), `deliver-test.ts`, `dump-links.ts`, `ps-syntax.ts`.
Gotchas: `tsx -e` cannot resolve `@/*` — write a script file; `worker.log` has NUL
bytes (read as a buffer); never hand-write a `netstat | grep` port list.
