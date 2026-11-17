// Captures frames while the driver performs a take. Two clocks, same driver:
// - studio: page time is frozen and moved exactly 1/60 s per frame, and each frame is a screenshot.
//   Perfectly even and sharp, slower than real time. For final videos.
// - live: the take plays in real time while the browser streams frames. Fast, may hitch. For drafts.
// Both write frames/ and list, for every video frame, which image shows it (capture.json).
import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright';
import type { Clock } from './clock.ts';
import { realtimeClock } from './clock.ts';
import { downloadsDone, giveUpDownloads } from './browser.ts';
import { stepMedia, watchMedia, type Played } from './media.ts';
import type { Box } from './events.ts';
import type { SoundCatcher } from './sound.ts';

export type Mode = 'studio' | 'live';

export interface CaptureInfo {
  version: 0;
  mode: Mode;
  fps: number;
  /** Size of each image in pixels (viewport × scale). */
  size: [number, number];
  /** For every video frame, the image that shows it, relative to the capture folder. Live mode may repeat images. */
  frames: string[];
  /** How long recording took, in seconds of wall time. */
  renderSeconds: number;
  /** How many distinct images were captured. Live mode repeats an image while the screen doesn't change. */
  images: number;
  /** The site refused the hidden browser, so it recorded in a visible window. */
  visibleWindow?: true;
  /** The take's theme, so compose on its own draws the video the way take run would. */
  theme?: string;
}

export interface Recorder {
  clock: Clock;
  warmup(ms: number): Promise<void>;
  /** Call once the driver is done. Writes nothing itself; returns what goes into capture.json. */
  finish(): Promise<Omit<CaptureInfo, 'version' | 'size' | 'renderSeconds'>>;
  /** Studio: where page videos were on screen (see EventLog.videos). */
  videos?: [number, Box[]][];
  /** Studio: resolves once frame f's picture is on disk, at frameFile(f) in the capture folder. */
  saved?(f: number): Promise<void>;
}

const QUALITY = 92; // JPEG; visually lossless at 1.5× and 2×, and fast to write
/** Where frame i's picture goes in the capture folder (studio: one per frame). */
export const frameFile = (i: number) => `frames/f${String(i).padStart(5, '0')}.jpg`;
const name = frameFile;

/** After each page timer it fires, Playwright's frozen clock yields to the browser with a real setTimeout(0).
 *  Chained timers are clamped to 4 ms, so a site running 7–18 timers a frame spent 30–70 ms a frame idle. A
 *  message-channel task yields the same way (a fresh task, nothing skipped) without the clamp. Returns whether
 *  the clock was found; if a Playwright update renames its insides, recording stays correct, only slower. */
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

/** What Take knows about a studio page: whether media ever played in it, and, in a browser that draws as fast as it
 *  can (see NeedsFrameLimit), whether a view transition started. */
const pageState = new WeakMap<Page, { media: boolean; unthrottled: boolean; viewTransition: boolean }>();

/** Studio browsers draw a picture the moment one is asked for, instead of waiting for the screen's next 60 Hz
 *  refresh (UNTHROTTLED): recording is much quicker. But Chrome launched that way never draws again once a page
 *  starts a view transition (the browser's own animation between two states of a page; YouTube starts one as it
 *  loads): every picture after it waits forever. Thrown as soon as one starts, or when a picture doesn't come back,
 *  so the take is recorded again in a browser that keeps to 60 Hz. */
export class NeedsFrameLimit extends Error {
  constructor(why: string) {
    super(`${why}, which the fast studio browser can't draw; recording again at the screen's usual pace`);
  }
}

/** In every page and frame before its own scripts: tells Take when a view transition starts, whether the page
 *  starts it (document.startViewTransition) or the browser does between two pages (@view-transition). */
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

/** How long a picture may take before the page counts as no longer drawing. Pictures normally take milliseconds. */
const STALL_MS = 15_000;

/** Studio: a picture from the page, or NeedsFrameLimit if the fast browser has stopped drawing. */
export async function picture<T>(page: Page, shot: Promise<T>): Promise<T> {
  shot.catch(() => {}); // when it's given up on below, it may still fail later
  checkDrawing(page);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), STALL_MS)));
  const got = await Promise.race([shot, late]).finally(() => clearTimeout(timer));
  if (got !== 'late') return got as T;
  if (pageState.get(page)?.unthrottled) throw new NeedsFrameLimit(`the page stopped drawing (no picture for ${STALL_MS / 1000} s)`);
  throw new Error(`the page stopped drawing: no picture came back for ${STALL_MS / 1000} s`);
}

/** Throws NeedsFrameLimit once a view transition has started in the fast browser: its next picture would never come. */
function checkDrawing(page: Page): void {
  const state = pageState.get(page);
  if (state?.unthrottled && state.viewTransition) throw new NeedsFrameLimit('the page started a view transition');
}

/** Under the frozen clock, Playwright runs the page's idle callbacks with no time left (timeRemaining() is always
 *  0), so code that only works while there is time left waits forever: Wikipedia's script loader never loads the
 *  article's scripts. Idle callbacks run on page time instead, a page frame later, each with a little time to work
 *  with. The time left counts down per question asked, so a loop that works "while there's time" always ends. */
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

/** Freezes page time and animations. Must run before the page is opened, so the page never sees real time.
 *  `unthrottled`: the browser was launched with UNTHROTTLED (see NeedsFrameLimit). */
