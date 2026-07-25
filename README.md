# 📡 YAOI — Yet another OVH Inspector

Live availability for **OVH Eco** dedicated servers — Kimsufi, Rise, So you
Start and Advance — read per exact configuration **and per datacenter**.

It uses OVH's public, no-auth feed
`/dedicated/server/datacenter/availabilities`, which reports availability for
each `planCode` + memory + storage combination in each datacenter. That is the
*order-level* truth rather than the marketing catalogue: the catalogue may
advertise a KS-1 with 2×480 GB SSD in Canada while the order page will only sell
you 2×2 TB there. This surfaces that difference directly.

## What it shows

**One row per configuration, datacenters as columns.** Availability is not a
yes-or-no — it is a position on a delivery-time ladder, and the useful question
is usually *where* you can get a machine, not merely whether someone somewhere
has one. So `RISE-1` is a single row telling you it is in stock in Beauharnois,
Frankfurt, Gravelines and London but a day out in Warsaw and Mumbai.

Cells encode the ladder: in stock (≤1h) → 24h → 72h → longer → coming soon → out
of stock. A **hollow** cell means OVH does not sell that configuration in that
datacenter at all, which is a different fact from being out of stock.

A **watch** is a saved description of what you want. Each one shows its live
match count and how many are in stock now, and tells you when a match appears.

## Run it

```bash
node server.js        # Node >= 18. No dependencies, no build step, no install.
```

Open <http://localhost:4321>. It polls every 60 seconds and streams updates.

```bash
npm test              # 94 tests, node:test
node bin/check.js --channels        # which notification channels are configured
node bin/check.js --test-channel telegram
```

## The three ways to run it

The same code runs three ways. They differ in where a watch lives and how far a
notification can reach.

| | Public dashboard | Your own fork | A server you run |
|---|---|---|---|
| Watches live in | your browser | a repository secret | `data/watches.json` |
| Matching runs | in your browser | in GitHub Actions | on the server |
| Alerts reach | this browser, tab open | Telegram, ntfy, Discord, email | all of those |
| Checks every | ~5 minutes | ~5 minutes | 60 seconds |
| Accounts | none | none | none |

**The public dashboard holds nothing personal.** It is a static page plus a
snapshot file. Your watches are in your own browser's storage, matched there by
the same code the server uses — so there is no shared state, nothing to collide
when many people use it at once, and nothing for anyone to read.

The trade is real, and the page says so rather than implying otherwise: **a
static page can only alert you while a tab is open.** For alerts that reach your
phone with the tab closed, run your own copy —
[docs/deploy-your-own.md](docs/deploy-your-own.md) walks through it in about five
minutes.

### Publishing your own dashboard

The `Publish snapshot` workflow deploys to GitHub Pages, but Pages has to be
turned on once by hand first — the workflow token can deploy to an existing site
and not create one:

```bash
gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
```

or **Settings → Pages → Source: GitHub Actions**. After that the schedule keeps
it fresh on its own.

## Notifications

Four channels, all dependency-free. Configure whichever you want by environment
variable; anything unset is simply off.

