import { VISIBLE_NOTE } from './drivers/web/browser.ts';
import fs from 'node:fs';
import path from 'node:path';
import { readyTake } from './take/load.ts';
import { commitCapture, discardRecording, record, stagingDir } from './drivers/web/record.ts';
import { TakeError } from './drivers/web/driver.ts';
import { NeedsFrameLimit, type Mode } from './drivers/web/capture.ts';
import { compose, ffmpegProblem, following, loadTheme, themeProblem, type ComposeResult } from './compose/compose.ts';
import { layout } from './compose/stage.ts';
import type { EventLog } from './drivers/web/events.ts';
import { check, type Report } from './check/check.ts';
import { contactSheet } from './check/contact.ts';
import { compareWithRehearsal, STEP_LIMIT } from './check/rehearsal.ts';
import { addressWarning, shownAddress } from './take/format.ts';
import { timeline, type Script } from './probe/script.ts';

export interface RunOptions {
  mode?: Mode;
  theme?: string;
  out?: string;
  headed?: boolean;
  log?: (line: string) => void;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  capture?: string;
  video?: string;
  report?: Report;
  sheet?: string;
  script?: Script;
  seconds: number;
}

export async function run(file: string, { mode = 'studio', theme, out, headed = false, log = () => {} }: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  const elapsed = () => +((performance.now() - t0) / 1000).toFixed(1);
  const stop = (error: string): RunResult => ({ ok: false, error, seconds: elapsed() });

  const { take, error } = await readyTake(file);
  if (!take) return stop(error);
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

  const options = { capture, out: video, theme: theme ?? take.theme, address: shownAddress(take.target) };
  let composing: Promise<ComposeResult> | undefined;
  let recorded: Awaited<ReturnType<typeof record>> | undefined;
  for (let unthrottled = true; ; unthrottled = false) {
    const recording = mode === 'studio' ? following() : undefined;
    composing = recording && compose({ ...options, capture: stagingDir(capture), follow: recording.follow });
    const abort = new AbortController();
    let composeError: unknown;
    let recordFailed = false;
    composing?.catch((e) => {
      if (recordFailed) return;
      composeError = e;
      abort.abort();
    });
    try {
      const { capture: info, events, warnings } = (recorded = await record(take, { mode, out: capture, headed, onFrame: recording?.frame, commit: !recording, signal: abort.signal, unthrottled }));
      recording?.end(events);
      log(`✓ recorded  ${info.frames.length} frames (${(info.frames.length / info.fps).toFixed(2)} s of app) in ${lap()} → ${rel(capture)}`);
      if (info.visibleWindow) log(`⚠ ${VISIBLE_NOTE}`);
      for (const w of warnings) log(`⚠ ${w}`);
      break;
    } catch (e) {
      recordFailed = composeError === undefined;
      recording?.fail(e);
      await composing?.catch(() => {});
      if (composeError !== undefined) throw composeError;
      if (e instanceof NeedsFrameLimit && unthrottled) {
        log(`↻ ${e.message}`);
        continue;
      }
      if (e instanceof TakeError) return { ...stop(e.message), capture };
      throw e;
    }
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
  const matches = mode === 'studio' && recorded ? compareWithRehearsal(capture, recorded.events, path.join(path.dirname(file), 'probe'), file) : undefined;
  if (matches) {
    const off = matches.filter((m) => m.differs > STEP_LIMIT);
    report.findings.push({
      name: 'rehearsal',
      status: off.length ? 'warn' : 'pass',
      detail: off.length
        ? `${off.map((m) => `${m.step === 0 ? 'the first screen' : `step ${m.step}`} (${(m.frame / 60).toFixed(2)} s) looks different from its rehearsal picture over ${Math.round(m.differs * 100)}% of the page`).join('; ')}: compare them on the contact sheet`
        : 'every step looks like its rehearsal picture',
    });
  }
  const base = video.replace(/\.mp4$/i, '');
  fs.writeFileSync(`${base}.check.json`, JSON.stringify(report, null, 1));
  const sheet = await contactSheet(report, `${base}.contact.jpg`, { loop, rehearsal: matches?.filter((m) => m.differs > STEP_LIMIT) });
  log(`✓ checked   in ${lap()}`);

  const script = recorded && timeline(take, recorded.events.steps, recorded.events.frames, { fps: recorded.events.fps, loopFrames: composed.frames - recorded.events.frames });
  return { ok: report.ok, capture, video, report, sheet, script, seconds: elapsed() };
}

export function pageVideoAreas(log: EventLog, theme?: string): ((f: number) => [number, number, number, number][]) | undefined {
  const list = log.videos;
  if (!list?.length) return undefined;
  const look = loadTheme(theme).theme;
  const box = layout(look, log.viewport);
  const z = look.stage.output[0] / look.stage.size[0];
  return (f) => {
    let i = list.length - 1;
    while (i > 0 && list[i][0] > f) i--;
    if (list[i][0] > f) return [];
    return list[i][1].map((b) => [(box.contentLeft + b.x * box.k) * z, (box.contentTop + b.y * box.k) * z, b.width * box.k * z, b.height * box.k * z]);
  };
}
