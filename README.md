# Called It

**A free, no-money prediction game where you call what happens next and earn points for being right.**

[![Live demo](https://img.shields.io/badge/demo-GitHub%20Pages-6f42c1)](https://prajith-vishnu.github.io/called-it/)

## What it is

Called It is a free prediction game inspired by prediction markets like **Polymarket** and **Kalshi** — but with **zero money involved**. Instead of betting cash, you predict the outcome of fun future events and earn **points and status** for being right. It's built for a **13+ audience**: no wagering, no prizes, no payouts — the only reward is bragging rights and climbing the ranks.

## Built for Stardance

This project was built for **Stardance** (NASA-themed challenge). The prediction engine is category-based and theme-friendly, so alongside music, movies, internet, and viral-trend questions it can feature **space & NASA prediction categories** — e.g. "Will a crewed launch happen before <date>?" — resolved the same way as any other question.

## Features

- 🗳️ **Prediction feed** across many categories (music, movies/TV, internet & creators, awards, viral trends, "will it happen", and space/NASA)
- 🎯 **Points** for correct calls, with each question worth a set value
- 🔥 **Streaks** that build as you keep calling it right
- 🧠 **Beat-the-crowd bonus** — correctly picking the *unpopular* option earns extra (rewarding independent thinking, like buying low in a real market)
- ⚡ **Opt-in confidence stakes** — a limited number of high-conviction picks that win more but risk points if wrong (the only way to lose points; casual players never get punished)
- 🏆 **Ranks** (Rookie → Caller → Forecaster → Oracle → Prophet → Legend) and a leaderboard
- ✨ **Cosmetic rewards** — themes, titles, and badges unlocked purely by milestones (never bought, never for sale)
- 📊 **Crowd-belief bars** showing how the community is leaning on each question
- 🤖 **Daily AI-generated questions** refreshed automatically each day

## How it works

1. Browse open predictions and **tap an option** to lock in your call.
2. When an event's outcome is known, the question resolves.
3. **Correct calls earn points** (plus beat-the-crowd and streak bonuses); climb the ranks and unlock cosmetics.

Outcomes are **resolved manually** by the maintainer via a hidden dev panel — this keeps resolutions accurate and prevents the AI from ever fabricating a result. Questions the AI isn't confident about stay pending for human review.

## Tech

- **Front-end:** a single self-contained static file (`index.html` — HTML + CSS + JS, no framework, no build step), hosted on **GitHub Pages**.
- **Daily predictions:** a **GitHub Actions cron job** calls the **Groq API** once a day to generate fresh, age-appropriate questions, safety-filters them, and commits the result as **`predictions.json`**, which the site reads.
- **Game state:** everything (points, picks, streaks, cosmetics) is stored in the browser's **`localStorage`** — there is no database and no server holding user data.

## Privacy & safety

- **No accounts, no login, no personal data.** No email, names, phone, location, device IDs, analytics, or trackers.
- **No user-generated text** anywhere — you only pick from preset options, and usernames are chosen from a preset list. Nothing to moderate, no chat, no user-to-user contact.
- **13+ age gate** on first load (stores only a yes/no flag — no date of birth).
- **All game data stays on your own device** in localStorage; clearing your browser resets it.

## Security notes

- The **Groq API key is stored only in GitHub Actions Secrets** and read server-side via an environment variable — it never appears in the front-end, in any committed file, or in any response.
- **AI output is treated as untrusted:** every generated prediction is validated against a strict schema and run through a **13+ content safety filter** (no sexual, violent, hateful, or unsafe content; no targeting of real private individuals; must be specific and time-bound) **before** it can ever be displayed. Failures are discarded and the app falls back to the last good set.
- A strict **Content-Security-Policy**, output escaping (no raw-HTML injection), and HTTPS-only hosting round out the defenses.

## Run locally

The game is fully playable with no setup:

```bash
# Option A — just open the file
open index.html      # (or double-click it in your file browser)
```

To also run the daily-predictions backend locally (optional):

```bash
cd server
cp ../.env.example .env          # then edit .env and add your Groq API key:
#   GROQ_API_KEY=gsk_your_key_here     (never commit this file — it's git-ignored)
npm start                        # serves the app + predictions on http://localhost:3000
node --env-file=.env scripts/refresh-cli.js --force   # generate predictions once
```

Get a free Groq API key at <https://console.groq.com/keys>. The key lives **only** in your local `.env` (git-ignored) or in GitHub Actions Secrets — never in code.

## Live demo

▶️ **<https://prajith-vishnu.github.io/called-it/>** *(enable GitHub Pages to activate — see repo Settings → Pages)*

---

_Called It is a for-fun, cosmetic-only game. Points and ranks have no monetary or real-world value and cannot be bought, sold, or redeemed._
