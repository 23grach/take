// take run: one command from take.json to a finished, checked video.
// Validate → is the app up? → record → compose → check + contact sheet. Each stage is the same code the
// separate commands use; run only chooses the paths and reports progress.
import { VISIBLE_NOTE } from './drivers/web/browser.ts';
import fs from 'node:fs';
import path from 'node:path';
import { readyTake } from './take/load.ts';
import { record } from './drivers/web/record.ts';
import { TakeError } from './drivers/web/driver.ts';
import type { Mode } from './drivers/web/capture.ts';
import { compose } from './compose/compose.ts';
import { check, type Report } from './check/check.ts';
import { contactSheet } from './check/contact.ts';
import { addressWarning, shownAddress } from './take/format.ts';

export interface RunOptions {
  mode?: Mode;
  /** Overrides the take's own theme. */
  theme?: string;
  /** The MP4 to write. Default: out/<take>.mp4 next to take.json (out/<take>-draft.mp4 in live mode). */
  out?: string;
  headed?: boolean;
  /** Progress lines, one per stage. */
  log?: (line: string) => void;
}

export interface RunResult {
  ok: boolean;
  /** Set when the run stopped before a video existed: a bad take, the app not answering, a step that failed. */
  error?: string;
  capture?: string;
  video?: string;
  report?: Report;
  sheet?: string;
  seconds: number;
}

export async function run(file: string, { mode = 'studio', theme, out, headed = false, log = () => {} }: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  const elapsed = () => +((performance.now() - t0) / 1000).toFixed(1);
  const stop = (error: string): RunResult => ({ ok: false, error, seconds: elapsed() });

  const { take, error } = await readyTake(file);
  if (!take) return stop(error);

  const dir = path.dirname(path.resolve(file));
  const name = path.basename(dir);
  const capture = path.join(dir, mode === 'studio' ? 'capture' : `capture-${mode}`);
  const video = path.resolve(out ?? path.join(dir, 'out', `${name}${mode === 'studio' ? '' : '-draft'}.mp4`));
  const rel = (p: string) => path.relative(process.cwd(), p) || p;

  log(`"${take.title}": ${take.steps.length} steps, ${mode} mode`);
  const warning = addressWarning(take.target);
  if (warning) log(`⚠ ${warning}`);
  let t = performance.now();
  const lap = () => {
    const s = (performance.now() - t) / 1000;
    t = performance.now();
    return `${s.toFixed(1)} s`;
  };

  try {
    const { capture: info } = await record(take, { mode, out: capture, headed });
    log(`✓ recorded  ${info.frames.length} frames (${(info.frames.length / info.fps).toFixed(2)} s of app) in ${lap()} → ${rel(capture)}`);
    if (info.visibleWindow) log(`⚠ ${VISIBLE_NOTE}`);
  } catch (e) {
    // A step that couldn't be performed: the message already says which step and why.
    if (e instanceof TakeError) return { ...stop(e.message), capture };
    throw e;
  }

  const composed = await compose({ capture, out: video, theme: theme ?? take.theme, address: shownAddress(take.target) });
  log(`✓ composed  ${composed.size.join('×')}, ${composed.frames} frames (${composed.seconds.toFixed(2)} s of video) in ${lap()} → ${rel(video)}`);

  const loop = take.loop !== 'none';
  const report = check(video, { loop });
  const base = video.replace(/\.mp4$/i, '');
  fs.writeFileSync(`${base}.check.json`, JSON.stringify(report, null, 1));
  const sheet = await contactSheet(report, `${base}.contact.jpg`, { loop });
  log(`✓ checked   in ${lap()}`);

  return { ok: report.ok, capture, video, report, sheet, seconds: elapsed() };
}
