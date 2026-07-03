"use strict";
// tiny Upstash Redis REST client (plain fetch, no SDK - stays zero-dependency).
// used when the app is deployed somewhere serverless (Vercel) where writing to
// a local file doesn't persist between requests. locally, with no KV env vars
// set, hasKV is false and callers fall back to the local JSON file instead.

const URL_ENV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN_ENV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const hasKV = !!(URL_ENV && TOKEN_ENV);

async function kvGetJSON(key, fallback) {
  if (!hasKV) return fallback;
  try {
    const res = await fetch(`${URL_ENV}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${TOKEN_ENV}` },
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    if (data.result == null) return fallback;
    return JSON.parse(data.result);
  } catch (e) {
    return fallback;
  }
}

async function kvSetJSON(key, value) {
  if (!hasKV) return false;
  try {
    const res = await fetch(`${URL_ENV}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_ENV}`, "Content-Type": "text/plain" },
      body: JSON.stringify(value),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { hasKV, kvGetJSON, kvSetJSON };
