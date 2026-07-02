"use strict";
/* ============================================================================
 * refresh.js — orchestrates ONE scheduled run.
 *
 * Per run (at most once per day — see MIN_INTERVAL_MS):
 *   1. Figure out which predictions are CLOSED + still PENDING (from the
 *      backend's own store), trimmed to id/question/options only.
 *   2. Make EXACTLY ONE Groq call (generate N new + resolve those).
 *   3. Run every result through the safety filter (safety.js). Discards fail.
 *   4. Apply high-confidence resolutions; send 'unresolved'/low-confidence ones
 *      to the manual-review queue.
 *   5. Atomically write the cache the public endpoint serves.
 *
 * DEFENSIVE FREE-TIER GUARDS:
 *   • MIN_INTERVAL_MS rate-limits real Groq calls to ~once/day even if invoked
 *     repeatedly; ratelimit.js additionally enforces Groq's header budget (80%
 *     safety margin) and 429 back-off so we never exceed free-tier limits.
 *   • NEW_COUNT and MAX_RESOLVE_BATCH cap tokens per call.
 *   • On any error/skip we keep the last good cache (fail safe, not destructive).
 * ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { generate, resolveClosed } = require("./groq");
const { sanitizeNewPrediction, sanitizeResolution } = require("./safety");

const DATA_DIR = path.join(__dirname, "..", "data");
const SEED_FILE = path.join(DATA_DIR, "predictions.seed.json");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const REPO_ROOT = path.join(__dirname, "..", "..");
// The PUBLIC feed the browser reads (committed by the cron job; served by GH Pages).
const PUBLIC_JSON = process.env.PUBLIC_JSON_PATH || path.join(REPO_ROOT, "predictions.json");
const MAX_KEEP = 60; // bound how many AI predictions accumulate

/* Multiple refreshes per day, spaced out. At the default 3h spacing that's at
 * most 8 runs/day × 2 calls = 16 Groq calls — under the hard 40/day cap in
 * ratelimit.js and ~1.6% of the free tier's ~1k/day. Override with
 * REFRESH_MIN_INTERVAL_HOURS if you want it calmer/fresher. */
const MIN_INTERVAL_MS = Math.max(0.5, Number(process.env.REFRESH_MIN_INTERVAL_HOURS) || 3) * 60 * 60 * 1000;
const NEW_COUNT = 3;                          // new predictions per run (small drips, runs often)
const MAX_RESOLVE_BATCH = 25;                 // cap closed-pending sent per call
const INTER_CALL_DELAY_MS = 1200;             // spacing between the 2 calls (never burst; well under 30 RPM)
const WEB_RESOLUTION = process.env.GROQ_WEB_RESOLUTION !== "off"; // Compound web-search resolution

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return fallback; }
}

function emptyCache() {
  return { lastRun: 0, predictions: [], resolutions: [], reviewQueue: [], runs: 0 };
}

function loadCache() {
  const c = readJSON(CACHE_FILE, null);
  if (c) return c;
  // Fresh environment (e.g. CI): seed from the committed public feed so
  // predictions and resolutions persist across runs WITHOUT any database.
  const pub = readJSON(PUBLIC_JSON, null);
  if (pub) return { lastRun: pub.lastRun || 0, predictions: pub.predictions || [], resolutions: pub.resolutions || [], reviewQueue: [], runs: 0 };
  return emptyCache();
}

/* Atomic write: temp file + rename, so the served cache is never half-written. */
function saveCache(cache) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CACHE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

/* The PUBLIC view the browser reads — only prediction content + resolution
 * verdicts. No internal fields, no secrets. */
function publicView(cache) {
  return {
    lastRun: cache.lastRun || 0,
    predictions: cache.predictions || [],
    resolutions: (cache.resolutions || []).map((r) => ({ id: r.id, outcome: r.outcome, confidence: r.confidence })),
  };
}
function writePublicJson(cache) {
  try { fs.writeFileSync(PUBLIC_JSON, JSON.stringify(publicView(cache))); } catch (e) {}
}

/* All predictions the backend knows about: built-in seed + AI-added. */
function allPredictions(cache) {
  const seed = readJSON(SEED_FILE, []);
  return seed.concat(cache.predictions || []);
}

function byId(list) {
  const m = {};
  for (const p of list) m[p.id] = p;
  return m;
}

/* In-memory pipeline status for the health endpoint (lastRun itself is
 * persisted in the cache; these fill in what happened since boot). */
const pipelineStatus = { lastAttemptAt: 0, lastSuccessAt: 0, lastError: null, lastSummary: null };

/* The core run. `opts.force` bypasses the min-interval (manual trigger).
 * Returns a small, key-free summary suitable for logging/HTTP responses. */
