// take run: one command from take.json to a finished, checked video.
// Validate → is the app up? → record and compose (at once, in studio mode) → check + contact sheet. Each stage
// is the same code the separate commands use; run only chooses the paths and reports progress.
import { VISIBLE_NOTE } from './drivers/web/browser.ts';
import fs from 'node:fs';
import path from 'node:path';
import { readyTake } from './take/load.ts';
import { commitCapture, discardRecording, record, stagingDir } from './drivers/web/record.ts';
import { TakeError } from './drivers/web/driver.ts';
import type { Mode } from './drivers/web/capture.ts';
import { compose, ffmpegProblem, following, loadTheme, themeProblem } from './compose/compose.ts';
import { layout } from './compose/stage.ts';
import type { EventLog } from './drivers/web/events.ts';
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
  // Things that would only fail once the recording is done: say so before opening the browser.
  const problem = themeProblem(theme ?? take.theme) ?? ffmpegProblem();
  if (problem) return stop(`take run: ${problem}`);

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

  // In studio mode the video is composed while recording, a few frames behind, so it's ready soon after.
  const recording = mode === 'studio' ? following() : undefined;
  const options = { capture, out: video, theme: theme ?? take.theme, address: shownAddress(take.target) };
  // While recording, the new capture sits in a staging folder (an earlier one stays whole until this one is done).
  const composing = recording && compose({ ...options, capture: stagingDir(capture), follow: recording.follow });
  // If composing fails, there's no point recording on: stop the recording too, and report why compose failed.
  const abort = new AbortController();
  let composeError: unknown;
  let recordFailed = false;
  let recorded: Awaited<ReturnType<typeof record>> | undefined;
  composing?.catch((e) => {
    if (recordFailed) return; // compose stopped because the recording did: that error is reported below
    composeError = e;
    abort.abort();
  });
  try {
    const { capture: info, events } = (recorded = await record(take, { mode, out: capture, headed, onFrame: recording?.frame, commit: !recording, signal: abort.signal }));
    recording?.end(events);
    log(`✓ recorded  ${info.frames.length} frames (${(info.frames.length / info.fps).toFixed(2)} s of app) in ${lap()} → ${rel(capture)}`);
    if (info.visibleWindow) log(`⚠ ${VISIBLE_NOTE}`);
  } catch (e) {
    recordFailed = composeError === undefined;
    recording?.fail(e);
    await composing?.catch(() => {}); // it stops and cleans up
    if (composeError !== undefined) throw composeError;
    // A step that couldn't be performed: the message already says which step and why.
    if (e instanceof TakeError) return { ...stop(e.message), capture };
    throw e;
  }

  let composed;
  if (composing) {
    try {
      composed = await composing;
    } catch (e) {
      discardRecording(capture);
      throw e;
    }
    commitCapture(capture);
  } else composed = await compose(options);
  log(`✓ composed  ${composed.size.join('×')}, ${composed.frames} frames (${composed.seconds.toFixed(2)} s of video) in ${lap()} → ${rel(video)}`);

  const loop = take.loop !== 'none';
  const report = check(video, { loop, pageVideos: recorded && pageVideoAreas(recorded.events, options.theme) });
  const base = video.replace(/\.mp4$/i, '');
  fs.writeFileSync(`${base}.check.json`, JSON.stringify(report, null, 1));
  const sheet = await contactSheet(report, `${base}.contact.jpg`, { loop });
  log(`✓ checked   in ${lap()}`);

  return { ok: report.ok, capture, video, report, sheet, seconds: elapsed() };
}

/** Where page videos show in each frame of the finished video, in its pixels (see EventLog.videos). */
export function pageVideoAreas(log: EventLog, theme?: string): ((f: number) => [number, number, number, number][]) | undefined {
  const list = log.videos;
  if (!list?.length) return undefined;
  const look = loadTheme(theme).theme;
  const box = layout(look, log.viewport);
  // The stage is laid out at 1920×1080 and rendered at the video's size.
  const z = look.stage.output[0] / look.stage.size[0];
  return (f) => {
    let i = list.length - 1;
    while (i > 0 && list[i][0] > f) i--;
    if (list[i][0] > f) return [];
    return list[i][1].map((b) => [(box.contentLeft + b.x * box.k) * z, (box.contentTop + b.y * box.k) * z, b.width * box.k * z, b.height * box.k * z]);
  };
}
