# docs/ — README media

The three PNGs here are **generated placeholders** (each is stamped
"placeholder — replace with a real screenshot"). Replace them with real
captures, keeping the same filenames so the main README links keep working:

| File | What to capture |
|---|---|
| `feed.png` | The **Feed** view showing 2–3 cards with the green/red crowd-belief bars (a Space & NASA card first looks great for Stardance) |
| `locked-in.png` | A card **after tapping an option** — the highlighted pick + "Locked in · awaiting result" chip (Picks view also works) |
| `celebration.png` | The **"YOU CALLED IT!"** overlay mid-confetti — resolve one of your picks via the dev panel (tap the footer 5× or press Ctrl/Cmd+Shift+D, then choose your picked option) |
| `demo.gif` *(optional)* | 5–10s of the core loop: tap option → locked-in toast → resolve in dev panel → confetti + points update |

## How to capture

1. Open `index.html` (or `npm start` in `server/` and visit `localhost:3000`).
2. In a Chromium browser: DevTools → device toolbar → **iPhone 14 Pro-ish
   (~390×844)** for clean phone-shaped shots.
3. Screenshot the viewport only (DevTools → ⋮ → "Capture screenshot").
4. For the GIF: record with QuickTime/Kap and convert, or use Kap's GIF export
   directly. Keep it under ~5 MB so the README loads fast.
5. If you add `demo.gif`, un-comment its line in the main README.
