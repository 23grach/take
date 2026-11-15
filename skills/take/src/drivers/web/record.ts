// Records a take: opens the app, performs the take while capturing frames, and writes
// <out>/frames/, <out>/capture.json and <out>/events.json.
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession } from 'playwright';
import type { Take } from '../../take/format.ts';
import { openTake, untilReady } from './browser.ts';
import { freezePage, live, studio, type CaptureInfo, type Mode, type Recorder } from './capture.ts';
import { perform } from './driver.ts';
import { hideCaret } from './caret.ts';
import type { EventLog } from './events.ts';

/** Time the page gets to settle (fonts, first renders, intro animations) before frame 0. */
const WARMUP_MS = 1000;

export interface RecordOptions {
  mode?: Mode;
  out: string;
  headed?: boolean;
  /** Studio mode: called after every frame with the log so far (it keeps growing) and how many frames are
   *  recorded with their pictures on disk. */
  onFrame?: (log: EventLog, frames: number) => void;
}

export async function record(take: Take, { mode = 'studio', out, headed = false, onFrame }: RecordOptions): Promise<{ capture: CaptureInfo; events: EventLog }> {
  // Start clean, but only remove what a recording writes.
  fs.rmSync(path.join(out, 'frames'), { recursive: true, force: true });
  for (const f of ['capture.json', 'events.json']) fs.rmSync(path.join(out, f), { force: true });
  fs.mkdirSync(out, { recursive: true });

  const [w, h] = take.target.viewport;
  const size: [number, number] = [Math.round(w * take.target.scale), Math.round(h * take.target.scale)];
  let cdp: CDPSession | undefined;
  const { browser, page, visible } = await openTake(take, { headed, prepare: mode === 'studio' ? async (p) => (cdp = await freezePage(p)) : undefined });
  try {
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
    const capture: CaptureInfo = { version: 0, ...info, size, renderSeconds: +((performance.now() - t0) / 1000).toFixed(2), ...(visible && !headed ? { visibleWindow: true as const } : {}) };
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(capture, null, 1));
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events));
    return { capture, events };
  } finally {
    await browser.close();
  }
}
