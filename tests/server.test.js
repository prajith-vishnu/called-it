"use strict";
/* ============================================================================
 * server.test.js — unit tests for the security-critical server pieces:
 * password hashing, input validation, and the AI-output safety filter.
 * Zero dependencies (node:test), no network, no database writes.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// keep the db module pointed at a throwaway path (it is never written here)
process.env.DB_PATH = path.join(__dirname, ".tmp-test-db.json");

const auth = require("../server/lib/auth");
const { sanitizeNewPrediction, sanitizeResolution, cleanText } = require("../server/lib/safety");
const { parseDur } = require("../server/lib/ratelimit");

// ── password hashing ─────────────────────────────────────────────────────────
test("passwords hash with scrypt and verify round-trip", () => {
  const h = auth.hashPassword("correct horse battery staple");
  assert.match(h, /^scrypt\$32768\$8\$1\$/);          // self-describing params
  assert.ok(!h.includes("correct horse"), "hash never contains the password");
  assert.equal(auth.verifyPassword("correct horse battery staple", h), true);
  assert.equal(auth.verifyPassword("wrong password", h), false);
  assert.equal(auth.verifyPassword("", h), false);
});

test("same password hashes differently every time (random salt)", () => {
  assert.notEqual(auth.hashPassword("password123"), auth.hashPassword("password123"));
});

// ── account input validation ─────────────────────────────────────────────────
test("usernames: length, charset, reserved and unsafe names rejected", () => {
  assert.ok(auth.validateUsername("Star_Caller9").ok);
  assert.ok(auth.validateUsername("ab").error, "too short");
  assert.ok(auth.validateUsername("a".repeat(21)).error, "too long");
  assert.ok(auth.validateUsername("bad name!").error, "bad charset");
  assert.ok(auth.validateUsername("admin").error, "reserved");
  assert.ok(auth.validateUsername(null).error, "non-string");
});

test("passwords: length rules and username-equality rejected", () => {
  assert.ok(auth.validatePassword("longenough", "someone").ok);
  assert.ok(auth.validatePassword("short").error);
  assert.ok(auth.validatePassword("x".repeat(129)).error);
  assert.ok(auth.validatePassword("SameAsUser1", "sameasuser1").error);
});

// ── AI-output safety filter ──────────────────────────────────────────────────
test("safety filter blocks markup, control chars, and unsafe content", () => {
  assert.equal(cleanText("<script>alert(1)</script>", 1, 100), null);
  assert.equal(cleanText("hello\x00world", 1, 100), null);
  assert.equal(cleanText("visit https://spam.example now", 1, 100), null);
  assert.ok(cleanText("Will the mission launch in 2026?", 1, 100));
});

test("malformed AI predictions are discarded, valid ones normalized", () => {
  const idf = () => "test-id";
  assert.equal(sanitizeNewPrediction(null, idf), null);
  assert.equal(sanitizeNewPrediction({ question: "too short", options: ["A", "B"] }, idf), null);
  assert.equal(sanitizeNewPrediction({
    question: "Will this resolve cleanly by the deadline?",
    options: ["Yes"], closeDate: "2099-01-01",
  }, idf), null, "needs 2-4 options");

  const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const ok = sanitizeNewPrediction({
    question: "Will this resolve cleanly by the deadline?",
    options: ["Yes", "No"], category: "nonsense", closeDate: future, pointValue: 999,
  }, idf);
  assert.ok(ok);
  assert.equal(ok.category, "general", "unknown category falls back");
  assert.equal(ok.pointValue, 60, "point value clamped to sane range");
});

test("resolutions must reference a known prediction and a real option", () => {
  const preds = { p1: { id: "p1", options: ["Yes", "No"] } };
  assert.equal(sanitizeResolution({ id: "ghost", outcome: "Yes" }, preds), null);
  const invented = sanitizeResolution({ id: "p1", outcome: "Maybe", confidence: "high" }, preds);
  assert.equal(invented.outcome, "unresolved", "invented outcomes are neutralized");
  const good = sanitizeResolution({ id: "p1", outcome: "Yes", confidence: "high" }, preds);
  assert.deepEqual(good, { id: "p1", outcome: "Yes", confidence: "high" });
});

// ── rate-limit duration parsing (Groq header formats) ────────────────────────
test("Groq reset-duration strings parse to milliseconds", () => {
  assert.equal(parseDur("7.66s"), 7660);
  assert.equal(parseDur("2m59.56s"), 179560);
  assert.equal(parseDur("120ms"), 120);
  assert.equal(parseDur("3"), 3000);                  // bare number = seconds
  assert.equal(parseDur(""), 0);
});
