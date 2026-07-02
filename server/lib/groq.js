"use strict";
/* ============================================================================
 * groq.js — the ONLY place that talks to Groq.
 *
 * SECURITY:
 *   • The API key is read from process.env.GROQ_API_KEY (backend env / secret
 *     store) — see KEY READ below. Never hardcoded, never sent to the browser,
 *     never logged. Sent as an Authorization: Bearer header.
 *
 * BUDGET / RATE LIMITS (free tier — never exceed):
 *   • Every call is gated by the header-aware guard in ratelimit.js BEFORE it
 *     runs, and records Groq's rate-limit headers AFTER. 429s trigger back-off.
 *   • The SYSTEM PROMPT IS STABLE across all calls (a frozen constant) so Groq's
 *     prompt caching applies — cached input tokens don't count toward the budget.
 *     Only the short user message varies.
 *   • maxTokens is capped; a hard timeout aborts slow calls.
 *
 * TWO jobs, both driven by the SAME stable system prompt:
 *   generate(n)            → new age-appropriate predictions (JSON mode).
 *   resolveClosed(list)    → resolve ONLY clear-cut closed questions using
 *                            Groq Compound (web search); returns "unresolved"
 *                            for anything not confidently sourced.
 * ========================================================================== */

const RL = require("./ratelimit");

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GEN_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
// Compound is Groq's agentic, web-search-capable system (good for resolution).
const COMPOUND_MODEL = process.env.GROQ_COMPOUND_MODEL || "groq/compound";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 30000;

/* ── STABLE SYSTEM PROMPT ──────────────────────────────────────────────────
 * Frozen string — DO NOT vary it per call (varying it defeats prompt caching).
 * It encodes both jobs + the 13+ safety rules + the JSON-only contract. */
const STABLE_SYSTEM_PROMPT = [
  "You generate and resolve fun, SFW pop-culture prediction questions for an all-ages trivia game.",
  "Always reply with a single compact JSON object only — no prose, no markdown, no code fences.",
  "When generating (new_predictions): each must be specific and TIME-BOUND (a named deadline),",
  "objectively resolvable, family-friendly for all ages, with NO sexual, violent, hateful, illegal,",
  "self-harm, or drug/gambling content, and must NOT target real private individuals.",
  "category must be one of: sports, music, movies, internet, awards, trends, general.",
  "Everything must be STRICTLY family-friendly for all ages: no politics, elections, politicians, war,",
  "weapons, crime, disasters, religion, gambling, drugs, or adult/violent content.",
  "options: 2-4 short choices. closeDate: ISO yyyy-mm-dd, 3-9 months in the future.",
  "pointValue: integer 10-60.",
  "When resolving: resolve ONLY when a reliable, widely-reported source clearly confirms the outcome.",
  "If there is ANY doubt or no clear source, set outcome to \"unresolved\" and confidence \"low\".",
  "Never guess or fabricate. Only return confidence \"high\" for clear-cut, well-sourced outcomes.",
].join(" ");

/* Try strict JSON.parse, else extract the first {...} block (defensive — some
 * agentic models wrap JSON in text). Returns an object or null. */
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

/* Low-level call. Gated by the rate-limit guard; records headers; handles 429.
 * Returns { text } on success, or { skipped, reason } when budget-blocked. */
async function call(model, userText, jsonMode, estTokens) {
  // ── BUDGET CHECK BEFORE THE CALL ──
  const guard = RL.canProceed("groq", estTokens);
  if (!guard.ok) return { skipped: true, reason: guard.reason, waitMs: guard.waitMs };

  // ───────────────────────── KEY READ (backend only) ─────────────────────────
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set. Refusing to call Groq.");
  // ────────────────────────────────────────────────────────────────────────────

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
    // STABLE system message first (cacheable prefix) + short variable user message.
    messages: [
      { role: "system", content: STABLE_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  // ── RECORD HEADERS AFTER THE CALL (source of truth for the next decision) ──
  RL.record("groq", res.headers);

  if (res.status === 429) {
    RL.note429("groq", res.headers.get("retry-after"));
    return { skipped: true, reason: "429" };           // back off; app serves cache
  }
  if (!res.ok) throw new Error("Groq HTTP " + res.status);

  const data = await res.json();
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content || ""
      : "";
  return { text };
}

/* Generate `n` new predictions. JSON mode on a fast model (no web needed).
 * NOTE: today's date goes in the USER message (which is expected to vary), NOT
 * the system prompt — that keeps the system prompt frozen so prompt caching
 * still applies. The model needs the date to produce FUTURE closeDates. */
async function generate(n) {
  const today = new Date().toISOString().slice(0, 10);
  const userText =
    `Today is ${today}. Generate ${n} new predictions about famous, mainstream events that almost EVERYONE recognizes and has an opinion on — ` +
    `like: FIFA World Cup match winners and the champion, Wimbledon/Grand Slam tennis, NBA stars' next teams and finals, ` +
    `celebrity relationships and weddings (e.g. Taylor Swift & Travis Kelce), #1 songs and new albums from huge artists, ` +
    `blockbuster movies and box office, award shows (Grammys/Oscars/VMAs), and major phone/tech launches. ` +
    `Use the "sports" category for sports. Prefer the biggest, most talked-about topics. ` +
    `STRICTLY FAMILY-FRIENDLY (all ages): absolutely NO politics, elections, politicians, war, weapons, crime, disasters, ` +
    `religion, gambling, drugs, or anything violent or adult. Keep it light and fun. ` +
    `Each closeDate MUST be between 2 weeks and 9 months AFTER ${today} (ISO yyyy-mm-dd) — never in the past — so imminent big events are allowed. ` +
    `Respond as {"new_predictions":[...]}.`;
  const r = await call(GEN_MODEL, userText, true, 2000);
  if (r.skipped) return { skipped: true, reason: r.reason, new_predictions: [] };
  const parsed = extractJson(r.text) || {};
  return { skipped: false, new_predictions: Array.isArray(parsed.new_predictions) ? parsed.new_predictions : [] };
}

/* Resolve closed questions via Compound (web search). `closedPending` is already
 * trimmed by the caller to ONLY { id, question, options }. */
async function resolveClosed(closedPending) {
  if (!closedPending.length) return { skipped: false, resolutions: [] };
  const today = new Date().toISOString().slice(0, 10);   // user-message only (system prompt stays frozen)
  const userText =
    `Today is ${today}. Resolve these closed questions using reliable sources. Respond as ` +
    `{"resolutions":[{"id","outcome","confidence"}]}. Use outcome "unresolved" + confidence "low" if not clearly sourced.\n` +
    JSON.stringify(closedPending);
  const est = 1200 + closedPending.length * 60;
  // Compound may not honor json_object mode → request JSON in-prompt and parse defensively.
  const r = await call(COMPOUND_MODEL, userText, false, est);
  if (r.skipped) return { skipped: true, reason: r.reason, resolutions: [] };
  const parsed = extractJson(r.text) || {};
  return { skipped: false, resolutions: Array.isArray(parsed.resolutions) ? parsed.resolutions : [] };
}

module.exports = { generate, resolveClosed, GEN_MODEL, COMPOUND_MODEL, STABLE_SYSTEM_PROMPT };
