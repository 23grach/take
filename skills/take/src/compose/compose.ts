// Turns a capture (frames + events) into a finished video: the footage sits in a browser window on a
// background, and the cursor is drawn on top from the event log.
// The stage is an HTML page rendered in Chromium, one screenshot per video frame, piped into ffmpeg.
// Every frame depends only on the log, so several browsers draw different frames at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from '../browser-binary.ts';
import { frameFile, type CaptureInfo } from '../drivers/web/capture.ts';
import type { EventLog } from '../drivers/web/events.ts';
import { stageHtml, layout, type Theme } from './stage.ts';
import { ease } from '../drivers/web/pacing.ts';
import type { Cursor } from '../drivers/web/cursor.ts';
import { cursorArt, type ArtSet } from './cursor-art.ts';
import type { StageCursor } from './stage.ts';

export interface ComposeOptions {
  /** Folder with capture.json, events.json and frames/. */
  capture: string;
  /** The MP4 to write. */
  out: string;
  /** Folder in themes/. */
  theme?: string;
  /** Text for the address bar. Default: the one recorded with the take. */
  address?: string;
  /** Only these video frames, [first, last] inclusive: for quick checks. */
  range?: [number, number];
  /** A recording still going on (take run): instead of reading capture.json and events.json, compose draws each
   *  frame as soon as the recording has everything for it, and finishes shortly after the recording does. */
  follow?: Follow;
  /** How many browsers draw frames. Default: composeWorkers(). */
  workers?: number;
}

/** Where a recording has got to. `log` is the one the recording is filling in. */
export interface Progress {
  log: EventLog;
  /** Frames recorded so far, with their pictures on disk. */
  frames: number;
  ended: boolean;
}

/** A recording compose can follow. */
export interface Follow {
  /** Resolves once at least `frames` frames are recorded, or the recording has ended; rejects if it failed. */
  wait(frames: number): Promise<Progress>;
}

/** A Follow fed by a recording: call frame() as frames come in, then end() or fail(). */
export function following() {
  let now: Progress | null = null;
  let error: unknown;
  let waiting: { frames: number; resolve: (p: Progress) => void; reject: (e: unknown) => void }[] = [];
  const settle = () => {
    waiting = waiting.filter((w) => {
      if (error !== undefined) return w.reject(error), false;
      if (now && (now.ended || now.frames >= w.frames)) return w.resolve(now), false;
      return true;
    });
  };
  const follow: Follow = {
    wait: (frames) => new Promise((resolve, reject) => {
      waiting.push({ frames, resolve, reject });
      settle();
    }),
  };
  return {
    follow,
    frame(log: EventLog, frames: number) {
      now = { log, frames, ended: false };
      settle();
    },
    end(log: EventLog) {
      now = { log, frames: log.frames, ended: true };
      settle();
    },
    fail(e: unknown) {
      error = e ?? new Error('the recording failed');
      settle();
    },
  };
}

export interface ComposeResult {
  file: string;
  /** Video size in pixels. */
  size: [number, number];
  frames: number;
  seconds: number;
  renderSeconds: number;
}

const THEMES = fileURLToPath(new URL('../../themes/', import.meta.url));
const HOST = 'http://take.local/';

/** How many browsers draw frames at once: one per 2 s of video (starting a browser costs more than drawing a
 *  short clip), up to 4 (beyond that the Mac's graphics are the limit), one per 2 cores and per 3 GB of memory,
 *  since each holds about 1 GB while drawing. Separate browsers, not tabs: tabs share one graphics process and
 *  wait on each other. */
export function composeWorkers(frames: number, cpus = os.availableParallelism(), memory = os.totalmem()): number {
  return Math.max(1, Math.min(4, Math.floor(cpus / 2), Math.floor(memory / 3 / 2 ** 30), Math.ceil(frames / 120)));
}

/** The themes Take ships with. */
export const themeNames = () => fs.readdirSync(THEMES).filter((d) => fs.existsSync(path.join(THEMES, d, 'tokens.json'))).sort();

/** Why a theme can't be used, or undefined when it can. Cheap: run it before opening a browser. */
export function themeProblem(name: string): string | undefined {
  if (themeNames().includes(name)) return undefined;
  return `there's no theme "${name}". Themes: ${themeNames().join(', ')}`;
}

/** Is ffmpeg on the PATH? Checked before recording, so a missing one is reported at once, not after the take. */
export function ffmpegProblem(): string | undefined {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
  return r.error ? "ffmpeg isn't installed (or isn't on the PATH). Run take doctor to see how to install it." : undefined;
}

