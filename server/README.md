# Called It — backend

A **zero-dependency** Node backend (no packages → `npm audit` finds nothing,
no supply chain to trust) that provides:

1. **Accounts + sessions** — username/password (no email), scrypt-hashed
   passwords, opaque session tokens in httpOnly `SameSite=Strict` cookies.
2. **Server-scored game state** — picks are validated and scored on the
   server, so the leaderboard cannot be faked from the client.
3. **A cached live leaderboard** — recomputed on a TTL, never per-request.
4. **Daily check-in streaks + bonus points** — the come-back-tomorrow loop.
5. **The Groq pipeline** — scheduled in-process (and/or CI cron), generates and
   resolves predictions, safety-filters everything, and only ever *enriches a
   cache*. User traffic never triggers a model call; Groq being down can never
   take the site down.

```
browser ──GET  /api/predictions ─▶ cache (+ real crowd tallies)      no key, no model call
browser ──POST /api/picks ───────▶ validated, scored server-side
browser ──GET  /api/leaderboard ─▶ TTL-cached ranking
scheduler (every 30 min tick) ───▶ refresh run? → Groq (triple rate-guarded) → cache
```

## Files

| File | Role |
|---|---|
| `server.js` | Router + error wall (one try/catch around every request), auth routes, CSRF guard, per-IP rate limit, security headers, **allowlisted** static hosting (secrets in the repo dir are unreachable), in-process refresh scheduler, `/api/health` |
| `lib/auth.js` | scrypt password hashing (OWASP-level params), session issue/verify/revoke (tokens hashed at rest), login/register brute-force windows, username/password validation |
| `lib/db.js` | Atomic JSON persistence (tmp+rename) with a tiny adapter surface — swap in SQLite/Postgres later by rewriting one file |
| `lib/game.js` | The client's scoring engine ported server-side: picks, streaks, beat-the-crowd, confidence stakes, daily check-ins, cached leaderboard, admin resolutions, public feed with **real** crowd counts |
| `lib/groq.js` | **The only file that calls Groq.** Key from `process.env`, stable cacheable system prompt, JSON-mode generation + Compound web-search resolution, bounded retry with exponential backoff |
| `lib/ratelimit.js` | Budget guard: Groq's own rate-limit headers (80% safety margin), 429 back-off, **plus a hard local cap of 40 calls/UTC-day** independent of anything Groq reports |
| `lib/safety.js` | The safety/validation choke point for all model output *and* usernames |
| `lib/refresh.js` | Orchestrates a run: generate → (spaced) resolve → filter → apply/queue → atomic cache write; tracks status for `/api/health` |
| `lib/log.js` | Structured logs; never logs secrets |
| `scripts/refresh-cli.js` | Run a refresh from cron with no HTTP endpoint exposed |
| `data/predictions.seed.json` | Built-in questions (ids match the front-end) |
| `data/cache.json`, `data/ratelimit.json`, `data/db.json` | Generated at runtime, **git-ignored** (`db.json` holds password/session hashes — treat as sensitive) |

## Setup

```bash
cd server
cp ../.env.example .env     # then edit: set GROQ_API_KEY + ADMIN_REFRESH_TOKEN
# .env is git-ignored — never commit it. In prod, use your host's secret store.

npm start                   # app + API on http://localhost:3000
```

Requires **Node ≥ 20.6** (`--env-file`). In production set `NODE_ENV=production`
(Secure cookies + HSTS) and run under a supervisor (pm2 / systemd / your host's
auto-restart) so even a hard crash self-heals:

```bash
pm2 start server.js --name called-it --env production
```

## Reliability model ("never goes down")

- **Every route** runs inside one async try/catch → a bad request returns a
  500 JSON and the process keeps serving.
- **Reads never wait on Groq.** `/api/predictions` and `predictions.json` serve
  the cache; the scheduled job updates it in the background.
- **The refresh can only fail quietly**: skipped by budget → cache serves;
  network error → bounded retries with backoff, then cache serves; 429 → the
  persisted back-off window opens and future runs wait it out.
- **All persistence is atomic** (tmp + rename) — a crash mid-write can never
  corrupt the cache or the user store.
- `GET /api/health` shows uptime, last run, last error, calls-today vs the
  daily cap, and cache sizes — pipeline liveness at a glance.

## Staying inside the free tier (three independent guards)

1. **Hard local cap:** at most `GROQ_MAX_CALLS_PER_DAY` (default 40) calls per
   UTC day, counted locally, reset at midnight — even if everything else
   misreads. That's <5% of the free tier's ~1k/day.
2. **Header guard:** after every call we record Groq's
   `x-ratelimit-remaining-*` headers; before every call we refuse at ≥80% of
   the budget or when tokens run low, and skip until reset.
3. **Spacing:** runs are min-interval-limited (`REFRESH_MIN_INTERVAL_HOURS`,
   default 3h → ≤8 runs/day × 2 calls), calls within a run are spaced, output
   tokens capped, and the system prompt is a frozen constant so Groq prompt
   caching keeps input tokens cheap.

429s read `retry-after`, persist a back-off window, and skip — the app keeps
serving the last cache through all of it.

## Security model

- **Passwords:** scrypt (N=2^15, r=8, p=1, 16-byte salt), timing-safe compare,
  self-describing hash format for future parameter bumps. Never logged, never
  in responses.
- **Sessions:** 256-bit random tokens, stored **hashed** (a leaked db.json
  can't be replayed), httpOnly + SameSite=Strict + Secure(prod) cookie,
  30-day rolling expiry, capped sessions/user, instant revocation on logout.
  *Why not JWT?* Single-server app with a store on hand → opaque sessions are
  simpler, revocable, and have no signing keys to manage. JWTs earn their
  complexity when many services must verify identity statelessly.
- **CSRF:** SameSite=Strict cookie + `Origin`/`Sec-Fetch-Site` checks on every
  state-changing request + JSON-only bodies (16 KB max).
- **Brute force:** sliding windows per IP *and* per account on login, per IP on
  register; identical error + timing-equalized hashing so usernames can't be
  enumerated.
- **Validation:** every input server-side (usernames filtered by the same
  family-friendly filter as AI output; picks checked against real predictions,
  options, close dates, and stake quotas).
- **Static hosting is allowlisted** — only `index.html` and `predictions.json`
  are servable; `server/.env`, `data/db.json`, `.git/` are unreachable by
  construction.
- **Admin routes** (`/api/refresh`, `/api/admin/resolve`) need
  `x-admin-token`, compared in constant time; fail closed when unset.
- **AI output is untrusted** — schema-validated + safety-filtered server-side,
  re-validated client-side, and rendered only as escaped text.

## Admin: resolving predictions

High-confidence AI resolutions apply automatically; everything fuzzy waits for
you:

```bash
# resolve (or overturn an AI resolution — admin always wins)
curl -X POST http://localhost:3000/api/admin/resolve \
  -H "x-admin-token: $ADMIN_REFRESH_TOKEN" -H "content-type: application/json" \
  -d '{"id":"wc_winner","outcome":"Argentina"}'

# un-resolve
curl -X POST http://localhost:3000/api/admin/resolve \
  -H "x-admin-token: $ADMIN_REFRESH_TOKEN" -H "content-type: application/json" \
  -d '{"id":"wc_winner","outcome":null}'

# force a refresh run now (still budget-guarded)
curl -X POST "http://localhost:3000/api/refresh?force=1" -H "x-admin-token: $ADMIN_REFRESH_TOKEN"
```