| channel | variables |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| ntfy | `NTFY_TOPIC`, optionally `NTFY_URL`, `NTFY_TOKEN` |
| Discord / Slack | `WEBHOOK_URL` |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TO` |

Each watch picks its own channels, so an overnight watch can wake your phone
while a browsing watch stays quiet. Watches also take `cooldownMinutes` (stay
quiet after alerting about the same machine) and `quietFrom`/`quietTo` (which
wrap midnight). Alerts are batched into one message per check, and every one
carries a link straight to the order page.

Email speaks SMTP directly rather than pulling in a mail library — see
`core/notify/smtp.js`. It is about 120 lines and covered by tests that run a real
SMTP server and assert on the transcript.

## Configuration

| variable | default | meaning |
|---|---|---|
| `PORT` | `4321` | web port |
| `HOST` | `127.0.0.1` | bind address; loopback by default |
| `AUTH_TOKEN` | *(empty)* | if set, every request needs the token |
| `MAX_SSE` | `50` | cap on live-stream connections |
| `POLL_INTERVAL` | `60` | seconds between polls (minimum 15) |
| `OVH_SUBSIDIARY` | `CA` | catalogue subsidiary for names, prices and order links |
| `OVH_AVAIL_URL` | eu.api.ovh.com | availability source |
| `DATA_DIR` | `./data` | where watches, state and the event log live |
| `WATCHES_FILE` | `$DATA_DIR/watches.json` | watch storage |
| `WATCHES_JSON` | — | watches as JSON, for environments with no writable disk |

## Things worth knowing

**Prices exist only for eco ranges.** OVH publishes a public catalogue for
`eco`, and nothing equivalent for Scale, High Grade, HCI or SDS —
`order/catalog/public/baremetal` and `.../dedicated` both 404, and `eco` returns
the same 98 plans in every subsidiary. Those ranges are hidden by default behind
one toggle, and when shown they say *no public price* rather than a bare dash.
Roughly 4,165 of the 16,689 configurations are eco.

**Mumbai is `ynm` in the feed**, not `mum`. All 1,775 configurations sold there
carry a `-mum` plan code, which is how it was identified.

**Datacenter and country filters are built from live data**, so you are never
offered a filter that cannot return anything.

**Order links are tiered**, because OVH's own pages are. Kimsufi, Rise and So
you Start have per-model pages on `eco.ovhcloud.com`; Advance, Scale and High
Grade only have range listings under `/bare-metal/`; HCI and SDS have no public
page, and those rows show only the API verification link rather than a control
that leads nowhere.

**Availability values** are `1H-high`/`1H-low` (in stock), `24H`/`72H`/`480H…`
(orderable with a delivery delay), `comingSoon`, and `unavailable`.

## Hosting and security

There are no credentials in this app — OVH's availability feed is public — and
all rendered input is escaped, so the data is not sensitive. The risk of exposing
it is abuse, not disclosure: someone editing your watches, or making your IP
hammer OVH. Applied:

- binds to **127.0.0.1** by default,
- state-changing requests require `application/json` and a same-origin `Origin`;
  a body that does not parse is a **400**, not an empty object,
- `/api/refresh` is throttled, live streams are capped, watches are capped,
- optional `AUTH_TOKEN` on every request, stored in an `HttpOnly` cookie that
  gains `Secure` over HTTPS.

To put a server online: keep the loopback bind and use `tailscale serve 4321`,
or a Cloudflare Tunnel, or a reverse proxy with TLS plus a strong `AUTH_TOKEN`:

```bash
AUTH_TOKEN="$(openssl rand -hex 24)" node server.js
# then open https://your-host/?token=THE_TOKEN once
```

Server mode is single-tenant: watches are server-side and shared by anyone who
can reach the page. That is fine for you; it is not a multi-user service. The
public deployment is the multi-user one, and it achieves that by storing nothing.

## Layout

```
core/            domain logic, imported by the server AND the browser
  ovh.js         feed normalisation, the delivery ladder, datacenter columns
  watches.js     matching, cooldown, quiet hours
  state.js       serializable alert memory
  history.js     transitions and how long stock stayed up
  deeplink.js    order links
  poll.js        fetching (server only)
  notify/        the four channels (server only)
  store-node.js  filesystem persistence (server only)
public/          the client; imports core/ directly
bin/check.js     one poll then exit, for scheduled environments
bin/snapshot.js  the static payload
test/            node:test
```

`core/ovh.js`, `watches.js`, `state.js`, `history.js` and `deeplink.js` run
unchanged in Node and in the browser. That is enforced by a test: the client used
to carry its own second copy of the availability and matching logic, and the two
drifted apart silently.

## Licence

MIT.
