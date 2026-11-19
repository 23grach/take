import fs from 'node:fs';
import path from 'node:path';
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
  safari: { morph: number; collapseAfter: number; blur: number; font: string; pillFont: string; pillPadding: number; pillWidth: number };
  keyboard: { pressFrames: number; lead: number; blur: number; letterFont: string; labelFont: string; suggestionFont: string; calloutFont: string };
  icons: Record<string, string>;
  light: Colors;
  dark: Colors;
  finger: { size: number; lead: number; lift: number; from: number; liftTo: number; fill: string; border: string; shadow: string };
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
export type BandPiece = Rows & ({ color: string } | { frame: number; row: number });
export interface Band {
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

export interface Finger {
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

export function safariCollapses(events: Event[], after: number): [number, boolean][] {
  const changes: [number, boolean][] = [];
  let [y, collapsed] = [0, false];
  for (const e of events) {
    if (e.type !== 'scroll' || !e.dy) continue;
    y = Math.max(0, y + e.dy);
    const want = e.dy > 0 && y > after;
    if (want !== collapsed) changes.push([e.frame, (collapsed = want)]);
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

type Layout = 'letters' | 'numbers';
const LETTERS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const NUMBERS = ['1234567890', '-/:;()€&@"', ".,?!'"];
const ON_NUMBERS = new Set([...NUMBERS.join('')]);
const NAMED: Record<string, string> = { ' ': 'space', Enter: 'return', Backspace: 'delete' };

function keyFor(key: string): { key: string; layout: Layout; shift: boolean; callout: boolean } | null {
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
  layout: Layout;
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
  const changes = safariCollapses(log.events, look.collapseAfter);
  const end = toggled(changes, Math.min(f, log.frames - 1), look.morph);
  return end + (toggled(changes, 0, look.morph) - end) * loop;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function keyboardHtml(icon: (name: string) => string, layout: Layout): string {
  const rows = layout === 'letters' ? LETTERS : NUMBERS;
  const chars = (keys: string) => [...keys].map((c) => `<div class="key char" data-key="${esc(c)}"><span>${esc(c)}</span></div>`).join('');
  const toggle = layout === 'letters' ? '<span class="label">123</span>' : '<span class="label">ABC</span>';
  const side = layout === 'letters'
    ? `<div class="key side" data-key="shift">${icon('shift')}${icon('shiftOn')}</div>`
    : `<div class="key side" data-key="symbols">${icon('symbols')}</div>`;
  return `<div class="layout" data-layout="${layout}">
      <div class="row">${chars(rows[0])}</div>
      <div class="row${layout === 'letters' ? ' inset' : ''}">${chars(rows[1])}</div>
      <div class="row third">${side}<div class="center">${chars(rows[2])}</div><div class="key side" data-key="delete">${icon('delete')}</div></div>
      <div class="row bottom"><div class="key wide" data-key="toggle">${toggle}</div><div class="key space" data-key="space"></div><div class="key wide" data-key="return">${icon('return')}</div></div>
    </div>`;
}

function softEdge({ blur, depth, steps }: PhoneTheme['edge'], k: number): string {
  const band = depth / steps;
  return Array.from({ length: steps }, (_, i) => {
    const mask = `linear-gradient(to bottom, #000 ${(depth - (i + 1) * band) * k}px, transparent ${(depth - i * band) * k}px)`;
    const each = (blur / steps) * Math.sqrt(2 * i + 1) * k;
    return `<div class="soft-edge" style="height: ${(depth + 3 * blur) * k}px; backdrop-filter: blur(${each}px); -webkit-mask-image: ${mask}; mask-image: ${mask};"></div>`;
  }).join('');
}

export function phoneStageHtml(theme: Theme, phone: PhoneTheme, themeDir: string, box: PhoneLayout, page: [number, number], address: string): string {
  const [W, H] = theme.stage.size;
  const { statusBar: bar, finger, safari, keyboard: kb } = phone;
  const [sw, sh] = PHONE.screen;
  const file = (name: string) => fs.readFileSync(path.join(themeDir, name), 'utf8').trim();
  const icon = (name: string) => `<i class="icon ${kebab(name)}">${file(phone.icons[name])}</i>`;
  const art = `/theme/${encodeURIComponent(phone.art)}`;
  const place = (l: number, t: number, w: number, h: number) => `left: ${l}px; top: ${t}px; width: ${w}px; height: ${h}px;`;
  const domain = address.split('/')[0];
  const colors = Object.keys(phone.light)
    .map((name) => `--${kebab(name)}: color-mix(in srgb, ${phone.light[name]}, ${phone.dark[name]} calc(var(--dark) * 100%));`)
    .join('\n    ');
  const { top: kbTop, accessory } = PHONE.keyboard;
  const band = box.statusBar * box.k;
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: ${theme.stage.background}; -webkit-font-smoothing: antialiased; }
  .art { position: absolute; ${place(box.left, box.top, box.width, box.height)} display: block; }
  .art.shadow { filter: ${phone.shadow}; }
  .backing { position: absolute; ${place(box.screenLeft - 1, box.screenTop - 1, box.screenWidth + 2, box.screenHeight + 2)} border-radius: ${box.screenRadius + 1}px; background: #000; }
  .screen { position: absolute; ${place(box.screenLeft, box.screenTop, box.screenWidth, box.screenHeight)} border-radius: ${box.screenRadius}px; overflow: hidden;
    --dark: 0;
    ${colors} }
  .viewport { position: absolute; inset: 0; filter: opacity(1); }
  .scene { position: absolute; inset: 0; }
  .band { position: absolute; left: 0; top: 0; width: 100%; height: ${band + 1}px; display: block; }
  .page { position: absolute; left: 0; top: ${band}px; width: 100%; height: ${page[1] * box.k}px; overflow: hidden; }
  .page img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .soft-edge { position: absolute; left: 0; top: 0; width: 100%; pointer-events: none; }
  #caret { position: absolute; left: 0; top: 0; display: none; }
  .points { position: absolute; transform: scale(${box.k}); transform-origin: 0 0; pointer-events: none; }
  .ui { left: 0; top: 0; width: ${sw}px; height: ${sh}px; }
  .status { position: absolute; left: 0; top: 0; width: ${sw}px; height: ${box.statusBar}px; display: flex; align-items: center; justify-content: center;
    padding: 11px 8px 0; box-sizing: border-box; color: var(--ink); }
  .time { flex: 1; height: 13px; display: flex; align-items: center; justify-content: center; font: ${bar.font}; white-space: nowrap; }
  .island { width: 95px; align-self: stretch; }
  .levels { flex: 1; display: flex; gap: 8px; align-items: center; justify-content: center; }
  .cellular { display: flex; gap: 2.333px; align-items: flex-end; padding-top: 1.333px; }
  .cellular i { width: 3.333px; border-radius: 4px; background: currentColor; }
  .levels svg { display: block; }
  .icon { position: absolute; display: block; line-height: 0; font-style: normal; }
  .icon svg { display: block; }
  .glass { position: absolute; border-radius: 24px; backdrop-filter: blur(${safari.blur}px); background: var(--glass-fill);
    box-shadow: 0 2px 40px var(--glass-shadow), 1.25px 0 0 -0.75px var(--glass-ring), -1.25px 0 0 -0.75px var(--glass-ring), 0 0 0 0.5px var(--glass-ring-outer), 0 8px 15px var(--glass-drop); }
  .glass::after { content: ""; position: absolute; inset: 0; border-radius: inherit;
    box-shadow: inset 0 0 0 0.5px var(--glass-border), inset 0 0.5px 0 var(--glass-inset-dark), inset 0 1.5px 1px var(--glass-inset-light); }
  .button { width: 48px; height: 48px; top: ${sh - PHONE.safariBar}px; color: var(--glyph); }
  #back { left: 34px; } #tabs { left: 320px; }
  .glass > .icon { top: 50%; translate: 0 -50%; }
  .button > .icon { left: 50%; translate: -50% -50%; }
  #field { color: var(--glyph); }
  #field .menu { left: 14px; } #field .reload { right: 12.64px; }
  .address { position: absolute; left: 40px; right: 40px; top: 50%; transform: translateY(-50%); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .address.big { font: ${safari.font}; letter-spacing: -0.4522px; padding-left: 1px; }
  .address.small { left: 0; right: 0; font: ${safari.pillFont}; letter-spacing: 0.12px; color: var(--pill-text); }
  #keys { position: absolute; left: 0; top: ${accessory}px; width: ${sw}px; }
  #accessory { left: 17px; top: 0; width: 368px; height: 48px; color: var(--accessory-glyph); }
  #accessory .up { left: 14.73px; } #accessory .down { left: 68.73px; } #accessory .done { left: 333px; }
  .keyboard { position: absolute; left: 0; top: ${kbTop + 95 - accessory}px; width: ${sw}px; height: ${sh - kbTop - 95}px; box-sizing: border-box; padding: 8px 4px 0;
    border-radius: 27px 27px 62.16px 62.16px; background: var(--kb-background); backdrop-filter: blur(${kb.blur}px);
    box-shadow: inset 0 0 0 1px var(--kb-border), inset 0 1px 2px var(--kb-inset-soft), inset 0 0 1px var(--kb-inset-hair); }
  .suggestions { height: 39px; display: flex; align-items: center; font: ${kb.suggestionFont}; color: var(--suggestion); }
  .suggestions span { flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 6px; }
  .suggestions i { width: 1px; height: 24px; border-radius: 1px; background: var(--divider); }
  .layout { padding-top: 8px; display: flex; flex-direction: column; gap: 10px; position: relative; }
  .layout + .layout { display: none; }
  .row { display: flex; gap: 6px; height: 45px; }
  .row.inset { padding: 0 16px; }
  .row.third { gap: 14px; }
  .center { flex: 1; display: flex; gap: 6px; }
  .key { position: relative; flex: 1; min-width: 0; border-radius: 8.5px; background: var(--key); color: var(--key-text);
    display: flex; align-items: center; justify-content: center; }
  .key.down { background: var(--key-pressed); }
  .key.char span { font: ${kb.letterFont}; margin-top: -5px; }
  .shifted .layout[data-layout="letters"] .key.char span { text-transform: uppercase; }
  .key.side { flex: 0 0 42px; }
  .key.wide { flex: 0 0 91px; }
  .key .icon { position: static; }
  .key .label { font: ${kb.labelFont}; letter-spacing: -0.32px; }
  .key .shift-on, .shifted .key .shift { display: none; }
  .shifted .key .shift-on { display: block; }
  .kb-icon { color: var(--kb-icon); }
  .kb-icon.emoji { left: 29px; bottom: 26px; } .kb-icon.mic { left: 350.07px; bottom: 25.4px; }
  .callout { position: absolute; display: none; filter: drop-shadow(0 0 0.5px rgb(0 0 0 / 0.25)) drop-shadow(0 4px 10px rgb(0 0 0 / 0.18)); }
  .callout svg { position: absolute; inset: 0; overflow: visible; }
  .callout path { fill: var(--callout); }
  .callout span { position: absolute; left: 0; right: 0; top: 2px; text-align: center; font: ${kb.calloutFont}; color: var(--key-text); }
  .touch { left: ${box.contentLeft}px; top: ${box.contentTop}px; width: ${page[0]}px; height: ${page[1]}px; }
  #finger { position: absolute; left: 0; top: 0; width: ${finger.size}px; height: ${finger.size}px; margin: ${-finger.size / 2}px 0 0 ${-finger.size / 2}px;
    border-radius: 50%; box-sizing: border-box; background: ${finger.fill}; border: ${finger.border}; box-shadow: ${finger.shadow}; visibility: hidden; }
</style>
<img class="art shadow" src="${art}" alt="">
<div class="backing"></div>
<div class="screen" id="screen">
  <div class="viewport">
    <div class="scene" id="scene">
      <canvas class="band" id="band"></canvas><canvas class="band" id="band-fade" style="opacity: 0"></canvas>
      <div class="page"><img id="shot" alt=""><img id="fade" alt="" style="opacity: 0"><div id="caret"></div></div>
    </div>
    ${softEdge(phone.edge, box.k)}
  </div>
  <div class="points ui">
    <div class="status">
      <div class="time">${esc(bar.time)}</div>
      <div class="island"></div>
      <div class="levels">
        <div class="cellular">${[6.333, 8.67, 11, 13.667].map((h) => `<i style="height: ${h}px"></i>`).join('')}</div>
        ${file(bar.wifi)}
        ${file(bar.battery)}
      </div>
    </div>
    <div class="glass button" id="back">${icon('back')}</div>
    <div class="glass button" id="tabs">${icon('tabs')}</div>
    <div id="keys">
      <div class="glass" id="accessory">${icon('up')}${icon('down')}${icon('done')}</div>
      <div class="keyboard" id="keyboard">
        <div class="suggestions"><span></span><i></i><span id="word"></span><i></i><span></span></div>
        ${keyboardHtml(icon, 'letters')}
        ${keyboardHtml(icon, 'numbers')}
        <div class="kb-icon emoji icon">${file(phone.icons.emoji)}</div>
        <div class="kb-icon mic icon">${file(phone.icons.mic)}</div>
        <div class="callout" id="callout"><svg><path></path></svg><span></span></div>
      </div>
    </div>
    <div class="glass" id="field">${icon('menu')}${icon('reload')}<div class="address big">${esc(domain)}</div><div class="address small">${esc(domain)}</div></div>
  </div>
</div>
<img class="art" src="${art}" alt="">
<div class="points touch"><div id="finger"></div></div>
<script>
  const k = ${box.k};
  const $ = (id) => document.getElementById(id);
  const shot = $('shot'), fade = $('fade'), band = $('band'), bandFade = $('band-fade');
  const screen = $('screen'), scene = $('scene'), finger = $('finger'), field = $('field'), keys = $('keys'), keyboard = $('keyboard');
  const back = $('back'), tabs = $('tabs'), word = $('word'), callout = $('callout');
  const big = field.querySelector('.address.big'), small = field.querySelector('.address.small');
  const fieldIcons = [...field.querySelectorAll('.icon')];
  const layouts = [...keyboard.querySelectorAll('.layout')];
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (t) => Math.min(1, Math.max(0, t));
  let pill = ${safari.pillWidth};
  const show = async (img, src) => { if (img.getAttribute('src') !== src) { img.src = src; await img.decode(); } };
  const images = new Map();
  const image = (src) => {
    if (!images.has(src)) {
      const img = new Image();
      img.src = src;
      images.set(src, img.decode().then(() => img));
      if (images.size > 16) images.delete(images.keys().next().value);
    }
    return images.get(src);
  };
  const paint = async (ctx, { pieces, cover }, s) => {
    const { width: w, height: h } = ctx.canvas;
    const sources = await Promise.all(pieces.map((p) => p.src && image(p.src)));
    ctx.clearRect(0, 0, w, h);
    pieces.forEach((p, i) => {
      const [y0, y1] = [Math.round(p.top * s), i === pieces.length - 1 ? h : Math.round((p.top + p.height) * s)];
      if (y1 <= y0) return;
      if (p.color) {
        ctx.fillStyle = p.color;
        return ctx.fillRect(0, y0, w, y1 - y0);
      }
      const img = sources[i], q = img.naturalWidth / ${page[0]}, rows = ((y1 - y0) / s) * q;
      const from = Math.max(0, Math.min(img.naturalHeight - rows, (p.row + y0 / s - p.top) * q));
      ctx.drawImage(img, 0, from, img.naturalWidth, rows, 0, y0, w, y1 - y0);
    });
    if (cover) {
      ctx.fillStyle = cover;
      ctx.fillRect(0, 0, w, h);
    }
  };
  const fit = (canvas) => {
    const [w, h] = [Math.round(canvas.offsetWidth * devicePixelRatio), Math.round(canvas.offsetHeight * devicePixelRatio)];
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    return canvas.getContext('2d');
  };
  const meter = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  meter.canvas.width = ${page[0]};
  meter.canvas.height = ${PHONE.statusBar};
  window.luma = async (band) => {
    await paint(meter, band, 1);
    const px = meter.getImageData(0, 0, meter.canvas.width, meter.canvas.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    return sum / (px.length / 4);
  };
  window.setup = async () => {
    await Promise.all([...document.querySelectorAll('img.art')].map((img) => img.decode()));
    small.style.position = 'static';
    pill = Math.max(${safari.pillWidth}, small.scrollWidth + ${2 * safari.pillPadding});
    small.style.position = '';
  };
  const offset = (el) => {
    let [x, y] = [0, 0];
    for (let e = el; e && e !== keyboard; e = e.offsetParent) [x, y] = [x + e.offsetLeft, y + e.offsetTop];
    return [x, y];
  };
  const bubble = (w, h, spread, lift, neck, shiftX) => {
    const B = w + 2 * spread, L = spread - shiftX, R = L + w, T = lift - neck, Hh = lift + h, r = 8.5, top = 10;
    return 'M' + top + ' 0H' + (B - top) + 'Q' + B + ' 0 ' + B + ' ' + top + 'V' + T
      + 'C' + B + ' ' + (T + neck * 0.55) + ' ' + R + ' ' + (T + neck * 0.45) + ' ' + R + ' ' + lift + 'V' + (Hh - r) + 'Q' + R + ' ' + Hh + ' ' + (R - r) + ' ' + Hh
      + 'H' + (L + r) + 'Q' + L + ' ' + Hh + ' ' + L + ' ' + (Hh - r) + 'V' + lift
      + 'C' + L + ' ' + (T + neck * 0.45) + ' 0 ' + (T + neck * 0.55) + ' 0 ' + T + 'V' + top + 'Q0 0 ' + top + ' 0Z';
  };
  window.render = async ({ footage, caret: c, finger: t, dark, lift, bar, keyboard: kb }) => {
    const s = ${band / PHONE.statusBar} * devicePixelRatio;
    await Promise.all([show(shot, footage.src), paint(fit(band), footage.band, s)]);
    if (footage.fade) await Promise.all([show(fade, footage.fade.src), paint(fit(bandFade), footage.fade.band, s)]);
    fade.style.opacity = bandFade.style.opacity = footage.fade ? footage.fade.opacity : 0;
    screen.style.setProperty('--dark', dark);
    scene.style.transform = 'translateY(' + (-lift * k) + 'px)';

    const folded = Math.max(bar, kb.up);
    const w = lerp(218, pill, folded), h = lerp(48, 28, folded);
    const y = lerp(lerp(${sh - PHONE.safariBar}, 828, folded), ${kbTop}, kb.up);
    Object.assign(field.style, { left: (${sw} - w) / 2 + 'px', top: y + 'px', width: w + 'px', height: h + 'px', borderRadius: Math.min(24, h / 2) + 'px' });
    const loud = clamp(1 - folded * 2), quiet = clamp(folded * 2 - 1);
    big.style.opacity = loud;
    small.style.opacity = quiet;
    for (const i of fieldIcons) i.style.opacity = loud;
    for (const b of [back, tabs]) Object.assign(b.style, { opacity: 1 - folded, transform: 'translateY(' + (y - ${sh - PHONE.safariBar}) + 'px) scale(' + (1 - 0.25 * folded) + ')' });

    keys.style.opacity = kb.opacity;
    keys.style.visibility = kb.up > 0 && kb.opacity > 0 ? 'visible' : 'hidden';
    keys.style.transform = 'translateY(' + (1 - kb.up) * ${sh - accessory + 20} + 'px)';
    keyboard.classList.toggle('shifted', kb.shift);
    for (const l of layouts) l.style.display = l.dataset.layout === kb.layout ? 'flex' : 'none';
    word.textContent = kb.word;
    callout.style.display = 'none';
    for (const el of keyboard.querySelectorAll('.key.down')) el.classList.remove('down');
    const layout = layouts.find((l) => l.dataset.layout === kb.layout);
    const key = kb.pressed && [...layout.querySelectorAll('.key')].find((e) => e.dataset.key === kb.pressed);
    if (key && kb.callout) {
      const [x, y0] = offset(key), kw = key.offsetWidth, kh = key.offsetHeight;
      const spread = 15, lift = 60, neck = 20, B = kw + 2 * spread;
      const shiftX = Math.min(0, ${sw} - 2 - (x - spread + B)) + Math.max(0, 2 - (x - spread));
      Object.assign(callout.style, { display: 'block', left: x - spread + shiftX + 'px', top: y0 - lift + 'px', width: B + 'px', height: kh + lift + 'px' });
      const svg = callout.firstChild;
      svg.setAttribute('width', B);
      svg.setAttribute('height', kh + lift);
      svg.firstChild.setAttribute('d', bubble(kw, kh, spread, lift, neck, shiftX));
      callout.lastChild.style.height = lift - neck + 'px';
      callout.lastChild.style.lineHeight = lift - neck + 'px';
      callout.lastChild.textContent = kb.shift ? kb.pressed.toUpperCase() : kb.pressed;
    } else if (key) key.classList.add('down');

    const caret = $('caret');
    caret.style.display = c && c.opacity > 0 ? 'block' : 'none';
    if (c) {
      const cw = Math.max(1, Math.round(${theme.caret.width} * k));
      Object.assign(caret.style, { left: Math.round(c.x * k) + 'px', top: Math.round(c.y * k) + 'px', width: cw + 'px', height: Math.round(c.height * k) + 'px', background: c.color, opacity: c.opacity });
    }
    finger.style.visibility = t ? 'visible' : 'hidden';
    if (t) Object.assign(finger.style, { opacity: t.opacity, transform: 'translate(' + t.x + 'px,' + (t.y - lift) + 'px) scale(' + t.scale + ')' });
  };
</script>`;
}