export function loadTheme(name = 'default'): { theme: Theme; dir: string } {
  const dir = path.join(THEMES, name);
  const problem = themeProblem(name);
  if (problem) throw new Error(problem);
  return { theme: JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')), dir };
}

/** Video length: the take, plus the loop back to the start. */
export function totalFrames(log: EventLog, theme: Theme): number {
  return log.frames + (log.loop === 'crossfade-to-start' ? theme.loop.frames : 0);
}

/** How far into the loop a frame is: 0 before it, rising towards (but never reaching) 1 on its last frame,
 *  because the next frame, the video's first, is the full step. That way the seam has no repeated frame. */
export function loopProgress(log: EventLog, theme: Theme, f: number): number {
  if (f < log.frames) return 0;
  return ease((f - log.frames + 1) / (theme.loop.frames + 1));
}

/** What the footage shows in one video frame: an image, and during the loop the first image fading in over it. */
export function footageAt(info: CaptureInfo, log: EventLog, theme: Theme, f: number) {
  const p = loopProgress(log, theme, f);
  return { src: info.frames[Math.min(f, info.frames.length - 1)], fade: p > 0 ? { src: info.frames[0], opacity: p } : null };
}

/** The cursor the page showed in frame f. */
export function shapeAt(log: EventLog, f: number): Cursor {
  let shape: Cursor = 'default';
  for (const [frame, s] of log.cursors) {
    if (frame > f) break;
    shape = s;
  }
  return shape;
}

/** The drawings a video needs, and which one shows for each cursor: a standard cursor by its name (the arrow
 *  when there's no drawing for it), a site's own image as itself; `none` shows nothing, as in the browser.
 *  A site image that first shows up later (in a recording still going on) gets its drawing then. */
export function stageCursors(log: EventLog, art: ArtSet) {
  const cursors: Record<string, StageCursor> = { ...art };
  const sites: string[] = [];
  const site = (c: Extract<Cursor, object>) => {
    let i = sites.indexOf(c.image);
    if (i < 0) {
      i = sites.push(c.image) - 1;
      cursors[`site-${i}`] = { src: c.image, hotspot: c.hotspot ?? [0, 0] };
    }
    return `site-${i}`;
  };
  for (const [, c] of log.cursors) if (typeof c === 'object') site(c);
  const keyOf = (c: Cursor): string | null => (typeof c === 'object' ? site(c) : c === 'none' ? null : art[c] ? c : 'default');
  return { cursors, keyOf };
}

const opacityCache = new WeakMap<EventLog, { values: number[]; hiding: boolean }>();
/** Cursor opacity in frame f. Like macOS, the cursor hides when typing starts and comes back as soon as it
 *  moves; both fade over theme.cursor.hideFade frames so it never pops. Each frame follows from the one before,
 *  so frames are worked out in order and kept: ask for a frame only once the log has everything up to it. */
export function opacityAt(log: EventLog, theme: Theme, f: number): number {
  let c = opacityCache.get(log);
  if (!c) opacityCache.set(log, (c = { values: [], hiding: false }));
  const step = 1 / Math.max(1, theme.cursor.hideFade);
  for (let g = c.values.length; g <= f; g++) {
    const [a, b] = [log.pointer[Math.min(g, log.frames - 1)], log.pointer[Math.max(0, Math.min(g - 1, log.frames - 1))]];
    if (log.events.some((e) => e.type === 'key' && e.frame === g)) c.hiding = true;
    else if (g >= log.frames || a[0] !== b[0] || a[1] !== b[1]) c.hiding = false;
    const o = c.values[g - 1] ?? 1;
    c.values.push(c.hiding ? Math.max(0, o - step) : Math.min(1, o + step));
  }
  return c.values[f];
}

/** Cursor opacity for every frame of a finished log. */
export function cursorOpacity(log: EventLog, theme: Theme): number[] {
  return Array.from({ length: totalFrames(log, theme) }, (_, f) => opacityAt(log, theme, f));
}

/** The text caret in one video frame, with its blink: solid while it moves (typing), then on/off on video
 *  time, as Chrome does on real time. During the loop it fades out with the footage it belongs to. */
export function caretAt(log: EventLog, theme: Theme, f: number) {
  const changes = log.carets;
  const g = Math.min(f, log.frames - 1);
  let i = -1;
  for (let j = 0; j < changes.length && changes[j][0] <= g; j++) i = j;
  const c = i >= 0 ? changes[i][1] : null;
  if (!c) return null;
  const since = g - changes[i][0];
  const { solidFrames, blinkFrames } = theme.caret;
  const on = since < solidFrames || Math.floor((since - solidFrames) / blinkFrames) % 2 === 1;
  const fade = 1 - loopProgress(log, theme, f);
  return { ...c, opacity: on ? fade : 0 };
}

/** What the cursor looks like in one video frame. Pure: depends only on the log, the theme and the frame. */
export function overlayAt(log: EventLog, theme: Theme, f: number) {
  const opacity = opacityAt(log, theme, f);
  if (f >= log.frames) {
    // The loop: the cursor glides back to where it started, arriving as the footage does, and takes on the
    // starting shape halfway, as the first frame fades in under it.
    const [a, b] = [log.pointer[log.pointer.length - 1], log.pointer[0]];
    const p = loopProgress(log, theme, f);
    const shape = p < 0.5 ? shapeAt(log, log.frames - 1) : shapeAt(log, 0);
    return { x: a[0] + (b[0] - a[0]) * p, y: a[1] + (b[1] - a[1]) * p, shape, opacity, pressed: false, caret: caretAt(log, theme, f) };
  }
  const [x, y] = log.pointer[f];
  const downs = log.events.filter((e) => e.type === 'down');
  const ups = log.events.filter((e) => e.type === 'up');
  const pressed = downs.some((d) => {
    const up = ups.find((u) => u.frame >= d.frame);
    return f >= d.frame && f < (up?.frame ?? Infinity);
  });
  return { x, y, shape: shapeAt(log, f), opacity, pressed, caret: caretAt(log, theme, f) };
}

export async function compose({ capture, out, theme: themeName = 'default', address, range, follow, workers: asked }: ComposeOptions): Promise<ComposeResult> {
  const { theme, dir: themeDir } = loadTheme(themeName);
  const [W, H] = theme.stage.size;
  // Videos are 2560×1440: the 1920×1080 stage at a higher pixel density, so every theme length keeps its look.
  const scale = theme.stage.output[0] / W;
  const size = theme.stage.output;
  const t0 = performance.now();
  // Following a recording, a couple of browsers keep up with it; more would only slow the recording down.
  const workers = asked ?? (follow ? Math.min(2, composeWorkers(Infinity)) : undefined);
  // Browsers start while the recording opens the app.
  const launches = follow ? Array.from({ length: workers! }, () => launchBrowser({ args: ARGS })) : [];

  let log: EventLog;
  let info: Pick<CaptureInfo, 'fps' | 'frames'>;
  let recorded = 0;
  let ended = true;
  try {
    if (follow) {
      ({ log, frames: recorded, ended } = await follow.wait(1));
      info = { fps: log.fps, frames: [] };
    } else {
      info = JSON.parse(fs.readFileSync(path.join(capture, 'capture.json'), 'utf8'));
      log = JSON.parse(fs.readFileSync(path.join(capture, 'events.json'), 'utf8'));
      if (!log.cursors || !log.carets || log.address === undefined || !log.loop)
        throw new Error(`${capture} was recorded by an older version of Take. Record it again: take record <take.json>`);
    }
  } catch (e) {
    await Promise.allSettled(launches.map((b) => b.then((b) => b.close())));
    throw e;
  }
  // The standard drawings are on the stage from the start; a site's own images join when first shown.
  const art = cursorArt(theme, themeDir);
  const { cursors, keyOf } = stageCursors(log, art);
  const html = stageHtml(theme, address ?? log.address, layout(theme, log.viewport), art);
  const staged = new Set(Object.keys(art));
  const first = range?.[0] ?? 0;
  /** Can frame f be drawn? Following a recording, waits until it has recorded frame f. False once the video
   *  has no frame f. */
  const ready = async (f: number): Promise<boolean> => {
    while (!ended && recorded <= f) ({ frames: recorded, ended } = await follow!.wait(f + 1));
    while (info.frames.length < recorded) info.frames.push(frameFile(info.frames.length));
    return f <= (range ? range[1] : totalFrames(log, theme) - 1);
  };

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  // Written next to the video and renamed at the end, so a failed run never leaves half a video in its place.
  const part = `${out}.part`;
  const browsers: Browser[] = [];
  const ffmpeg = encoder(part, info.fps);
  let frames = 0;
  try {
    // Settled, not all: a browser that fails to start must not leave the others running.
    const started = await Promise.allSettled(
      (follow ? launches : Array.from({ length: workers ?? composeWorkers(range ? range[1] - range[0] + 1 : totalFrames(log, theme)) }, () => launchBrowser({ args: ARGS })))
        .map(async (launch) => {
          const browser = await launch;
          browsers.push(browser);
          const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale });
          // The stage loads frames and theme files from disk through a made-up host.
          await page.route(`${HOST}**`, (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
            const [root, rel] = url.pathname.startsWith('/theme/') ? [themeDir, url.pathname.slice(7)] : [capture, url.pathname.slice(1)];
            const file = path.join(root, decodeURIComponent(rel));
            if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
            return route.fulfill({ path: file });
          });
          await page.goto(HOST);
          await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.querySelectorAll('img.cursor')].map((i) => (i as HTMLImageElement).decode())]));
          await page.evaluate(() => (window as unknown as { setup: () => void }).setup());
          return page;
        }),
    );
    const failed = started.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const pages = started.map((r) => (r as PromiseFulfilledResult<Page>).value);

    // Browser i draws every n-th frame, each in turn; the pictures reach ffmpeg in frame order.
    const queues: Promise<unknown>[] = pages.map(() => Promise.resolve());
    const onEvery = (fn: (page: Page) => Promise<unknown>) => pages.forEach((page, i) => (queues[i] = queues[i].then(() => fn(page))));
    const draw = (f: number): Promise<Buffer> => {
      const overlay = overlayAt(log, theme, f);
      const cursor = keyOf(overlay.shape);
      if (cursor && !staged.has(cursor)) {
        // A site's own cursor image: every browser gets its drawing before drawing this frame.
        staged.add(cursor);
        const { src, hotspot } = cursors[cursor];
        onEvery((page) => page.evaluate((c) => (window as unknown as { addCursor: (c: unknown) => Promise<void> }).addCursor(c), { key: cursor, src, hotspot }));
      }
      const state = { footage: footageAt(info as CaptureInfo, log, theme, f), overlay: { ...overlay, cursor } };
      const i = (f - first) % pages.length;
      const jpeg = queues[i].then(async () => {
        await pages[i].evaluate((s) => (window as unknown as { render: (s: unknown) => Promise<void> }).render(s), state);
        return pages[i].screenshot({ type: 'jpeg', quality: 95 });
      });
      queues[i] = jpeg.catch(() => {}); // a failure is thrown where the frame is awaited, in order
      return jpeg;
    };
    /** Sends the oldest frame to ffmpeg. False when ffmpeg has stopped (the reason comes from `done`). */
    const ahead: Promise<Buffer>[] = [];
    const send = async (): Promise<boolean> => {
      const jpeg = await ahead.shift()!;
      if (ffmpeg.failed()) return false;
      if (!ffmpeg.stdin.write(jpeg)) await Promise.race([new Promise((r) => ffmpeg.stdin.once('drain', r)), ffmpeg.done]);
      frames++;
      return true;
    };
    let going = true;
    // Every browser busy, but only a few frames ahead of ffmpeg.
    for (let f = first; going && (await ready(f)); f++) {
      ahead.push(draw(f));
      if (ahead.length >= 2 * pages.length) going = await send();
    }
    while (going && ahead.length) going = await send();
    ffmpeg.stdin.end();
    await ffmpeg.done;
    fs.renameSync(part, out);
  } catch (e) {
    // Closing its input first: ffmpeg waiting for the next picture doesn't notice a polite stop.
    ffmpeg.stdin.destroy();
    ffmpeg.kill('SIGKILL');
    fs.rmSync(part, { force: true });
    throw e;
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    // A launch still on its way when something failed.
    await Promise.allSettled(launches.map((b) => b.then((b) => b.close())));
  }
  return { file: out, size, frames, seconds: frames / info.fps, renderSeconds: +((performance.now() - t0) / 1000).toFixed(2) };
}

