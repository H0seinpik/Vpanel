# Several configurations on port 443 — step by step

Your server: **195.248.241.251**, Xray listening on **443**. Panel at
`http://localhost:3000`.

---

## The idea in one paragraph

A TCP port can only be held by one program at a time, so you cannot have several
separate listeners on 443. Instead **one** listener holds 443, and it reads the
start of each connection to work out which configuration it belongs to. VLESS
over WebSocket sends a **path** (something like `/vp-21msxqcwh1`), and that path
is the label that separates your configurations. Each one still has its own
credential, its own traffic counter and its own limit — they just come in through
one front door.

Four things must all be true for a configuration to join a shared 443:

| Setting | Value | Why |
|---|---|---|
| Protocol | **VLESS** | Only VLESS and Trojan can share a port, and only VLESS routes by path |
| Security | **tls** | Without TLS the listener cannot tell your client from ordinary web traffic |
| Transport | **ws** | It is the path that labels each configuration; `tcp` has no path |
| Port | **443** | The port you want them all on |

---

## Before you start — one important thing

There is only **one** certificate on the whole server (at `C:\xray\cert.pem`).
It is what makes TLS work, and the panel stamps its fingerprint ("the pin") into
every client link it issues. **You never enter or upload it anywhere** — the
panel attaches it for you, to every TLS configuration, automatically. That is why
you should get **all** your 443 configurations created and working first, and only
then hand the links out. If the certificate is ever replaced, every link you have
already given out stops working.

**Each configuration does not need its own certificate.** One is enough for all of
them, including several configurations sharing port 443 — they come in through the
same listener, so they present the same certificate. When you create a
configuration, the wizard shows a green line confirming this:

> **TLS certificate ready — no action needed**
> One certificate covers every TLS configuration on this server. It is added
> automatically when the node config is built, so there is nothing to paste here.

Check it is healthy at any time with:

```
doctor.bat
```

You want to see:

```
  [ok]    TLS certificate present (pin 24098dd21a1a8f23...)
```

If that line says `[FAIL]`, run `xray-gencert.bat` — but read the next section
first, because it matters when you run it.

### If the certificate is ever missing

```
xray-gencert.bat
```

creates it. It deliberately **refuses** to replace an existing certificate,
because doing so would break every client you have already given a link to. If
you are sure you want a fresh one (you will re-issue every client), use
`xray-gencert.bat -Force`.

---

## Step 1 — Free port 443 for sharing

If you already have a configuration on 443 that is **not** `ws`, it blocks every
other configuration from joining 443, and you will see:

> Port 443 is already used by "Server 01 · VLESS", and the configurations cannot
> share it: · "Server 01 · VLESS" — the "tcp" transport has no path to route on.

**You do not need to delete it.** You can change its transport in place, and its
credential stays the same — so any client already using it keeps working.

1. Open the configuration (**Configurations → your 443 config**).
2. Change **Network / Transport** to **`ws`**.
3. Set **Path** to something starting with `/`, e.g. `/vp-main`. Any unique value
   works. It must **not** contain spaces or dots.
4. Save.

That is all it takes. A `tcp` configuration has no path, so it cannot be routed
when several configurations want the same port — switching it to `ws` gives the
server something to route on.

> **Watch out for one trap.** The **Path** field must start with `/`. If you paste
> the certificate fingerprint (a long hex string like `24098dd21a1a8f23…`) into
> it, that is not a path — the client will send it literally and connections may
> behave oddly. Use a short path such as `/vp-main`.

Then:

```
xray-sync.bat
```

### If a configuration genuinely cannot be converted

- **VMess** and **Shadowsocks** cannot share a port at all; only VLESS and Trojan
  can. A VMess configuration on 443 must be given its own port.
- **Trojan** can share, but only VLESS routes by path.

---

## Step 2 — Create the first shared configuration

