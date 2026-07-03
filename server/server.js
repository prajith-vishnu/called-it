"use strict";
// local dev server. On Vercel this file isn't used at all - api/index.js
// handles requests instead, since Vercel runs functions, not a long-lived
// process. The router itself (lib/app.js) is shared between both.

const http = require("node:http");
const log = require("./lib/log");
const db = require("./lib/db");
const auth = require("./lib/auth");
const game = require("./lib/game");
const { runRefreshSafe } = require("./lib/refresh");
const { handleRequest, ADMIN_TOKEN, SECURE_COOKIES } = require("./lib/app");

const PORT = Number(process.env.PORT) || 3000;
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED !== "0";

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    log.error("request failed", e, { method: req.method, path: (req.url || "").split("?")[0] });
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "internal error" })); }
    else try { res.end(); } catch (e2) {}
  });
});

if (SCHEDULER_ENABLED) {
  const tick = async () => {
    const s = await runRefreshSafe({});
    if (!(s.skipped && s.reason === "rate-limited")) log.info("refresh tick", s);
    if (s && s.skipped === false) game.invalidateLeaderboard();
  };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, 30 * 60 * 1000).unref();
  setInterval(() => auth.pruneSessions(), 6 * 3600 * 1000).unref();
}

process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
process.on("uncaughtException", (e) => { log.error("uncaughtException", e); db.flushSync(); });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info("shutdown", { signal: sig });
    db.flushSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(PORT, () => {
  log.info(`Called It backend on http://localhost:${PORT}`);
  log.info(`  GET  /predictions.json /api/predictions /api/leaderboard /api/health  (public, cached)`);
  log.info(`  POST /api/auth/register|login|logout · /api/picks · /api/daily/checkin (accounts)`);
  log.info(`  POST /api/refresh /api/admin/resolve  (x-admin-token)${ADMIN_TOKEN ? "" : "  [DISABLED: set ADMIN_REFRESH_TOKEN]"}`);
  log.info(`  scheduler=${SCHEDULER_ENABLED ? "on" : "off"} secureCookies=${SECURE_COOKIES}`);
});
