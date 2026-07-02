"use strict";
// filters everything Groq generates before it's stored or shown to anyone

const KNOWN_CATEGORIES = ["sports", "space", "music", "movies", "internet", "awards", "trends", "general"];

const UNSAFE = new RegExp(
  [
    // sexual / adult
    "porn", "nsfw", "nude", "\\bsex\\b", "sexual", "erotic", "fetish",
    // violence / self-harm / weapons
    "\\bkill\\b", "murder", "suicide", "self[\\s-]?harm", "\\brape\\b", "abuse",
    "nazi", "terror", "\\bbomb\\b", "shooting", "\\bgun\\b", "weapon",
    "\\bwar\\b", "invasion", "nuclear", "missile", "\\bcoup\\b", "assassinat", "hostage", "genocide",
    // drugs / gambling
    "cocaine", "heroin", "meth\\b", "\\bdrugs?\\b", "vape", "alcohol",
    "gambl", "\\bbet\\b", "casino", "\\bslur\\b", "\\bgore\\b",
    // divisive politics / crime — keep it fun & family-friendly (not for 13+ game)
    "\\belection\\b", "\\bpresident\\b", "politician", "parliament", "\\bsenate\\b", "\\bcongress\\b", "impeach",
    "homicide", "convicted", "\\bverdict\\b"
  ].join("|"),
  "i"
);

const PRIVATE_SIGNALS = new RegExp(
  [
    "@[a-z0-9_]+",                              // social handles
    "https?:\\/\\/", "www\\.",                  // links
    "\\b\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b",  // phone numbers
    "\\b[\\w.+-]+@[\\w-]+\\.[\\w.-]+\\b"          // emails
  ].join("|"),
  "i"
);

function cleanText(value, min, max) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length < min || t.length > max) return null;
  if (/[<>]/.test(t)) return null;
  if (/[\x00-\x1f\x7f]/.test(t)) return null;
  if (UNSAFE.test(t)) return null;
  if (PRIVATE_SIGNALS.test(t)) return null;
  return t;
}

function sanitizeNewPrediction(raw, idFactory) {
  if (!raw || typeof raw !== "object") return null;

  const question = cleanText(raw.question, 12, 140);
  if (!question) return null;

  if (!Array.isArray(raw.options)) return null;
  const options = [];
  for (const o of raw.options) {
    const c = cleanText(o, 1, 48);
    if (!c || options.includes(c)) return null;    // each option clean + unique
    options.push(c);
  }
  if (options.length < 2 || options.length > 4) return null;

  const category = KNOWN_CATEGORIES.includes(raw.category) ? raw.category : "general";

  let pv = Math.round(Number(raw.pointValue));
  if (!Number.isFinite(pv)) pv = 25;
  pv = Math.max(10, Math.min(60, pv));

  const ts = Date.parse(raw.closeDate);
  if (!Number.isFinite(ts)) return null;
  const now = Date.now();
  if (ts < now || ts > now + 18 * 30 * 86400000) return null;
  const closeDate = new Date(ts).toISOString().slice(0, 10);

  return {
    id: idFactory(),
    category,
    question,
    options,
    closeDate,
    pointValue: pv,
    resolution: "pending",
    source: "ai",
  };
}

function sanitizeResolution(raw, predictionsById) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string") return null;
  const pred = predictionsById[raw.id];
  if (!pred) return null;

  const confidence = raw.confidence === "high" ? "high" : "low";

  let outcome = raw.outcome;
  if (outcome !== "unresolved") {
    if (typeof outcome !== "string" || !pred.options.includes(outcome)) {
      outcome = "unresolved";
    }
  }
  return { id: raw.id, outcome, confidence };
}

module.exports = {
  KNOWN_CATEGORIES,
  cleanText,
  sanitizeNewPrediction,
  sanitizeResolution,
};
