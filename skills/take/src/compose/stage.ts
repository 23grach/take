import type { CursorArt } from './cursor-art.ts';

export interface Theme {
  stage: { size: [number, number]; output: [number, number]; background: string; padding: number };
  window: {
    radius: number;
    shadow: string;
    border: string;
    bar: { height: number; background: string; divider: string };
    dots: { size: number; gap: number; outlineWidth: number } & Record<WindowButton, { fill: string; outline: string }>;
    address: { show: boolean; width: number; height: number; background: string; color: string; font: string };
  };
  cursor: { art?: 'system'; size: number; pressScale: number; hideFade: number; shapes: Record<'arrow' | 'hand' | 'text', { file: string; hotspot: [number, number] }> };
  caret: { width: number; solidFrames: number; blinkFrames: number };
  loop: { frames: number };
}

export type WindowButton = 'close' | 'minimize' | 'zoom';
const BUTTONS: WindowButton[] = ['close', 'minimize', 'zoom'];

export interface Layout {
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

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export type StageCursor = Omit<CursorArt, 'size'> & { size?: [number, number] };

export function stageHtml(theme: Theme, address: string, box: Layout, cursors: Record<string, StageCursor>): string {
  const { window: win, cursor } = theme;
  const [W, H] = theme.stage.size;
  const keys = Object.keys(cursors);
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: ${theme.stage.background}; }
  .window { position: absolute; left: ${box.left}px; top: ${box.top}px; width: ${box.width}px; height: ${box.height}px;
    border-radius: ${win.radius}px; box-shadow: ${win.shadow}; overflow: hidden; background: #fff; }
  .window::after { content: ""; position: absolute; inset: 0; border-radius: inherit; border: ${win.border}; pointer-events: none; }
  .bar { height: ${win.bar.height}px; background: ${win.bar.background}; border-bottom: 1px solid ${win.bar.divider};
    box-sizing: border-box; display: flex; align-items: center; padding: 0 ${win.bar.height / 2 - win.dots.size / 2 + 2}px; position: relative; }
  .dot { width: ${win.dots.size}px; height: ${win.dots.size}px; border-radius: 50%; margin-right: ${win.dots.gap}px; }
${BUTTONS.map((b) => `  .dot.${b} { background: ${win.dots[b].fill}; box-shadow: inset 0 0 0 ${win.dots.outlineWidth}px ${win.dots[b].outline}; }`).join('\n')}
  .address { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: ${win.address.width}px; height: ${win.address.height}px;
    border-radius: ${win.address.height / 2}px; background: ${win.address.background}; color: ${win.address.color}; font: ${win.address.font};
    display: ${win.address.show ? 'flex' : 'none'}; align-items: center; justify-content: center; }
  .content { position: absolute; left: 0; top: ${win.bar.height}px; width: ${box.width}px; height: ${box.height - win.bar.height}px; overflow: hidden; }
  .content img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  #caret { position: absolute; left: 0; top: 0; display: none; }
  .cursor { position: absolute; left: 0; top: 0; visibility: hidden; }
</style>
<div class="window">
  <div class="bar">${BUTTONS.map((b) => `<span class="dot ${b}"></span>`).join('')}<div class="address">${esc(address)}</div></div>
  <div class="content"><img id="shot" alt=""><img id="fade" alt="" style="opacity: 0"><div id="caret"></div></div>
</div>
${keys.map((key, i) => `<img class="cursor" data-key="${esc(key)}" id="cursor-${i}" src="${esc(cursors[key].src)}" alt="">`).join('')}
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
  const shot = document.getElementById('shot'), fade = document.getElementById('fade');
  const sx = (x) => box.contentLeft + x * box.k, sy = (y) => box.contentTop + y * box.k;
  const show = async (img, src) => { if (img.getAttribute('src') !== src) { img.src = src; await img.decode(); } };
  window.render = async ({ footage, overlay: o }) => {
    await show(shot, footage.src);
    if (footage.fade) await show(fade, footage.fade.src);
    fade.style.opacity = footage.fade ? footage.fade.opacity : 0;
    const caret = document.getElementById('caret'), c = o.caret;
    caret.style.display = c && c.opacity > 0 ? 'block' : 'none';
    if (c) {
      const w = Math.max(1, Math.round(${theme.caret.width} * box.k));
      Object.assign(caret.style, { left: Math.round(c.x * box.k) + 'px', top: Math.round(c.y * box.k) + 'px', width: w + 'px', height: Math.round(c.height * box.k) + 'px', background: c.color, opacity: c.opacity });
    }
    for (const c of Object.values(byKey)) c.style.visibility = 'hidden';
    const cur = o.cursor && byKey[o.cursor];
    if (cur) {
      const h = art[o.cursor].hotspot;
      cur.style.visibility = o.opacity > 0 ? 'visible' : 'hidden';
      cur.style.opacity = o.opacity;
      cur.style.transform = 'translate(' + (sx(o.x) - h[0] * box.k) + 'px,' + (sy(o.y) - h[1] * box.k) + 'px) scale(' + (o.pressed ? pressScale : 1) + ')';
    }
  };
</script>`;
}
