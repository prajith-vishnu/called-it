# Called It — backend

This is the optional backend for Called It. It handles accounts, scores picks server-side so the leaderboard can't be faked, and runs the Groq job that generates and resolves predictions in the background. No npm packages, just Node's built-ins.

## Setup

```bash
cd server
cp ../.env.example .env
# edit .env: set GROQ_API_KEY and ADMIN_REFRESH_TOKEN
npm start
```

Needs Node 20.6+. In production set `NODE_ENV=production` and run it under pm2 or systemd so it restarts if it crashes.

## What's in here

- `server.js` — thin local dev entrypoint: starts an http server and the in-process Groq scheduler, both using the router below
- `lib/app.js` — the actual router: auth routes, picks, leaderboard, rate limiting, static file serving. Used by both `server.js` (local) and `../api/index.js` (Vercel)
- `lib/auth.js` — password hashing (scrypt) and sessions
- `lib/game.js` — scoring, streaks, leaderboard, picks
- `lib/groq.js` — the only file that talks to Groq
- `lib/ratelimit.js` — keeps Groq calls under the free tier limit (hard cap of 40/day by default, plus it reads Groq's own rate limit headers)
- `lib/refresh.js` — runs one generate + resolve cycle and writes the cache
- `lib/db.js` — the "database": a local JSON file for local dev, or Redis (via `lib/kv.js`) when deployed to Vercel, since a serverless function can't keep a file around between requests
- `lib/kv.js` — tiny Upstash Redis REST client (plain `fetch`, no SDK)
- `lib/safety.js` — filters AI-generated content before it's ever shown to anyone
- `data/` — the seed questions plus the cache and rate limit state for local dev (git-ignored, regenerated at runtime)

On Vercel, `../api/index.js` and `../api/cron/refresh.js` wrap this same router/pipeline with a hydrate-then-persist step around each request, since state has to come from Redis instead of living in memory the whole time. See the main README's "Deploying it" section for setup.

## Why it doesn't need a real database or npm packages

It's a small hackathon project, so a JSON file on disk is plenty, and using only Node's built-in modules means there's nothing for `npm audit` to flag and nothing extra to trust. The Groq job never runs on a user request — it's a background timer that updates a cache, and reads always come from that cache, so if Groq is slow or down the site still works.

## Resolving predictions manually

```bash
curl -X POST http://localhost:3000/api/admin/resolve \
  -H "x-admin-token: $ADMIN_REFRESH_TOKEN" -H "content-type: application/json" \
  -d '{"id":"wc_winner","outcome":"Argentina"}'
```

Set `outcome` to `null` to undo a resolution.
