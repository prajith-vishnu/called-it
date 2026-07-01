# Called It — backend (Groq daily-predictions generator)

A tiny **zero-dependency** Node job that:

1. **Holds the Groq API key** (the browser never sees it).
2. On a **scheduled run** (default ≈once/day), makes a **batched** request set that
   **generates** ~5 new age-appropriate predictions **and** (optionally) **resolves**
   only clear-cut closed questions via **Groq Compound web search**.
3. **Safety-filters & validates** everything the model returns (untrusted data).
4. Writes a **static `predictions.json`** that the front-end reads. No accounts,
   no database, no personal data — every visitor reads the same file.

```
browser  ──GET predictions.json──▶  static file        (no key, no model call, no user data)
cron     ──run once daily────────▶  job ──Authorization: Bearer──▶ Groq  →  writes predictions.json
```

**Recommended deploy:** GitHub Pages (static front-end) + the GitHub Actions cron
in `.github/workflows/refresh.yml` (key in repo Secrets). No public endpoint at
all. The `server.js` below is only for local dev or a single-host deploy.

## Files

| File | Role |
|---|---|
| `server.js` | Local/dev HTTP server: read-only `/predictions.json`, token-gated `/api/refresh`, per-IP rate limit, strict CORS, hardened static hosting |
| `lib/groq.js` | **The only file that calls Groq.** Reads the key from `process.env`, stable cacheable system prompt, JSON-mode generation + Compound web-search resolution, token caps |
| `lib/ratelimit.js` | **Header-aware budget guard.** Reads Groq's rate-limit headers, enforces an 80% safety margin + 429 back-off |
| `lib/safety.js` | **The safety/validation choke point.** Every model field is sanitized here |
| `lib/refresh.js` | Orchestrates a run: closed-pending → generate → (spaced) resolve → filter → apply/queue → cache |
| `scripts/refresh-cli.js` | Run the daily refresh from cron with **no HTTP endpoint exposed** (most secure) |
| `data/predictions.seed.json` | Mirror of the app's built-in questions (ids match) so resolutions line up |
| `data/cache.json`, `data/ratelimit.json` | Generated at runtime (git-ignored) |

## Setup

```bash
cd server
cp ../.env.example .env          # creates server/.env — then edit it: add GROQ_API_KEY (admin token optional)
# .env is git-ignored — never commit it. In prod, use your host's secret store.

npm start                        # serves app + API on http://localhost:3000
```

Requires **Node ≥ 18.17** (global `fetch`); `--env-file` needs Node ≥ 20.6 — otherwise
export the vars yourself or use your host's env config.

### Trigger the run

```bash
# Most secure: cron runs the CLI, no public refresh endpoint needed
0 9 * * *  cd /path/to/server && node --env-file=.env scripts/refresh-cli.js

# Or via the token-protected HTTP route (serverless cron / manual):
curl -X POST http://localhost:3000/api/refresh -H "x-admin-token: $ADMIN_REFRESH_TOKEN"
```

`--force` (CLI) / `?force=1` (HTTP) bypasses the once-per-day lock for a manual run —
the header budget guard still applies.

## Staying inside the free tier (how it never exceeds limits)

- **Headers are the source of truth.** After every call we record Groq's
  `x-ratelimit-remaining-requests/-tokens` and `-reset-*`; before every call
  `ratelimit.js` refuses to proceed if we're in a 429 back-off, have used **≥80%** of
  the request budget, or are low on tokens. It then **waits for reset** (skips the run)
  rather than risking a 429.
- **429s are handled gracefully** — we read `retry-after`, back off, and skip; the app
  keeps running on the **last cache**.
- **Stable system prompt.** The system message is a frozen constant reused on **every**
  call, so Groq **prompt caching** applies (cached input tokens don't count) — only the
  short user message varies.
- **Don't burst.** Default is one scheduled run/day. A run makes at most two calls
  (generate, then resolve), spaced by `INTER_CALL_DELAY_MS` — far under ~30 RPM. Token
  output is capped (`MAX_TOKENS`) and the resolve batch is capped (`MAX_RESOLVE_BATCH`).

## Where the important bits are (as commented in code)

- **Key read:** `lib/groq.js` → `const apiKey = process.env.GROQ_API_KEY` (sent as
  `Authorization: Bearer`, never logged, never to the client).
- **Safety filter:** `lib/safety.js` → `cleanText()` / `sanitizeNewPrediction()` /
  `sanitizeResolution()`. Anything unsafe or malformed is **discarded**.
- **Manual-review fallback:** `lib/refresh.js` → resolutions that are `unresolved` or
  not `high` confidence go to `reviewQueue` and the prediction **stays pending**. The
  model is told to return `unresolved` rather than guess, so fuzzy outcomes are never
  auto-applied.

## Security confirmations

- ✅ **Key is backend-only** — appears nowhere in client code or the repo; read from env,
  sent in a request header.
- ✅ **Never exceeds limits** — header-aware guard + 80% safety margin + 429 back-off +
  capped tokens/batch + one run/day, no bursting.
- ✅ **App keeps running on skipped/failed calls** — every skip/error falls back to the
  cached results; nothing destructive.
- ✅ **Stable, cacheable system prompt** — frozen constant across all calls.
- ✅ **AI output validated + safety-checked before display** — server filter + mirrored
  client filter; renderer only emits escaped text.
- ✅ **Fuzzy resolutions stay manual** — only clear-cut, high-confidence, real-option
  outcomes auto-apply; everything else waits for human review in the dev panel.
