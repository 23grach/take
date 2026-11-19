import fs from 'node:fs';
import path from 'node:path';
import type { Event, EventLog } from '../drivers/web/events.ts';
import { ease } from '../drivers/web/pacing.ts';
import type { Theme } from './stage.ts';

export interface PhoneTheme {
  art: string;
  artSize: [number, number];
  screen: [number, number, number, number];
  screenRadius: number;
  shadow: string;
  statusBar: { time: string; font: string; inkThreshold: number; wifi: string; battery: string };
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
  const contentTop = screenTop + screenHeight - page[1] * k;
  return {
    left, top, width, height,
    screenLeft, screenTop, screenWidth, screenHeight, screenRadius: phone.screenRadius * s,
    contentLeft: screenLeft, contentTop, k,
    statusBar: (contentTop - screenTop) / k,
  };
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

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function phoneStageHtml(theme: Theme, phone: PhoneTheme, themeDir: string, box: PhoneLayout, page: [number, number]): string {
  const [W, H] = theme.stage.size;
  const { statusBar: bar, finger } = phone;
  const icon = (file: string) => fs.readFileSync(path.join(themeDir, file), 'utf8').trim();
  const art = `/theme/${encodeURIComponent(phone.art)}`;
  const place = (l: number, t: number, w: number, h: number) => `left: ${l}px; top: ${t}px; width: ${w}px; height: ${h}px;`;
  const inScreen = (t: number) => t - box.screenTop;
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: ${theme.stage.background}; -webkit-font-smoothing: antialiased; }
  .art { position: absolute; ${place(box.left, box.top, box.width, box.height)} display: block; }
  .art.shadow { filter: ${phone.shadow}; }
  .backing { position: absolute; ${place(box.screenLeft - 1, box.screenTop - 1, box.screenWidth + 2, box.screenHeight + 2)} border-radius: ${box.screenRadius + 1}px; background: #000; }
  .screen { position: absolute; ${place(box.screenLeft, box.screenTop, box.screenWidth, box.screenHeight)} border-radius: ${box.screenRadius}px; overflow: hidden; }
  #strip { position: absolute; left: 0; top: 0; width: 100%; height: ${inScreen(box.contentTop) + 1}px; }
  .page { position: absolute; left: 0; top: ${inScreen(box.contentTop)}px; width: 100%; height: ${page[1] * box.k}px; overflow: hidden; }
  .page img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  #caret { position: absolute; left: 0; top: 0; display: none; }
  .points { position: absolute; transform: scale(${box.k}); transform-origin: 0 0; pointer-events: none; }
  .status { left: 0; top: 0; width: ${page[0]}px; height: ${box.statusBar}px; display: flex; align-items: center; justify-content: center;
    padding: 3px 8px 0; box-sizing: border-box; }
  .time { flex: 1; height: 13px; display: flex; align-items: center; justify-content: center; font: ${bar.font}; white-space: nowrap; }
  .island { width: 95px; align-self: stretch; }
  .levels { flex: 1; display: flex; gap: 8px; align-items: center; justify-content: center; }
  .cellular { display: flex; gap: 2.333px; align-items: flex-end; padding-top: 1.333px; }
  .cellular i { width: 3.333px; border-radius: 4px; background: currentColor; }
  .levels svg { display: block; }
  .touch { left: ${box.contentLeft}px; top: ${box.contentTop}px; width: ${page[0]}px; height: ${page[1]}px; }
  #finger { position: absolute; left: 0; top: 0; width: ${finger.size}px; height: ${finger.size}px; margin: ${-finger.size / 2}px 0 0 ${-finger.size / 2}px;
    border-radius: 50%; box-sizing: border-box; background: ${finger.fill}; border: ${finger.border}; box-shadow: ${finger.shadow}; visibility: hidden; }
</style>
<img class="art shadow" src="${art}" alt="">
<div class="backing"></div>
<div class="screen">
  <div id="strip"></div>
  <div class="page"><img id="shot" alt=""><img id="fade" alt="" style="opacity: 0"><div id="caret"></div></div>
  <div class="points status" id="status">
    <div class="time">${esc(bar.time)}</div>
    <div class="island"></div>
    <div class="levels">
      <div class="cellular">${[6.333, 8.67, 11, 13.667].map((h) => `<i style="height: ${h}px"></i>`).join('')}</div>
      ${icon(bar.wifi)}
      ${icon(bar.battery)}
    </div>
  </div>
</div>
<img class="art" src="${art}" alt="">
<div class="points touch"><div id="finger"></div></div>
<script>
  const k = ${box.k};
  const shot = document.getElementById('shot'), fade = document.getElementById('fade');
  const strip = document.getElementById('strip'), status = document.getElementById('status'), finger = document.getElementById('finger');
  const row = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const topColour = (img) => {
    row.canvas.width = img.naturalWidth;
    row.canvas.height = 1;
    row.drawImage(img, 0, 0, img.naturalWidth, 1, 0, 0, img.naturalWidth, 1);
    const px = row.getImageData(0, 0, img.naturalWidth, 1).data;
    const groups = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const key = (px[i] >> 4) * 256 + (px[i + 1] >> 4) * 16 + (px[i + 2] >> 4);
      const g = groups.get(key) ?? [0, 0, 0, 0];
      g[0] += px[i]; g[1] += px[i + 1]; g[2] += px[i + 2]; g[3]++;
      groups.set(key, g);
    }
    const [r, g, b, n] = [...groups.values()].reduce((a, c) => (c[3] > a[3] ? c : a));
    return [r / n, g / n, b / n];
  };
  const lightness = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const show = async (img, src) => { if (img.getAttribute('src') !== src) { img.src = src; await img.decode(); } };
  window.setup = () => Promise.all([...document.querySelectorAll('img.art')].map((img) => img.decode()));
  window.render = async ({ footage, caret: c, finger: t }) => {
    await show(shot, footage.src);
    if (footage.fade) await show(fade, footage.fade.src);
    const mix = footage.fade ? footage.fade.opacity : 0;
    fade.style.opacity = mix;
    let colour = topColour(shot);
    if (mix > 0) {
      const to = topColour(fade);
      colour = colour.map((v, i) => v + (to[i] - v) * mix);
    }
    strip.style.background = 'rgb(' + colour.map(Math.round).join(' ') + ')';
    status.style.color = lightness(colour) > ${bar.inkThreshold} ? '#000' : '#fff';
    const caret = document.getElementById('caret');
    caret.style.display = c && c.opacity > 0 ? 'block' : 'none';
    if (c) {
      const w = Math.max(1, Math.round(${theme.caret.width} * k));
      Object.assign(caret.style, { left: Math.round(c.x * k) + 'px', top: Math.round(c.y * k) + 'px', width: w + 'px', height: Math.round(c.height * k) + 'px', background: c.color, opacity: c.opacity });
    }
    finger.style.visibility = t ? 'visible' : 'hidden';
    if (t) Object.assign(finger.style, { opacity: t.opacity, transform: 'translate(' + t.x + 'px,' + t.y + 'px) scale(' + t.scale + ')' });
  };
</script>`;
}
