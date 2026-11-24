import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright';
import type { Clock } from './clock.ts';
import { realtimeClock } from './clock.ts';
import { downloadsDone, giveUpDownloads } from './browser.ts';
import { stepMedia, watchMedia, type Played } from './media.ts';
import type { Box } from './events.ts';
import type { SoundCatcher } from './sound.ts';
import type { Appearance } from '../../take/format.ts';

export type Mode = 'studio' | 'live';

export interface CaptureInfo {
  version: 0;
  mode: Mode;
  fps: number;
  size: [number, number];
  frames: string[];
  renderSeconds: number;
  images: number;
  visibleWindow?: true;
  theme?: string;
  appearance?: Appearance;
}

export interface Recorder {
  clock: Clock;
  warmup(ms: number): Promise<void>;
  finish(): Promise<Omit<CaptureInfo, 'version' | 'size' | 'renderSeconds'>>;
  videos?: [number, Box[]][];
  saved?(f: number): Promise<void>;
}

const QUALITY = 92;
export const frameFile = (i: number) => `frames/f${String(i).padStart(5, '0')}.jpg`;
const name = frameFile;

export function quickTimerYield(): boolean {
  type Embedder = { setTimeout: (task: () => void, ms?: number) => () => void };
  const clock = (globalThis as { __pwClock?: { controller?: { _embedder?: Embedder; __takeQuick?: true } } }).__pwClock?.controller;
  if (!clock?._embedder?.setTimeout) return false;
  if (clock.__takeQuick) return true;
  const embedder = clock._embedder;
  const original = embedder.setTimeout.bind(embedder);
  const queue: (() => void)[] = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => queue.shift()?.();
  embedder.setTimeout = (task, ms) => {
    if (ms) return original(task, ms);
    let cancelled = false;
    queue.push(() => cancelled || task());
    channel.port2.postMessage(0);
    return () => void (cancelled = true);
  };
  clock.__takeQuick = true;
  return true;
}

const pageState = new WeakMap<Page, { media: boolean; unthrottled: boolean; viewTransition: boolean }>();

export class NeedsFrameLimit extends Error {
  constructor(why: string) {
    super(`${why}, which the fast studio browser can't draw; recording again at the screen's usual pace`);
  }
}

export function watchViewTransitions(): void {
  const w = globalThis as unknown as { __takeViewTransition?: () => void; __takeWatchesTransitions?: true };
  if (w.__takeWatchesTransitions || typeof Document === 'undefined') return;
  w.__takeWatchesTransitions = true;
  const proto = Document.prototype;
  const start = proto.startViewTransition as typeof proto.startViewTransition | undefined;
  if (start)
    proto.startViewTransition = function (this: Document, ...a: Parameters<typeof start>) {
      w.__takeViewTransition?.();
      return start.apply(this, a);
    };
  for (const type of ['pageswap', 'pagereveal']) addEventListener(type, (e) => (e as Event & { viewTransition?: unknown }).viewTransition && w.__takeViewTransition?.());
}

const STALL_MS = 15_000;

export async function picture<T>(page: Page, shot: Promise<T>): Promise<T> {
  shot.catch(() => {});
  checkDrawing(page);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), STALL_MS)));
  const got = await Promise.race([shot, late]).finally(() => clearTimeout(timer));
  if (got !== 'late') return got as T;
  if (pageState.get(page)?.unthrottled) throw new NeedsFrameLimit(`the page stopped drawing (no picture for ${STALL_MS / 1000} s)`);
  throw new Error(`the page stopped drawing: no picture came back for ${STALL_MS / 1000} s`);
}

function checkDrawing(page: Page): void {
  const state = pageState.get(page);
  if (state?.unthrottled && state.viewTransition) throw new NeedsFrameLimit('the page started a view transition');
}

export function idleWithTime(): void {
  const w = globalThis as unknown as { __takeIdle?: true } & Window;
  if (w.__takeIdle) return;
  w.__takeIdle = true;
  w.requestIdleCallback = (cb, opts) =>
    w.setTimeout(() => {
      let left = 50;
      cb({ didTimeout: false, timeRemaining: () => Math.max(0, left--) });
    }, Math.min(16, opts?.timeout ?? 16));
  w.cancelIdleCallback = (id) => w.clearTimeout(id);
}

export async function freezePage(page: Page, unthrottled = false): Promise<CDPSession> {
  const now = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await page.context().addInitScript(quickTimerYield);
  const seen = { media: false, unthrottled, viewTransition: false };
  pageState.set(page, seen);
  await page.context().exposeBinding('__takeMediaPlays', () => void (seen.media = true));
  await page.context().addInitScript(watchMedia);
  if (unthrottled) {
    await page.context().exposeBinding('__takeViewTransition', () => void (seen.viewTransition = true));
    await page.context().addInitScript(watchViewTransitions);
  }
  await page.evaluate(quickTimerYield);
  await page.context().addInitScript(idleWithTime);
  await page.evaluate(idleWithTime);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
  return cdp;
}

