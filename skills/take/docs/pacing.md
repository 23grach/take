# Pacing: from scenario to take.json

Rules for writing `take.json` ([take-format.md](take-format.md)) from a scenario ([scenario-format.md](scenario-format.md)). The driver already moves the cursor like a person (eased travel, a slight arc, a pause on the target, 0.45 s between steps, and a stop just below and right of a control's middle so the hand never covers its label), so the take only says *what* happens and *what to wait for*.

## Settings

| Scenario | take.json |
|---|---|
| `Title: Create a project` | `"title": "Create a project"`; folder `takes/create-project/` |
| `App: http://localhost:3000` | `target.url` |
| `Address: boards.app` | `target.address`. Local app and no address: ask the user once. |
| `Size: desktop` (default) | `viewport: [1440, 900]`, `scale: 1.5` |
| `Loop: yes` (default) / `no` | `"loop": "crossfade-to-start"` / `"none"` |
| `Theme:` | `"theme"`; default `"default"` |

## Shape of every take

```json
"steps": [
  { "do": "hold", "ms": 1000, "mark": "start" },
  …the scenario's steps…,
  { "do": "hold", "ms": 2000, "mark": "result" }
]
```

- **1 s opening hold** on the first screen, marked `start`, and a **2 s closing hold** on the result, marked `result`. Always, unless the user asks otherwise. The scenario never mentions them. The opening is short on purpose: a video scrolling past in a feed has to show something happening within its first second.
- No other holds, except a scenario `Pause`.

## Steps

| Scenario | Step |
|---|---|
| `Click "New project"` | `click` on its target |
| `Hover "Share"` | `hover` (only to show a hover state or tooltip; never before a click, the click already travels there) |
| `Type "Moodboard" into Name` | `type` with `target` (it clicks the field itself; no separate click) |
| `Press Enter`, `Cmd+K` | `press` with Playwright key names: `Enter`, `Escape`, `Meta+K` |
| `Scroll to "Pricing"` / `Scroll down` | `scroll` with `target` / `by: [0, 600]` |
| `Drag "Card" to "Done"`, `move the slider to 50%`, `draw a box` | `drag` with `from` and `to`. Use targets where elements have names; use points `[x, y]` for spots on a canvas or along a slider. Points are page pixels: read them off the probe's screenshots (`probe/step-NN.png` is the page at its viewport size, 1440×900 by default), and draw in empty space well clear of toolbars. A drawing tool is picked first with a `click`. |
| `"Saved" appears`, `the new card appears` | `waitFor` on the step before it (preferred), or a `wait` step if nothing triggers it directly |
| `Pause 1 s`, `show it for 2 s` | `hold` |
| `Lock the middle colour` (an icon that only appears on hover, with no name) | `hover` the column, probe, read the icon's point off that step's picture, then `click` with `"target": [x, y]`. |
| `Select the word "started"` (in text or a code editor) | `click` the word with `"clicks": 2`; then `type` replaces it. A triple-click (`3`) selects the whole line. |
| `Change Name to "Moodboard"` (a field that already has text) | `click` the field, `press` `Meta+A` (select all), then `type` without a target: typing replaces the selection. A `type` with a target adds to what's there. |
| `slowly` / `quickly` on typing | `cps` 8 / 22 (normal 14). On a phone, typing is thumbs on glass: 5 / 11 (normal 7, the default when a phone's `type` step gives no `cps`) |
| `show the dialog for 3 s`, `this step takes 2 s`, a length the user changed in the script | `"ms"` on that step: it lasts exactly that long, the pause after it fills the rest ([Timing](take-format.md#timing)) |

**Toasts at the end.** The app's own confirmation toast during the closing hold is good: it says what happened. But if it's still showing when the closing hold ends, the loop fades it into the first screen. Then add `{ "do": "wait", "for": { "hidden": <the toast> } }` before the closing hold, so the result is shown clean for the full 2 s.

**Wait after anything that changes the page.** A click that opens a dialog, saves, navigates or loads gets a `waitFor` on what appears (the dialog, the toast, the new heading). Then the video always waits for the app at its own speed, never cuts into a half-finished transition, and a probe that clicked the wrong thing fails right there instead of three steps later.

## Targets

Pick from the page outline `take probe` writes after each step (`probe/step-NN.outline.yml`), in this order:

1. `role` + `name`: `{ "role": "button", "name": "New project" }`. Names as the outline shows them.
2. `label` for form fields: `{ "label": "Name" }`.
3. `placeholder`, when a field has no label.
4. `text`, for things that aren't controls (a card title, a menu item without a role).
5. `css` only as a last resort; it breaks when the app's code changes. When the outline itself offers one (at its end: elements with no name, or several with the same name), use that.

Add `"exact": true` when the name is part of another name on the page (`Create` vs `Create project`, `Save` vs `Save as…`). A target must match exactly one visible element; the probe says when it doesn't. A name can hold text the screen doesn't show, for screen readers (a tab showing "Issues 871" can be named `Issues (871)`): the outline shows the name to use. Avoid names with live counts; target those by `css`.

## Length

Aim for 3–7 scenario steps and 8–20 s of video. If a scenario is much longer, suggest splitting it into two videos before rehearsing.

When the user wants it shorter:
- "Shorter" with no number: cut the holds and `"ms"` lengths that run past the action by 25–50%. Pauses almost always end up shorter than the first draft, never longer.
- Cut pauses, never steps: a step the scenario asks for stays, however short the video gets.
- Keep the 2 s closing hold for last: it's where the viewer reads the result.
