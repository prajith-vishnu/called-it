"use strict";
/* ============================================================================
 * refresh-cli.js — run the ONE batched Groq refresh from the command line.
 *
 * This is the MOST SECURE way to do the scheduled run: no HTTP endpoint is
 * exposed at all. Point cron at it once per day. The Groq key is read from
 * the environment by groq.js (never passed on the command line).
 *
 *   # once daily at 09:00, key + lock provided by the environment / secret store
 *   0 9 * * *  cd /path/to/server && node --env-file=.env scripts/refresh-cli.js
 *
 * Use --force to bypass the once-per-day rate limit for a manual run.
 * ========================================================================== */

const { runRefresh } = require("../lib/refresh");

(async () => {
  const force = process.argv.includes("--force");
  try {
    const summary = await runRefresh({ force });
    // Log only a non-secret summary.
    console.log("[refresh]", JSON.stringify(summary));
    process.exit(0);
  } catch (e) {
    console.error("[refresh] failed:", e.message); // message contains no key
    process.exit(1);
  }
})();
