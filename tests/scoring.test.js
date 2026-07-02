"use strict";
/* ============================================================================
 * scoring.test.js — zero-dependency tests (node:test) for the game's scoring
 * engine: base points, beat-the-crowd bonus, streak increment/reset,
 * confidence-stake gain/loss, daily check-in.
 *
 * The engine under test is the REAL one shipped to players: the `Game` module
 * is extracted verbatim from index.html and evaluated in a VM against fixture
 * DATA, so these tests can never drift from the code users actually run.
 * (The server port in server/lib/game.js implements the same math; see
 * server.test.js for the server-side pieces.)
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ── extract the Game IIFE from index.html ────────────────────────────────────
function loadGame(DATA) {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const start = html.indexOf("const Game = (() => {");
  assert.ok(start > 0, "Game module found in index.html");
  const anchor = html.indexOf("unlockedRewards, unlockProgressText,", start);
  const end = html.indexOf("})();", anchor) + "})();".length;
  const src = html.slice(start, end) + "\nglobalThis.__Game = Game;";
  const ctx = vm.createContext({ DATA, Date, Math, console });
  vm.runInContext(src, ctx);
  return ctx.__Game;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// crowd note: effectiveCrowd adds the user's own pick, so expected percentages
// below are computed on (seed + 1) tallies.
const PREDICTIONS = [
  // dummy keeps the EVERGREEN date-shift math finite; never used in tests
  { id: "dummy", category: "general", question: "d", options: ["Yes", "No"], crowd: [1, 1], closeDate: "2099-01-01", pointValue: 10, resolution: "pending" },
  { id: "pA", category: "general", question: "A?", options: ["Yes", "No"], crowd: [80, 20], closeDate: "2099-01-01", pointValue: 20, resolution: "pending", noShift: true },
  { id: "pB", category: "general", question: "B?", options: ["A", "B"], crowd: [50, 50], closeDate: "2099-01-01", pointValue: 30, resolution: "pending", noShift: true },
  { id: "pC", category: "space", question: "C?", options: ["Yes", "No"], crowd: [1, 1], closeDate: "2099-01-01", pointValue: 10, resolution: "pending", noShift: true },
  { id: "pD", category: "space", question: "D?", options: ["Yes", "No"], crowd: [1, 1], closeDate: "2099-01-01", pointValue: 10, resolution: "pending", noShift: true },
  { id: "pE", category: "music", question: "E?", options: ["Yes", "No"], crowd: [1, 1], closeDate: "2099-01-01", pointValue: 10, resolution: "pending", noShift: true },
];
const byId = {};
for (const p of PREDICTIONS) byId[p.id] = p;
const DATA = {
  PREDICTIONS, byId,
  RANKS: [
    { name: "Rookie", emoji: "🌱", min: 0, title: "start" },
    { name: "Caller", emoji: "📣", min: 150, title: "mid" },
  ],
  REWARDS: [
    { id: "r_pts", type: "badge", unlock: { kind: "points", value: 30 } },
    { id: "r_daily", type: "badge", unlock: { kind: "daily", value: 2 } },
  ],
};
const Game = loadGame(DATA);

function state(picks, resolutions, extra) {
  return Object.assign({
    username: null, picks: picks || {}, resolutions: resolutions || {},
    activeTheme: "default", activeTitle: null,
    celebrated: [], seenUnlocks: [], seenRank: "Rookie",
    daily: { streak: 0, best: 0, lastDay: null }, bonusPoints: 0,
  }, extra || {});
}

// ── correct / incorrect ──────────────────────────────────────────────────────
test("correct call earns the prediction's base points", () => {
  const d = Game.computeDerived(state(
    { pA: { option: "Yes", confident: false, at: 1 } },
    { pA: { answer: "Yes", at: 100 } }
  ));
  // picking the favorite (81/101 with own pick) → no beat bonus, just base
  assert.equal(d.points, 20);
  assert.equal(d.correct, 1);
  assert.equal(d.streak, 1);
  assert.equal(d.accuracy, 100);
  assert.equal(d.per.pA.base, 20);
  assert.equal(d.per.pA.beat, 0);
});

test("incorrect call earns nothing and counts against accuracy", () => {
  const d = Game.computeDerived(state(
    { pA: { option: "Yes", confident: false, at: 1 } },
    { pA: { answer: "No", at: 100 } }
  ));
  assert.equal(d.points, 0);
  assert.equal(d.correct, 0);
  assert.equal(d.streak, 0);
  assert.equal(d.totalResolved, 1);
  assert.equal(d.accuracy, 0);
});

// ── beat-the-crowd bonus ─────────────────────────────────────────────────────
test("contrarian correct pick earns beat-the-crowd bonus", () => {
  // crowd 80/20 + own pick on "No" → counts 80/21, pickPct = 21/101
  const d = Game.computeDerived(state(
    { pA: { option: "No", confident: false, at: 1 } },
    { pA: { answer: "No", at: 100 } }
  ));
  const expectedBeat = Math.round(20 * (1 - 21 / 101)); // = 16
  assert.equal(d.per.pA.beat, expectedBeat);
  assert.equal(d.points, 20 + expectedBeat);
});

test("picking the crowd favorite earns no beat bonus", () => {
  // even crowd; own pick makes "A" the favorite (51/101)
  const d = Game.computeDerived(state(
    { pB: { option: "A", confident: false, at: 1 } },
    { pB: { answer: "A", at: 100 } }
  ));
  assert.equal(d.per.pB.beat, 0);
  assert.equal(d.points, 30);
});

// ── streaks ──────────────────────────────────────────────────────────────────
test("streak increments across wins and pays the 3-streak bonus", () => {
  const d = Game.computeDerived(state(
    {
      pC: { option: "Yes", confident: false, at: 1 },
      pD: { option: "Yes", confident: false, at: 2 },
      pE: { option: "Yes", confident: false, at: 3 },
    },
    {
      pC: { answer: "Yes", at: 101 },
      pD: { answer: "Yes", at: 102 },
      pE: { answer: "Yes", at: 103 },
    }
  ));
  assert.equal(d.streak, 3);
  assert.equal(d.peakStreak, 3);
  assert.equal(d.per.pE.sBonus, 10);                 // bonus lands on the 3rd win
  assert.equal(d.points, 10 + 10 + (10 + 10));       // 3× base + streak bonus
});

test("a wrong call resets the streak but keeps earned points", () => {
  const d = Game.computeDerived(state(
    {
      pC: { option: "Yes", confident: false, at: 1 },
      pD: { option: "Yes", confident: false, at: 2 },
      pA: { option: "Yes", confident: false, at: 3 },
    },
    {
      pC: { answer: "Yes", at: 101 },
      pD: { answer: "Yes", at: 102 },
      pA: { answer: "No", at: 103 },                  // miss, resolved last
    }
  ));
  assert.equal(d.streak, 0);
  assert.equal(d.peakStreak, 2);
  assert.equal(d.points, 20);                         // two wins survive the miss
});

// ── confidence stakes ────────────────────────────────────────────────────────
test("confident + correct doubles up with the matched stake", () => {
  const d = Game.computeDerived(state(
    { pA: { option: "Yes", confident: true, at: 1 } },
    { pA: { answer: "Yes", at: 100 } }
  ));
  assert.equal(d.per.pA.cBonus, 20);
  assert.equal(d.points, 40);                         // 20 base + 20 stake
});

test("confident + wrong loses the stake, capped at points on hand", () => {
  const d = Game.computeDerived(state(
    {
      pC: { option: "Yes", confident: false, at: 1 }, // win 10 first
      pB: { option: "A", confident: true, at: 2 },    // stake 30, lose
    },
    {
      pC: { answer: "Yes", at: 101 },
      pB: { answer: "B", at: 102 },
    }
  ));
  assert.equal(d.per.pB.cLoss, 10);                   // min(30 stake, 10 held)
  assert.equal(d.points, 0);                          // never goes negative
});

test("weekly confidence quota counts only this ISO week", () => {
  const now = Date.now();
  const s = state({
    pC: { option: "Yes", confident: true, at: now },
    pD: { option: "Yes", confident: true, at: now },
    pE: { option: "Yes", confident: true, at: 1 },    // 1970 — another week
  });
  assert.equal(Game.confidenceLeft(s), Game.CONFIDENCE_PER_WEEK - 2);
});

// ── daily check-in + bonus points ────────────────────────────────────────────
test("first daily check-in starts a streak and awards the day-1 bonus", () => {
  const s = state();
  const r = Game.dailyCheckin(s);
  assert.equal(r.alreadyCheckedIn, false);
  assert.equal(r.streak, 1);
  assert.equal(r.bonusAwarded, 10);
  assert.equal(s.bonusPoints, 10);
});

test("second check-in the same day is idempotent", () => {
  const s = state();
  Game.dailyCheckin(s);
  const r2 = Game.dailyCheckin(s);
  assert.equal(r2.alreadyCheckedIn, true);
  assert.equal(s.bonusPoints, 10);                    // no double award
});

// ── "made a call today" streak (device-local stickiness) ─────────────────────
test("calling-day streak: starts at 1 and is idempotent within a day", () => {
  const s = state();
  const r1 = Game.recordCallDay(s);
  assert.equal(r1.already, false);
  assert.equal(r1.streak, 1);
  const r2 = Game.recordCallDay(s);
  assert.equal(r2.already, true);
  assert.equal(s.callDays.streak, 1);
});

test("calling-day streak: consecutive days increment, a gap resets", () => {
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const s = state();
  s.callDays = { streak: 4, best: 4, lastDay: day(-1) };      // called yesterday
  assert.equal(Game.recordCallDay(s).streak, 5);              // today → 5 in a row
  const s2 = state();
  s2.callDays = { streak: 6, best: 6, lastDay: day(-3) };     // skipped two days
  const r = Game.recordCallDay(s2);
  assert.equal(r.streak, 1, "gap resets the streak");
  assert.equal(r.best, 6, "best is preserved");
});

// ── best category + prediction personality (profile story) ──────────────────
test("categoryStats finds the best category (min 2 resolved, 1+ win)", () => {
  const s = state(
    {
      pC: { option: "Yes", confident: false, at: 1 },         // space, win
      pD: { option: "Yes", confident: false, at: 2 },         // space, win
      pA: { option: "Yes", confident: false, at: 3 },         // general, miss
    },
    {
      pC: { answer: "Yes", at: 101 },
      pD: { answer: "Yes", at: 102 },
      pA: { answer: "No", at: 103 },
    }
  );
  const cats = Game.categoryStats(s);
  assert.equal(cats.best.category, "space");
  assert.equal(cats.best.accuracy, 100);
  assert.equal(cats.best.total, 2);
});

test("personality stays locked under 10 resolved calls", () => {
  const d = { totalResolved: 9, correct: 9, beatWins: 9, peakStreak: 9, accuracy: 100 };
  assert.equal(Game.personality(d, { best: null }), null);
});

test("personality rules: contrarian, streak hunter, favorite-backer", () => {
  const contrarian = Game.personality(
    { totalResolved: 12, correct: 8, beatWins: 5, peakStreak: 3, accuracy: 66 }, { best: null });
  assert.equal(contrarian.name, "The Contrarian");

  const hunter = Game.personality(
    { totalResolved: 12, correct: 8, beatWins: 0, peakStreak: 6, accuracy: 66 }, { best: null });
  assert.equal(hunter.name, "Streak Hunter");

  const backer = Game.personality(
    { totalResolved: 12, correct: 8, beatWins: 1, peakStreak: 3, accuracy: 66 },
    { best: { category: "music" } });
  assert.equal(backer.name, "Favorite-Backer");

  const cadet = Game.personality(
    { totalResolved: 12, correct: 6, beatWins: 2, peakStreak: 3, accuracy: 50 },
    { best: { category: "space" } });
  assert.equal(cadet.name, "Space Cadet");
});

// ── the crowd % shown in reveals and share cards ─────────────────────────────
test("effectiveCrowd yields the pick % used by reveals/share cards", () => {
  const s = state({ pA: { option: "No", confident: false, at: 1 } });
  const ec = Game.effectiveCrowd(s, DATA.byId.pA);              // 80/20 + own pick
  assert.equal(Math.round(ec.pct[1] * 100), 21);                // "only 21% said No"
  assert.equal(ec.total, 101);
});

test("bonus points flow into total points and reward unlocks", () => {
  const s = state(
    { pC: { option: "Yes", confident: false, at: 1 } },
    { pC: { answer: "Yes", at: 100 } },
    { bonusPoints: 25, daily: { streak: 2, best: 2, lastDay: "2026-01-01" } }
  );
  const d = Game.computeDerived(s);
  assert.equal(d.points, 35);                         // 10 win + 25 daily bonus
  assert.equal(d.peakDaily, 2);
  const unlocked = Game.unlockedRewards(d);
  assert.ok(unlocked.includes("r_pts"));              // 35 ≥ 30-point badge
  assert.ok(unlocked.includes("r_daily"));            // 2-day streak badge
});
