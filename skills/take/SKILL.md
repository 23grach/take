---
name: take
description: Make a demo video of a web app from a plain-text scenario. Plays the steps in the real app at human pace, records frames straight from the browser, and composes a finished 60 fps MP4 with a browser window, cursor and a seamless loop (2560×1440), or just the page at 1920×1080. Use when the user asks for a demo video, product video, screen recording, walkthrough clip or "video of the app doing X", or wants an existing take re-recorded or changed.
---

# Take

You turn the user's scenario into an exact `take.json`, prove every step works with a storyboard, show the user the timeline and wait for them to press Record, then a script records and composes the video. You are never in the loop while recording: everything you decide goes into `take.json`.

The CLI lives in this skill's base directory, the folder that holds this `SKILL.md`: run it as `node <base>/bin/take <command>`. Below, `take` means that.

**Before first use:** if `<base>/node_modules` is missing (a fresh install), run `npm ci --omit=dev` in `<base>` once, then `take doctor`. When `take doctor` reports problems, tell the user in one short list what is missing and what each fix does. Offer to run each fix yourself (Take's own ffmpeg or Chromium download). Give the user the exact command to paste into their own terminal for any fix you can't finish: one that asks for a password (`sudo`) or a new Node from nodejs.org. Run `take doctor` again once they say it's done, and continue with their video.

| Command | Does |
|---|---|
| `take doctor` | Checks Node, the browser (Google Chrome if installed, else Playwright's Chromium), ffmpeg. Run it the first time you use Take in a session, and whenever a command fails for a reason that isn't the take. |
| `take login <url>` | Opens a visible browser window on `<url>` where the user signs in themselves; saves that login when they close the window, under the site's domain (`--name` to choose another). Takes whose target has `"login": "<name>"` then start signed in. |
| `take logout <name>` | Forgets a saved login. |
| `take validate takes/<name>/take.json` | Checks the file's shape and explains every problem. |
| `take probe takes/<name>/take.json` | Plays the take in the app without recording, twice as fast as the video (the opening and closing holds last 0.5 s here; times on the storyboard are rough). `--slow` plays at the video's pace: use it when a step fails only because the app hadn't caught up yet. When every step passes it ends with the timecoded script: each step's start and length in the video, the loop and the total. Writes `probe/step-00.png` + `step-00.outline.yml` (the first screen, before any step), then `step-NN.*` after step NN, `probe.json` and `probe/storyboard.jpg`. A failing step stops it: the reason and that screen's outline are printed, the reason is stored as `error` in `probe.json` and shown in red on the storyboard. The last probe that passed keeps its storyboard as `probe/storyboard.passed.jpg`. A take of only holds also prints the first screen's outline. |
| `take run takes/<name>/take.json` | Records, composes and checks: `out/<name>.mp4`, `out/<name>.check.json`, `out/<name>.contact.jpg`. Exit code 1 if the check fails. If a step or `setup` fails while recording, it saves the screen it stopped on as `failed/screen.png` + `failed/screen.outline.yml` (removed on the next run). |
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

Cookie banners and welcome pop-ups: close them in the take's `setup` steps (done after the page opens, not filmed), so the video doesn't open on them and the loop doesn't return to them. Use `setup` only for getting things out of the way; never film setup steps to reach a state. A signed-in video shows a real account, so look out for personal details on screen (balance, email, phone, account ID) and mention them when asking to record.

### 3. Rehearse

Write `take.json` following [docs/pacing.md](docs/pacing.md), and prove it with `take probe`.

Every turn re-reads the whole conversation, so turns are what a rehearsal costs. Put what doesn't wait on a result into one message: edit `take.json` and run the probe in the same message, and open the storyboard together with whatever you read next. The outline you need is already in the probe's output; open a `step-NN.outline.yml` only for a step that passed when you need the screen it led to (a dialog it opened). Open a single step's picture only when the storyboard is too small to tell.

1. Start with just the opening hold and probe it. The probe prints the first screen's outline (also in `probe/step-00.outline.yml`): the page's roles and names, exactly as targets use them. Names and text longer than 60 characters end in "…"; target them by their start. On a long page it lists only what is on screen, plus every heading. The outline ends with ready `css` targets for what a role and name can't pick: buttons and links with no name (an icon-only close "×", listed only as `- button`), and elements that share a name with others (a "Sign up" button in the header and the footer), each with where it is on screen. Use them as they are; don't write your own scripts to inspect the page. Look at `probe/storyboard.jpg`.
2. Add the steps. Targets on the first screen come from that outline; for screens that only appear later (a dialog a click opens), write your best guess, probe, and correct it from the outline after the step that opened it. Adding the steps one or two at a time works too.
3. If a step fails, the message says which and why, followed by that step's outline: what the page had instead. Fix the target or the wait, and probe again. The driver already waits out the ordinary things (slow loading, elements off screen, a toast passing over a button, a button that enables late, a list that re-renders), so a failure means something real:
   - `can't find …` — the name is wrong, or the element appears only after something you haven't done yet.
   - `the site is showing a bot check instead of the page` — the site decided Take's browser is a robot (often after many visits in a few minutes). Don't click through it or retry in a loop: wait a few minutes and probe once more; if it's still there, tell the user plainly that the site blocks automated browsers.
   - `N elements match … ("A", "B" on screen: { "css": … })` — the names listed are the ones targets match. Add `"exact": true` with the full name, or use the `css` given for the one on screen. When the name holds a number that changes (a tab "Issues (871)" with its count), use the `css`: the count will differ next time.
   - `is covered by …` — something stays on top: a cookie banner or welcome pop-up goes in `setup`; a dialog the story opened needs a step that closes it.
   - `stayed disabled` — a step before it didn't do what the app needs (a required field is still empty).
   - `the app threw an error` / `opening the app: …` — the app itself is broken or not running; tell the user, don't work around it. (Errors from other sites' scripts on the page, like a bot-check widget or an ad, are already ignored.)
   - `⚠ nothing scrolled` / `⚠ the page didn't scroll` under a step — the step passed but may not do what you meant; look at its picture.
   - `⚠ the site refused Take's hidden browser` — Take opened it in a visible window instead, by itself. Tell the user a browser window will appear while you probe and record, and not to click in it or close it.
   - `answered with error 403` even so, or the user says the sign-in captcha keeps coming back or tabs keep flashing in the sign-in window — the site is challenging Take's browser. Do **not** type secrets or solve the captcha yourself. Ask the user to clear the challenge **once** in the `take login` window (they sign in / pass the check, then close it), then probe again with `target.login`. If that still fails after one clear try, say so plainly and stop — don't attach to their everyday Chrome or control their Mac.

Repeat until every step passes. If the same step still fails after three tries, stop and tell the user what you see on the page; don't retry the same take hoping for a different result.

### 4. Approve (the one question)

Every video waits here for the user's yes, even when they asked for it in one message: the scenario is not the approval. Never start `take run` in the same turn as the probe that passed.

Before showing anything, check the storyboard against the first part of [docs/review-checklist.md](docs/review-checklist.md) and fix what you can. Then show the user, in this order:
1. **The timeline** of the video, from the timecoded script at the end of the probe's output, as a table: start, length, and one plain-language line per step (what the viewer sees, not the probe's literal labels), then the loop and the total length.
2. `probe/storyboard.jpg`.
3. The settings you chose (address, loop, size, sound), and anything personal on screen in a signed-in video.

