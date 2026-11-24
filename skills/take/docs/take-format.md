# take.json (version 0)

A take is the exact list of steps a recording replays. The agent writes it while rehearsing a scenario; a script performs it. Check one with `take validate path/to/take.json`.

```json
{
  "version": 0,
  "title": "Create a project",
  "target": { "kind": "web", "url": "http://127.0.0.1:4300/", "viewport": [1440, 900], "scale": 1.5 },
  "theme": "default",
  "steps": [
    { "do": "hold", "ms": 1000, "mark": "start" },
    { "do": "click", "target": { "role": "button", "name": "New project" },
      "waitFor": { "visible": { "role": "dialog", "name": "New project" } } },
    { "do": "type", "target": { "label": "Name" }, "text": "Moodboard", "cps": 14 },
    { "do": "click", "target": { "role": "button", "name": "Create", "exact": true },
      "waitFor": { "visible": { "role": "heading", "name": "Moodboard" } } },
    { "do": "hold", "ms": 2000, "mark": "result" }
  ],
  "loop": "crossfade-to-start"
}
```

## Top level

| Field | Required | Default | Meaning |
|---|---|---|---|
| `version` | yes | | Always `0` for now. |
| `title` | yes | | Name of the demo. |
| `target.kind` | yes | | `"web"`, the only kind. |
| `target.url` | yes | | Page the take starts on, `http://` or `https://`. |
| `target.device` | | `"desktop"` | `"desktop"`: a browser window with a cursor. `"phone"`: the site's iPhone layout in an iPhone in the middle of the same 2560×1440 video, with a finger instead of the cursor: taps, drags, and scrolls as swipes that glide on after the finger lifts. A phone's page is always 402×820 (no `viewport`), the screen below the status bar; the page's own content runs on under Safari's bar, as in iOS Safari. Elements pinned to the bottom (`position: fixed` or `sticky` with `bottom` set, like toasts and bottom navs) sit 82 pt higher, just above Safari's bar, as Safari lays them out; full-height overlays stay put. At the end of a page that scrolls, the page can scroll on until its last content sits 8 pt above Safari's bar, and the bar opens again, as in Safari. The status bar shows what the page would show there in Safari: the page's top colour at rest, content that has scrolled up past it (softly blurred at the very top), or the colour of a header pinned to the top. It has no hover (`hover` steps are errors). Safari's bar at the bottom shows only the domain of the page's address (as iOS Safari does), so it changes only when a step opens another site, and shrinks to a smaller pill while the page scrolls down; typing brings up the iOS keyboard, which slides the page up so the field stays above it. |
| `target.address` | | the URL's domain, or blank for a local URL | What the window's address bar shows, e.g. `"boards.app"` or `"boards.app/projects"`. It's what the first page shows. When a step opens another page, the bar follows it, as a browser does: on the same site it keeps this domain and shows the new path (`"boards.app"` → `boards.app/projects/42`), on another site it shows that site's address; a change only in `#…` or `?…` keeps it. The loop brings the first address back halfway through. Use the product's real domain: the app usually runs on `localhost` while recording, and that address is never shown. Ask the agent to change it any time; it only affects composing, not recording. |
| `target.appearance` | | none: follows the site | `"light"` or `"dark"`. The browser asks the site for that mode (as a computer set to light or dark would), and the window and background match: a light window on #f2f2f2 or a dark window on #181b25. Left out, the site opens as it normally does and the window follows what the opening frame shows, so a site that's dark by design gets the dark window. A site without its own dark mode stays light, but `"dark"` still puts it in the dark window. |
| `target.login` | | none: starts signed out | The name of a saved login, e.g. `"boards.app"`: the take starts signed in. See [Saved logins](#saved-logins). |
| `target.viewport` | | `[1440, 900]` | Desktop page size in CSS pixels. With the `default` theme the video is 2560×1440; with `plain`, use `[1920, 1080]` so the page fills the video. |
| `target.scale` | | `1.5` | How sharp the recorded frames are. The video shows the page at about 1.35× its size, so `1.5` is sharp and records about a quarter faster than `2`. `2` for the crispest small text; `1` for quick drafts. |
| `theme` | | `"default"` | Folder in `themes/`. `"default"`: the page in a browser window on a soft background (light or dark, see `target.appearance`), 2560×1440. `"plain"`: just the page, 1920×1080, no window or background. |
| `ready` | | none | A condition (like `waitFor`), or a list of them, that must all hold before filming starts, checked after `setup` (so a consent page closed in `setup` can't hold it up), e.g. `{ "visible": { "role": "button", "name": "Deposit" } }`. The page loads in the meantime and none of it is filmed, so the video opens on a finished page instead of loading placeholders. Pictures that are downloading finish first, then fades get 0.5 s. Up to 30 s; then the take stops and says which condition never showed. |
| `setup` | | none | Steps done after the page opens, before `ready` is checked and filming starts, written like `steps`: closing a cookie banner or a welcome pop-up, e.g. `[{ "do": "click", "target": { "role": "button", "name": "Reject all" } }]`. None of it is filmed and the page gets 0.6 s to settle after, so the video opens on the page without them. A failure says `setup step N`. Only for getting things out of the way; anything the viewer should see belongs in `steps`. |
| `steps` | yes | | At least one step, performed in order. |
| `loop` | | `"crossfade-to-start"` | How the video ends. `"crossfade-to-start"`: the last frame dissolves back into the first (0.67 s) and the cursor glides home, so the video loops seamlessly. `"none"`: the video simply ends on the last frame, for videos that play once (a talk, a page that doesn't autoplay in a loop). Ask the agent "no loop" / "don't go back to the start". |
| `sound` | | `true` | The page's own sound in the final video: click sounds, chimes, a video's soundtrack, each on the frame it was made on. `false`: a silent video, and nothing is caught. See [Sound](#sound). |

## Steps

Every step has `do`. Any step may also have `mark` (a unique name for that moment, e.g. `"result"`), `waitFor` (a condition to wait for after the step) and `ms` (how long the step lasts, see [Timing](#timing)).

| `do` | Fields | What happens |
|---|---|---|
| `click` | `target`, `clicks`? | The cursor travels to the element and clicks it. No separate hover step is needed. `"clicks": 2` double-clicks (selects a word, opens an item), `3` triple-clicks (selects a line or paragraph). A radio or checkbox hidden under its own label is clicked through the label, as a person would. `target` may also be a point `[x, y]` (as in `drag`) for things no target names, like an icon that only shows on hover: hover the row first, read the point off that step's picture. |
| `hover` | `target` | The cursor travels to the element (or a point `[x, y]`) and rests there (to show a tooltip or hover state). |
| `drag` | `from`, `to` | The cursor travels to `from`, presses, moves to `to` with the button held, and lets go: draws a shape, moves a slider, drops a card in a column. Each end is a [target](#targets) (`from` just below and right of its middle, like a click; `to` its middle) or a point `[x, y]` in CSS pixels from the page's top left, e.g. `[540, 330]`, for places no element names, like a spot on a drawing canvas. |
| `type` | `text`, `target`?, `cps`? = 14 (7 on a phone) | Clicks the field if `target` is given, then types character by character at `cps` characters per second. Without `target`, types into whatever has focus. Give `cps` or `ms`, not both: with `ms` the typing speed follows from the length (between 5 and 40 characters per second; any time left over is a pause after). |
| `press` | `key` | A single key, e.g. `"Enter"`, `"Escape"`, `"Meta+A"`. The browser's key names: `Meta` (⌘), `Control`, `Alt` (⌥), `Shift`, `ArrowUp`…; join keys with `+`. `take validate` flags others (`Cmd`, `Esc`) and names the right one. With `Meta`, `Control` or `Alt` held a letter is sent lowercase, as a real keyboard does, so `"Meta+K"` opens a ⌘K search; add `Shift` for a capital. |
| `scroll` | `target` or `by: [x, y]` | Scrolls an element into view, or by a distance in pixels. An element already on screen isn't scrolled to, and the probe says so (`⚠ nothing scrolled`); use `by` to move the page anyway. A `by` scroll goes to whatever is under the cursor, so it also zooms a map or scrolls a list there; the probe notes when the page itself didn't move. |
| `wait` | `for`, `timeout`? = 10000, `film`? | Waits for a condition. The take fails if it isn't met within `timeout` ms. With `"film": false` the page keeps running but nothing is filmed until the condition holds, and the step before it gets no pause after it: the video cuts straight from that step to what the page shows next. For something the viewer shouldn't sit through, like a video ad before the real video. Final videos only; a `--mode live` draft films the wait. |
| `hold` | `ms` | Nothing happens for `ms` milliseconds, so the viewer can take it in. |
| `appearance` | `to` | The computer switches to `"light"` or `"dark"` mode, as if the person changed it in system settings: a site that follows the system mode changes, with its own animation if it has one. The window and background fade to the new mode over 0.7 s. The cursor doesn't move. Give the step an `ms` long enough for the site's animation, e.g. `2500`. The video starts in `target.appearance` (set it, so the start is certain); the loop fades back to it. Desktop only, and not in `setup`. |

How the cursor moves, and the pauses between steps, are decided by the driver, not written into the take, unless a step is given a length. A desktop take with no `click`, `hover`, `drag`, `scroll` or `type` into a target never uses the pointer, so its video shows no cursor at all.

## Timing

`take probe` ends with the timecoded script: when each step starts in the video and how long it lasts, the loop back to the start, and the total. `take run` prints it again as recorded.

```
Script: "Create a project", 10.12 s (from the rehearsal: steps that wait for the app may come out a little different)
   #  start      length  step
   1  0:00.00   2.00 s*  Hold 2 s [start]
   2  0:02.00   1.40 s   Click button "New project", then wait for dialog "New project" to show
   3  0:03.40   2.13 s   Type "Moodboard" into field labelled "Name"
   4  0:05.53   1.92 s   Click button "Create", then wait for heading "Moodboard" to show
   5  0:07.45   2.00 s*  Hold 2 s [result]
      0:09.45   0.67 s   Back to the start (loop)
      0:10.12            End
```

A step's length runs from its start to the start of the next step. Without `ms` it's as long as the action takes (the cursor's travel, the typing, waiting for the app) plus a 0.45 s pause. With `"ms": 3000` the step lasts exactly 3 s: the action plays at its usual pace and the pause after it fills the rest, so the viewer sees the result longer. A `type` step fills it with slower or faster typing instead, and a `scroll` step with one slower scroll (a 2500 px scroll with `"ms": 6000` glides for about 5.5 s); `ms` never makes a scroll faster than its usual pace. A hold's `ms` is its length already. A length shorter than the action needs can't be met: the step runs at its usual pace with no pause after, and the probe says how short it can be (`⚠ … it can't be under 1.20 s`).

Lengths marked `*` are set in the take. Rehearsals play twice as fast, so a step that waits for the app is an estimate there, usually within a few hundredths of a second; set lengths come out exact.

## Targets

How to find an element. Give exactly one way, and prefer them in this order, since they survive redesigns best:

| Target | Finds | Example |
|---|---|---|
| `role` + `name`? | an element by what it is and its accessible name | `{ "role": "button", "name": "Create" }` |
| `label` | a form field by its label | `{ "label": "Name" }` |
| `text` | an element by its visible text | `{ "text": "Pricing page" }` |
| `placeholder` | a field by its placeholder | `{ "placeholder": "e.g. Moodboard" }` |
| `css` | a CSS selector: last resort | `{ "css": "#projects > li:first-child" }` |

Names and text match as a case-insensitive substring by default; add `"exact": true` to match the whole string exactly (above, so that "Create" doesn't also match "Create project"). A target must match exactly one element when the step runs.

## Conditions

Used by `waitFor` and `wait.for`. Exactly one of:

- `{ "text": "Saved" }`: this text is on the page.
- `{ "visible": target }`: this element is showing.
- `{ "hidden": target }`: this element is gone or hidden.

## Sound

A final video (studio mode) carries the sounds the page itself makes, landing on the frames they belong to: a click sound on the click, a chime when a notification arrives, a video playing in the page. Drafts (`--mode live`) and probes are silent. A page that makes no sound gives a video with no sound track. Take catches:
- sounds a page makes with the browser's audio engine (Web Audio), as most click and notification sounds are made;
- `<audio>` and `<video>` elements and `new Audio(…)`, from their files (fetched with the take's login, if it has one);
- streamed players such as YouTube's, from the data the player loads.

Things that keep a sound from playing keep it out of the video too: a video behind a cookie dialog never starts, so close the dialog in `setup`. With the loop, the sound fades out as the picture crossfades back to the start. Each sound engine a page starts is caught for up to 3 minutes; past that Take says so.

Not caught: speech the browser reads aloud (speech synthesis), players that load their media in a background worker, and live streams from a camera or a call. A streamed video that seeks, changes quality or plays an ad may have its sound out of place after that moment.

## Saved logins

`take login https://boards.app` opens a browser window on that page. You sign in there as you normally would (Take never sees or types your password), then close the window. Take saves that browser's login (cookies, local storage, IndexedDB and the browser's user agent) as `~/.take/logins/boards.app.json`: outside the project, readable only by you, so it never lands in git or in a shared `takes/` folder. `--name` saves it under another name, for a second account on the same site.

A take with `"login": "boards.app"` in its target then starts every probe and recording signed in. When the login expires, the first screen shows the app signed out: run `take login` again and it refreshes. `take logout boards.app` forgets a login. Sites with bot protection may show a captcha in the sign-in window: clear it yourself in that window, then close it so Take can save the login — Take never types your password or solves the captcha for you. Logins that live only in session storage aren't saved yet, and Google's own sign-in page may still refuse the window.

## Validation

`take validate` reports every problem at once, each with where it is, and suggests a fix for likely typos:

```
✗ take.json: 3 problems
  steps[1].taget: unknown field (did you mean "target"?)
  steps[1]: missing "target" (what to click)
  steps[3].do: unknown action "clik" (did you mean "click"?); use one of click, hover, drag, type, press, scroll, wait, hold
```

It checks the shape of the take only. Whether each target exists in the app is checked by running the take (`take probe`).
