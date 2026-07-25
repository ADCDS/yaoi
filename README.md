# 📡 Kimsufi Watch

Live availability monitor for **OVH Eco** dedicated servers (Kimsufi / Rise /
So you Start / Advance / Scale), with notification **targets**.

It reads OVH's public, no-auth feed
`/dedicated/server/datacenter/availabilities`, which reports availability **per
exact configuration** (`planCode` + memory + storage) **per datacenter** — so it
shows the *order-level truth*, not the marketing catalogue. That's the whole
point: the eco catalogue may advertise e.g. *KS-1 with 2×480 GB SSD in Canada*,
but the order page will only sell *2×2 TB* there. This tool surfaces that
difference directly, so you never have to open servers one-by-one again.

## Run

```bash
cd kimsufi-monitor
node server.js          # Node >= 18 (uses built-in fetch). No npm install needed.
```

Open <http://localhost:4321> and click **🔔 Enable alerts** (browser desktop
notifications). Keep the tab open; it polls every 60 s and pushes live updates
over SSE.

## Targets

A **target** is a saved filter that you want to be *notified* about. Ships with
one preconfigured: **Canada · NVMe · available now**. Each target shows its live
match count + how many are *in stock now*; when a matching config flips from
unavailable → available you get a desktop notification, a toast, and a beep.

Create/edit targets in the UI (country, storage type, range, min RAM, plan
codes, "in-stock only", …). They're saved to `data/targets.json`.

## Config (env vars)

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `4321` | web port |
| `HOST` | `127.0.0.1` | bind address — loopback by default; set `0.0.0.0` to expose on all NICs |
| `AUTH_TOKEN` | _(empty)_ | if set, every request needs the token (see Hosting) |
| `MAX_SSE` | `50` | cap on concurrent live-stream connections |
| `POLL_INTERVAL` | `60` | seconds between polls (min 15) |
| `OVH_SUBSIDIARY` | `CA` | catalogue subsidiary for commercial names + pricing |
| `OVH_AVAIL_URL` | eu.api.ovh.com feed | availability source |

Commercial names + prices come from the OVH order catalogue (best-effort). If it
can't be fetched, the app falls back to names derived from the plan code/specs —
availability monitoring is unaffected.

## Hosting & security

There are **no credentials in this app** (OVH's availability feed is public) and
all rendered input is escaped, so the data isn't sensitive. The risks of exposing
it are abuse, not leaks: the API has no auth, so anyone could edit your targets or
spam `/api/refresh` (which would pull from OVH through your IP). Hardening applied:

- binds to **127.0.0.1** by default (set `HOST` to change),
- optional `AUTH_TOKEN` gate on **every** request,
- `/api/refresh` throttled to once / 10 s, and SSE capped at `MAX_SSE`.

Recommended ways to put it online:

1. **Tailscale (simplest, private).** Run with the default loopback bind and
   `tailscale serve 4321` (HTTPS within your tailnet). Only your devices reach it;
   the tailnet is the auth boundary — no `AUTH_TOKEN` needed.
2. **Cloudflare Tunnel + Access.** `cloudflared tunnel --url http://localhost:4321`
   and gate the hostname with Access (e.g. your Google login). Auto-HTTPS, no open
   ports.
3. **Public VPS.** Keep the loopback bind, set a strong `AUTH_TOKEN`, and front it
   with Caddy/nginx for TLS:
   ```bash
   AUTH_TOKEN="$(openssl rand -hex 24)" node server.js
   ```
   Then open `https://your-host/?token=THE_TOKEN` once — the token is stored in an
   HttpOnly cookie and dropped from the URL.

Note: targets are **global/server-side** and alerts are **per-browser**, so this
is single-tenant — fine for you, not a shared multi-user service.

## Notes

- **Canada** = datacenters `bhs` (Beauharnois) **and** `ca-east-tor-a` (Toronto).
- Availability values: `1H-high/1H-low` = in stock, `24H/72H/480H…` = orderable
  with a delivery delay, `comingSoon`, `unavailable`.
- The per-row **API↗** link verifies that exact config straight from OVH.
