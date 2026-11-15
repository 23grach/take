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
import { downloadsDone } from './browser.ts';

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
  /** Studio: resolves once frame f's picture is on disk, at frameFile(f) in the capture folder. */
  saved?(f: number): Promise<void>;
}

const QUALITY = 92; // JPEG; visually lossless at 1.5× and 2×, and fast to write
/** Where frame i's picture goes in the capture folder (studio: one per frame). */
export const frameFile = (i: number) => `frames/f${String(i).padStart(5, '0')}.jpg`;
const name = frameFile;

/** Freezes page time and animations. Must run before the page is opened, so the page never sees real time. */
export async function freezePage(page: Page): Promise<CDPSession> {
  // Page time starts at a fixed moment and moves only when we advance it (install alone keeps it running).
  await page.clock.install({ time: new Date('2026-01-01T09:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T09:00:01Z'));
  // Freeze the browser's animation clock too, so CSS transitions that start mid-take begin frozen.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
  return cdp;
}

/** Studio: each tick moves animations and page time on exactly one frame, then screenshots it.
 *  `cdp` is the session freezePage opened; `viewport` and `scale` are the take's. */
export async function studio(page: Page, dir: string, cdp: CDPSession, [width, height]: [number, number], scale: number, fps = 60): Promise<Recorder> {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  // That session takes the pictures (see tick). It sees the page with its own size and pixel density, so give it
  // the take's; otherwise its first picture switches the page to 1×.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  let frame = 0;
  const dt = 1000 / fps;
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
        for (const a of document.getAnimations()) {
          const seen = a as Animation & { __take?: boolean };
          if (seen.__take) a.currentTime = Number(a.currentTime ?? 0) + dt;
        }
      }, dt);
      // Page time steps 16 or 17 ms so it never drifts from the frame count.
      await page.clock.runFor(Math.round((frame + 1) * dt) - Math.round(frame * dt));
      await page.evaluate(() => {
        for (const a of document.getAnimations()) (a as Animation & { __take?: boolean }).__take = true;
      });
      // Page time stands still while a picture on screen or a font downloads (up to 3 s of wall time), as if the
      // network were instant: frozen time makes every download look many times slower, so a banner sliding in
      // would sit blank for a second of video, or text would show in a stand-in font.
      for (const until = Date.now() + 3000; !(await downloadsDone(page)) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 15));
      // Straight from the browser: Playwright's screenshot does extra work each time (it hides the caret, which
      // hideCaret already did, and waits for fonts, as the line above does). A tenth faster, the same picture.
      const jpeg = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY })).data, 'base64');
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
          for (const a of document.getAnimations()) {
            const seen = a as Animation & { __take?: boolean };
            if (seen.__take) a.currentTime = Number(a.currentTime ?? 0) + dt;
            seen.__take = true;
          }
        }, dt);
        await page.clock.runFor(Math.round(dt));
      }
    },
    async finish() {
      await Promise.all(writes);
      if (writeError) throw writeError;
      return { mode: 'studio', fps, frames: Array.from({ length: frame }, (_, i) => name(i)), images: frame };
    },
    saved: (f) => writes[f],
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