async function runRefresh(opts) {
  opts = opts || {};
  const cache = loadCache();
  const now = Date.now();

  // ── DEFENSIVE: keep real Groq runs spaced out ────────────────────────────
  if (!opts.force && now - (cache.lastRun || 0) < MIN_INTERVAL_MS) {
    return { skipped: true, reason: "rate-limited", lastRun: cache.lastRun };
  }
  pipelineStatus.lastAttemptAt = now;

  const everything = allPredictions(cache);
  const resolvedIds = new Set((cache.resolutions || []).map((r) => r.id));

  // Closed + still pending, trimmed to id/question/options (token-minimal).
  const closedPending = everything
    .filter((p) => !resolvedIds.has(p.id) && Date.parse(p.closeDate) < now)
    .slice(0, MAX_RESOLVE_BATCH)
    .map((p) => ({ id: p.id, question: p.question, options: p.options }));

  // ── CALL 1: generate new predictions (budget-checked inside groq.js) ──────
  const gen = await generate(NEW_COUNT);

  // ── CALL 2: resolve clear-cut closed questions via web search (optional) ──
  // Spaced out (never burst) and only if there's something to resolve.
  let res = { resolutions: [], skipped: false };
  const wantResolve = WEB_RESOLUTION && closedPending.length > 0;
  if (wantResolve) {
    await sleep(INTER_CALL_DELAY_MS);
    res = await resolveClosed(closedPending);
  }

  // If NO call actually went through (budget-blocked, missing key, transient
  // failure after retries), leave the cache — and crucially lastRun —
  // untouched, so the next scheduled tick tries again instead of waiting a
  // full interval behind a run that did nothing.
  if (gen.skipped && (!wantResolve || res.skipped)) {
    return { skipped: true, reason: gen.reason || res.reason || "no-calls", lastRun: cache.lastRun || 0 };
  }

  // ── SAFETY FILTER: validate/sanitize EVERYTHING before use ────────────────
  let counter = 0;
  const idFactory = () =>
    "ai-" + now.toString(36) + "-" + (counter++).toString(36) + "-" +
    crypto.randomBytes(2).toString("hex");

  const cleanNew = [];
  for (const np of (gen.new_predictions || []).slice(0, NEW_COUNT)) {
    const safe = sanitizeNewPrediction(np, idFactory);
    if (safe) cleanNew.push(safe);   // failed safety/validation → discarded
  }

  const predIndex = byId(everything);
  const newResolutions = [];
  const newReview = [];
  for (const r of (res.resolutions || [])) {
    const s = sanitizeResolution(r, predIndex);
    if (!s) continue;
    // ── MANUAL-REVIEW FALLBACK ──────────────────────────────────────────────
    // Only high-confidence, real-option outcomes are applied automatically.
    // 'unresolved' or low-confidence stay pending for a human to resolve.
    if (s.outcome !== "unresolved" && s.confidence === "high") {
      newResolutions.push({ id: s.id, outcome: s.outcome, confidence: "high", method: "ai", at: now });
    } else {
      newReview.push({ id: s.id, outcome: s.outcome, confidence: s.confidence, at: now });
    }
  }

  // Merge into cache (dedupe resolutions by id; cap review queue).
  const mergedResolutions = (cache.resolutions || []).slice();
  const have = new Set(mergedResolutions.map((r) => r.id));
  for (const r of newResolutions) if (!have.has(r.id)) { mergedResolutions.push(r); have.add(r.id); }

  const updated = {
    lastRun: now,
    runs: (cache.runs || 0) + 1,
    predictions: (cache.predictions || []).concat(cleanNew).slice(-MAX_KEEP), // bound growth
    resolutions: mergedResolutions,
    reviewQueue: (cache.reviewQueue || []).concat(newReview).slice(-100),
  };
  saveCache(updated);
  writePublicJson(updated);   // emit the public feed the front-end fetches

  const summary = {
    skipped: false,
    // surface budget-driven skips so the run is observable without leaking secrets
    generateSkipped: !!gen.skipped, generateReason: gen.reason || null,
    resolveSkipped: !!res.skipped, resolveReason: res.reason || null,
    addedPredictions: cleanNew.length,
    appliedResolutions: newResolutions.length,
    sentToReview: newReview.length,
    totalPredictions: updated.predictions.length,
    lastRun: now,
  };
  pipelineStatus.lastSuccessAt = now;
  pipelineStatus.lastError = null;
  pipelineStatus.lastSummary = summary;
  return summary;
}

/* Safe wrapper for schedulers: a refresh failure is logged into the status and
 * NEVER thrown — the last good cache keeps serving either way. */
async function runRefreshSafe(opts) {
  try {
    return await runRefresh(opts);
  } catch (e) {
    pipelineStatus.lastError = e.message;    // message only — never a key or stack in responses
    return { skipped: true, reason: "error", error: e.message };
  }
}

function getPipelineStatus() {
  const cache = loadCache();
  return Object.assign({}, pipelineStatus, {
    lastRun: cache.lastRun || 0,
    cachedPredictions: (cache.predictions || []).length,
    cachedResolutions: (cache.resolutions || []).length,
    reviewQueue: (cache.reviewQueue || []).length,
    minIntervalMs: MIN_INTERVAL_MS,
  });
}

module.exports = { runRefresh, runRefreshSafe, getPipelineStatus, loadCache, saveCache, publicView, CACHE_FILE, emptyCache };