export async function freezePage(page: Page, unthrottled = false): Promise<CDPSession> {
  // Page time starts at the real time, so dates in the app ("Today", "2 min ago") match the storyboard, and moves
  // only when we advance it (install alone keeps it running).
  const now = Math.floor(Date.now() / 1000) * 1000;
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  // Registered after the clock's own script, so it runs after it in every page and frame the take opens.
  await page.context().addInitScript(quickTimerYield);
  // Tells Take when media starts playing in any frame, so pages without any get no extra work per frame (which
  // would also make their frames vary by a shade from run to run).
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
  // Freeze the browser's animation clock too, so CSS transitions that start mid-take begin frozen.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
  return cdp;
}

/** Moves media on only in pages where some has played (see freezePage). */
const stepPlaying = (page: Page, ms: number) => (pageState.get(page)?.media ? stepMedia(page, ms) : { boxes: [], played: [] as Played[] });

// "onTime", written out in each page.evaluate below (which can't see this file): the animations Take moves on frame
// by frame. Scroll-driven ones (their timeline has an axis) follow the scroll, and refuse a time. Not "the timeline
// is document.timeline": a page can replace that global (YouTube sometimes installs a stand-in), and then none of its
// animations would ever move: a view transition would cover the page for good.

/** Studio: each tick moves animations and page time on exactly one frame, then screenshots it.
 *  `cdp` is the session freezePage opened; `viewport` and `scale` are the take's. `sound` hears the page as page
 *  time moves on. */
export async function studio(page: Page, dir: string, cdp: CDPSession, [width, height]: [number, number], scale: number, fps = 60, sound?: SoundCatcher): Promise<Recorder> {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  // That session takes the pictures (see tick). It sees the page with its own size and pixel density, so give it
  // the take's; otherwise its first picture switches the page to 1×.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
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
      // Animations already on screen move forward one frame; ones that started during this frame begin at 0.
      await page.evaluate((dt) => {
        const onTime = (a: Animation) => !!a.timeline && !('axis' in a.timeline); // see "onTime" above
        for (const a of document.getAnimations()) {
          const seen = a as Animation & { __take?: boolean };
          if (seen.__take && onTime(a)) a.currentTime = Number(a.currentTime ?? 0) + dt;
        }
      }, dt);
      // Page time steps 16 or 17 ms so it never drifts from the frame count.
      const ms = Math.round((frame + 1) * dt) - Math.round(frame * dt);
      await page.clock.runFor(ms);
      const { boxes, played } = await stepPlaying(page, ms);
      await sound?.moved(played, true);
      if (JSON.stringify(videos.at(-1)?.[1] ?? []) !== JSON.stringify(boxes)) videos.push([frame, boxes]);
      await page.evaluate(() => {
        const onTime = (a: Animation) => !!a.timeline && !('axis' in a.timeline); // see "onTime" above
        for (const a of document.getAnimations()) {
          const seen = a as Animation & { __take?: boolean };
          if (seen.__take) continue;
          seen.__take = true;
          // Starts now. Pages that time an animation's start with the page clock (frozen, so it disagrees with the
          // browser's animation clock) would otherwise schedule it seconds ahead: a panel opening stays invisible.
          if (onTime(a) && a.currentTime !== null && Number(a.currentTime) < 0) a.currentTime = 0;
        }
      });
      // Page time stands still while a picture on screen or a font downloads (up to 3 s of wall time), as if the
      // network were instant: frozen time makes every download look many times slower, so a banner sliding in
      // would sit blank for a second of video, or text would show in a stand-in font.
      const until = Date.now() + 3000;
      while (!(await downloadsDone(page))) {
        if (Date.now() >= until) {
          await giveUpDownloads(page);
          break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      // Straight from the browser: Playwright's screenshot does extra work each time (it hides the caret, which
      // hideCaret already did, and waits for fonts, as the line above does). A tenth faster, the same picture.
      const jpeg = Buffer.from((await picture(page, cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY }))).data, 'base64');
      writes[frame] = fs.promises.writeFile(path.join(dir, name(frame)), jpeg).catch((e: Error) => void (writeError ??= e));
      frame++;
    },
  };
  return {
    clock,
    /** Lets page time and animations run for a while without capturing, so the page settles before frame 0. */
    async warmup(ms: number) {
      for (let t = 0; t < ms; t += dt) {
        await page.evaluate((dt) => {
          const onTime = (a: Animation) => !!a.timeline && !('axis' in a.timeline); // see "onTime" above
          for (const a of document.getAnimations()) {
            const seen = a as Animation & { __take?: boolean };
            if (seen.__take && onTime(a)) a.currentTime = Number(a.currentTime ?? 0) + dt;
            if (!seen.__take && onTime(a) && a.currentTime !== null && Number(a.currentTime) < 0) a.currentTime = 0; // see tick
            seen.__take = true;
          }
        }, dt);
        await page.clock.runFor(Math.round(dt));
        checkDrawing(page);
        const { played } = await stepPlaying(page, Math.round(dt));
        await sound?.moved(played, false);
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

/** Live: the take runs in real time; the browser sends a frame whenever the screen changes.
 *  Each video frame shows the last image that arrived before it ended. */
export async function live(page: Page, dir: string, size: [number, number], fps = 60): Promise<Recorder> {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  const shots: { file: string; at: number }[] = [];
  const writes: Promise<void>[] = [];
  const save = (data: Buffer, at: number) => {
    const file = name(shots.length);
    shots.push({ file, at });
    writes.push(fs.promises.writeFile(path.join(dir, file), data));
  };
  // The screen as it is before anything moves: the screencast only sends a frame when something changes.
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