const stepPlaying = (page: Page, ms: number) => (pageState.get(page)?.media ? stepMedia(page, ms) : { boxes: [], played: [] as Played[] });

export async function studio(
  page: Page,
  dir: string,
  cdp: CDPSession,
  [width, height]: [number, number],
  scale: number,
  { mobile = false, fps = 60, sound }: { mobile?: boolean; fps?: number; sound?: SoundCatcher } = {},
): Promise<Recorder> {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  let frame = 0;
  const dt = 1000 / fps;
  const videos: [number, Box[]][] = [];
  const writes: Promise<void>[] = [];
  let writeError: Error | undefined;
  const clock: Clock = {
    fps,
    get frame() {
      return frame;
    },
    async tick() {
      if (writeError) throw writeError;
      await page.evaluate((dt) => {
        const onTime = (a: Animation) => !!a.timeline && !('axis' in a.timeline);
        for (const a of document.getAnimations()) {
          const seen = a as Animation & { __take?: boolean };
          if (seen.__take && onTime(a)) a.currentTime = Number(a.currentTime ?? 0) + dt;
        }
      }, dt);
      const ms = Math.round((frame + 1) * dt) - Math.round(frame * dt);
      await page.clock.runFor(ms);
      const { boxes, played } = await stepPlaying(page, ms);
      await sound?.moved(played, true, ms);
      if (JSON.stringify(videos.at(-1)?.[1] ?? []) !== JSON.stringify(boxes)) videos.push([frame, boxes]);
      await page.evaluate(() => {
        const onTime = (a: Animation) => !!a.timeline && !('axis' in a.timeline);
        for (const a of document.getAnimations()) {
          const seen = a as Animation & { __take?: boolean };
          if (seen.__take) continue;
          seen.__take = true;
          if (onTime(a) && a.currentTime !== null && Number(a.currentTime) < 0) a.currentTime = 0;
        }
      });
      const until = Date.now() + 3000;
      while (!(await downloadsDone(page))) {
        if (Date.now() >= until) {
          await giveUpDownloads(page);
          break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      const jpeg = Buffer.from((await picture(page, cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY }))).data, 'base64');
      writes[frame] = fs.promises.writeFile(path.join(dir, name(frame)), jpeg).catch((e: Error) => void (writeError ??= e));
      frame++;
    },
  };
  return {
    clock,
    async warmup(ms: number) {
      for (let t = 0; t < ms; t += dt) {
        await page.evaluate((dt) => {
          const onTime = (a: Animation) => !!a.timeline && !('axis' in a.timeline);
          for (const a of document.getAnimations()) {
            const seen = a as Animation & { __take?: boolean };
            if (seen.__take && onTime(a)) a.currentTime = Number(a.currentTime ?? 0) + dt;
            if (!seen.__take && onTime(a) && a.currentTime !== null && Number(a.currentTime) < 0) a.currentTime = 0;
            seen.__take = true;
          }
        }, dt);
        await page.clock.runFor(Math.round(dt));
        checkDrawing(page);
        const { played } = await stepPlaying(page, Math.round(dt));
        await sound?.moved(played, false, Math.round(dt));
      }
    },
    async finish() {
      await Promise.all(writes);
      if (writeError) throw writeError;
      return { mode: 'studio', fps, frames: Array.from({ length: frame }, (_, i) => name(i)), images: frame };
    },
    saved: (f) => writes[f],
    videos,
  };
}

export async function live(page: Page, dir: string, size: [number, number], fps = 60): Promise<Recorder> {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  const shots: { file: string; at: number }[] = [];
  const writes: Promise<void>[] = [];
  const save = (data: Buffer, at: number) => {
    const file = name(shots.length);
    shots.push({ file, at });
    writes.push(fs.promises.writeFile(path.join(dir, file), data));
  };
  save(await page.screenshot({ type: 'jpeg', quality: QUALITY }), 0);
  await page.screencast.start({
    size: { width: size[0], height: size[1] },
    quality: QUALITY,
    onFrame: ({ data, timestamp }) => save(data, timestamp),
  });
  const clock = realtimeClock(fps);
  return {
    clock,
    warmup: (ms) => page.waitForTimeout(ms),
    async finish() {
      await page.screencast.stop();
      await Promise.all(writes);
      const start = clock.startedAt ?? Date.now();
      const frames: string[] = [];
      let s = 0;
      for (let f = 0; f < clock.frame; f++) {
        const end = start + ((f + 1) * 1000) / fps;
        while (s + 1 < shots.length && shots[s + 1].at <= end) s++;
        frames.push(shots[s].file);
      }
      return { mode: 'live', fps, frames, images: new Set(frames).size };
    },
  };
}
