import type { Event, EventLog, PageTop } from '../drivers/web/events.ts';
import { ease, frames } from '../drivers/web/pacing.ts';
import { PHONE, phonePage } from '../take/format.ts';
import type { Theme } from './stage.ts';

type Colors = Record<string, string>;

export interface PhoneTheme {
  art: string;
  artSize: [number, number];
  screen: [number, number, number, number];
  screenRadius: number;
  shadow: string;
  statusBar: { time: string; font: string; wifi: string; battery: string };
  ink: InkRule;
  edge: { blur: number; depth: number; steps: number };
  safari: { morph: number; collapseAfter: number; font: string; pillFont: string; pillPadding: number; pillWidth: number };
  glass: GlassLook;
  keyboard: { pressFrames: number; lead: number; blur: number; letterFont: string; labelFont: string; suggestionFont: string; calloutFont: string };
  icons: Record<string, string>;
  light: Colors;
  dark: Colors;
  finger: { size: number; lead: number; lift: number; from: number; liftTo: number; fill: string; border: string; shadow: string };
}

interface GlassTone {
  gain: number;
  lift: number;
  chroma: number;
  over: string;
  fill: string[];
  ring: { width: number; top: string; side: string };
  specular: { width: number; color: string; reach: number };
}

interface GlassLook {
  blur: number;
  bevel: number;
  curve: number;
  light: GlassTone;
  dark: GlassTone;
}

const channels = (color: string): number[] => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const [r, g, b, a = '1'] = color.match(/[\d.]+/g) ?? [];
  return [Number(r), Number(g), Number(b), Number(a)];
};
const colorLuma = (color: string) => { const [r, g, b] = channels(color); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const alpha = (color: string) => channels(color)[3];

export function glassTone({ gain, lift, chroma, over, fill, ring, specular }: GlassTone) {
  const stops = fill.map((stop) => [parseFloat(stop.slice(stop.lastIndexOf(' ') + 1)) / 100, colorLuma(stop.slice(0, stop.lastIndexOf(' ')))]);
  const seen = gain * colorLuma(over) + lift * 255;
  return {
    gain, lift, chroma,
    glow: stops.map(([at, g]) => [at, g - seen]),
    ring: { width: ring.width, top: alpha(ring.top), side: alpha(ring.side) },
    specular: { width: specular.width, strength: alpha(specular.color), reach: specular.reach },
  };
}

export interface PhoneLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  screenLeft: number;
  screenTop: number;
  screenWidth: number;
  screenHeight: number;
  screenRadius: number;
  contentLeft: number;
  contentTop: number;
  k: number;
  statusBar: number;
}

export function phoneLayout(theme: Theme, phone: PhoneTheme, page: [number, number]): PhoneLayout {
  const [W, H] = theme.stage.size;
  const P = theme.stage.padding;
  const [artWidth, artHeight] = phone.artSize;
  const s = Math.min((W - 2 * P) / artWidth, (H - 2 * P) / artHeight);
  const [width, height] = [artWidth * s, artHeight * s];
  const [left, top] = [Math.round((W - width) / 2), Math.round((H - height) / 2)];
  const [x, y, w, h] = phone.screen;
  const k = (w * s) / page[0];
  const [screenLeft, screenTop, screenWidth, screenHeight] = [left + x * s, top + y * s, w * s, h * s];
  const contentTop = screenTop + PHONE.statusBar * k;
  return {
    left, top, width, height,
    screenLeft, screenTop, screenWidth, screenHeight, screenRadius: phone.screenRadius * s,
    contentLeft: screenLeft, contentTop, k,
    statusBar: PHONE.statusBar,
  };
}

export function pageTops(changes: readonly [number, PageTop][], count: number): PageTop[] {
  const tops: PageTop[] = [];
  for (let f = 0, i = 0; f < count; f++) {
    while (i + 1 < changes.length && changes[i + 1][0] <= f) i++;
    tops.push(changes[i][1]);
  }
  return tops;
}

type Rows = { top: number; height: number };
type BandPiece = Rows & ({ color: string } | { frame: number; row: number });
interface Band {
  pieces: BandPiece[];
  cover: string | null;
}

const solid = (color: string) => color.endsWith('/ 1)');

function furthest(f: number, rows: (g: number) => number | undefined, all: number): number | undefined {
  let [best, most] = [undefined as number | undefined, -Infinity];
  for (let g = f - 1; g >= 0 && most < all; g--) {
    const end = rows(g);
    if (end !== undefined && end > most) [best, most] = [g, end];
  }
  return best;
}

