"use strict";
// runs one generate+resolve cycle, safety-filters the output, writes the cache

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { generate, resolveClosed } = require("./groq");
const { sanitizeNewPrediction, sanitizeResolution } = require("./safety");
const kv = require("./kv");

const DATA_DIR = path.join(__dirname, "..", "data");
const SEED_FILE = path.join(DATA_DIR, "predictions.seed.json");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const KV_KEY = "calledit:cache";
const REPO_ROOT = path.join(__dirname, "..", "..");
const PUBLIC_JSON = process.env.PUBLIC_JSON_PATH || path.join(REPO_ROOT, "predictions.json");
const MAX_KEEP = 60;

const MIN_INTERVAL_MS = Math.max(0.5, Number(process.env.REFRESH_MIN_INTERVAL_HOURS) || 3) * 60 * 60 * 1000;
const NEW_COUNT = 3;
const MAX_RESOLVE_BATCH = 25;
const INTER_CALL_DELAY_MS = 1200;
const WEB_RESOLUTION = process.env.GROQ_WEB_RESOLUTION !== "off";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return fallback; }
}

function emptyCache() {
  return { lastRun: 0, predictions: [], resolutions: [], reviewQueue: [], runs: 0 };
}

function seedFromPublicJson() {
  const pub = readJSON(PUBLIC_JSON, null);
  if (pub) return { lastRun: pub.lastRun || 0, predictions: pub.predictions || [], resolutions: pub.resolutions || [], reviewQueue: [], runs: 0 };
  return emptyCache();
}

let cachedCache = null;
let cacheDirty = false;

// Sync accessor used everywhere (game.js, server.js). On a serverless deploy,
// call hydrateCache() once per request first; locally this reads the file
// itself the first time it's called, same as before.
function loadCache() {
  if (cachedCache) return cachedCache;
  if (kv.hasKV) { cachedCache = emptyCache(); return cachedCache; }
  cachedCache = readJSON(CACHE_FILE, null) || seedFromPublicJson();
  return cachedCache;
}

function saveCache(cache) {
  cachedCache = cache;
  cacheDirty = true;
  if (kv.hasKV) return; // persisted explicitly via persistCache() at the end of the request
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
    cacheDirty = false;
  } catch (e) {}
}

async function hydrateCache() {
  if (!kv.hasKV) return;
  cachedCache = await kv.kvGetJSON(KV_KEY, null);
  if (!cachedCache) cachedCache = seedFromPublicJson();
}

async function persistCache() {
  if (!kv.hasKV || !cacheDirty || !cachedCache) return;
  cacheDirty = false;
  await kv.kvSetJSON(KV_KEY, cachedCache);
}

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

function allPredictions(cache) {
  const seed = readJSON(SEED_FILE, []);
  return seed.concat(cache.predictions || []);
}

function byId(list) {
  const m = {};
  for (const p of list) m[p.id] = p;
  return m;
}

const pipelineStatus = { lastAttemptAt: 0, lastSuccessAt: 0, lastError: null, lastSummary: null };

async function runRefresh(opts) {
  opts = opts || {};
  const cache = loadCache();
  const now = Date.now();

  if (!opts.force && now - (cache.lastRun || 0) < MIN_INTERVAL_MS) {
    return { skipped: true, reason: "rate-limited", lastRun: cache.lastRun };
  }
  pipelineStatus.lastAttemptAt = now;

  const everything = allPredictions(cache);
  const resolvedIds = new Set((cache.resolutions || []).map((r) => r.id));

  const closedPending = everything
    .filter((p) => !resolvedIds.has(p.id) && Date.parse(p.closeDate) < now)
    .slice(0, MAX_RESOLVE_BATCH)
    .map((p) => ({ id: p.id, question: p.question, options: p.options }));

  const gen = await generate(NEW_COUNT);

  let res = { resolutions: [], skipped: false };
  const wantResolve = WEB_RESOLUTION && closedPending.length > 0;
  if (wantResolve) {
    await sleep(INTER_CALL_DELAY_MS);
    res = await resolveClosed(closedPending);
  }

  if (gen.skipped && (!wantResolve || res.skipped)) {
    return { skipped: true, reason: gen.reason || res.reason || "no-calls", lastRun: cache.lastRun || 0 };
  }

  let counter = 0;
  const idFactory = () =>
    "ai-" + now.toString(36) + "-" + (counter++).toString(36) + "-" +
    crypto.randomBytes(2).toString("hex");

  const cleanNew = [];
  for (const np of (gen.new_predictions || []).slice(0, NEW_COUNT)) {
    const safe = sanitizeNewPrediction(np, idFactory);
    if (safe) cleanNew.push(safe);
  }

  const predIndex = byId(everything);
  const newResolutions = [];
  const newReview = [];
  for (const r of (res.resolutions || [])) {
    const s = sanitizeResolution(r, predIndex);
    if (!s) continue;
    if (s.outcome !== "unresolved" && s.confidence === "high") {
      newResolutions.push({ id: s.id, outcome: s.outcome, confidence: "high", method: "ai", at: now });
    } else {
      newReview.push({ id: s.id, outcome: s.outcome, confidence: s.confidence, at: now });
    }
  }

  const mergedResolutions = (cache.resolutions || []).slice();
  const have = new Set(mergedResolutions.map((r) => r.id));
  for (const r of newResolutions) if (!have.has(r.id)) { mergedResolutions.push(r); have.add(r.id); }

  const updated = {
    lastRun: now,
    runs: (cache.runs || 0) + 1,
    predictions: (cache.predictions || []).concat(cleanNew).slice(-MAX_KEEP),
    resolutions: mergedResolutions,
    reviewQueue: (cache.reviewQueue || []).concat(newReview).slice(-100),
  };
  saveCache(updated);
  writePublicJson(updated);

  const summary = {
    skipped: false,
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

async function runRefreshSafe(opts) {
  try {
    return await runRefresh(opts);
  } catch (e) {
    pipelineStatus.lastError = e.message;
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

module.exports = { runRefresh, runRefreshSafe, getPipelineStatus, loadCache, saveCache, hydrateCache, persistCache, publicView, CACHE_FILE, emptyCache };
