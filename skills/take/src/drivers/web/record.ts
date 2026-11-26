import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright';
import type { Take } from '../../take/format.ts';
import { openTake, untilReady } from './browser.ts';
import { UNTHROTTLED } from '../../browser-binary.ts';
import { freezePage, live, NeedsFrameLimit, picture, studio, type CaptureInfo, type Mode, type Recorder } from './capture.ts';
import { perform, performSetup } from './driver.ts';
import { TakeError } from './take-error.ts';
import { pageOutline } from '../../probe/probe.ts';
import { realtimeClock, wallPacedClock } from './clock.ts';
import { hideCaret } from './caret.ts';
import type { EventLog } from './events.ts';
import { catchSound, type SoundCatcher } from './sound.ts';
import { isolate } from './focus.ts';
import { focusLook } from '../../compose/themes.ts';

const WARMUP_MS = 1000;
const SETTLE_AFTER_SETUP_MS = 600;

interface RecordOptions {
  mode?: Mode;
  out: string;
  headed?: boolean;
  onFrame?: (log: EventLog, frames: number) => void;
  commit?: boolean;
  signal?: AbortSignal;
  unthrottled?: boolean;
  failedScreen?: string;
}

const CAPTURE_FILES = ['frames', 'capture.json', 'events.json', 'sound', 'sound.json'];

export const stagingDir = (out: string) => path.join(path.dirname(path.resolve(out)), `.${path.basename(path.resolve(out))}.recording`);

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

export interface Recording {
  capture: CaptureInfo;
  events: EventLog;
  warnings: string[];
}

export async function record(take: Take, { mode = 'studio', out: final, headed = false, onFrame, commit = true, signal, unthrottled = true, failedScreen }: RecordOptions): Promise<Recording> {
  const out = stagingDir(final);
  const fresh = () => {
    discardRecording(final);
    fs.mkdirSync(out, { recursive: true });
  };
  fresh();
  try {
    let reported = false;
    const report = onFrame && ((log: EventLog, frames: number) => ((reported = true), onFrame(log, frames)));
    const result = await recordInto(take, { mode, out, headed, onFrame: report, signal, unthrottled, failedScreen }).catch((e) => {
      if (!(e instanceof NeedsFrameLimit) || reported) throw e;
      fresh();
      return recordInto(take, { mode, out, headed, onFrame: report, signal, unthrottled: false, failedScreen });
    });
    if (commit) commitCapture(final);
    return result;
  } catch (e) {
    discardRecording(final);
    throw e;
  }
}

async function recordInto(take: Take, { mode, out, headed, onFrame, signal, unthrottled, failedScreen }: Required<Pick<RecordOptions, 'mode' | 'out' | 'headed' | 'unthrottled'>> & Pick<RecordOptions, 'onFrame' | 'signal' | 'failedScreen'>): Promise<Recording> {
  const [w, h] = take.target.viewport;
  const size: [number, number] = [Math.round(w * take.target.scale), Math.round(h * take.target.scale)];
  let cdp: CDPSession | undefined;
  const studioMode = mode === 'studio';
  const fast = studioMode && unthrottled;
  let sound: SoundCatcher | undefined;
  const prepare = async (p: Page) => {
    cdp = await freezePage(p, fast);
    if (take.sound) sound = await catchSound(p);
  };
  const { browser, page, visible } = await openTake(take, { headed, args: fast ? UNTHROTTLED : [], prepare: studioMode ? prepare : undefined });
  const stop = () => void browser.close().catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    await hideCaret(page);
    const recorder: Recorder = mode === 'studio' ? await studio(page, out, cdp!, take.target.viewport, take.target.scale, { mobile: take.target.device === 'phone', sound }) : await live(page, out, size);
    await recorder.warmup(WARMUP_MS);
    const drawn = async (ms: number) => {
      await recorder.warmup(ms);
      const shot = page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }).catch(() => null);
      await (studioMode ? picture(page, shot) : shot);
    };
    if (await performSetup(page, take, studioMode ? wallPacedClock(drawn) : realtimeClock())) await recorder.warmup(SETTLE_AFTER_SETUP_MS);
    await untilReady(page, take.ready, drawn);
    const look = take.target.focus && focusLook(take.theme);
    const focus = look && (await isolate(page, take.target.focus!, take.target.viewport, look));
    if (focus) await recorder.crop?.(focus, look.light.size[0]);
    await sound?.start();
    const t0 = performance.now();
    let reported = Promise.resolve();
    const saved = recorder.saved;
    const events = await perform(page, take, recorder.clock, {
      ...(studioMode ? { unfilmed: wallPacedClock(drawn) } : {}),
      ...(focus ? { focus } : {}),
      onFrame: onFrame && saved && ((log) => {
        const n = log.frames;
        reported = reported.then(() => saved(n - 1)).then(() => onFrame(log, n));
      }),
    });
    await reported;
    const info = await recorder.finish();
    const warnings = (await sound?.finish(out)) ?? [];
    if (recorder.videos?.length) events.videos = recorder.videos;
    const capture: CaptureInfo = { version: 0, ...info, size: info.shows && look ? look.light.size : size, theme: take.theme, ...(take.target.appearance ? { appearance: take.target.appearance } : {}), renderSeconds: +((performance.now() - t0) / 1000).toFixed(2), ...(visible && !headed ? { visibleWindow: true as const } : {}) };
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(capture, null, 1));
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events));
    return { capture, events, warnings };
  } catch (e) {
    if (e instanceof TakeError && failedScreen) await saveScreen(page, failedScreen);
    throw e;
  } finally {
    await browser.close();
  }
}

export const FAILED_SCREEN = 'screen.png';
export const FAILED_OUTLINE = 'screen.outline.yml';

async function saveScreen(page: Page, folder: string) {
  fs.mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: path.join(folder, FAILED_SCREEN), timeout: 5000 }).catch(() => {});
  fs.writeFileSync(path.join(folder, FAILED_OUTLINE), await pageOutline(page));
}
