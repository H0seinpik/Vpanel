# Running VPanel on a Windows PC

Everything here is driven by double-clickable `.bat` files in the **project
root**. The `.ps1` files in this folder do the actual work — you never need to
run them directly, and you never need to open a terminal.

---

## Quick start

**Prerequisite: a database.** VPanel needs PostgreSQL. If you do not have one
yet, install it once (see [Two ways to run it](#two-ways-to-run-it) below) — on a
machine with 4 GB of RAM, PostgreSQL alone is much lighter than Docker Desktop.

| Step | Double-click | What it does |
| --- | --- | --- |
| 0 | *(once)* install PostgreSQL, then `db-setup.bat` | Installs PostgreSQL and creates the role + database. Skip if you already have PostgreSQL, or if you are using Docker. |
| 1 | `install.bat` | Creates `.env` with generated secrets, installs dependencies, creates the schema, builds the app, creates your admin account. **Run once.** |
| 2 | `start.bat` | Starts the panel and opens it in your browser. |
| 3 | `stop.bat` | Stops the panel. Your data is untouched. |

After that, `start.bat` and `stop.bat` are all you need day to day.

---

## All the commands

| File | Purpose |
| --- | --- |
| `install.bat` | First-time setup. Re-run with `install.bat -Force` to regenerate secrets. |
| `install-xray.bat` | Downloads Xray (the actual proxy server) to `C:\xray`. Run once. |
| `xray-sync.bat` | Renders the panel's configurations into Xray and restarts it. **Run after every config change.** |
| `xray-start.bat` / `xray-stop.bat` | Start / stop Xray on its own. |
| `xray-status.bat` | Is Xray running, and which ports are open? |
| `db-setup.bat` | Native mode only: creates the PostgreSQL role and database for you. Run it once after installing PostgreSQL. |
| `reset-pg-password.bat` | Forgot the PostgreSQL superuser password? Resets it safely (needs admin). Default new password `123`; override with `-Password "..."`. |
| `start.bat` | Start the panel and open the browser. |
| `stop.bat` | Stop the panel. Add `-Down` to remove the Docker containers (data volumes are kept). |
| `restart.bat` | Stop, then start. Use after editing `.env`. |
| `status.bat` | Is it running? Is it healthy? What URLs should I use? |
| `logs.bat` | Recent web + worker output. `logs.bat worker` for the worker, `logs.bat web follow` to watch live. |
| `backup.bat` | Write a database dump into `.\backups`. Add `-KeepDays 30` to change retention. |
| `repair.bat` | Fixes a broken `node_modules` (missing npm bin shims, missing Prisma client). Add `-Reinstall` to wipe and reinstall. |
| `autostart.bat` | `install` / `remove` / `status` — start the panel automatically when you sign in. |
| `firewall.bat` | Let other devices on your network reach the panel. **Right-click → Run as administrator.** |

---

## Two pieces: the panel and the proxy server

This is the part that trips people up, so it is worth being explicit:

| Piece | What it is | Where it lives |
| --- | --- | --- |
| **VPanel** | The management panel. Users, quotas, config generation, traffic accounting. | This project, port 3000 |
| **Xray** | The actual proxy server that accepts client connections. | `C:\xray`, your chosen port |

**VPanel alone cannot be connected to.** It generates the *configuration*; Xray
serves it. If Xray is not running, a generated link has nothing to connect to.

```
panel generates a config  ->  xray-sync.bat writes it into C:\xray\config.json
                          ->  Xray listens on the port
                          ->  your client (NekoBox / v2rayN) connects
```

### Setting up the proxy side

```bat
install-xray.bat          :: once - downloads Xray to C:\xray
```

Then, in the panel:

1. **Servers → Add server** — your public IP, and the port you want to serve on
2. **Configurations → Create configuration** — pick that server, a protocol, and
   the user it belongs to
3. Copy the generated link (or scan the QR code)

Then apply it to Xray and open the port:

```bat
xray-sync.bat             :: render the config and start Xray
firewall.bat add-port     :: as administrator - let clients in
```

`xray-status.bat` tells you whether Xray is up and which ports are open.

**Remember: every time you add or change a configuration in the panel, run
`xray-sync.bat` again.** The panel does not push changes to Xray by itself.

### Choosing a protocol

| Protocol | Encrypted without a certificate? | Notes |
| --- | --- | --- |
| **VMess** | Yes | Simplest to get working on a bare IP. Xray warns it is deprecated but it still works. |
| **VLESS** | **No** — needs TLS | Use only with a domain and a real certificate |
| **Trojan** | Needs TLS | Requires a certificate |
| **Shadowsocks** | Yes | One user per port |
| **WireGuard** | — | **Not supported by VPanel** |

On a bare IP with no domain, **VMess is the pragmatic choice** — it encrypts on
its own, so you do not need a certificate.

## Two ways to run it

`start.bat` picks one automatically.

### Native mode (Node + PostgreSQL)

Runs the web server and the background worker as background processes, recording
their PIDs in `.vpanel\runtime.json` and their output in `.vpanel\web.log` and
`.vpanel\worker.log`.

**This is the better choice on a machine with limited RAM.** Measured footprint
is roughly 600-700 MB in total:

| Component | Approx. RAM |
| --- | --- |
| PostgreSQL | 150-300 MB |
| Next.js web server | ~200 MB |
| Background worker | ~120 MB |

Redis is optional — with no Redis running, the app falls back to in-process
rate limiting and worker locks, which is fine for a single instance.

Setup:

```powershell
# 1. Install PostgreSQL (needs an elevated prompt for the installer).
#    Find the current package id first - version numbers move.
winget search PostgreSQL
winget install PostgreSQL.PostgreSQL.18      # or whatever the search shows

# 2. CLOSE this window and open a new one - winget does not refresh PATH

# 3. Create the role and database (asks for the postgres superuser password)
db-setup.bat

# 4. Finish
install.bat
```

Any PostgreSQL from 14 upwards works; the scripts discover whichever version you
installed (`C:\Program Files\PostgreSQL\<version>\bin`) and do not care which.

If winget does not recognise that package, run `winget search PostgreSQL` to find
the current ID, or download the installer directly from
<https://www.postgresql.org/download/windows/>. Either way, **remember the
superuser password you choose** — `db-setup.bat` needs it once.

`db-setup.bat` creates the role and database from the values already in `.env`,
so you never write SQL. If PostgreSQL is installed but its service is stopped,
`install.bat` and `start.bat` try to start it for you.

> If PostgreSQL is installed but `psql` is still not found, the scripts also look
> in `C:\Program Files\PostgreSQL\<version>\bin` directly — winget installs it
> there without adding it to `PATH`.

### Docker mode

Used when a working Docker engine is detected. One command brings up PostgreSQL,
Redis, the web app, the worker and nginx — nothing else to configure, and the
database lives in a Docker volume that survives restarts and upgrades.

**Budget ~1.5 GB of RAM for Docker Desktop itself** (WSL2 + the daemon) on top of
the stack above. On a 4 GB machine that leaves very little headroom, which is why
native mode is the recommendation there. Docker is also awkward for an
always-on server: Docker Desktop only runs while a user is signed in.

If you still want it:

```powershell
winget install Docker.DockerDesktop
# start Docker Desktop once, wait for "Engine running", then:
install.bat
```

---

## Reaching the panel from other devices

Your PC is the server; you want to open the panel from your phone or laptop.

1. **Open the firewall once** — right-click `firewall.bat` → *Run as administrator*.
   This adds an inbound rule for the panel's port, scoped to the **Private and
   Domain** profiles only. Public Wi-Fi stays closed.

2. **Set `APP_URL` in `.env` to the address you will actually type.** This is the
   step people miss:

   ```ini
   APP_URL=http://192.168.1.50     # your PC's LAN IP, no trailing slash
   ```

   `status.bat` prints the exact LAN URL to use. Copy that value in.

3. Run `restart.bat` for the change to take effect.

### Why `APP_URL` matters

The auth cookies are `httpOnly`, so JavaScript can never read them — good. But
browsers **reject cookies flagged `Secure` when the page is served over plain
HTTP**, except on `localhost`. So a panel served at `http://192.168.1.50` with
`APP_URL=https://...` would let you log in and then immediately bounce you back
to the login screen.

VPanel handles this by deriving the `Secure` flag from `APP_URL`:

| `APP_URL` | Cookies | Works from |
| --- | --- | --- |
| `http://localhost:3000` | not Secure | this PC only |
| `http://192.168.1.50` | not Secure | any device on your LAN |
| `https://panel.example.com` | Secure | anywhere, over TLS |

You can override it with `COOKIE_SECURE=true|false` in `.env` if you have an
unusual setup.

> **Plain HTTP on a LAN sends your password in the clear.** That is acceptable on
> a home network you control. If you expose this panel to the internet, put TLS
> in front of it — see [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) §7 for the
> Let's Encrypt walkthrough. The nginx container already has the TLS server block
> ready; you only need to drop certificates into `docker\nginx\certs\`.

---

## Starting automatically

A PC acting as a server usually should not need a human to start things.

```bat
autostart.bat install
```

This registers a per-user Scheduled Task that runs `start.ps1 -NoBrowser` at
sign-in. No administrator rights needed, and `autostart.bat remove` undoes it.

**If the panel must run before anyone logs in**, create a task manually in Task
Scheduler with the trigger *At startup* and the account *SYSTEM*. That variant
needs administrator rights, and it only works in native mode (Docker Desktop
does not run under the SYSTEM account).

---

## Common problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| Login succeeds, then you land back on `/login` | Cookie rejected — `APP_URL` scheme/host does not match how you are browsing | Set `APP_URL` to the exact URL you type, then `restart.bat` |
| `PostgreSQL is not reachable at localhost:5432` and `psql` is missing | No database installed | `winget search PostgreSQL`, install it, open a **new** window, then `db-setup.bat` |
| `PostgreSQL is not reachable` but `psql` was found | The service is stopped (common after a reboot) | `net start postgresql-x64-18` (match your version) in an elevated window, or start it in `services.msc`. `start.bat` also tries this for you. |
| `psql was not found` right after installing PostgreSQL | winget does not refresh `PATH` in existing windows | Close the window and open a new one — the scripts also probe `Program Files\PostgreSQL` directly |
| `could not create the role` | Wrong superuser name or password | Re-run `db-setup.bat -SuperUser postgres` with the password chosen during installation |
| You don't know the PostgreSQL superuser password | It is stored as a hash and cannot be read back | `reset-pg-password.bat` (right-click → Run as administrator). It briefly makes local connections password-free, sets a new password, then restores the original rules. |
| `'prisma' is not recognized` / `'next' is not recognized` | `node_modules\.bin` was never created — the install completed but the shims did not | `repair.bat`. VPanel's own npm scripts call every CLI by its real path, so the build works once the shims exist (or even without them). |
| `Cannot find module '@prisma/client'` | The Prisma client was never generated | `repair.bat`, or `npm run prisma:generate` |
| `Node.js was not found on PATH` | Native mode without Node | Install Node.js 20+ from nodejs.org, or use Docker mode |
| Panel not healthy after `start.bat` | First build still running, or a config error | `logs.bat` — the web log names the problem |
| Port 80 already in use | IIS, Skype, or another web server | Set `HTTP_PORT=8080` in `.env` (Docker mode) and browse to `http://localhost:8080` |
| Port 3000 already in use | Another dev server | Set `PORT=3001` in `.env` (native mode) |
| Build fails with `EPERM` or file-lock errors | Antivirus or a file watcher holding files | Add the project folder to your antivirus exclusions and retry |
| Build runs out of memory | `next build` is the peak-memory step | Close other applications; if it keeps failing, raise the page file size |
| `docker compose` says the engine is not running | Docker Desktop is installed but stopped | Start Docker Desktop, wait for "Engine running", retry |

---

## Security notes

- **`.env` holds your database password and the keys that encrypt stored agent
  tokens.** It is gitignored — keep it that way, and never share it. If you lose
  `JWT_REFRESH_SECRET`, every stored agent token must be re-entered.
- **`.\backups` holds credentials and the full audit trail.** Keep it out of any
  web-served folder, and copy it off this machine. See
  [`docs/BACKUP.md`](../docs/BACKUP.md).
- **Change the administrator password after your first login** (Profile → Change
  password). Doing so signs out every existing session.
- **The firewall rule is scoped to Private/Domain networks** so the panel is not
  exposed when your PC joins public Wi-Fi.
- **Anyone who can reach the panel can attempt to log in.** Rate limiting (8
  attempts per 5 minutes) blunts brute force, but a strong admin password is what
  actually protects it.

---

## How the pieces fit

```
start.bat  ->  windows\start.ps1  ->  windows\_vpanel.ps1   (shared helpers)
stop.bat   ->  windows\stop.ps1       - mode detection
status.bat ->  windows\status.ps1     - .env parsing
...                                   - health checks
                                      - PID tracking
```

Runtime state lives in `.vpanel\`:

| File | Contents |
| --- | --- |
| `runtime.json` | PIDs of the running web server and worker (native mode) |
| `web.log`, `web.log.err` | Web server output |
| `worker.log`, `worker.log.err` | Background worker output |

Delete `.vpanel\` freely when the panel is stopped — it is recreated on the next
start and holds nothing you cannot regenerate.
