"use strict";
// picks, scoring, streaks, leaderboard - same scoring math as the front end,
// but run here so the client can only send picks, never points directly

const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
const { loadCache } = require("./refresh");

const DATA_DIR = path.join(__dirname, "..", "data");
const SEED_FILE = path.join(DATA_DIR, "predictions.seed.json");

const CONFIDENCE_PER_WEEK = 3;
const LEADERBOARD_TTL_MS = 60 * 1000;
const LEADERBOARD_SIZE = 50;
const DAY_MS = 86400000;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return fallback; }
}

let predCache = { at: 0, list: [], byId: {} };
function predictions() {
  const now = Date.now();
  if (now - predCache.at < 30 * 1000) return predCache;
  const seed = readJSON(SEED_FILE, []).map((p) => Object.assign({ source: "seed" }, p));
  const cache = loadCache();
  const list = seed.concat(cache.predictions || []);
  const byId = {};
  for (const p of list) byId[p.id] = p;
  predCache = { at: now, list, byId, lastRun: cache.lastRun || 0 };
  return predCache;
}

function closeTime(pred) { return Date.parse(pred.closeDate + "T23:59:59Z"); }
function isClosed(pred) { return Date.now() > closeTime(pred); }

function resolutionsMap() {
  const out = {};
  for (const r of (loadCache().resolutions || [])) {
    if (r && typeof r.id === "string" && typeof r.outcome === "string" && r.outcome !== "unresolved") {
      out[r.id] = { answer: r.outcome, at: r.at || 0, method: "ai" };
    }
  }
  const admin = db.get().resolutions || {};
  for (const [id, r] of Object.entries(admin)) out[id] = r;
  return out;
}

function crowdCounts() {
  const { byId } = predictions();
  const counts = {};
  for (const p of predictions().list) counts[p.id] = p.options.map(() => 0);
  for (const userPicks of Object.values(db.get().picks || {})) {
    for (const [predId, pick] of Object.entries(userPicks)) {
      const pred = byId[predId];
      if (!pred) continue;
      const i = pred.options.indexOf(pick.option);
      if (i >= 0) counts[predId][i]++;
    }
  }
  return counts;
}

function submitPick(user, body) {
  if (!body || typeof body !== "object") return { error: "Bad request.", status: 400 };
  const { byId } = predictions();
  const pred = typeof body.id === "string" ? byId[body.id] : null;
  if (!pred) return { error: "Unknown prediction.", status: 404 };
  if (isClosed(pred)) return { error: "This prediction is closed.", status: 409 };
  if (resolutionsMap()[pred.id]) return { error: "This prediction is already resolved.", status: 409 };
  if (typeof body.option !== "string" || !pred.options.includes(body.option)) {
    return { error: "Pick one of the listed options.", status: 400 };
  }
  const confident = body.confident === true;

  const d = db.get();
  const mine = d.picks[user.id] || (d.picks[user.id] = {});
  const existing = mine[pred.id];

  if (confident && !(existing && existing.confident)) {
    const wk = isoWeekKey(Date.now());
    let used = 0;
    for (const p of Object.values(mine)) if (p.confident && isoWeekKey(p.at) === wk) used++;
    if (used >= CONFIDENCE_PER_WEEK) {
      return { error: `No confidence stakes left this week (max ${CONFIDENCE_PER_WEEK}).`, status: 409 };
    }
  }

  mine[pred.id] = {
    option: body.option,
    confident,
    at: confident && !(existing && existing.confident) ? Date.now() : (existing ? existing.at : Date.now()),
  };
  db.save();
  invalidateLeaderboard();
  return { ok: true, pick: mine[pred.id] };
}

function isoWeekKey(ts) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / DAY_MS - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

function streakBonus(streak) {
  if (streak >= 10) return 50;
  if (streak >= 5) return 25;
  if (streak >= 3) return 10;
  return 0;
}

