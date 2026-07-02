# Privacy Policy — Called It

_Last updated: 2026-07-01. Plain-language summary of what the app does and doesn't collect._

## Who this is for
Called It is a free, for-fun game open to **everyone**. Content is kept family-friendly.

## Two ways to play

### Guest mode (default)
**Nothing personal is collected and nothing leaves your device.** Your picks,
points, streaks, rank, and cosmetics are saved **only in your own browser**
(localStorage). Clearing your browser data resets guest progress.

### Optional account
Accounts exist only so your progress can follow you and you can appear on the
live leaderboard. If you create one, the server stores **exactly**:

- a **username you choose** (filtered for appropriateness — don't put personal
  information in it),
- a **securely hashed password** (scrypt; the actual password is never stored
  and never logged),
- your **picks** (which option you chose on which prediction, and when),
- your **daily check-in streak and bonus points**.

That's the complete list. **No email, no name, no phone, no birthday, no
location, no device IDs, no analytics, no advertising, no third-party
trackers.** Because there is no email, there is no password reset — keep your
password safe.

## Cookies
One cookie, only when you sign in: an httpOnly session cookie that keeps you
signed in. It contains a random identifier — nothing about you — and is not
used for tracking. Signing out deletes it.

## Leaderboard
The live leaderboard shows only **username, score, streaks, and accuracy** of
players with accounts. When the backend is unreachable, the app shows clearly
labeled demo rivals instead.

## No contact between users
There is **no chat, no messaging, and no user-to-user contact**. The only
user-written text anywhere is usernames, which are filtered.

## The AI pipeline
Daily predictions are AI-generated **on a schedule, on the server** and pass a
safety filter before anyone sees them. Prompts contain **no user data** — the
AI never sees who you are or what you picked. The AI provider's API key never
reaches your browser.

## Security
- The site is served over **HTTPS**; session cookies are httpOnly and strict
  same-site.
- Passwords are hashed with **scrypt** (a memory-hard algorithm designed for
  password storage); session tokens are stored only as hashes.
- All server input is validated; login attempts are rate-limited.

## Your control
- **Guest data:** use the in-app reset or clear your browser's site data.
- **Account data:** contact the project owner to delete your account and all
  of its data (username, password hash, picks).

## Contact
This is a personal / open-source project. Questions: the project owner.
