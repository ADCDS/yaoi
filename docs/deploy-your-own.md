# Get alerts on your phone

The public dashboard can only alert you **while a tab is open**. It is static
hosting: there is no server behind it to push anything to your phone, and no
account — which is also why your watches stay in your own browser and nobody
else can see them.

For alerts that reach you with the tab closed, run your own copy. It takes about
five minutes and costs nothing.

## Why a fork rather than an account

Sending you a Telegram message means holding your chat ID; sending you email
means holding your address. A fork keeps all of that in **your** repository,
under your own Actions secrets. Nobody has to trust anybody, and there is no
shared database to leak.

## 1. Fork it — privately

Fork this repository, then in **Settings → General** make it private, or create
a private repository and push a copy:

```bash
git clone https://github.com/ADCDS/kimsufi-watch.git
cd kimsufi-watch
gh repo create my-kimsufi-watch --private --source=. --push
```

Private matters: your watches go in a secret, but a private repository means the
Actions logs — which name the servers you were alerted about — stay yours too.

## 2. Describe what you want

Set a repository secret named `WATCHES_JSON` (**Settings → Secrets and variables
→ Actions → New repository secret**) to a JSON array of watches. Start from
[`config/watches.example.json`](../config/watches.example.json):

```json
[
  {
    "name": "Canada NVMe, in stock",
    "countries": ["CA"],
    "storageKinds": ["NVMe"],
    "inStockOnly": true,
    "cooldownMinutes": 30,
    "channels": ["telegram"]
  }
]
```

Every field is optional except `name`. Leave a list empty to mean "any".

| field | meaning |
|---|---|
| `countries` | `["CA","FR"]` — ISO codes, empty for anywhere |
| `datacenters` | `["bhs","gra"]` — overrides `countries` |
| `ranges` | `["kimsufi","rise","soyoustart","advance"]` |
| `storageKinds` | `["NVMe","SSD","SAS","SATA","HDD"]` |
| `storageContains` | free text against the raw storage code, e.g. `"1920"` |
| `planCodes` | `["24sk202"]` — those exact models only |
| `minRamGB` | `64` |
| `inStockOnly` | `true` ignores 24h and 72h builds |
| `includeComingSoon` | `true` includes machines not yet orderable |
| `cooldownMinutes` | stay quiet this long after alerting about the same machine |
| `quietFrom` / `quietTo` | `"23:00"` / `"07:00"` — wraps midnight |
| `channels` | any of `telegram`, `ntfy`, `webhook`, `email` |

## 3. Set up a channel

Add secrets for the channels you named. Any subset works; unconfigured channels
are simply off.

**Telegram** — the best mobile push, and the least work.
1. Message [@BotFather](https://t.me/botfather), send `/newbot`, copy the token.
2. Message your new bot once so it may write to you.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.

| secret | value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `123456:ABC-DEF…` |
| `TELEGRAM_CHAT_ID` | `987654321` |

**ntfy** — no account at all. Install the ntfy app, subscribe to a topic that
nobody else would guess.

| secret | value |
|---|---|
| `NTFY_TOPIC` | `kimsufi-a7f3c1` |
| `NTFY_URL` | *(optional)* `https://ntfy.example.com` for a self-hosted server |
| `NTFY_TOKEN` | *(optional)* bearer token for a protected topic |

**Discord or Slack** — an archived feed rather than a buzz. Create a channel
webhook and set `WEBHOOK_URL`; the payload shape is chosen from the host.

**Email** — over SMTP, no third-party service.

| secret | value |
|---|---|
| `SMTP_HOST` | `smtp.example.com` |
| `SMTP_PORT` | `587` (STARTTLS) or `465` (implicit TLS) |
| `SMTP_USER` / `SMTP_PASS` | your credentials |
| `SMTP_FROM` | `Kimsufi Watch <alerts@example.com>` |
| `SMTP_TO` | where to send; comma-separated for several |

Gmail needs an [app password](https://support.google.com/accounts/answer/185833),
not your account password.

## 4. Turn the notifying workflow on

The public workflow deliberately does not notify. Add this alongside it as
`.github/workflows/notify.yml`:

```yaml
name: Watch and notify

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: watch-notify
  cancel-in-progress: false

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Restore state
        run: |
          mkdir -p data
          if git fetch --depth=1 origin notify-state 2>/dev/null; then
            for f in state.json previous.json events.jsonl; do
              git show origin/notify-state:$f > data/$f 2>/dev/null || true
            done
          fi

      - name: Check and notify
        run: node bin/check.js --out /tmp/kw-out
        env:
          WATCHES_JSON:       ${{ secrets.WATCHES_JSON }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID:   ${{ secrets.TELEGRAM_CHAT_ID }}
          NTFY_URL:           ${{ secrets.NTFY_URL }}
          NTFY_TOPIC:         ${{ secrets.NTFY_TOPIC }}
          NTFY_TOKEN:         ${{ secrets.NTFY_TOKEN }}
          WEBHOOK_URL:        ${{ secrets.WEBHOOK_URL }}
          SMTP_HOST:          ${{ secrets.SMTP_HOST }}
          SMTP_PORT:          ${{ secrets.SMTP_PORT }}
          SMTP_USER:          ${{ secrets.SMTP_USER }}
          SMTP_PASS:          ${{ secrets.SMTP_PASS }}
          SMTP_FROM:          ${{ secrets.SMTP_FROM }}
          SMTP_TO:            ${{ secrets.SMTP_TO }}

      - name: Save state
        run: |
          git config user.name  'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          rm -rf .state && mkdir .state && cp data/* .state/ 2>/dev/null || true
          cd .state && git init -q -b notify-state && git add -A
          git commit -q -m "state at $(date -u +%FT%TZ)"
          git push -q --force "https://x-access-token:${{ github.token }}@github.com/${{ github.repository }}" notify-state:notify-state
```

## 5. Prove it works

Run it by hand from **Actions → Watch and notify → Run workflow**.

**The first run tells you nothing, on purpose.** It records what is already in
stock so it can report *changes* from then on; without that, every first run
would announce hundreds of servers at once. Run it twice — the second run is the
one that behaves normally.

To test a channel directly:

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node bin/check.js --test-channel telegram
node bin/check.js --channels    # what is configured
```

## What to expect

- **Five minutes is the floor.** GitHub's `schedule` will not run more often,
  and runs can be delayed or dropped when Actions is busy. Stock that lasts
  seconds will be missed. Most of the feed is 24h and 72h builds, which this
  catches comfortably.
- **Scheduled workflows switch off after 60 days of repository inactivity.**
  `keepalive.yml` handles it; keep it enabled.
- **Actions minutes are free for public repositories** but metered for private
  ones. At 288 runs a day of roughly 20 seconds each, budget about 1,700
  minutes a month — more than the free private allowance, so either accept the
  cost, widen the cron, or keep the repository public and put your watches in a
  secret anyway (the secret stays hidden; only the run logs are visible).

## Running it as a server instead

If you have a machine that is always on, `node server.js` polls every 60 seconds
instead of every five minutes, keeps watches in `data/watches.json`, edits them
from the page, and streams updates live. Same channels, same environment
variables. Bind it to loopback and put it behind Tailscale or a tunnel — see the
README.