1. Open the panel at `http://localhost:3000` and log in.
2. **Configurations → Create.**
3. **Step 1** — pick **Server 01**.
4. **Step 2** — pick **VLESS**.
5. **Step 3** — pick the user who should get it.
6. **Step 4** — name it (e.g. `Shared 01`), set an expiry and an optional
   traffic limit, then **Continue**.
7. **Step 5 — Parameters.** Fill in exactly this:

   | Field | Value |
   |---|---|
   | Address | `195.248.241.251` |
   | Port | `443` |
   | Network / Transport | `ws` |
   | Security | `tls` |
   | SNI | `195.248.241.251` |
   | Path | **leave empty** |
   | Host header | leave empty |

   Leave everything under **Advanced settings** alone.

8. **Generate.**

### What you should see

Because nothing else is live yet, 443 is free, so you get a plain result and the
configuration is created. It is the only thing on 443 for now.

---

## Step 3 — Create the second configuration

Repeat step 2 exactly. Same protocol, same TLS, same `ws`, same port **443**.

This time, when you reach **Step 5**, the wizard notices 443 is already in use
and shows a **blue banner**:

> **Port 443 is shared — this configuration gets its own path.**
> 1 configuration already uses port 443. Xray routes each one by its path, so
> they all stay separate — each keeps its own credential, traffic counter and
> limit. Give this one the path `/vp-xxxxxxxx` below, or keep your own.

**Fill in the Path field with the path the banner shows you.** Do not leave it
blank this time, and do not invent your own — copy the suggested one. Every
configuration on the shared port needs a *different* path.

Then **Generate**.

Repeat for a third, a fourth, as many as you want. Each gets its own path.

---

## Step 4 — Make sure each one actually connects

Before you hand anything out:

```
doctor.bat --connect
```

Every configuration should report `connected`. This starts a real client process
and opens a real connection through your node, so it is the honest answer.

Then on each configuration's page, copy the **import link** (or scan the QR
code) and check it on a client. The link will contain `type=ws` and a
`path=%2Fvp-...` — if it says `type=tcp` or has no path, that configuration is
not on the shared port.

---

## What the wizard will refuse, and why

| You choose | Result |
|---|---|
| VLESS + tls + **ws** on 443 | **Shares it.** Give it a unique path. |
| VLESS + tls + **tcp** on 443 | Refused — `tcp` has no path to route on. Use `ws`. |
| **VMess** on a shared 443 | Refused — VMess cannot share. It would take the port and silently carry nothing, which is worse than an error. |
| VLESS + **none** (no tls) on 443 | Refused — the listener needs TLS. |
| Port **445** | Refused — Windows owns it for file sharing, permanently. |
| A free port (e.g. 8443) | Fine — it gets its own separate listener, as before. |

---

## Limits worth knowing

- **The first configuration on a port gets it to itself.** The shared fallback
  structure only kicks in once a second configuration wants the same port.
- **Nested sharing is not a thing.** All configurations wanting 443 need to be
  VLESS + tls + ws. One `tcp` configuration on 443 blocks sharing for the others
  on that port.
- **Each configuration keeps its own limit and counter.** Sharing a port does not
  merge traffic accounting — each still stops on its own ceiling.
- **Do not run two instances of the worker** (see `stop.bat` / `start.bat`). Two
  workers overwrite the node config every 15 s and produce confusing results.

---

## If something does not work

| Symptom | What to check |
|---|---|
| Wizard says the port cannot share | Your transport is `tcp`, your security is `none`, or the protocol is VMess. See the table above. |
| Configuration created but will not connect | `doctor.bat --connect`. Look for a `skipped` line explaining why it is not being served. |
| All TLS configurations stopped at once | `doctor.bat` — check the certificate line. A missing certificate skips *every* TLS configuration. |
| Client connects but hangs | The path on the client does not match the path on the server. Re-copy the import link from the configuration page. |
| Port looks open but nothing connects | You are on port 445, or another program holds the port. Use 443, 444, 2087, 8443, 2053 or 2083. |
