"use strict";
// the only file that talks to Groq. key comes from process.env, never hardcoded.

const RL = require("./ratelimit");

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GEN_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const COMPOUND_MODEL = process.env.GROQ_COMPOUND_MODEL || "groq/compound";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 30000;

// keep this frozen so Groq's prompt caching kicks in - only the user message changes
const STABLE_SYSTEM_PROMPT = [
  "You generate and resolve fun, SFW pop-culture prediction questions for an all-ages trivia game.",
  "Always reply with a single compact JSON object only — no prose, no markdown, no code fences.",
  "When generating (new_predictions): each must be specific and TIME-BOUND (a named deadline),",
  "objectively resolvable, family-friendly for all ages, with NO sexual, violent, hateful, illegal,",
  "self-harm, or drug/gambling content, and must NOT target real private individuals.",
  "category must be one of: sports, space, music, movies, internet, awards, trends, general.",
  "Everything must be STRICTLY family-friendly for all ages: no politics, elections, politicians, war,",
  "weapons, crime, disasters, religion, gambling, drugs, or adult/violent content.",
  "options: 2-4 short choices. closeDate: ISO yyyy-mm-dd, 3-9 months in the future.",
  "pointValue: integer 10-60.",
  "When resolving: resolve ONLY when a reliable, widely-reported source clearly confirms the outcome.",
  "If there is ANY doubt or no clear source, set outcome to \"unresolved\" and confidence \"low\".",
  "Never guess or fabricate. Only return confidence \"high\" for clear-cut, well-sourced outcomes.",
].join(" ");

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

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(model, userText, jsonMode, estTokens) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { skipped: true, reason: "no-api-key" };

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
    messages: [
      { role: "system", content: STABLE_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const guard = RL.canProceed("groq", estTokens);
    if (!guard.ok) return { skipped: true, reason: guard.reason, waitMs: guard.waitMs };

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
    } catch (e) {
      lastErr = e;
      clearTimeout(timer);
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * Math.pow(4, attempt - 1));
      continue;
    } finally {
      clearTimeout(timer);
    }

    RL.record("groq", res.headers);

    if (res.status === 429) {
      RL.note429("groq", res.headers.get("retry-after"));
      return { skipped: true, reason: "429" };
    }
    if (res.status >= 500) {
      lastErr = new Error("Groq HTTP " + res.status);
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * Math.pow(4, attempt - 1));
      continue;
    }
    if (!res.ok) {
      return { skipped: true, reason: "http-" + res.status };
    }

    const data = await res.json().catch(() => null);
    const text =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content || ""
        : "";
    return { text };
  }
  return { skipped: true, reason: "transient: " + (lastErr ? lastErr.message : "unknown") };
}

async function generate(n) {
  const today = new Date().toISOString().slice(0, 10);
  const userText =
    `Today is ${today}. Generate ${n} new predictions about famous, mainstream events that almost EVERYONE recognizes and has an opinion on — ` +
    `like: FIFA World Cup match winners and the champion, Wimbledon/Grand Slam tennis, NBA stars' next teams and finals, ` +
    `celebrity relationships and weddings (e.g. Taylor Swift & Travis Kelce), #1 songs and new albums from huge artists, ` +
    `blockbuster movies and box office, award shows (Grammys/Oscars/VMAs), major phone/tech launches, ` +
    `and space exploration (NASA missions, Moon landings, rocket launches, astronaut records). ` +
    `Use the "sports" category for sports and the "space" category for space/NASA. Prefer the biggest, most talked-about topics. ` +
    `STRICTLY FAMILY-FRIENDLY (all ages): absolutely NO politics, elections, politicians, war, weapons, crime, disasters, ` +
    `religion, gambling, drugs, or anything violent or adult. Keep it light and fun. ` +
    `Each closeDate MUST be between 2 weeks and 9 months AFTER ${today} (ISO yyyy-mm-dd) — never in the past — so imminent big events are allowed. ` +
    `Respond as {"new_predictions":[...]}.`;
  const r = await call(GEN_MODEL, userText, true, 2000);
  if (r.skipped) return { skipped: true, reason: r.reason, new_predictions: [] };
  const parsed = extractJson(r.text) || {};
  return { skipped: false, new_predictions: Array.isArray(parsed.new_predictions) ? parsed.new_predictions : [] };
}

async function resolveClosed(closedPending) {
  if (!closedPending.length) return { skipped: false, resolutions: [] };
  const today = new Date().toISOString().slice(0, 10);
  const userText =
    `Today is ${today}. Resolve these closed questions using reliable sources. Respond as ` +
    `{"resolutions":[{"id","outcome","confidence"}]}. Use outcome "unresolved" + confidence "low" if not clearly sourced.\n` +
    JSON.stringify(closedPending);
  const est = 1200 + closedPending.length * 60;
  const r = await call(COMPOUND_MODEL, userText, false, est);
  if (r.skipped) return { skipped: true, reason: r.reason, resolutions: [] };
  const parsed = extractJson(r.text) || {};
  return { skipped: false, resolutions: Array.isArray(parsed.resolutions) ? parsed.resolutions : [] };
}

module.exports = { generate, resolveClosed, GEN_MODEL, COMPOUND_MODEL, STABLE_SYSTEM_PROMPT };
