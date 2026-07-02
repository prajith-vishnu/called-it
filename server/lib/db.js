"use strict";
/* ============================================================================
 * db.js — zero-dependency persistent store (atomic JSON file).
 *
 * WHY A FILE AND NOT A DATABASE SERVER:
 *   • Zero dependencies → nothing for `npm audit` to flag, no supply-chain
 *     surface in a public repo, deploys anywhere Node runs.
 *   • Hackathon scale (hundreds of users) fits comfortably in one JSON file
 *     held in memory and flushed atomically (temp file + rename — the same
 *     pattern refresh.js already uses, so a crash can never half-write it).
 *   • This module is the ONLY place that knows about the file. The exported
 *     surface (get / save / flushSync) is deliberately tiny so swapping in
 *     SQLite/Postgres later means rewriting one file, not the app.
 *
 * SECURITY:
 *   • db.json holds password HASHES (scrypt) and session-token HASHES — never
 *     plaintext passwords, never raw session tokens. It is git-ignored; treat
 *     it like any credential store in production (restrict file permissions).
 *
 * SHAPE (all keyed maps for O(1) lookup):
 *   users:      { userId → { id, username, passHash, createdAt, lastLoginAt,
 *                            bonusPoints, daily:{streak,best,lastDay} } }
 *   usernames:  { usernameLower → userId }              (uniqueness index)
 *   sessions:   { sha256(token) → { userId, createdAt, expiresAt, seenAt } }
 *   picks:      { userId → { predictionId → { option, confident, at } } }
 *   resolutions:{ predictionId → { answer, at, method } }   (admin-set outcomes)
 * ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");
const log = require("./log");

const FILE = process.env.DB_PATH || path.join(__dirname, "..", "data", "db.json");
const WRITE_DEBOUNCE_MS = 250;   // batch bursts of mutations into one disk write

function emptyDb() {
  return { users: {}, usernames: {}, sessions: {}, picks: {}, resolutions: {}, meta: { createdAt: Date.now() } };
}

let data = null;
let writeTimer = null;
let dirty = false;

function load() {
  if (data) return data;
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    data = Object.assign(emptyDb(), JSON.parse(raw));
  } catch (e) {
    // Missing/corrupt file → start fresh but keep a corrupt copy for forensics.
    if (fs.existsSync(FILE)) {
      try { fs.copyFileSync(FILE, FILE + ".corrupt-" + Date.now()); } catch (e2) {}
      log.error("db: could not parse db.json; starting fresh (corrupt copy kept)", e);
    }
    data = emptyDb();
  }
  return data;
}

/* Atomic write: temp file + rename so the file is never half-written. */
function writeNow() {
  if (!data) return;
  dirty = false;
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) {
    dirty = true; // retry on the next save()
    log.error("db: write failed (state kept in memory, will retry)", e);
  }
}

/* Mark the store dirty and schedule a debounced atomic flush. */
function save() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; if (dirty) writeNow(); }, WRITE_DEBOUNCE_MS);
  // Don't let a pending flush keep the process alive on shutdown.
  if (writeTimer.unref) writeTimer.unref();
}

/* Synchronous flush for shutdown paths. */
function flushSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (dirty) writeNow();
}

// Best-effort durability on shutdown (server.js also calls flushSync on SIGTERM).
process.on("beforeExit", flushSync);

module.exports = { get: load, save, flushSync, FILE };
