# Called It

Called It is a prediction game I built for Hack Club. It's based on prediction markets like Polymarket, but it's designed to be free and accessible to everyone — no money involved, ever. You pick what you think will happen in the future, and you get points if you're right. Beating the crowd (picking the unpopular choice and winning anyway) gets you extra points.

The part I struggled with most was getting the backend working and hooking up the Groq API — I learned a lot doing it. That API gets called a few times a day in the background to pull in new predictions and update old ones, so the feed stays fresh without anyone having to touch it.

Try it here: https://called-it-self.vercel.app (accounts + a real leaderboard that syncs across devices)

There's also a static version at https://prajith-vishnu.github.io/called-it/ — same game, but since GitHub Pages can't run a server, that one only works as a guest (no accounts, nothing synced across devices).

![feed](docs/feed.png) ![locked in](docs/locked-in.png) ![beat the crowd](docs/celebration.png)

## Features

- Pick outcomes across categories like sports, music, movies, and a Space & NASA category for Hack Club
- Points for correct calls, streak bonuses, and extra points for beating the crowd
- Optional accounts (just a username and password, no email) with a real leaderboard
- Daily check-in streak, dark mode, sound effects, and a countdown timer on picks closing soon
- Works fully offline as a guest with no account, no backend, no data leaving your device

## Running it

Just open `index.html` in a browser and you can play right away in guest mode.

To run the full version with accounts and the AI refresh job:

```
cd server
cp ../.env.example .env
# add your own Groq API key in .env
npm start
```

## Deploying it (Vercel)

The live version above runs on Vercel. It's serverless, so instead of the local `db.json` file it stores everything in a small Redis database (I used Upstash, which has a free tier). To deploy your own:

1. Import the repo into Vercel.
2. In the project's Storage tab, add an Upstash Redis database and connect it — that sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically, which is all the code needs to switch from local files to Redis.
3. Add `GROQ_API_KEY` and `ADMIN_REFRESH_TOKEN` as environment variables too.
4. Deploy. `vercel.json` handles routing `/api/*` to the backend and sets up a daily cron as a backup refresh trigger.

The GitHub Actions workflow that keeps predictions fresh every few hours (`.github/workflows/vercel-refresh.yml`) needs two repo secrets to actually call your deployment: `VERCEL_APP_URL` (your deployed URL) and `ADMIN_REFRESH_TOKEN` (same value as step 3).

## AI use

I used AI to help write and debug parts of the code, especially the backend and the Groq integration, since that was the hardest part for me. The idea, the game design, and the decisions on how it should work are mine.

## License

MIT
