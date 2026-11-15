// Records a take: opens the app, performs the take while capturing frames, and writes
// <out>/frames/, <out>/capture.json and <out>/events.json.
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession } from 'playwright';
import type { Take } from '../../take/format.ts';
import { openTake, untilReady } from './browser.ts';
import { UNTHROTTLED } from '../../browser-binary.ts';
import { freezePage, live, studio, type CaptureInfo, type Mode, type Recorder } from './capture.ts';
import { perform, performSetup } from './driver.ts';
import { realtimeClock } from './clock.ts';
import { hideCaret } from './caret.ts';
import type { EventLog } from './events.ts';

/** Time the page gets to settle (fonts, first renders, intro animations) before frame 0. */
const WARMUP_MS = 1000;
/** What the page gets after setup steps (a banner fading away) before frame 0. */
const SETTLE_AFTER_SETUP_MS = 600;

export interface RecordOptions {
  mode?: Mode;
  out: string;
  headed?: boolean;
  /** Studio mode: called after every frame with the log so far (it keeps growing) and how many frames are
   *  recorded with their pictures on disk. */
  onFrame?: (log: EventLog, frames: number) => void;
  /** Move the finished recording into `out` (default). False: it stays in stagingDir(out) for the caller. */
  commit?: boolean;
  /** Aborting it stops the recording: the browser closes and record throws. */
  signal?: AbortSignal;
}

/** What a recording writes into its folder; nothing else there is touched. */
const CAPTURE_FILES = ['frames', 'capture.json', 'events.json'];

/** Where a recording goes while it's being made, next to its folder: an earlier capture stays whole until the
 *  new one has finished, so a failed re-record loses nothing. */
export const stagingDir = (out: string) => path.join(path.dirname(path.resolve(out)), `.${path.basename(path.resolve(out))}.recording`);

/** Puts a finished recording in place of the earlier one. */
export function commitCapture(out: string) {
  const staging = stagingDir(out);
  fs.mkdirSync(out, { recursive: true });
  for (const f of CAPTURE_FILES) {
    fs.rmSync(path.join(out, f), { recursive: true, force: true });
    if (fs.existsSync(path.join(staging, f))) fs.renameSync(path.join(staging, f), path.join(out, f));
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

export const discardRecording = (out: string) => fs.rmSync(stagingDir(out), { recursive: true, force: true });

/** Records into stagingDir(out); with `commit` (the default) moves it into `out` once it has finished. Without,
 *  the caller does that (take run, once the video composed from the staging folder is done). */
export async function record(take: Take, { mode = 'studio', out: final, headed = false, onFrame, commit = true, signal }: RecordOptions): Promise<{ capture: CaptureInfo; events: EventLog }> {
  discardRecording(final);
  const out = stagingDir(final);
  fs.mkdirSync(out, { recursive: true });
  try {
    const result = await recordInto(take, { mode, out, headed, onFrame, signal });
    if (commit) commitCapture(final);
    return result;
  } catch (e) {
    discardRecording(final);
    throw e;
  }
}

async function recordInto(take: Take, { mode, out, headed, onFrame, signal }: Required<Pick<RecordOptions, 'mode' | 'out' | 'headed'>> & Pick<RecordOptions, 'onFrame' | 'signal'>): Promise<{ capture: CaptureInfo; events: EventLog }> {

  const [w, h] = take.target.viewport;
  const size: [number, number] = [Math.round(w * take.target.scale), Math.round(h * take.target.scale)];
  let cdp: CDPSession | undefined;
  const studioMode = mode === 'studio';
  const { browser, page, visible } = await openTake(take, { headed, args: studioMode ? UNTHROTTLED : [], prepare: studioMode ? async (p) => (cdp = await freezePage(p)) : undefined });
  const stop = () => void browser.close().catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    // The compositor draws the caret, blinking on video time; the browser's own must never be filmed.
    await hideCaret(page);
    const recorder: Recorder = mode === 'studio' ? await studio(page, out, cdp!, take.target.viewport, take.target.scale) : await live(page, out, size);
    await recorder.warmup(WARMUP_MS);
    // While waiting, a tiny screenshot after each step makes the browser draw a frame, as it does all the time on
    // a real screen: sites that wait for an image to show (some banners) only move on when frames are drawn.
    await untilReady(page, take.ready, async (ms) => {
      await recorder.warmup(ms);
      await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
    });
    // Setup steps (a cookie banner, a welcome pop-up) on a clock that moves page time on without filming.
    let unfilmed = 0;
    const setupClock = { fps: 60, get frame() { return unfilmed; }, async tick() { await recorder.warmup(1000 / 60); unfilmed++; } };
    if (await performSetup(page, take, studioMode ? setupClock : realtimeClock())) await recorder.warmup(SETTLE_AFTER_SETUP_MS);
    const t0 = performance.now();
    // Pictures are written in the background and can land out of order: report them in order.
    let reported = Promise.resolve();
    const saved = recorder.saved;
    const events = await perform(page, take, recorder.clock, {
      onFrame: onFrame && saved && ((log) => {
        const n = log.frames;
        reported = reported.then(() => saved(n - 1)).then(() => onFrame(log, n));
      }),
    });
    await reported;
    const info = await recorder.finish();
    if (recorder.videos?.length) events.videos = recorder.videos;
    const capture: CaptureInfo = { version: 0, ...info, size, theme: take.theme, renderSeconds: +((performance.now() - t0) / 1000).toFixed(2), ...(visible && !headed ? { visibleWindow: true as const } : {}) };
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(capture, null, 1));
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events));
    return { capture, events };
  } finally {
    await browser.close();
  }
}