const ARGS = ['--force-color-profile=srgb', '--hide-scrollbars'];

/** H.264, constant frame rate, yuv420p (limited range, BT.709), +faststart: plays everywhere. */
function encoder(out: string, fps: number) {
  const proc = spawn('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    // Chromium's JPEGs are full-range BT.601; convert to the limited-range BT.709 players expect.
    '-vf', 'scale=in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high',
    '-r', String(fps), '-fps_mode', 'cfr',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-f', 'mp4', out,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let failure: Error | undefined;
  proc.stderr.on('data', (d) => (err += d));
  // ffmpeg missing, or gone mid-video: writing to it fails too, but `done` carries the reason.
  proc.stdin.on('error', () => {});
  const done = new Promise<void>((resolve, reject) => {
    const fail = (e: Error) => reject((failure ??= e));
    proc.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? new Error("ffmpeg isn't installed (or isn't on the PATH). Run take doctor to see how to install it.") : e));
    proc.on('close', (code) => (code === 0 ? resolve() : fail(new Error(`ffmpeg failed (${code}): ${err.trim()}`))));
  });
  done.catch(() => {}); // awaited by the caller; this only stops an early failure counting as unhandled
  return Object.assign(proc, { done, failed: () => failure }) as typeof proc & {
    stdin: NodeJS.WritableStream & { destroy(): void };
    done: Promise<void>;
    failed: () => Error | undefined;
  };
}