Say they can change any step's length ("make the dialog stay 3 s", "type slower"). Then end your turn with one question, **Record?**, answered by a **Record** button (first) and a **Change timing** button when your host has buttons or a question tool, otherwise as the last line of your message. A new length goes into that step's `"ms"` ([Timing](docs/take-format.md#timing)); probe again and show the new timeline, with the storyboard only if it changed, and ask again. A `⚠ … it can't be under …` means the step can't be that short: tell the user the shortest it can be. Any other change request goes back to step 3. Record only after the user answers Record or says yes in their own words.

### 5. Record

`take run takes/<name>/take.json`. It records in studio mode (exact 60 fps), composes and checks; expect a few seconds of work per second of video. Don't use `--mode live` for a video you deliver: it's a quick draft and stutters on fast animations.

The video carries the page's own sound (click sounds, chimes, a video's soundtrack), each on its frame: Web Audio, `<audio>`/`<video>`/`new Audio()`, and streamed players like YouTube's. Studio mode only; `"sound": false` makes it silent. A sound that doesn't play in the app (a video behind a cookie dialog: close the dialog in `setup`) isn't in the video either. Not caught: speech synthesis, media loaded in a background worker, and a streamed video's sound after it seeks, changes quality or plays an ad. See [Sound](docs/take-format.md#sound).

### 6. Check

Read the report `take run` prints (it ends with the script as recorded: lengths the user set should match) and look at `out/<name>.contact.jpg` against the second part of the review checklist.
- A step failed during recording (the page behaved differently from the probe): look at `failed/screen.png` and its outline, probe again, fix, run again.
- `rehearsal` ⚠: a step looks different from its rehearsal picture. The contact sheet shows the two side by side. Something missing from the video (a panel, a menu, map tiles) means the recording went wrong: run once more, and if it repeats tell the user. Live content that changed is fine.
- A doubled frame (`smoothness` ✗): look at that moment on the contact sheet first. If it's the page's own behaviour (content vanishing in one frame, a picture popping in, a video in the page), recording again gives the same result: deliver and tell the user what it is. Run once more only when it looks like a recording glitch.
- Any other ✗: the report says what and where; fix the take and run again.
- Never patch the video by hand. Every fix goes into `take.json` and is recorded again.

### 7. Deliver

Give the user the MP4 path, its length, and the contact sheet. Say that `scenario.md` and `take.json` stay in the folder, so the video can be changed or re-recorded later by asking. When you record a video again, the one before it stays next to it as `out/<name>.previous.mp4` until the next recording, so the user can compare the two.

Then offer one concrete cut and what it saves, picked from the timeline (for example "the dialog holds 3 s; 1.5 s would make the video 1.5 s shorter"), not a list of options. Skip it when the video has nothing to cut.

## Changing a video later

| The user asks | Do |
|---|---|
| "no loop" / "loop it" | `loop` → `"none"` / `"crossfade-to-start"`, then `take run`. |
| "no sound", "mute it" | `"sound": false`, then `take run`. |
| "no window", "just the page", "plain 1920×1080" | `theme` → `"plain"` and `target.viewport` → `[1920, 1080]`: the page fills a 1920×1080 video, no window or background. The viewport changes the layout, so probe again, then run. |
| "dark mode", "light mode" | `target.appearance` → `"dark"` / `"light"`: the site switches to that mode if it has one, and the window and background match. Left out, they follow the site. The page can look different, so probe again, then run. |
| "on a phone", "mobile version" | `target.device` → `"phone"` and no `viewport`: the iPhone layout in an iPhone on the same 2560×1440 video. Phones have no hover, so tap instead or drop `hover` steps; probe again (the layout changes), then run. |
| "change the address" | `target.address`, then `take compose takes/<name>/capture --address <new>` (no re-record), or `take run`. |
| "show the result longer", "start slower", "pause after X" | Change or add `hold` steps, then probe and run. |
| "shorter", "faster", "too slow" | Cut holds and step lengths as [Length](docs/pacing.md#length) says, then probe, show the new timeline and ask **Record?** again (step 4). |
| "make step 3 last 4 s", "the dialog should stay longer", a new length in the script | `"ms"` on that step, then probe, show the new timeline and ask **Record?** again (step 4). |
| The first frame shows loading placeholders, empty banners or skeletons | Add `ready` to take.json: what the loaded page shows, e.g. `{ "visible": { "role": "button", "name": "Deposit" } }` (a list if several things load separately), then run. |
| "type slower" / "faster" | `cps` on the type step (8 slow, 14 normal, 22 fast). On a phone: 5 slow, 7 normal (the default), 11 fast. |
| "the app changed" / "re-record" | Probe; fix any step that fails; run. |
| The first screen is signed out, or "sign in again" | `take login <url>` (the user signs in), then probe and run. |
| A new step or a different flow | Edit the scenario, then rehearse from step 3. |

## Not supported yet

Multi-finger gestures; setup before the video starts other than signing in and closing things in `setup` (no filling in forms or choosing settings off camera); video sizes other than 2560×1440 (window or phone) and 1920×1080 (`plain`, just the page); tablets, and phones in the `plain` theme. Animations inside pages embedded from other sites (players, maps, widgets in an iframe from another address) run on real time while a final video records, so they play several times too fast in it; a `--mode live` draft shows them at the right speed. Videos in the page itself (`<video>`) play at their true speed; recording takes longer while one is on screen. Say so plainly when a scenario needs them, and offer the closest version that works.

Never change Take itself (anything in `<base>`: its code, docs, plan or themes) to get a video done, even when a fix looks small. Work only in the user's project. When Take can't do something, say what is missing; the user decides whether Take should learn it.
