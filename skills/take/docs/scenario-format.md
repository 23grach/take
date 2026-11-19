# Scenario format v1

A scenario is what you write: a short plain-text description of the video you want. The agent reads it, tries it in the app, turns it into an exact `take.json` ([take-format.md](take-format.md)), shows you the video's timeline and one screenshot per step, and records the video once you press Record.

Write it the way you'd brief a colleague. Any language is fine. Copy [templates/scenario.md](../templates/scenario.md) to `takes/<name>/scenario.md` to start, or just tell the agent in chat and it writes the file for you.

```
Title: Create a project
App: http://localhost:3000 (start with: npm run dev)
Address: boards.app
Size: desktop or phone
Loop: yes

Before:
- The Projects page with three sample projects

Steps:
1. Click "New project"
2. Type "Moodboard" into Name
3. Click "Create"
4. The new "Moodboard" card appears

Notes:
- Keep the cursor off the logo
```

Only **Title**, **App** and **Steps** are needed. For anything else left out, the agent uses the default below, or asks once if it can't tell.

## Header

| Line | Default | What it means |
|---|---|---|
| `Title:` | — | What the video shows. Names the folder and the file (`create-project.mp4`). |
| `App:` | — | Where the app runs, and how to start it if it isn't running. The page the video starts on. |
| `Address:` | the app's domain, or empty for a local app | What the window's address bar shows, e.g. `boards.app`. Write the product's real domain; the local address the app runs on is never shown. |
| `Size:` | `desktop` | `desktop` is a 1440×900 browser window on a 2560×1440 video. `phone` is the site's mobile layout on an iPhone in the middle of the same video, tapped and swiped by a finger. Other sizes aren't supported. |
| `Loop:` | `yes` | `yes`: the end dissolves back into the start so the video loops seamlessly. `no`: it ends on the last step, for videos that play once. |
| `Theme:` | `default` | The look: background, window, cursor. |

## Before

How the app should look when the video starts, if it isn't how it opens: signed in, some data in place, a panel open, a setting on. The agent sets this up before recording and never films it. Leave it out when the app's first screen is right.

For **signed in**, the agent opens a browser window where you sign in yourself, once; Take saves that login on your computer and every recording starts signed in. Your password is never typed by the agent or stored in the take.

## Steps

One numbered line per thing the viewer sees happen. Name what's on screen in quotes, exactly as it's written there, so the agent finds the right element.

| Write | The video shows |
|---|---|
| `Click "New project"` | The cursor travels to it and clicks. |
| `Hover "Share"` | The cursor travels to it and rests, to show a tooltip or hover state. |
| `Type "Moodboard" into Name` | The cursor clicks the field, then the text appears letter by letter. Add `slowly` or `quickly` to change the pace. |
| `Press Enter` | A key, or a shortcut like `Cmd+K`. |
| `Scroll to "Pricing"` / `Scroll down` | The page scrolls smoothly. |
| `Drag "Card" to "Done"` / `Draw a box in the middle` | The cursor presses, moves with the button held, and lets go. |
| `"Saved" appears` / `Wait for the upload to finish` | The video waits until it happens, at the app's own speed. |
| `Pause 1 s` / `Show the result for 4 s` | Nothing happens for that long, so the viewer can take it in. |

Pacing is automatic: the cursor moves like a person's, with short pauses between steps. The video always opens with **1 s** on the first screen and closes with **2 s** on the result, so you don't need to write those; write a `Pause` only for a moment in the middle that needs time.

Multi-finger gestures (pinch, two-finger swipe) aren't supported yet.

## Notes

Anything else the agent should know: what to avoid on camera, what the point of the video is, which of two similar buttons you mean. Free text.

## Tips for a good video

- **One idea per video.** 3–7 steps, about 8–20 s. Make two videos rather than one long one.
- **End on the result.** The last step should be something the viewer can see changed: the new card, the saved state, the updated preview.
- **Use real-looking content.** Names and text in the steps are what viewers read: "Moodboard", not "test123".
- **Mention what moves on its own.** Toasts, loaders, animations: write them as steps (`"Saved" appears`) so the video waits for them instead of cutting them off.

## Changing a video later

The scenario and `take.json` stay in `takes/<name>/`. To change something, edit the scenario or just ask: "make it loop", "show the result longer", "change the address to boards.io". When the app's UI changes, re-record the same take and the video updates.
