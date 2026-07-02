"use strict";
// run one refresh from the command line / cron, no HTTP endpoint needed

const { runRefresh } = require("../lib/refresh");

(async () => {
  const force = process.argv.includes("--force");
  try {
    const summary = await runRefresh({ force });
    console.log("[refresh]", JSON.stringify(summary));
    process.exit(0);
  } catch (e) {
    console.error("[refresh] failed:", e.message);
    process.exit(1);
  }
})();
