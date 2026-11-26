import fs from 'node:fs';
import path from 'node:path';
import type { CursorArt } from './cursor-art.ts';
import type { PhoneTheme } from './phone.ts';
import type { Appearance } from '../take/format.ts';
import type { FocusLook } from '../drivers/web/focus.ts';
import type { Box } from '../drivers/web/events.ts';
import { escapeHtml } from '../escape-html.ts';

export interface Theme {
  stage: { size: [number, number]; output: [number, number]; background: string; padding: number };
  window: {
    radius: number;
    background: string;
    shadow: string;
    border: string;
    bar: { height: number; padding: [number, number]; background: string; divider: string };
    dots: { size: number; gap: number; outlineWidth: number } & Record<WindowButton, { fill: string; outline: string }>;
    address: { show: boolean; width: number; color: string; font: string };
    toolbar?: Toolbar;
  };
  cursor: { art?: 'system'; size: number; pressScale: number; morph: number; hideFade: number; shapes: Record<'arrow' | 'hand' | 'text', { file: string; hotspot: [number, number] }> };
  caret: { width: number; solidFrames: number; blinkFrames: number };
  loop: { frames: number };
  appearance: { frames: number };
  focus?: FocusLook;
  phone?: PhoneTheme;
  dark?: Overrides<Pick<Theme, 'stage' | 'window' | 'focus'>>;
}

interface Glass {
  fill: string[];
  ring: { width: number; top: string; side: string };
  specular: { width: number; color: string; reach: number };
  shadow: string;
}

interface Toolbar {
  height: number;
  navGap: number;
  navButton: number;
  button: number;
  glyph: string;
  glyphOff: string;
  separator: string;
  glass: Glass;
  icons: Record<ToolbarIcon, string>;
}

type ToolbarIcon = 'back' | 'forward' | 'reload' | 'share' | 'newTab' | 'tabs';

type Overrides<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? Overrides<T[K]> : T[K] };

function overlaid<T>(base: T, over: unknown): T {
  if (typeof over !== 'object' || over === null || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over)) out[key] = overlaid(out[key], value);
  return out as T;
}

export const themeFor = (theme: Theme, appearance: Appearance): Theme => (appearance === 'dark' && theme.dark ? overlaid(theme, theme.dark) : theme);

type WindowButton = 'close' | 'minimize' | 'zoom';
const BUTTONS: WindowButton[] = ['close', 'minimize', 'zoom'];

interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
  contentLeft: number;
  contentTop: number;
  k: number;
}

export function layout(theme: Theme, viewport: [number, number]): Layout {
  const [W, H] = theme.stage.size;
  const P = theme.stage.padding;
  const bar = theme.window.bar.height;
  const k = Math.min((W - 2 * P) / viewport[0], (H - 2 * P - bar) / viewport[1]);
  const width = Math.round(viewport[0] * k);
  const height = Math.round(viewport[1] * k) + bar;
  const left = Math.round((W - width) / 2);
  const top = Math.round((H - height) / 2);
  return { left, top, width, height, contentLeft: left, contentTop: top + bar, k: width / viewport[0] };
}

export function focusLayout(viewport: [number, number], region: Box, [W]: [number, number]): Layout {
  const k = W / region.width;
  const left = -region.x * k;
  const top = -region.y * k;
  return { left, top, width: viewport[0] * k, height: viewport[1] * k, contentLeft: left, contentTop: top, k };
}

export type StageCursor = Omit<CursorArt, 'size'> & { size?: [number, number] };

type Stop = [color: string, offset: string, opacity?: number];