export function bandAt(tops: readonly PageTop[], f: number): Band {
  const [height, pageHeight] = [PHONE.statusBar, phonePage()[1]];
  const now = tops[f];
  if (now.cover && solid(now.cover)) return { pieces: [{ top: 0, height, color: now.cover }], cover: null };
  const pieces: BandPiece[] = [];
  const add = (piece: BandPiece) => {
    const last = pieces.at(-1);
    if (last && 'color' in last && 'color' in piece && last.color === piece.color) last.height += piece.height;
    else pieces.push(piece);
  };
  const docTop = now.scrollY - height;
  const filmed = (g: number): [number, number] => [tops[g].scrollY + tops[g].depth - docTop, tops[g].scrollY + pageHeight - docTop];
  const shows = (g: number, y: number) => {
    const [lo, hi] = filmed(g);
    return lo <= y && y < hi && tops[g].inner === now.inner && tops[g].scrollHeight === now.scrollHeight;
  };
  const rest = tops.slice(0, f + 1).findLast((t) => t.scrollY <= 0)?.color ?? now.color;
  const above = Math.min(height, Math.max(0, -docTop));
  if (above > 0) add({ top: 0, height: above, color: rest });
  for (let y = above; y < height;) {
    const g = furthest(f, (g) => (shows(g, y) ? filmed(g)[1] : undefined), height);
    const end = g === undefined ? Math.min(height, Math.floor(y) + 1) : Math.min(height, filmed(g)[1]);
    add(g === undefined ? { top: y, height: end - y, color: now.color } : { top: y, height: end - y, frame: g, row: docTop + y - tops[g].scrollY });
    y = end;
  }
  return { pieces, cover: now.cover };
}