function computeDerived(user, opts) {
  opts = opts || {};
  const { byId } = predictions();
  const resolutions = opts.resolutions || resolutionsMap();
  const crowd = opts.crowd || crowdCounts();
  const picks = db.get().picks[user.id] || {};

  const events = Object.keys(resolutions)
    .filter((id) => picks[id] !== undefined && byId[id])
    .map((id) => ({ id, answer: resolutions[id].answer, at: resolutions[id].at || 0 }))
    .sort((a, b) => a.at - b.at);

  let points = 0, peakPoints = 0, streak = 0, peakStreak = 0, correct = 0, beatWins = 0;
  const per = {};

  for (const ev of events) {
    const pred = byId[ev.id];
    const pick = picks[ev.id];
    const isCorrect = pick.option === ev.answer;
    const confident = !!pick.confident;
    let base = 0, beat = 0, sBonus = 0, cBonus = 0, cLoss = 0;

    if (isCorrect) {
      streak++; peakStreak = Math.max(peakStreak, streak); correct++;
      base = pred.pointValue;
      const counts = crowd[ev.id] || pred.options.map(() => 0);
      const total = counts.reduce((a, b) => a + b, 0) || 1;
      const i = pred.options.indexOf(pick.option);
      const pickPct = i >= 0 ? counts[i] / total : 1;
      const leaderPct = Math.max(...counts.map((c) => c / total));
      if (pickPct < leaderPct - 1e-9) { beat = Math.round(pred.pointValue * (1 - pickPct)); beatWins++; }
      sBonus = streakBonus(streak);
      if (confident) cBonus = pred.pointValue;
      points += base + beat + sBonus + cBonus;
      peakPoints = Math.max(peakPoints, points);
    } else {
      streak = 0;
      if (confident) { cLoss = Math.min(pred.pointValue, points); points -= cLoss; }
    }
    per[ev.id] = { isCorrect, confident, base, beat, sBonus, cBonus, cLoss, streakAt: streak, net: base + beat + sBonus + cBonus - cLoss };
  }

  const totalResolved = events.length;
  const bonusPoints = user.bonusPoints || 0;
  return {
    points, bonusPoints,
    totalScore: points + bonusPoints,
    peakPoints: peakPoints + bonusPoints,
    streak, peakStreak, correct, beatWins, totalResolved,
    accuracy: totalResolved ? Math.round((correct / totalResolved) * 100) : 0,
    per,
    daily: user.daily || { streak: 0, best: 0, lastDay: null },
  };
}

const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);

function dailyCheckin(user) {
  const today = utcDay(Date.now());
  const daily = user.daily || (user.daily = { streak: 0, best: 0, lastDay: null });

  if (daily.lastDay === today) {
    return { alreadyCheckedIn: true, streak: daily.streak, best: daily.best, bonusAwarded: 0, broke: false };
  }
  const yesterday = utcDay(Date.now() - DAY_MS);
  const broke = daily.lastDay !== null && daily.lastDay !== yesterday && daily.streak > 0;
  const lostStreak = broke ? daily.streak : 0;

  daily.streak = daily.lastDay === yesterday ? daily.streak + 1 : 1;
  daily.best = Math.max(daily.best, daily.streak);
  daily.lastDay = today;

  const bonusAwarded = Math.min(10 + (daily.streak - 1) * 5, 40);
  user.bonusPoints = (user.bonusPoints || 0) + bonusAwarded;
  db.save();
  invalidateLeaderboard();
  return { alreadyCheckedIn: false, streak: daily.streak, best: daily.best, bonusAwarded, broke, lostStreak };
}

let lb = { at: 0, entries: [] };
function invalidateLeaderboard() { lb.at = 0; }

function leaderboard() {
  const now = Date.now();
  if (now - lb.at < LEADERBOARD_TTL_MS) return lb;

  const resolutions = resolutionsMap();
  const crowd = crowdCounts();
  const users = Object.values(db.get().users || {});
  const entries = users.map((u) => {
    const d = computeDerived(u, { resolutions, crowd });
    return {
      username: u.username,
      score: d.totalScore,
      streak: d.streak,
      dailyStreak: (u.daily && u.daily.streak) || 0,
      accuracy: d.accuracy,
      correct: d.correct,
    };
  })
  .sort((a, b) => b.score - a.score || b.accuracy - a.accuracy || a.username.localeCompare(b.username))
  .map((e, i) => Object.assign({ rank: i + 1 }, e));

  lb = { at: now, entries, updatedAt: now };
  return lb;
}

function leaderboardView(forUsername) {
  const { entries, updatedAt } = leaderboard();
  const top = entries.slice(0, LEADERBOARD_SIZE);
  let you = null;
  if (forUsername) {
    you = entries.find((e) => e.username === forUsername) || null;
  }
  return { updatedAt, players: entries.length, entries: top, you };
}

function adminResolve(id, outcome) {
  const { byId } = predictions();
  const pred = typeof id === "string" ? byId[id] : null;
  if (!pred) return { error: "Unknown prediction.", status: 404 };
  const d = db.get();
  if (outcome === null) {
    delete d.resolutions[id];
  } else {
    if (typeof outcome !== "string" || !pred.options.includes(outcome)) {
      return { error: "Outcome must be one of the prediction's options.", status: 400 };
    }
    d.resolutions[id] = { answer: outcome, at: Date.now(), method: "admin" };
  }
  db.save();
  invalidateLeaderboard();
  return { ok: true };
}

function publicFeed() {
  const { list, lastRun } = predictions();
  const crowd = crowdCounts();
  const res = resolutionsMap();
  return {
    lastRun,
    predictions: list.map((p) => ({
      id: p.id, category: p.category, question: p.question, options: p.options,
      closeDate: p.closeDate, pointValue: p.pointValue, source: p.source || "ai",
      crowd: crowd[p.id] || p.options.map(() => 0),
    })),
    resolutions: Object.entries(res).map(([id, r]) => ({ id, outcome: r.answer, confidence: "high", at: r.at })),
  };
}

module.exports = {
  predictions, resolutionsMap, crowdCounts, closeTime, isClosed,
  submitPick, computeDerived, dailyCheckin,
  leaderboard, leaderboardView, invalidateLeaderboard,
  adminResolve, publicFeed,
  CONFIDENCE_PER_WEEK,
};
