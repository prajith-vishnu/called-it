"use strict";
// Vercel Cron hits this once a day on the free plan (see vercel.json's
// "crons" - Hobby tier caps you at daily). The real cadence (every few hours)
// comes from the GitHub Actions workflow calling /api/refresh with the admin
// token instead; this is just a backup so the pipeline still ticks even if
// that workflow is ever paused. Vercel signs cron requests with CRON_SECRET
// as a bearer token if that env var is set - this checks it.

const log = require("../../server/lib/log");
const db = require("../../server/lib/db");
const game = require("../../server/lib/game");
const refresh = require("../../server/lib/refresh");
const ratelimit = require("../../server/lib/ratelimit");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.authorization || "";
  if (!secret || got !== `Bearer ${secret}`) {
    res.statusCode = 401; res.end("unauthorized"); return;
  }
  try {
    await Promise.all([db.hydrate(), refresh.hydrateCache(), ratelimit.hydrateBudget()]);
    const summary = await refresh.runRefreshSafe({});
    game.invalidateLeaderboard();
    await Promise.all([db.persist(), refresh.persistCache(), ratelimit.persistBudget()]);
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify(summary));
  } catch (e) {
    log.error("cron refresh failed", e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "refresh failed" }));
  }
};