interface Finger {
  x: number;
  y: number;
  opacity: number;
  scale: number;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

export function fingerAt(log: EventLog, finger: PhoneTheme['finger'], f: number): Finger | null {
  const { lead, lift, from, liftTo } = finger;
  const touches = log.events.filter((e): e is Extract<Event, { type: 'down' | 'up' }> => e.type === 'down' || e.type === 'up');
  let strongest: Finger | null = null;
  for (const [i, down] of touches.entries()) {
    if (down.type !== 'down') continue;
    const up = touches[i + 1]?.type === 'up' ? touches[i + 1] : undefined;
    const upFrame = up?.frame ?? Infinity;
    let c: Finger | null = null;
    if (f >= down.frame - lead && f < down.frame) {
      const q = easeOut((f - down.frame + lead + 1) / (lead + 1));
      c = { x: down.x, y: down.y, opacity: q, scale: from + (1 - from) * q };
    } else if (f >= down.frame && f < upFrame) {
      const [x, y] = log.pointer[Math.min(f, log.pointer.length - 1)];
      c = { x, y, opacity: 1, scale: 1 };
    } else if (up && f >= upFrame && f < upFrame + lift) {
      const r = (f - upFrame + 1) / lift;
      c = { x: up.x, y: up.y, opacity: 1 - ease(r), scale: 1 + (liftTo - 1) * easeOut(r) };
    }
    if (c && c.opacity > 0 && (!strongest || c.opacity > strongest.opacity)) strongest = c;
  }
  return strongest;
}

function glide(changes: readonly (readonly [number, number])[], f: number, n: number): number {
  let [from, to, at] = [0, 0, -Infinity];
  const value = (g: number) => from + (to - from) * ease(Math.min(1, Math.max(0, (g - at + 1) / n)));
  for (const [frame, target] of changes) {
    if (frame > f) break;
    [from, to, at] = [value(frame - 1), target, frame];
  }
  return value(f);
}

const toggled = (changes: [number, boolean][], f: number, n: number) => glide(changes.map(([frame, on]) => [frame, on ? 1 : 0]), f, n);

export function safariCollapses(events: Event[], after: number, ends: [number, boolean][] = []): [number, boolean][] {
  const changes: [number, boolean][] = [];
  let [y, down, atEnd, collapsed] = [0, false, false, false];
  const marks = [...events.flatMap((e) => (e.type === 'scroll' && e.dy ? [{ frame: e.frame, dy: e.dy }] : [])), ...ends.map(([frame, end]) => ({ frame, end }))].sort((a, b) => a.frame - b.frame);
  for (const m of marks) {
    if ('end' in m) atEnd = m.end;
    else {
      y = Math.max(0, y + m.dy);
      down = m.dy > 0 && y > after;
    }
    const want = down && !atEnd;
    if (want !== collapsed) changes.push([m.frame, (collapsed = want)]);
  }
  return changes;
}

interface InkRule {
  toDark: number;
  toLight: number;
  fade: number;
}

export interface Ink {
  dark: boolean;
  amount: number;
}

export function nextInk(ink: Ink | undefined, luma: number, rule: InkRule): Ink {
  const dark = !ink ? luma < (rule.toDark + rule.toLight) / 2 : ink.dark ? luma <= rule.toLight : luma < rule.toDark;
  if (!ink) return { dark, amount: dark ? 1 : 0 };
  const step = 1 / Math.max(1, rule.fade);
  return { dark, amount: dark ? Math.min(1, ink.amount + step) : Math.max(0, ink.amount - step) };
}

export type KeyboardLayout = 'letters' | 'numbers';
export const LETTERS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
export const NUMBERS = ['1234567890', '-/:;()€&@"', ".,?!'"];
const ON_NUMBERS = new Set([...NUMBERS.join('')]);
const NAMED: Record<string, string> = { ' ': 'space', Enter: 'return', Backspace: 'delete' };

function keyFor(key: string): { key: string; layout: KeyboardLayout; shift: boolean; callout: boolean } | null {
  if (NAMED[key]) return { key: NAMED[key], layout: 'letters', shift: false, callout: false };
  if (/^[a-z]$/.test(key)) return { key, layout: 'letters', shift: false, callout: true };
  if (/^[A-Z]$/.test(key)) return { key: key.toLowerCase(), layout: 'letters', shift: true, callout: true };
  if (ON_NUMBERS.has(key)) return { key, layout: 'numbers', shift: false, callout: true };
  return null;
}

interface KeyboardFrame {
  up: number;
  opacity: number;
  lift: number;
  layout: KeyboardLayout;
  shift: boolean;
  pressed: string | null;
  callout: boolean;
  word: string;
}

export const KEYBOARD_SLIDE = frames(PHONE.keyboard.slide);

export function keyboardAt(log: EventLog, look: PhoneTheme['keyboard'], f: number, loop: number): KeyboardFrame {
  const changes = log.keyboard ?? [];
  const at = (g: number) => ({
    up: toggled(changes.map(([frame, open]) => [frame, !!open]), g, KEYBOARD_SLIDE),
    lift: glide(changes.map(([frame, open]) => [frame, open?.lift ?? 0]), g, KEYBOARD_SLIDE),
  });
  const g = Math.min(f, log.frames - 1);
  const end = at(g);
  const start = loop > 0 ? at(0) : end;
  const shown = (s: { up: number }) => (s.up > 0 ? 1 : 0);
  const keys = log.events.filter((e): e is Extract<Event, { type: 'key' }> => e.type === 'key' && e.frame <= g + look.lead);
  const pressed = [...keys].reverse().find((e) => e.frame <= g && g < e.frame + look.pressFrames);
  const coming = keys.find((e) => e.frame > g && e.frame - look.lead <= g && keyFor(e.key));
  const pressedKey = pressed ? keyFor(pressed.key) : null;
  const mode = pressedKey ?? (coming ? keyFor(coming.key) : null);
  const opened = changes.findLast(([frame, up], i) => frame <= g && up && !changes[i - 1]?.[1])?.[0] ?? Infinity;
  let word = '';
  for (const e of keys) {
    if (e.frame < opened || e.frame > g) continue;
    if (e.key === 'Backspace') word = word.slice(0, -1);
    else if ([...e.key].length === 1 && e.key !== ' ') word += e.key;
    else word = '';
  }
  return {
    up: Math.max(end.up, start.up),
    opacity: shown(end) + (shown(start) - shown(end)) * loop,
    lift: end.lift + (start.lift - end.lift) * loop,
    layout: mode?.layout ?? 'letters',
    shift: mode?.shift ?? false,
    pressed: pressedKey?.key ?? null,
    callout: pressedKey?.callout ?? false,
    word,
  };
}

export function safariAt(log: EventLog, look: PhoneTheme['safari'], f: number, loop: number): number {
  const changes = safariCollapses(log.events, look.collapseAfter, log.ends);
  const end = toggled(changes, Math.min(f, log.frames - 1), look.morph);
  return end + (toggled(changes, 0, look.morph) - end) * loop;
}
