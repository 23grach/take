# Review checklist

What the agent checks itself before showing anything to the user. Fix what can be fixed in `take.json`; mention what can't.

## 1. Storyboard (before asking to record)

Open `probe/storyboard.jpg`.

- **Each picture shows what its scenario step says.** The dialog is open after "Click New project"; the typed text is in the field; the result is visible after the last step.
- **The outlines sit on the right things.** Blue on the element acted on, dashed green on what was waited for. An outline on a different button means the target matched the wrong element. Each picture is taken *after* its step, so an element the step removed (a Create button whose dialog closed) has no outline; that's expected.
- **Nothing unwanted on camera:** cookie banners and welcome pop-ups (close them in `setup`, which isn't filmed), dev-tools badges, error toasts, "font substituted" notices, real personal data, half-loaded images or spinners in the first or last picture. If something is there, find a way around it (a URL that skips it, waiting for it to go) or tell the user.
- **The first picture is a clear starting point** and **the last shows the result** plainly, not covered by the cursor or a toast. The app's own success toast after the action is fine and part of the story ("Moodboard created"); see [pacing](pacing.md) for when to wait for it to go.
- **The cursor shape makes sense** for what's under it *after* the step: a text cursor in a field it typed into; an arrow where a click opened something over the button or removed it, which is expected. An arrow on a button that's still plainly there and clickable means the page doesn't mark it as clickable; worth a mention, not a fix.

## 2. Finished video (before delivering)

Read the report from `take run` and open `out/<name>.contact.jpg`.

- **Every check passes** (✓), with two exceptions you explain instead of fixing: a doubled frame that is the site's own behaviour (it repeats at the same moment every time: content that vanishes in one frame, a picture popping in), and a ⚠ that you've looked at and found harmless. Anything else ✗ is fixed and recorded again, never delivered.
- **Each step looks like its rehearsal** (`rehearsal` line). A ⚠ there puts the rehearsal picture next to the video frame on the contact sheet: a panel, menu or map missing from the video is a broken recording, so record again and, if it repeats, tell the user; live content that changed (a rotating banner, a new headline) is fine. This check sees large areas only: also look at the frames yourself.
- **The frames along the top tell the story** in order, with no surprise screens (an error page, a login wall, an empty state).
- **Nothing is cut off:** animations finish before the next step; toasts are readable.
- **The end:** with a loop, the loop seam strip shows the last frames easing into the first; without, the last frame is the result.
- **Length** is in the 8–20 s range for a 3–7 step scenario. Much longer usually means a step is waiting too long; look at the stillness line.
