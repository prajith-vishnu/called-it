"use strict";
// accounts + sessions. passwords are hashed with scrypt, sessions are random
// tokens stored as a hash (not JWTs, simpler for a single server like this)

const crypto = require("node:crypto");
const db = require("./db");
const { cleanText } = require("./safety");

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split("$");
    if (algo !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const got = crypto.scryptSync(password, salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(got, expected);
  } catch (e) {
    return false;
  }
}

const RESERVED = new Set(["admin", "administrator", "mod", "moderator", "system", "root",
  "calledit", "called_it", "official", "support", "staff", "owner", "null", "undefined", "you", "demo"]);

function validateUsername(u) {
  if (typeof u !== "string") return { error: "Username is required." };
  const t = u.trim();
  if (t.length < 3 || t.length > 20) return { error: "Username must be 3–20 characters." };
  if (!/^[A-Za-z0-9_]+$/.test(t)) return { error: "Letters, numbers and _ only." };
  if (RESERVED.has(t.toLowerCase())) return { error: "That username is reserved." };
  if (!cleanText(t.replace(/_/g, " "), 1, 40)) return { error: "That username isn't allowed." };
  return { ok: true, value: t };
}

function validatePassword(pw, username) {
  if (typeof pw !== "string") return { error: "Password is required." };
  if (pw.length < 8) return { error: "Password must be at least 8 characters." };
  if (pw.length > 128) return { error: "Password must be at most 128 characters." };
  if (username && pw.toLowerCase() === String(username).toLowerCase()) {
    return { error: "Password can't be your username." };
  }
  return { ok: true };
}

const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { loginIp: 20, loginAccount: 10, registerIp: 8 };
const attempts = new Map(); // key → [timestamps]

function limited(key, max) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  if (attempts.size > 20000) attempts.clear();           // memory guard
  return list.length >= max;
}
function noteAttempt(key) {
  const list = attempts.get(key) || [];
  list.push(Date.now());
  attempts.set(key, list);
}
function clearAttempts(key) { attempts.delete(key); }

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const MAX_SESSIONS_PER_USER = 10;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function createSession(userId) {
  const d = db.get();
  const token = crypto.randomBytes(32).toString("base64url"); // returned ONCE, never stored raw
  const now = Date.now();
  d.sessions[sha256(token)] = { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS, seenAt: now };

  // Cap concurrent sessions per user (drop the oldest).
  const mine = Object.entries(d.sessions).filter(([, s]) => s.userId === userId)
    .sort((a, b) => a[1].seenAt - b[1].seenAt);
  while (mine.length > MAX_SESSIONS_PER_USER) delete d.sessions[mine.shift()[0]];

  db.save();
  return token;
}

function getSessionUser(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const d = db.get();
  const key = sha256(token);
  const s = d.sessions[key];
  const now = Date.now();
  if (!s || now > s.expiresAt) { if (s) { delete d.sessions[key]; db.save(); } return null; }
  const user = d.users[s.userId];
  if (!user) { delete d.sessions[key]; db.save(); return null; }
  if (now - s.seenAt > 60 * 60 * 1000) {                 // refresh at most hourly (avoid write churn)
    s.seenAt = now; s.expiresAt = now + SESSION_TTL_MS;
    db.save();
  }
  return user;
}

function destroySession(token) {
  if (typeof token !== "string") return;
  const d = db.get();
  if (d.sessions[sha256(token)]) { delete d.sessions[sha256(token)]; db.save(); }
}

function pruneSessions() {
  const d = db.get();
  const now = Date.now();
  let removed = 0;
  for (const [k, s] of Object.entries(d.sessions)) {
    if (now > s.expiresAt) { delete d.sessions[k]; removed++; }
  }
  if (removed) db.save();
  return removed;
}

function register(usernameRaw, password, ip) {
  if (limited("reg:" + ip, LIMITS.registerIp)) return { error: "Too many signups from this network. Try later.", status: 429 };
  const u = validateUsername(usernameRaw);
  if (!u.ok) return { error: u.error, status: 400 };
  const p = validatePassword(password, u.value);
  if (!p.ok) return { error: p.error, status: 400 };

  const d = db.get();
  const lower = u.value.toLowerCase();
  if (d.usernames[lower]) return { error: "That username is taken.", status: 409 };

  noteAttempt("reg:" + ip);
  const now = Date.now();
  const user = {
    id: crypto.randomUUID(),
    username: u.value,
    passHash: hashPassword(password),
    createdAt: now,
    lastLoginAt: now,
    bonusPoints: 0,
    daily: { streak: 0, best: 0, lastDay: null },
  };
  d.users[user.id] = user;
  d.usernames[lower] = user.id;
  db.save();
  return { user };
}

function login(usernameRaw, password, ip) {
  const uname = typeof usernameRaw === "string" ? usernameRaw.trim() : "";
  const acctKey = "acct:" + uname.toLowerCase();
  if (limited("login:" + ip, LIMITS.loginIp) || limited(acctKey, LIMITS.loginAccount)) {
    return { error: "Too many attempts. Try again in a few minutes.", status: 429 };
  }
  noteAttempt("login:" + ip);
  noteAttempt(acctKey);

  const d = db.get();
  const userId = d.usernames[uname.toLowerCase()];
  const user = userId ? d.users[userId] : null;
  const ok = user ? verifyPassword(String(password || ""), user.passHash)
                  : (verifyPassword(String(password || ""), hashPassword("timing-equalizer")), false);
  if (!ok) return { error: "Wrong username or password.", status: 401 };

  clearAttempts(acctKey);
  user.lastLoginAt = Date.now();
  db.save();
  return { user };
}

function publicUser(user) {
  return { username: user.username, createdAt: user.createdAt };
}

module.exports = {
  register, login, publicUser,
  createSession, getSessionUser, destroySession, pruneSessions,
  validateUsername, validatePassword, hashPassword, verifyPassword,
};
