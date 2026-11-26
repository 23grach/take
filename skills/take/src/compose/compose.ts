import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from '../browser-binary.ts';
import { frameFile, type CaptureInfo } from '../drivers/web/capture.ts';
import type { EventLog, PageTop } from '../drivers/web/events.ts';
import { followedAddress, type Appearance, type Device } from '../take/format.ts';
import { stageHtml, focusLayout, layout, themeFor, type Theme } from './stage.ts';
import { bandAt, fingerAt, keyboardAt, KEYBOARD_SLIDE, nextInk, pageTops, phoneLayout, phoneStageHtml, safariAt, type Ink, type PhoneTheme } from './phone.ts';
import { ease } from '../drivers/web/pacing.ts';
import type { Cursor } from '../drivers/web/cursor.ts';
import { cursorArt, type ArtSet } from './cursor-art.ts';
import type { StageCursor } from './stage.ts';
import { addSound, readSound } from './sound.ts';
import type { FocusLook } from '../drivers/web/focus.ts';
import { mediaTool } from '../media-tools.ts';

export interface ComposeOptions {
  capture: string;
  out: string;
  theme?: string;
  appearance?: Appearance;
  address?: string;
  range?: [number, number];
  follow?: Follow;
  workers?: number;
}

export interface Progress {
  log: EventLog;
  frames: number;
  ended: boolean;
}

export interface Follow {
  wait(frames: number): Promise<Progress>;
}

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
  size: [number, number];
  frames: number;
  seconds: number;
  renderSeconds: number;
}

const THEMES = fileURLToPath(new URL('../../themes/', import.meta.url));
const HOST = 'http://take.local/';

export function composeWorkers(frames: number, cpus = os.availableParallelism(), memory = os.totalmem()): number {
  return Math.max(1, Math.min(4, Math.floor(cpus / 2), Math.floor(memory / 3 / 2 ** 30), Math.ceil(frames / 120)));
}

export const themeNames = () => fs.readdirSync(THEMES).filter((d) => fs.existsSync(path.join(THEMES, d, 'tokens.json'))).sort();

export function themeProblem(name: string, device: Device = 'desktop'): string | undefined {
  if (!themeNames().includes(name)) return `there's no theme "${name}". Themes: ${themeNames().join(', ')}`;
  if (device === 'phone' && !loadTheme(name).theme.phone) return phoneLessTheme(name);
  return undefined;
}

const phoneLessTheme = (name: string) => `the "${name}" theme has no phone look; use the default theme for phone takes`;

const NO_FFMPEG = "ffmpeg isn't installed (or isn't on the PATH). Run take doctor to see how to install it.";

export function ffmpegProblem(): string | undefined {
  const r = spawnSync(mediaTool('ffmpeg'), ['-hide_banner', '-version'], { stdio: 'ignore' });
  return r.error ? NO_FFMPEG : undefined;
}

