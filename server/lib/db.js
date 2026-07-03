"use strict";
// the "database". On Vercel (serverless, no persistent local disk) this reads
// and writes one JSON blob in Upstash Redis. Locally, with no KV env vars set,
// it falls back to a JSON file on disk, atomically written so it can't end up
// half-written. Holds users, sessions (hashed), picks, and resolutions.

const fs = require("node:fs");
const path = require("node:path");
const log = require("./log");
const kv = require("./kv");

const FILE = process.env.DB_PATH || path.join(__dirname, "..", "data", "db.json");
const KV_KEY = "calledit:db";
const WRITE_DEBOUNCE_MS = 250;

function emptyDb() {
  return { users: {}, usernames: {}, sessions: {}, picks: {}, resolutions: {}, meta: { createdAt: Date.now() } };
}

let data = null;
let writeTimer = null;
let dirty = false;

function loadFromFile() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    return Object.assign(emptyDb(), JSON.parse(raw));
  } catch (e) {
    if (fs.existsSync(FILE)) {
      try { fs.copyFileSync(FILE, FILE + ".corrupt-" + Date.now()); } catch (e2) {}
      log.error("db: could not parse db.json; starting fresh (corrupt copy kept)", e);
    }
    return emptyDb();
  }
}

// Sync accessor used everywhere in the app (auth.js, game.js, server.js).
// On a serverless deploy, call hydrate() once per request before this is used;
// locally it lazily reads the file itself the first time it's called.
function get() {
  if (data) return data;
  data = kv.hasKV ? emptyDb() : loadFromFile();
  return data;
}

function save() {
  dirty = true;
  if (kv.hasKV) return; // persisted explicitly via persist() at the end of the request
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; if (dirty) writeToFile(); }, WRITE_DEBOUNCE_MS);
  if (writeTimer.unref) writeTimer.unref();
}

function writeToFile() {
  if (!data) return;
  dirty = false;
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) {
    dirty = true;
    log.error("db: write failed (state kept in memory, will retry)", e);
  }
}

// Called once per request on a serverless deploy, before any route handler
// touches get(). No-op locally (the file is read lazily by get() itself).
async function hydrate() {
  if (!kv.hasKV) return;
  data = await kv.kvGetJSON(KV_KEY, emptyDb());
}

// Called once per request after the route handler ran. No-op locally (local
// file writes are already debounced by save()).
async function persist() {
  if (!kv.hasKV || !dirty || !data) return;
  dirty = false;
  await kv.kvSetJSON(KV_KEY, data);
}

function flushSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (dirty && !kv.hasKV) writeToFile();
}

process.on("beforeExit", flushSync);

module.exports = { get, save, hydrate, persist, flushSync, FILE };
