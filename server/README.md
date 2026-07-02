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

- `server.js` — the router, auth routes, rate limiting, and the scheduler that kicks off the Groq refresh
- `lib/auth.js` — password hashing (scrypt) and sessions
- `lib/game.js` — scoring, streaks, leaderboard, picks
- `lib/groq.js` — the only file that talks to Groq
- `lib/ratelimit.js` — keeps Groq calls under the free tier limit (hard cap of 40/day by default, plus it reads Groq's own rate limit headers)
- `lib/refresh.js` — runs one generate + resolve cycle and writes the cache
- `lib/db.js` — a plain JSON file as the database, written atomically so it can't get corrupted
- `lib/safety.js` — filters AI-generated content before it's ever shown to anyone
- `data/` — the seed questions plus the cache and rate limit state (git-ignored, regenerated at runtime)

## Why it doesn't need a real database or npm packages

It's a small hackathon project, so a JSON file on disk is plenty, and using only Node's built-in modules means there's nothing for `npm audit` to flag and nothing extra to trust. The Groq job never runs on a user request — it's a background timer that updates a cache, and reads always come from that cache, so if Groq is slow or down the site still works.

## Resolving predictions manually

```bash
curl -X POST http://localhost:3000/api/admin/resolve \
  -H "x-admin-token: $ADMIN_REFRESH_TOKEN" -H "content-type: application/json" \
  -d '{"id":"wc_winner","outcome":"Argentina"}'
```

Set `outcome` to `null` to undo a resolution.