export function loadTheme(name = 'default'): { theme: Theme; dir: string } {
  const dir = path.join(THEMES, name);
  const problem = themeProblem(name);
  if (problem) throw new Error(problem);
  return { theme: JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')), dir };
}

export function focusLook(name: string): { light: FocusLook; dark: FocusLook } {
  const { theme } = loadTheme(name);
  const light = theme.focus;
  const dark = themeFor(theme, 'dark').focus;
  if (!light || !dark) throw new Error(`the "${name}" theme has no look for component videos; use the default theme`);
  return { light, dark };
}

export function phoneLook(theme: Theme, name: string): PhoneTheme {
  if (!theme.phone) throw new Error(phoneLessTheme(name));
  return theme.phone;
}

export function pageAppearance(frame: string): Appearance {
  const r = spawnSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', frame, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1024 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error(NO_FFMPEG);
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr?.toString().trim() || r.error?.message}`);
  return r.stdout[0] < 128 ? 'dark' : 'light';
}

export function totalFrames(log: EventLog, theme: Theme): number {
  return log.frames + (log.loop === 'crossfade-to-start' ? theme.loop.frames : 0);
}

export function loopProgress(log: EventLog, theme: Theme, f: number): number {
  if (f < log.frames) return 0;
  return ease((f - log.frames + 1) / (theme.loop.frames + 1));
}

export function darknessAt(log: EventLog, theme: Theme, start: Appearance, f: number): number {
  const level = (a: Appearance) => (a === 'dark' ? 1 : 0);
  const changes = log.appearances ?? [];
  const g = Math.min(f, log.frames - 1);
  let dark = level(start);
  for (let i = 0; i < changes.length && changes[i][0] <= g; i++) {
    const [from, to] = changes[i];
    const next = changes[i + 1]?.[0];
    const until = next !== undefined && next <= g ? next : g;
    dark += (level(to) - dark) * ease(Math.min(1, (until - from) / theme.appearance.frames));
  }
  return dark + (level(start) - dark) * loopProgress(log, theme, f);
}

export function addressAt(log: EventLog, theme: Theme, shown: string, f: number): string {
  const urls = log.urls ?? [];
  if (urls.length < 2 || loopProgress(log, theme, f) > 0.5) return shown;
  const now = urls.findLast(([frame]) => frame <= f) ?? urls[0];
  return followedAddress(shown, urls[0][1], now[1]);
}

export function footageAt(info: CaptureInfo, log: EventLog, theme: Theme, f: number) {
  const p = loopProgress(log, theme, f);
  return { src: info.frames[Math.min(f, info.frames.length - 1)], fade: p > 0 ? { src: info.frames[0], opacity: p } : null };
}

export function shapeAt(log: EventLog, f: number): Cursor {
  let shape: Cursor = 'default';
  for (const [frame, s] of log.cursors) {
    if (frame > f) break;
    shape = s;
  }
  return shape;
}

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
export function opacityAt(log: EventLog, theme: Theme, f: number): number {
  if (log.noCursor) return 0;
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

export function cursorOpacity(log: EventLog, theme: Theme): number[] {
  return Array.from({ length: totalFrames(log, theme) }, (_, f) => opacityAt(log, theme, f));
}

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

export function shapeChanges(log: EventLog, theme: Theme): [number, Cursor][] {
  const changes = [...log.cursors];
  if (log.loop !== 'crossfade-to-start') return changes;
  let f = log.frames;
  while (f < totalFrames(log, theme) - 1 && loopProgress(log, theme, f) < 0.5) f++;
  changes.push([f, shapeAt(log, 0)]);
  return changes;
}

export function shapeMixAt(log: EventLog, theme: Theme, f: number): { shape: Cursor; from: Cursor; mix: number } {
  const changes = shapeChanges(log, theme);
  let i = -1;
  for (let j = 0; j < changes.length && changes[j][0] <= f; j++) i = j;
  const shape = i >= 0 ? changes[i][1] : 'default';
  const from = i >= 1 ? changes[i - 1][1] : shape;
  const since = i >= 0 ? f - changes[i][0] : Infinity;
  const mix = since < theme.cursor.morph ? ease((since + 1) / (theme.cursor.morph + 1)) : 1;
  return { shape, from: mix < 1 ? from : shape, mix };
}

export function overlayAt(log: EventLog, theme: Theme, f: number) {
  const opacity = opacityAt(log, theme, f);
  const shapes = shapeMixAt(log, theme, f);
  if (f >= log.frames) {
    const [a, b] = [log.pointer[log.pointer.length - 1], log.pointer[0]];
    const p = loopProgress(log, theme, f);
    return { x: a[0] + (b[0] - a[0]) * p, y: a[1] + (b[1] - a[1]) * p, ...shapes, opacity, pressed: false, caret: caretAt(log, theme, f) };
  }
  const [x, y] = log.pointer[f];
  const downs = log.events.filter((e) => e.type === 'down');
  const ups = log.events.filter((e) => e.type === 'up');
  const pressed = downs.some((d) => {
    const up = ups.find((u) => u.frame >= d.frame);
    return f >= d.frame && f < (up?.frame ?? Infinity);
  });
  return { x, y, ...shapes, opacity, pressed, caret: caretAt(log, theme, f) };
}

export async function compose({ capture, out, theme: themeName = 'default', appearance, address, range, follow, workers: asked }: ComposeOptions): Promise<ComposeResult> {
  const { theme: base, dir: themeDir } = loadTheme(themeName);
  const t0 = performance.now();
  const workers = asked ?? (follow ? Math.min(2, composeWorkers(Infinity)) : undefined);
  const launches = follow ? Array.from({ length: workers! }, () => launchBrowser({ args: ARGS })) : [];

  let log: EventLog;
  let info: Pick<CaptureInfo, 'fps' | 'frames' | 'shows'>;
  let recorded = 0;
  let ended = true;
  let theme: Theme;
  let start: Appearance;
  try {
    if (follow) {
      ({ log, frames: recorded, ended } = await follow.wait(1));
      info = { fps: log.fps, frames: [], ...(log.focus ? { shows: log.focus } : {}) };
    } else {
      info = JSON.parse(fs.readFileSync(path.join(capture, 'capture.json'), 'utf8'));
      log = JSON.parse(fs.readFileSync(path.join(capture, 'events.json'), 'utf8'));
      if (!log.cursors || !log.carets || log.address === undefined || !log.loop)
        throw new Error(`${capture} was recorded by an older version of Take. Record it again: take record <take.json>`);
      log.device ??= 'desktop';
      if (log.device === 'phone' && !log.tops) throw new Error(`${capture} was recorded by an older version of Take. Record it again: take record <take.json>`);
    }
    start = appearance ?? pageAppearance(path.join(capture, info.frames[0] ?? frameFile(0)));
    theme = themeFor(base, start);
  } catch (e) {
    await Promise.allSettled(launches.map((b) => b.then((b) => b.close())));
    throw e;
  }
  const phone = log.device === 'phone' ? phoneLook(theme, themeName) : undefined;
  const focus = log.focus && focusLook(themeName);
  const [W, H] = focus ? focus.light.size : base.stage.size;
  const size: [number, number] = focus ? focus.light.size : base.stage.output;
  const scale = size[0] / W;
  const shown = address ?? log.address;
  const art = cursorArt(theme, themeDir);
  const { cursors, keyOf } = stageCursors(log, art);
  const box = log.focus ? focusLayout(log.viewport, log.focus, [W, H]) : layout(theme, log.viewport);
  const bare = focus && { size: focus.light.size, shows: info.shows ?? { x: 0, y: 0, width: log.viewport[0], height: log.viewport[1] } };
  const html = phone
    ? phoneStageHtml(theme, phone, themeDir, phoneLayout(theme, phone, log.viewport), log.viewport, shown)
    : log.appearances && base.dark
      ? stageHtml(base, shown, box, art, themeDir, themeFor(base, 'dark'), bare)
      : stageHtml(theme, shown, box, art, themeDir, undefined, bare);
  const staged = new Set(Object.keys(art));
  const first = range?.[0] ?? 0;
  const ahead = phone ? Math.max(phone.finger.lead, KEYBOARD_SLIDE) : 0;
  const ready = async (f: number): Promise<boolean> => {
    while (!ended && recorded <= f + ahead) ({ frames: recorded, ended } = await follow!.wait(f + ahead + 1));
    while (info.frames.length < recorded) info.frames.push(frameFile(info.frames.length));
    return f <= (range ? range[1] : totalFrames(log, theme) - 1);
  };

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const part = `${out}.part`;
  const mixed = `${out}.sound.part`;
  const browsers: Browser[] = [];
  const ffmpeg = encoder(part, info.fps);
  let frames = 0;
  try {
    const started = await Promise.allSettled(
      (follow ? launches : Array.from({ length: workers ?? composeWorkers(range ? range[1] - range[0] + 1 : totalFrames(log, theme)) }, () => launchBrowser({ args: ARGS })))
        .map(async (launch) => {
          const browser = await launch;
          browsers.push(browser);
          const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale });
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

    const queues: Promise<unknown>[] = pages.map(() => Promise.resolve());
    const onEvery = (fn: (page: Page) => Promise<unknown>) => pages.forEach((page, i) => (queues[i] = queues[i].then(() => fn(page))));
    const desktopState = (f: number) => {
      const overlay = overlayAt(log, theme, f);
      const [cursor, from] = [keyOf(overlay.shape), keyOf(overlay.from)];
      for (const key of [from, cursor])
        if (key && !staged.has(key)) {
          staged.add(key);
          const { src, hotspot } = cursors[key];
          onEvery((page) => page.evaluate((c) => (window as unknown as { addCursor: (c: unknown) => Promise<void> }).addCursor(c), { key, src, hotspot }));
        }
      return { footage: footageAt(info as CaptureInfo, log, theme, f), overlay: { ...overlay, cursor, from }, address: addressAt(log, theme, shown, f), dark: darknessAt(log, theme, start, f) };
    };
    let tops: PageTop[] = [];
    const bandOf = (g: number) => {
      if (tops.length < log.frames) tops = pageTops(log.tops!, log.frames);
      const { pieces, cover } = bandAt(tops, g);
      return { cover, pieces: pieces.map((p) => ('frame' in p ? { top: p.top, height: p.height, row: p.row, src: info.frames[p.frame] } : p)) };
    };
    const inks: Ink[] = [];
    let measured = Promise.resolve();
    const inkUpTo = (g: number) => (measured = measured.then(async () => {
      while (inks.length <= g) {
        const luma = await pages[0].evaluate((band) => (window as unknown as { luma: (band: unknown) => Promise<number> }).luma(band), bandOf(inks.length));
        inks.push(nextInk(inks.at(-1), luma, phone!.ink));
      }
    }));
    const phoneState = async (look: PhoneTheme, f: number) => {
      const g = Math.min(f, log.frames - 1);
      await inkUpTo(g);
      const loop = loopProgress(log, theme, f);
      const keyboard = keyboardAt(log, look.keyboard, f, loop);
      const footage = footageAt(info as CaptureInfo, log, theme, f);
      return {
        footage: { ...footage, band: bandOf(g), fade: footage.fade && { ...footage.fade, band: bandOf(0) } },
        caret: caretAt(log, theme, f),
        finger: fingerAt(log, look.finger, f),
        dark: ease(inks[g].amount + (inks[0].amount - inks[g].amount) * loop),
        lift: keyboard.lift,
        bar: safariAt(log, look.safari, f, loop),
        keyboard,
        address: addressAt(log, theme, shown, f),
      };
    };
    const draw = (f: number): Promise<Buffer> => {
      const state = phone ? phoneState(phone, f) : desktopState(f);
      const i = (f - first) % pages.length;
      const jpeg = queues[i].then(async () => {
        await pages[i].evaluate((s) => (window as unknown as { render: (s: unknown) => Promise<void> }).render(s), await state);
        return pages[i].screenshot({ type: 'jpeg', quality: 95 });
      });
      queues[i] = jpeg.catch(() => {});
      return jpeg;
    };
    const ahead: Promise<Buffer>[] = [];
    const send = async (): Promise<boolean> => {
      const jpeg = await ahead.shift()!;
      if (ffmpeg.failed()) return false;
      if (!ffmpeg.stdin.write(jpeg)) await Promise.race([new Promise((r) => ffmpeg.stdin.once('drain', r)), ffmpeg.done]);
      frames++;
      return true;
    };
    let going = true;
    for (let f = first; going && (await ready(f)); f++) {
      ahead.push(draw(f));
      if (ahead.length >= 2 * pages.length) going = await send();
    }
    while (going && ahead.length) going = await send();
    ffmpeg.stdin.end();
    await ffmpeg.done;
    const sound = readSound(capture);
    const seconds = frames / info.fps;
    const loopFrom = log.loop === 'crossfade-to-start' && log.frames - first < frames ? (log.frames - first) / info.fps : undefined;
    if (sound && (await addSound(part, mixed, sound, capture, { seconds, offset: first / info.fps, fadeFrom: loopFrom }))) {
      replaceKeepingPrevious(mixed, out);
      fs.rmSync(part);
    } else replaceKeepingPrevious(part, out);
  } catch (e) {
    ffmpeg.stdin.destroy();
    ffmpeg.kill('SIGKILL');
    fs.rmSync(part, { force: true });
    fs.rmSync(mixed, { force: true });
    throw e;
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    await Promise.allSettled(launches.map((b) => b.then((b) => b.close())));
  }
  return { file: out, size, frames, seconds: frames / info.fps, renderSeconds: +((performance.now() - t0) / 1000).toFixed(2) };
}

const ARGS = ['--force-color-profile=srgb', '--hide-scrollbars'];

function encoder(out: string, fps: number) {
  const proc = spawn(mediaTool('ffmpeg'), [
    '-v', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv:flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p,'
      + 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=iec61966-2-1',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high',
    '-r', String(fps), '-fps_mode', 'cfr',
    '-movflags', '+faststart', '-f', 'mp4', out,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let failure: Error | undefined;
  proc.stderr.on('data', (d) => (err += d));
  proc.stdin.on('error', () => {});
  const done = new Promise<void>((resolve, reject) => {
    const fail = (e: Error) => reject((failure ??= e));
    proc.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? new Error(NO_FFMPEG) : e));
    proc.on('close', (code) => (code === 0 ? resolve() : fail(new Error(`ffmpeg failed (${code}): ${err.trim()}`))));
  });
  done.catch(() => {});
  return Object.assign(proc, { done, failed: () => failure }) as typeof proc & {
    stdin: NodeJS.WritableStream & { destroy(): void };
    done: Promise<void>;
    failed: () => Error | undefined;
  };
}

const previousOf = (video: string) => video.replace(/(\.mp4)?$/i, '.previous.mp4');

function replaceKeepingPrevious(fresh: string, video: string) {
  if (fs.existsSync(video)) fs.renameSync(video, previousOf(video));
  fs.renameSync(fresh, video);
}
