---
name: take
description: Make a demo video of a web app from a plain-text scenario. Plays the steps in the real app at human pace, records frames straight from the browser, and composes a finished 60 fps MP4 with a browser window, cursor, click ripples and a seamless loop (2560×1440). Use when the user asks for a demo video, product video, screen recording, walkthrough clip or "video of the app doing X", or wants an existing take re-recorded or changed.
---

# Take

You turn the user's scenario into an exact `take.json`, prove every step works with a storyboard, get one approval, then a script records and composes the video. You are never in the loop while recording: everything you decide goes into `take.json`.

The CLI lives in this skill's base directory, the folder that holds this `SKILL.md`: run it as `node <base>/bin/take <command>`. Below, `take` means that.

**Before first use:** if `<base>/node_modules` is missing (a fresh install), run `npm ci --omit=dev` in `<base>` once, then `take doctor`.

| Command | Does |
|---|---|
| `take doctor` | Checks Node, the browser (Google Chrome if installed, else Playwright's Chromium), ffmpeg. Run it the first time you use Take in a session, and whenever a command fails for a reason that isn't the take. |
| `take login <url>` | Opens a visible browser window on `<url>` where the user signs in themselves; saves that login when they close the window, under the site's domain (`--name` to choose another). Takes whose target has `"login": "<name>"` then start signed in. |
| `take logout <name>` | Forgets a saved login. |
| `take validate takes/<name>/take.json` | Checks the file's shape and explains every problem. |
| `take probe takes/<name>/take.json` | Plays the take in the app without recording (the opening and closing holds last 0.5 s here, so times on the storyboard run a little short of the video's). Writes `probe/step-00.png` + `step-00.outline.yml` (the first screen, before any step), then `step-NN.*` after step NN, `probe.json` and `probe/storyboard.jpg`. A failing step stops it: the reason is printed, stored as `error` in `probe.json` and shown in red on the storyboard. |
| `take run takes/<name>/take.json` | Records, composes and checks: `out/<name>.mp4`, `out/<name>.check.json`, `out/<name>.contact.jpg`. Exit code 1 if the check fails. |
| `take compose takes/<name>/capture --address …` | Re-composes without re-recording (address, theme). |

Reference, read when you need it: [docs/scenario-format.md](docs/scenario-format.md) (what the user writes), [docs/take-format.md](docs/take-format.md) (what you write), [docs/pacing.md](docs/pacing.md) (how to turn one into the other), [docs/review-checklist.md](docs/review-checklist.md) (what to look for before showing anything).

## Workflow

Work in the user's project. Each video gets a folder `takes/<name>/` (`<name>` from the title, lowercase with dashes) holding `scenario.md` and `take.json`; the CLI adds `probe/`, `capture/` and `out/`. If the project is a git repository, offer once, when you deliver, to add `takes/*/probe/`, `takes/*/capture*/` and `takes/*/out/` to `.gitignore` (the scenario and take are worth keeping in git; the rest is generated).

### 1. Intake

Get the scenario: a file the user points to, or their words in chat, which you write into `takes/<name>/scenario.md` in the [scenario format](docs/scenario-format.md). It needs a title, the app and the steps. Fill the rest from defaults. Ask once, in one message, only for what you can't find out yourself:
- the app's URL, if it isn't running and you can't tell from the project (`package.json` scripts, a dev server you can start);
- the address to show in the window, when the app runs locally and the scenario gives none (suggest the product's real domain);
- anything in the steps you can't map to the app after looking at it.

### 2. Prepare

Make sure the app answers at its URL. If it doesn't, start it the way the scenario or the project says (in the background) and wait until it answers. The video starts on that URL in a fresh browser: no cookies, empty local storage, signed out, unless the take names a saved login.

`Before:` in the scenario describes the state the video starts in. Take can reach states the start URL gives (a route, a query parameter, seeded demo data the app loads itself) and a signed-in account:
- **Signed in.** Set `target.login` to the site's domain (e.g. `"boards.app"`). If `take validate` says there's no saved login yet, or the first screen shows the app signed out (the login expired), get a login one of two ways. If the user says they're signed in to the site in their own Google Chrome, run `take login <url> --from-chrome` in the background and tell them, in one message, to click **Allow** when Chrome asks to "allow remote debugging" (Chrome's name for this connection; Take only reads that site's login and disconnects) (Chrome asks on every run; the first time they also turn on remote debugging at chrome://inspect/#remote-debugging, and on a Mac the app running you needs Full Disk Access; the command's error says which is missing). It copies only that site's cookies. Otherwise run `take login <url>` in the background and tell the user, in one message, that a browser window has opened where they sign in themselves and then close it. Never type a password, a code or any other secret yourself, and never read or print the saved login file. When the command finishes, probe again.
- Anything more (a particular record, a setting on): say what is missing and how the user could provide it (a demo mode, a seed script, a URL that opens that state).

Never film setup steps to get there. A signed-in video shows a real account, so look out for personal details on screen (balance, email, phone, account ID) and mention them when asking to record.

### 3. Rehearse

Write `take.json` following [docs/pacing.md](docs/pacing.md), and prove it with `take probe`:
1. Start with just the opening hold and probe it. Read `probe/step-00.outline.yml` (the first screen): the page's roles and names, exactly as targets use them. Look at `probe/storyboard.jpg`.
2. Add the steps. Targets on the first screen come from that outline; for screens that only appear later (a dialog a click opens), write your best guess, probe, and correct it from the outline after the step that opened it. Adding the steps one or two at a time works too.
3. If a step fails, the message says which and why, and that step's outline shows what the page had instead. Fix the target or the wait, and probe again. The driver already waits out the ordinary things (slow loading, elements off screen, a toast passing over a button, a button that enables late, a list that re-renders), so a failure means something real:
   - `can't find …` — the name is wrong, or the element appears only after something you haven't done yet.
   - `N elements match … ("A", "B")` — add `"exact": true`, or pick a role and name that's unique.
   - `is covered by …` — something stays on top (a cookie banner, a dialog): close it with a step first, or find a start URL without it.
   - `stayed disabled` — a step before it didn't do what the app needs (a required field is still empty).
   - `the app threw an error` / `opening the app: …` — the app itself is broken or not running; tell the user, don't work around it.
   - `⚠ the site refused Take's hidden browser` — Take opened it in a visible window instead, by itself. Tell the user a browser window will appear while you probe and record, and not to click in it or close it.
   - `answered with error 403` even so, or the user says the sign-in captcha keeps coming back or tabs keep flashing in the sign-in window — the site is challenging Take's browser. Do **not** type secrets or solve the captcha yourself. Ask the user to clear the challenge **once** in the `take login` window (they sign in / pass the check, then close it), then probe again with `target.login`. If that still fails after one clear try, say so plainly and stop — don't attach to their everyday Chrome or control their Mac.

Repeat until every step passes. If the same step still fails after three tries, stop and tell the user what you see on the page.

### 4. Approve (the one question)

Before showing anything, check the storyboard against the first part of [docs/review-checklist.md](docs/review-checklist.md) and fix what you can. Then show the user `probe/storyboard.jpg` with one plain-language line per step (what the viewer sees, not the storyboard's literal labels) and the settings you chose (address, loop, size, rough length), and ask one question: record it? Change requests go back to step 3. Don't record before the user says yes.

### 5. Record

`take run takes/<name>/take.json`. It records in studio mode (exact 60 fps), composes and checks; expect a few seconds of work per second of video. Don't use `--mode live` for a video you deliver: it's a quick draft and stutters on fast animations.

### 6. Check

Read the report `take run` prints and look at `out/<name>.contact.jpg` against the second part of the review checklist.
- A step failed during recording (the page behaved differently from the probe): probe again, fix, run again.
- A check failed: the report says what and where. A doubled frame in studio mode means something on the page jumped; look at that moment on the contact sheet. Run once more; if it repeats, tell the user what it is.
- Never patch the video by hand. Every fix goes into `take.json` and is recorded again.

### 7. Deliver

Give the user the MP4 path, its length, and the contact sheet. Say that `scenario.md` and `take.json` stay in the folder, so the video can be changed or re-recorded later by asking.

## Changing a video later

| The user asks | Do |
|---|---|
| "no loop" / "loop it" | `loop` → `"none"` / `"crossfade-to-start"`, then `take run`. |
| "change the address" | `target.address`, then `take compose takes/<name>/capture --address <new>` (no re-record), or `take run`. |
| "show the result longer", "start slower", "pause after X" | Change or add `hold` steps, then probe and run. |
| The first frame shows loading placeholders, empty banners or skeletons | Add `ready` to take.json: what the loaded page shows, e.g. `{ "visible": { "role": "button", "name": "Deposit" } }` (a list if several things load separately), then run. |
| "type slower" / "faster" | `cps` on the type step (8 slow, 14 normal, 22 fast). |
| "the app changed" / "re-record" | Probe; fix any step that fails; run. |
| The first screen is signed out, or "sign in again" | `take login <url>` (the user signs in), then probe and run. |
| A new step or a different flow | Edit the scenario, then rehearse from step 3. |

## Not supported yet

Multi-finger gestures; setup before the video starts other than signing in; video sizes other than 2560×1440; phone frames. Videos playing inside the page (`<video>`, embedded players) and animations inside pages embedded from other sites run on real time while a final video records, so they play several times too fast in it; a `--mode live` draft shows them at the right speed. Say so plainly when a scenario needs them, and offer the closest version that works.

Never change Take itself (anything in `<base>`: its code, docs, plan or themes) to get a video done, even when a fix looks small. Work only in the user's project. When Take can't do something, say what is missing; the user decides whether Take should learn it.