function glassArt(g: Glass, width: number, height: number): string {
  const gradient = (id: string, stops: Stop[]) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">${stops
    .map(([color, offset, opacity = 1]) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`).join('')}</linearGradient>`;
  const shape = (inset: number, paint: string) =>
    `<rect x="${inset}" y="${inset}" width="${width - 2 * inset}" height="${height - 2 * inset}" rx="${height / 2 - inset}" fill="url(#${paint})"/>`;
  const { ring, specular } = g;
  const reach = specular.reach * 100;
  const fill = g.fill.map((stop): Stop => [stop.slice(0, stop.lastIndexOf(' ')), stop.slice(stop.lastIndexOf(' ') + 1)]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${gradient('fill', fill)}`
    + gradient('ring', [[ring.top, '0%'], [ring.side, '50%'], [ring.top, '100%']])
    + gradient('light', [[specular.color, '0%'], [specular.color, `${reach}%`, 0], [specular.color, `${100 - reach}%`, 0], [specular.color, '100%']])
    + `</defs>${shape(0, 'ring')}${shape(ring.width, 'fill')}${shape(ring.width, 'light')}${shape(ring.width + specular.width, 'fill')}</svg>`;
  return `background: url("data:image/svg+xml,${encodeURIComponent(svg)}") center / 100% 100% no-repeat; box-shadow: ${g.shadow};`;
}

function toolbarParts(win: Theme['window'], themeDir: string, address: string): { css: string; nav: string; address: string; actions: string } {
  const bar = win.toolbar;
  const field = (glass: string, inner: string) => `<div class="address${glass}">${inner}<span class="address-text">${escapeHtml(address)}</span></div>`;
  if (!bar) return { css: '', nav: '', address: field('', ''), actions: '' };
  const icon = (name: ToolbarIcon) => `<i class="icon">${fs.readFileSync(path.join(themeDir, bar.icons[name]), 'utf8').trim()}</i>`;
  const tool = (name: ToolbarIcon, width: number, off = false) => `<span class="tool${off ? ' off' : ''}" style="width: ${width}px">${icon(name)}</span>`;
  const css = `
  .glass { position: relative; height: ${bar.height}px; border-radius: ${bar.height / 2}px; display: flex; align-items: center; color: ${bar.glyph}; }
  .tool { height: 100%; display: flex; align-items: center; justify-content: center; }
  .tool.off { color: ${bar.glyphOff}; }
  .icon { display: block; line-height: 0; font-style: normal; }
  .icon svg { display: block; }
  .separator { width: 1px; height: ${Math.round(bar.height * 0.55)}px; background: ${bar.separator}; }
  .nav { margin-left: ${bar.navGap - win.dots.gap}px; ${glassArt(bar.glass, 2 * bar.navButton + 1, bar.height)} }
  .actions { margin-left: auto; ${glassArt(bar.glass, 3 * bar.button, bar.height)} }
  .glass.address { position: absolute; justify-content: center; ${glassArt(bar.glass, win.address.width, bar.height)} }
  .address .icon { position: absolute; right: ${(bar.height - 12) / 2}px; top: 50%; transform: translateY(-50%); }`;
  return {
    css,
    nav: `<div class="glass nav">${tool('back', bar.navButton)}<span class="separator"></span>${tool('forward', bar.navButton, true)}</div>`,
    address: field(' glass', icon('reload')),
    actions: `<div class="glass actions">${tool('share', bar.button)}${tool('newTab', bar.button)}${tool('tabs', bar.button)}</div>`,
  };
}

function sceneCss(theme: Theme, box: Layout, toolbarCss: string): string {
  const win = theme.window;
  const fieldHeight = win.toolbar?.height ?? 0;
  return `
  & { position: absolute; inset: 0; background: ${theme.stage.background}; }
  .window { position: absolute; left: ${box.left}px; top: ${box.top}px; width: ${box.width}px; height: ${box.height}px;
    border-radius: ${win.radius}px; box-shadow: ${win.shadow}; overflow: hidden; background: ${win.background}; }
  .window::after { content: ""; position: absolute; inset: 0; border-radius: inherit; border: ${win.border}; pointer-events: none; }
  .bar { height: ${win.bar.height}px; background: ${win.bar.background}; border-bottom: 1px solid ${win.bar.divider};
    box-sizing: border-box; display: flex; align-items: center; padding: 0 ${win.bar.padding[1]}px 0 ${win.bar.padding[0]}px; position: relative; }
  .dot { width: ${win.dots.size}px; height: ${win.dots.size}px; border-radius: 50%; margin-right: ${win.dots.gap}px; }
${BUTTONS.map((b) => `  .dot.${b} { background: ${win.dots[b].fill}; box-shadow: inset 0 0 0 ${win.dots.outlineWidth}px ${win.dots[b].outline}; }`).join('\n')}
  .address { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: ${win.address.width}px; height: ${fieldHeight}px;
    color: ${win.address.color}; font: ${win.address.font}; display: ${win.address.show ? 'flex' : 'none'}; align-items: center; justify-content: center; }${toolbarCss}
  .content { position: absolute; left: 0; top: ${win.bar.height}px; width: ${box.width}px; height: ${box.height - win.bar.height}px; overflow: hidden; }
  .content img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .caret { position: absolute; left: 0; top: 0; display: none; }`;
}

interface Bare {
  size: [number, number];
  shows: Box;
}

function bareSceneCss(theme: Theme, box: Layout, shows: Box): string {
  const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
  return `
  & { position: absolute; inset: 0; background: ${theme.focus!.background}; overflow: hidden; }
  .window { position: absolute; left: ${px(box.left)}; top: ${px(box.top)}; width: ${px(box.width)}; height: ${px(box.height)}; }
  .content { position: absolute; inset: 0; }
  .content img { position: absolute; left: ${px(shows.x * box.k)}; top: ${px(shows.y * box.k)}; width: ${px(shows.width * box.k)}; height: ${px(shows.height * box.k)}; display: block; }
  .caret { position: absolute; left: 0; top: 0; display: none; }`;
}

const bareSceneHtml = (look: string) => `<div class="scene ${look}">
  <div class="window"><div class="content"><img class="shot" alt=""><img class="fade" alt="" style="opacity: 0"><div class="caret"></div></div></div>
</div>`;

function sceneHtml(look: string, theme: Theme, themeDir: string, address: string): string {
  const parts = toolbarParts(theme.window, themeDir, address);
  return `<div class="scene ${look}">
  <div class="window">
    <div class="bar">${BUTTONS.map((b) => `<span class="dot ${b}"></span>`).join('')}${parts.nav}${parts.address}${parts.actions}</div>
    <div class="content"><img class="shot" alt=""><img class="fade" alt="" style="opacity: 0"><div class="caret"></div></div>
  </div>
</div>`;
}

export function stageHtml(theme: Theme, address: string, box: Layout, cursors: Record<string, StageCursor>, themeDir: string, dark?: Theme, bare?: Bare): string {
  const { cursor } = theme;
  const looks: [string, Theme][] = dark ? [['light', theme], ['dark', dark]] : [['only', theme]];
  const [W, H] = bare?.size ?? theme.stage.size;
  const css = (t: Theme) => (bare ? bareSceneCss(t, box, bare.shows) : sceneCss(t, box, toolbarParts(t.window, themeDir, address).css));
  const html = (look: string, t: Theme) => (bare ? bareSceneHtml(look) : sceneHtml(look, t, themeDir, address));
  const keys = Object.keys(cursors);
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
${looks.map(([look, t]) => `  .scene.${look} {${css(t)}\n  }`).join('\n')}
  .scene.dark { opacity: 0; }
  .cursor { position: absolute; left: 0; top: 0; visibility: hidden; }
</style>
${looks.map(([look, t]) => html(look, t)).join('\n')}
${keys.map((key, i) => `<img class="cursor" data-key="${escapeHtml(key)}" id="cursor-${i}" src="${escapeHtml(cursors[key].src)}" alt="">`).join('')}
<script>
  const box = ${JSON.stringify(box)};
  const art = ${JSON.stringify(Object.fromEntries(keys.map((key) => [key, { size: cursors[key].size, hotspot: cursors[key].hotspot, shadow: cursors[key].shadow }])))};
  const pressScale = ${cursor.pressScale};
  const byKey = {};
  const fit = (img) => {
    const a = art[img.dataset.key], k = box.k;
    const [w, h] = a.size ?? [img.naturalWidth, img.naturalHeight];
    Object.assign(img.style, { width: w * k + 'px', height: h * k + 'px', transformOrigin: a.hotspot[0] * k + 'px ' + a.hotspot[1] * k + 'px',
      filter: a.shadow ? 'drop-shadow(0 ' + a.shadow.y * k + 'px ' + a.shadow.blur * k + 'px rgb(0 0 0 / ' + a.shadow.alpha + '))' : 'none' });
    byKey[img.dataset.key] = img;
  };
  window.setup = () => { for (const img of document.querySelectorAll('.cursor')) fit(img); };
  window.addCursor = async ({ key, src, hotspot }) => {
    art[key] = { hotspot };
    const img = Object.assign(document.createElement('img'), { className: 'cursor', alt: '', src });
    img.dataset.key = key;
    document.body.append(img);
    await img.decode();
    fit(img);
  };
  const scenes = [...document.querySelectorAll('.scene')];
  const darkScene = document.querySelector('.scene.dark');
  const sx = (x) => box.contentLeft + x * box.k, sy = (y) => box.contentTop + y * box.k;
  const show = async (img, src) => { if (img.getAttribute('src') !== src) { img.src = src; await img.decode(); } };
  const caretWidth = Math.max(1, Math.round(${theme.caret.width} * box.k));
  const paint = async (scene, footage, c, address) => {
    const addressText = scene.querySelector('.address-text');
    if (addressText && addressText.textContent !== address) addressText.textContent = address;
    const fade = scene.querySelector('.fade');
    await show(scene.querySelector('.shot'), footage.src);
    if (footage.fade) await show(fade, footage.fade.src);
    fade.style.opacity = footage.fade ? footage.fade.opacity : 0;
    const caret = scene.querySelector('.caret');
    caret.style.display = c && c.opacity > 0 ? 'block' : 'none';
    if (c) Object.assign(caret.style, { left: Math.round(c.x * box.k) + 'px', top: Math.round(c.y * box.k) + 'px', width: caretWidth + 'px', height: Math.round(c.height * box.k) + 'px', background: c.color, opacity: c.opacity });
  };
  window.render = async ({ footage, overlay: o, address, dark }) => {
    if (darkScene) darkScene.style.opacity = dark;
    const shown = darkScene ? scenes.filter((s) => (s === darkScene ? dark > 0 : dark < 1)) : scenes;
    await Promise.all(shown.map((s) => paint(s, footage, o.caret, address)));
    for (const c of Object.values(byKey)) c.style.visibility = 'hidden';
    const place = (key, opacity) => {
      const img = key && byKey[key];
      if (!img) return;
      const h = art[key].hotspot;
      img.style.visibility = opacity > 0 ? 'visible' : 'hidden';
      img.style.opacity = opacity;
      img.style.transform = 'translate(' + (sx(o.x) - h[0] * box.k) + 'px,' + (sy(o.y) - h[1] * box.k) + 'px) scale(' + (o.pressed ? pressScale : 1) + ')';
    };
    if (o.from !== o.cursor) place(o.from, o.opacity * (1 - o.mix));
    place(o.cursor, o.from === o.cursor ? o.opacity : o.opacity * o.mix);
  };
</script>`;
}
