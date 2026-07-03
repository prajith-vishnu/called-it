"use strict";
// Vercel entrypoint for everything under /api/* (see vercel.json's rewrite).
// Wraps the shared router with a hydrate-then-persist step around each
// request, since a serverless function can't hold state in memory between
// invocations the way the local dev server does - see lib/db.js.

const log = require("../server/lib/log");
const db = require("../server/lib/db");
const refresh = require("../server/lib/refresh");
const ratelimit = require("../server/lib/ratelimit");
const { handleRequest } = require("../server/lib/app");

module.exports = async (req, res) => {
  try {
    await Promise.all([db.hydrate(), refresh.hydrateCache(), ratelimit.hydrateBudget()]);
    await handleRequest(req, res);
  } catch (e) {
    log.error("request failed", e, { method: req.method, path: (req.url || "").split("?")[0] });
    if (!res.headersSent) { res.statusCode = 500; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: "internal error" })); }
  } finally {
    try { await Promise.all([db.persist(), refresh.persistCache(), ratelimit.persistBudget()]); } catch (e2) {}
  }
};
