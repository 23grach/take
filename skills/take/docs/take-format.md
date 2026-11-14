# take.json (version 0)

A take is the exact list of steps a recording replays. The agent writes it while rehearsing a scenario; a script performs it. Check one with `take validate path/to/take.json`.

```json
{
  "version": 0,
  "title": "Create a project",
  "target": { "kind": "web", "url": "http://127.0.0.1:4300/", "viewport": [1440, 900], "scale": 2 },
  "theme": "default",
  "steps": [
    { "do": "hold", "ms": 2000, "mark": "start" },
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
| `target.address` | | the URL's domain, or blank for a local URL | What the window's address bar shows, e.g. `"boards.app"` or `"boards.app/projects"`. Use the product's real domain: the app usually runs on `localhost` while recording, and that address is never shown. Ask the agent to change it any time; it only affects composing, not recording. |
| `target.login` | | none: starts signed out | The name of a saved login, e.g. `"boards.app"`: the take starts signed in. See [Saved logins](#saved-logins). |
| `target.viewport` | | `[1440, 900]` | Page size in CSS pixels. The video is always 2560×1440. |
| `target.scale` | | `2` | `2` records retina-sharp frames; `1` for quick drafts. |
| `theme` | | `"default"` | Folder in `themes/`. |
| `ready` | | none | A condition (like `waitFor`), or a list of them, that must all hold before filming starts, e.g. `{ "visible": { "role": "button", "name": "Deposit" } }`. The page loads in the meantime and none of it is filmed, so the video opens on a finished page instead of loading placeholders. Pictures that are downloading finish first, then fades get 0.5 s. Up to 30 s; then the take stops and says which condition never showed. |
| `steps` | yes | | At least one step, performed in order. |
| `loop` | | `"crossfade-to-start"` | How the video ends. `"crossfade-to-start"`: the last frame dissolves back into the first (0.67 s) and the cursor glides home, so the video loops seamlessly. `"none"`: the video simply ends on the last frame, for videos that play once (a talk, a page that doesn't autoplay in a loop). Ask the agent "no loop" / "don't go back to the start". |

## Steps

Every step has `do`. Any step may also have `mark` (a unique name for that moment, e.g. `"result"`) and `waitFor` (a condition to wait for after the step).

| `do` | Fields | What happens |
|---|---|---|
| `click` | `target` | The cursor travels to the element and clicks it. No separate hover step is needed. |
| `hover` | `target` | The cursor travels to the element and rests there (to show a tooltip or hover state). |
| `drag` | `from`, `to` | The cursor travels to `from`, presses, moves to `to` with the button held, and lets go: draws a shape, moves a slider, drops a card in a column. Each end is a [target](#targets) (its middle) or a point `[x, y]` in CSS pixels from the page's top left, e.g. `[540, 330]`, for places no element names, like a spot on a drawing canvas. |
| `type` | `text`, `target`?, `cps`? = 14 | Clicks the field if `target` is given, then types character by character at `cps` characters per second. Without `target`, types into whatever has focus. |
| `press` | `key` | A single key, e.g. `"Enter"`, `"Escape"`, `"Meta+A"`. |
| `scroll` | `target` or `by: [x, y]` | Scrolls an element into view, or by a distance in pixels. |
| `wait` | `for`, `timeout`? = 10000 | Waits for a condition. The take fails if it isn't met within `timeout` ms. |
| `hold` | `ms` | Nothing happens for `ms` milliseconds, so the viewer can take it in. |

How the cursor moves, and the pauses between steps, are decided by the driver, not written into the take.

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
