import type { CaptureInfo } from '../drivers/web/capture.ts';
import type { Cursor } from '../drivers/web/cursor.ts';
import type { EventLog } from '../drivers/web/events.ts';
import { ease } from '../drivers/web/pacing.ts';
import { followedAddress } from '../take/address.ts';
import type { Appearance } from '../take/format.ts';
import type { ArtSet } from './cursor-art.ts';
import type { StageCursor, Theme } from './stage.ts';

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
function opacityAt(log: EventLog, theme: Theme, f: number): number {
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

export function caretOnFrame(log: EventLog, theme: Theme, f: number) {
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

function shapeChanges(log: EventLog, theme: Theme): [number, Cursor][] {
  const changes = [...log.cursors];
  if (log.loop !== 'crossfade-to-start') return changes;
  let f = log.frames;
  while (f < totalFrames(log, theme) - 1 && loopProgress(log, theme, f) < 0.5) f++;
  changes.push([f, shapeAt(log, 0)]);
  return changes;
}

function shapeMixAt(log: EventLog, theme: Theme, f: number): { shape: Cursor; from: Cursor; mix: number } {
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
    return { x: a[0] + (b[0] - a[0]) * p, y: a[1] + (b[1] - a[1]) * p, ...shapes, opacity, pressed: false, caret: caretOnFrame(log, theme, f) };
  }
  const [x, y] = log.pointer[f];
  const downs = log.events.filter((e) => e.type === 'down');
  const ups = log.events.filter((e) => e.type === 'up');
  const pressed = downs.some((d) => {
    const up = ups.find((u) => u.frame >= d.frame);
    return f >= d.frame && f < (up?.frame ?? Infinity);
  });
  return { x, y, ...shapes, opacity, pressed, caret: caretOnFrame(log, theme, f) };
}
