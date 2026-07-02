"use strict";
// database is just a JSON file on disk, written atomically so it can't get
// half-written. holds users, sessions (hashed), picks, and resolutions.

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
    if (fs.existsSync(FILE)) {
      try { fs.copyFileSync(FILE, FILE + ".corrupt-" + Date.now()); } catch (e2) {}
      log.error("db: could not parse db.json; starting fresh (corrupt copy kept)", e);
    }
    data = emptyDb();
  }
  return data;
}

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

function save() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; if (dirty) writeNow(); }, WRITE_DEBOUNCE_MS);
  if (writeTimer.unref) writeTimer.unref();
}

function flushSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (dirty) writeNow();
}

process.on("beforeExit", flushSync);

module.exports = { get: load, save, flushSync, FILE };
