# Take

The tool lives in `skills/take/` (`SKILL.md`, CLI, docs, tests, themes). Run every `npm` and `node` command from there. The repo root holds only the README, LICENSE, `CLAUDE.md` (which loads this file), `assets/` (the README demo and the plugin icon), the Claude Code (`.claude-plugin/`) and Cursor (`.cursor-plugin/`) manifests, and CI.

## Done

- `npm test` runs the type check and every test. CI (`.github/workflows/test.yml`) runs the same steps.
- One file while you work: `node --test test/<name>.test.ts`.
- After a change that affects the video, render a short clip and look at its contact sheet (`take check <video.mp4>`) before calling it done.

## Rules

- No comments anywhere in code, tests, themes or CI. Names and structure explain the code; reasons go in the commit message. `test/rules.test.ts` enforces it.
- No dead code. `npm run typecheck` rejects unused locals and parameters; delete unused exports and fallbacks too. `test/rules.test.ts` catches exports no other file uses.
- Never use Playwright's built-in video (`recordVideo`, or `page.screencast` with `path`). Frames come from the browser engine through `src/drivers/web/capture.ts`. `test/rules.test.ts` checks it.
- Output stays H.264 MP4, constant 60 fps, yuv420p, `+faststart`.
- Keep captures and renders out of git. The one exception is `assets/`: the README demo GIF and the plugin icon.
- A release bumps `version` in `skills/take/package.json`, `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` together. `test/rules.test.ts` checks they match.
