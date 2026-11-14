// Turns a capture (frames + events) into a finished video: the footage sits in a browser window on a
// background, and the cursor and click ripples are drawn on top from the event log.
// The stage is an HTML page rendered in Chromium, one screenshot per video frame, piped into ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from '../browser-binary.ts';
import type { CaptureInfo } from '../drivers/web/capture.ts';
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
}

export interface ComposeResult {
  file: string;
  /** Video size in pixels. */
  size: [number, number];
  frames: number;
  seconds: number;
  renderSeconds: number;
}

const THEMES = new URL('../../themes/', import.meta.url).pathname;
const HOST = 'http://take.local/';

export function loadTheme(name = 'default'): { theme: Theme; dir: string } {
  const dir = path.join(THEMES, name);
  if (!fs.existsSync(path.join(dir, 'tokens.json'))) throw new Error(`theme "${name}" not found in ${THEMES}`);
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
 *  when there's no drawing for it), a site's own image as itself; `none` shows nothing, as in the browser. */
export function stageCursors(log: EventLog, art: ArtSet) {
  const cursors: Record<string, StageCursor> = { ...art };
  const sites: string[] = [];
  for (const [, c] of log.cursors) {
    if (typeof c === 'object' && !sites.includes(c.image)) {
      cursors[`site-${sites.length}`] = { src: c.image, hotspot: c.hotspot ?? [0, 0] };
      sites.push(c.image);
    }
  }
  const keyOf = (c: Cursor): string | null =>
    typeof c === 'object' ? `site-${sites.indexOf(c.image)}` : c === 'none' ? null : art[c] ? c : 'default';
  return { cursors, keyOf };
}

const opacityCache = new WeakMap<EventLog, number[]>();
/** Cursor opacity for every video frame. Like macOS, the cursor hides when typing starts and comes back as soon
 *  as it moves; both fade over theme.cursor.hideFade frames so it never pops. */
export function cursorOpacity(log: EventLog, theme: Theme): number[] {
  const cached = opacityCache.get(log);
  if (cached) return cached;
  const keys = new Set(log.events.filter((e) => e.type === 'key').map((e) => e.frame));
  const step = 1 / Math.max(1, theme.cursor.hideFade);
  const out: number[] = [];
  let hiding = false;
  let o = 1;
  for (let f = 0; f < totalFrames(log, theme); f++) {
    const [a, b] = [log.pointer[Math.min(f, log.frames - 1)], log.pointer[Math.max(0, Math.min(f - 1, log.frames - 1))]];
    if (keys.has(f)) hiding = true;
    else if (f >= log.frames || a[0] !== b[0] || a[1] !== b[1]) hiding = false;
    o = hiding ? Math.max(0, o - step) : Math.min(1, o + step);
    out.push(o);
  }
  opacityCache.set(log, out);
  return out;
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

/** What the cursor and ripples look like in one video frame. Pure: depends only on the log, the theme and the frame. */
export function overlayAt(log: EventLog, theme: Theme, f: number) {
  const opacity = cursorOpacity(log, theme)[f] ?? 1;
  if (f >= log.frames) {
    // The loop: the cursor glides back to where it started, arriving as the footage does, and takes on the
    // starting shape halfway, as the first frame fades in under it.
    const [a, b] = [log.pointer[log.pointer.length - 1], log.pointer[0]];
    const p = loopProgress(log, theme, f);
    const shape = p < 0.5 ? shapeAt(log, log.frames - 1) : shapeAt(log, 0);
    return { x: a[0] + (b[0] - a[0]) * p, y: a[1] + (b[1] - a[1]) * p, shape, opacity, pressed: false, ripples: [], caret: caretAt(log, theme, f) };
  }
  const [x, y] = log.pointer[f];
  const downs = log.events.filter((e) => e.type === 'down');
  const ups = log.events.filter((e) => e.type === 'up');
  const pressed = downs.some((d) => {
    const up = ups.find((u) => u.frame >= d.frame);
    return f >= d.frame && f < (up?.frame ?? Infinity);
  });
  const r = theme.ripple;
  const ripples = [];
  for (const d of downs) {
    if (d.type !== 'down') continue;
    // The ripple starts a few frames before the press (anticipation), gathers to the contact size on the
    // press, then spreads out and fades.
    const t = f - (d.frame - r.lead);
    if (t < 0 || t >= r.frames) continue;
    const easeOut = (u: number) => 1 - (1 - u) ** 3;
    if (t < r.lead) {
      const u = easeOut(t / r.lead);
      ripples.push({ x: d.x, y: d.y, radius: r.from + (r.contact - r.from) * u, opacity: u });
    } else {
      const u = (t - r.lead) / (r.frames - r.lead);
      ripples.push({ x: d.x, y: d.y, radius: r.contact + (r.to - r.contact) * easeOut(u), opacity: (1 - u) ** 1.5 });
    }
  }
  return { x, y, shape: shapeAt(log, f), opacity, pressed, ripples, caret: caretAt(log, theme, f) };
}

export async function compose({ capture, out, theme: themeName = 'default', address, range }: ComposeOptions): Promise<ComposeResult> {
  const info: CaptureInfo = JSON.parse(fs.readFileSync(path.join(capture, 'capture.json'), 'utf8'));
  const log: EventLog = JSON.parse(fs.readFileSync(path.join(capture, 'events.json'), 'utf8'));
  if (!log.cursors || !log.carets || log.address === undefined || !log.loop)
    throw new Error(`${capture} was recorded by an older version of Take. Record it again: take record <take.json>`);
  const { theme, dir: themeDir } = loadTheme(themeName);
  const { cursors, keyOf } = stageCursors(log, cursorArt(theme, themeDir));
  const [first, last] = range ?? [0, totalFrames(log, theme) - 1];
  const [W, H] = theme.stage.size;
  const box = layout(theme, log.viewport);
  const html = stageHtml(theme, address ?? log.address, box, cursors);
  // Videos are 2560×1440: the 1920×1080 stage at a higher pixel density, so every theme length keeps its look.
  const scale = theme.stage.output[0] / W;
  const size = theme.stage.output;

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const t0 = performance.now();
  const browser = await launchBrowser({ args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
  const ffmpeg = encoder(out, info.fps);
  try {
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

    for (let f = first; f <= last; f++) {
      if (ffmpeg.failed()) break; // the reason comes from `done` below
      const overlay = overlayAt(log, theme, f);
      const state = { footage: footageAt(info, log, theme, f), overlay: { ...overlay, cursor: keyOf(overlay.shape) } };
      await page.evaluate((s) => (window as unknown as { render: (s: unknown) => Promise<void> }).render(s), state);
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 95 });
      if (!ffmpeg.stdin.write(jpeg)) await Promise.race([new Promise((r) => ffmpeg.stdin.once('drain', r)), ffmpeg.done]);
    }
    ffmpeg.stdin.end();
    await ffmpeg.done;
  } catch (e) {
    ffmpeg.kill();
    throw e;
  } finally {
    await browser.close();
  }
  const frames = last - first + 1;
  return { file: out, size, frames, seconds: frames / info.fps, renderSeconds: +((performance.now() - t0) / 1000).toFixed(2) };
}

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
    '-movflags', '+faststart', out,
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
    stdin: NodeJS.WritableStream;
    done: Promise<void>;
    failed: () => Error | undefined;
  };
}
