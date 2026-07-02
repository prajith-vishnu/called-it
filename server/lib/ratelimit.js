"use strict";
/* ============================================================================
 * ratelimit.js — header-aware budget guard for Groq's free tier.
 *
 * Groq returns rate-limit headers on every response; we treat them as the
 * SOURCE OF TRUTH:
 *   x-ratelimit-limit-requests / -tokens
 *   x-ratelimit-remaining-requests / -tokens
 *   x-ratelimit-reset-requests / -tokens   (durations like "7.66s", "2m59.5s")
 *   retry-after                            (seconds, on 429)
 *
 * We persist the latest values and, BEFORE each call, refuse to proceed if:
 *   • we're inside a 429 back-off window, or
 *   • we've consumed ≥ SAFETY_MARGIN (80%) of the request budget, or
 *   • remaining requests/tokens are too low to be safe.
 * AFTER each call we record the fresh headers. This keeps us from ever tripping
 * a 429 in normal operation, and if one slips through we back off instead of
 * hammering. Skipped calls are non-fatal — the app serves the last cache.
 * ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "ratelimit.json");
const SAFETY_MARGIN = 0.8;     // stop once 80% of the request budget is used
const TOKEN_FLOOR = 2000;      // keep at least this many tokens in reserve

/* HARD LOCAL CAP: independent of anything Groq reports, never make more than
 * this many calls per UTC day. The counter lives in the same persisted file
 * and resets when the date changes. Groq's free tier allows ~1k requests/day
 * for the generation model; 40 keeps us at <5% of that even if the header
 * guard below ever misreads. Belt AND suspenders. */
const MAX_CALLS_PER_DAY = Math.max(1, Number(process.env.GROQ_MAX_CALLS_PER_DAY) || 40);
const utcDay = () => new Date().toISOString().slice(0, 10);

function read() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { return {}; } }
function write(o) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(o, null, 2));
  } catch (e) {}
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }

/* Parse Groq duration strings → milliseconds. "7.66s", "2m59.56s", "120ms". */
function parseDur(s) {
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) * 1000; // bare number = seconds
  let ms = 0; const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g; let m;
  while ((m = re.exec(s))) {
    const v = parseFloat(m[1]);
    ms += m[2] === "ms" ? v : m[2] === "s" ? v * 1000 : m[2] === "m" ? v * 60000 : v * 3600000;
  }
  return ms;
}

/* Record the rate-limit headers from a fetch Response.headers (or a plain map). */
function record(provider, headers) {
  const h = (k) => (headers && headers.get ? headers.get(k) : headers ? headers[k] : undefined);
  const now = Date.now();
  const o = read();
  // count this call against today's hard cap (resets when the UTC date changes)
  const day = utcDay();
  const prev = o[provider] || {};
  const callsToday = prev.capDay === day ? (prev.callsToday || 0) + 1 : 1;
  o[provider] = Object.assign(prev, { capDay: day, callsToday }, {
    limitReq: num(h("x-ratelimit-limit-requests")),
    limitTok: num(h("x-ratelimit-limit-tokens")),
    remainingReq: num(h("x-ratelimit-remaining-requests")),
    remainingTok: num(h("x-ratelimit-remaining-tokens")),
    resetReqAt: now + parseDur(h("x-ratelimit-reset-requests")),
    resetTokAt: now + parseDur(h("x-ratelimit-reset-tokens")),
    at: now,
  });
  write(o);
}

/* Record a 429: back off until retry-after (default 60s). */
function note429(provider, retryAfterSec) {
  const o = read();
  o[provider] = o[provider] || {};
  o[provider].backoffUntil = Date.now() + (Number(retryAfterSec) || 60) * 1000;
  write(o);
}

/* Should we make a call now? Returns { ok, reason, waitMs }. */
function canProceed(provider, estTokens) {
  const o = read()[provider];
  const now = Date.now();
  if (!o) return { ok: true };                                   // no data yet → allow

  // ── HARD DAILY CAP (checked first; independent of provider headers) ──
  if (o.capDay === utcDay() && (o.callsToday || 0) >= MAX_CALLS_PER_DAY) {
    return { ok: false, reason: "daily-cap", waitMs: msUntilUtcMidnight() };
  }
  if (o.backoffUntil && now < o.backoffUntil) {
    return { ok: false, reason: "429-backoff", waitMs: o.backoffUntil - now };
  }
  // Request budget with 80% safety margin (only while the window is still open).
  if (Number.isFinite(o.limitReq) && Number.isFinite(o.remainingReq) && o.limitReq > 0 && now < o.resetReqAt) {
    const usedFraction = 1 - o.remainingReq / o.limitReq;
    if (usedFraction >= SAFETY_MARGIN) return { ok: false, reason: "request-budget-margin", waitMs: o.resetReqAt - now };
    if (o.remainingReq <= 1) return { ok: false, reason: "requests-exhausted", waitMs: o.resetReqAt - now };
  }
  // Token budget: keep a reserve.
  if (Number.isFinite(o.remainingTok) && now < o.resetTokAt && o.remainingTok < (estTokens || TOKEN_FLOOR)) {
    return { ok: false, reason: "token-budget", waitMs: o.resetTokAt - now };
  }
  return { ok: true };
}

function msUntilUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

/* Non-secret snapshot for the health endpoint. */
function status(provider) {
  const o = read()[provider] || {};
  return {
    callsToday: o.capDay === utcDay() ? (o.callsToday || 0) : 0,
    dailyCap: MAX_CALLS_PER_DAY,
    inBackoff: !!(o.backoffUntil && Date.now() < o.backoffUntil),
    remainingRequests: Number.isFinite(o.remainingReq) ? o.remainingReq : null,
  };
}

module.exports = { canProceed, record, note429, parseDur, status, SAFETY_MARGIN, MAX_CALLS_PER_DAY };
