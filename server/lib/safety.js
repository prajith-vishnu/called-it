"use strict";
/* ============================================================================
 * safety.js — validation + content safety for ALL Groq output.
 *
 * SECURITY/SAFETY PRINCIPLE: model output is UNTRUSTED data. Nothing returned by
 * Groq is used or stored until it passes through here. This is the single
 * choke point where the content safety filter runs (audience is 13+).
 *
 * The front-end runs a mirror of these checks again before display (defense in
 * depth), and the renderer only ever emits escaped text — never raw HTML.
 * ========================================================================== */

const KNOWN_CATEGORIES = ["sports", "music", "movies", "internet", "awards", "trends", "general"];

// ---- content blocklist (a pragmatic 13+ filter; tune for your needs) --------
// Anything matching is DISCARDED, never shown. Word-ish boundaries keep it from
// nuking innocent substrings too aggressively while still being strict.
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

// Signals of contact info / targeting a real private individual → discard.
const PRIVATE_SIGNALS = new RegExp(
  [
    "@[a-z0-9_]+",                              // social handles
    "https?:\\/\\/", "www\\.",                  // links
    "\\b\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b",  // phone numbers
    "\\b[\\w.+-]+@[\\w-]+\\.[\\w.-]+\\b"          // emails
  ].join("|"),
  "i"
);

/* Returns a trimmed, safe string within [min,max] length, or null. */
function cleanText(value, min, max) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length < min || t.length > max) return null;
  if (/[<>]/.test(t)) return null;                 // no HTML/markup characters
  if (/[\x00-\x1f\x7f]/.test(t)) return null;      // no control characters
  if (UNSAFE.test(t)) return null;                 // ── CONTENT SAFETY FILTER ──
  if (PRIVATE_SIGNALS.test(t)) return null;        // no private-individual targeting
  return t;
}

/* Validate + normalize ONE AI-generated prediction into the app's shape.
 * Returns a clean prediction object or null (caller discards null). */
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
  pv = Math.max(10, Math.min(60, pv));             // clamp to sane range

  const ts = Date.parse(raw.closeDate);
  if (!Number.isFinite(ts)) return null;
  // must close in the future and within ~18 months (sanity bound)
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

/* Validate ONE resolution against the known prediction it refers to.
 * Returns { id, outcome, confidence } or null.
 *
 * NOTE: this only validates SHAPE. The decision to APPLY vs send to manual
 * review (low confidence / "unresolved") happens in refresh.js. */
function sanitizeResolution(raw, predictionsById) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string") return null;
  const pred = predictionsById[raw.id];
  if (!pred) return null;                           // unknown id → ignore

  const confidence = raw.confidence === "high" ? "high" : "low";

  let outcome = raw.outcome;
  if (outcome !== "unresolved") {
    // outcome MUST be one of the prediction's real options, else treat as unresolved
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
