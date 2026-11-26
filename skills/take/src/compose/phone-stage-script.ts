import { PHONE } from '../take/format.ts';
import { glassTone, type PhoneLayout, type PhoneTheme } from './phone.ts';
import type { Theme } from './stage.ts';

export function phoneStageScript(theme: Theme, phone: PhoneTheme, box: PhoneLayout, page: [number, number], band: number): string {
  const { safari } = phone;
  const [sw, sh] = PHONE.screen;
  const { top: kbTop, accessory } = PHONE.keyboard;
  return `<script>
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
  const glassLook = ${JSON.stringify({ ...phone.glass, light: glassTone(phone.glass.light), dark: glassTone(phone.glass.dark) })};
  const glasses = [back, tabs, field, $('accessory')].map((el) => {
    const canvas = document.createElement('canvas');
    canvas.className = 'lens';
    el.prepend(canvas);
    return { el, canvas };
  });
  const surface = () => document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const [under, soft] = [surface(), surface()];
  const sized = (ctx, w, h) => {
    if (ctx.canvas.width !== w || ctx.canvas.height !== h) Object.assign(ctx.canvas, { width: w, height: h });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  };
  const backdrop = (x, y, w, h, res, view) => {
    const ctx = sized(under, Math.ceil(w * res), Math.ceil(h * res));
    ctx.setTransform(res, 0, 0, res, -x * res, -y * res);
    const top = ${PHONE.statusBar} - view.lift;
    ctx.drawImage(shot, 0, top, ${page[0]}, ${page[1]});
    if (view.fade > 0) {
      ctx.globalAlpha = view.fade;
      ctx.drawImage(fade, 0, top, ${page[0]}, ${page[1]});
    }
    if (view.caret && view.caret.opacity > 0) {
      ctx.globalAlpha = view.caret.opacity;
      ctx.fillStyle = view.caret.color;
      ctx.fillRect(view.caret.x, top + view.caret.y, ${theme.caret.width}, view.caret.height);
    }
    ctx.globalAlpha = 1;
    const out = sized(soft, under.canvas.width, under.canvas.height);
    out.filter = 'blur(' + glassLook.blur * res + 'px)';
    out.drawImage(under.canvas, 0, 0);
    out.filter = 'none';
    return out.getImageData(0, 0, out.canvas.width, out.canvas.height);
  };
  const glowAt = (glow, y) => {
    const next = glow.findIndex(([at]) => at >= y);
    if (next <= 0) return next === 0 ? glow[0][1] : glow.at(-1)[1];
    const [[a, ga], [b, gb]] = [glow[next - 1], glow[next]];
    return ga + (gb - ga) * (y - a) / (b - a);
  };
  const edgeAt = (look, y) => {
    const { ring, specular: spec } = look;
    const fade = y < spec.reach ? 1 - y / spec.reach : y > 1 - spec.reach ? (y - 1 + spec.reach) / spec.reach : 0;
    return { glow: glowAt(look.glow, y), ring: ring.top + (ring.side - ring.top) * (1 - Math.abs(2 * y - 1)), shine: spec.strength * fade, ringWidth: ring.width, shineWidth: spec.width };
  };
  const toneAt = (dark, y) => {
    const [l, d] = [edgeAt(glassLook.light, y), edgeAt(glassLook.dark, y)];
    return Object.fromEntries(Object.keys(l).map((name) => [name, lerp(l[name], d[name], dark)]));
  };
  const lens = ({ el, canvas }, view) => {
    const w = el.offsetWidth, h = el.offsetHeight;
    const box = el.getBoundingClientRect(), frame = screen.getBoundingClientRect();
    if (!w || !h || !box.width || getComputedStyle(el).opacity === '0' || getComputedStyle(el).visibility === 'hidden') return;
    const grow = box.width / (w * k);
    const [x0, y0] = [(box.left - frame.left) / k, (box.top - frame.top) / k];
    const res = k * devicePixelRatio, local = res * grow;
    const [cw, ch] = [Math.max(1, Math.round(w * local)), Math.max(1, Math.round(h * local))];
    if (canvas.width !== cw || canvas.height !== ch) Object.assign(canvas, { width: cw, height: ch });
    const r = Math.min(w / 2, h / 2, parseFloat(getComputedStyle(el).borderRadius) || 0);
    const bevel = glassLook.bevel * Math.min(w, h) / 2;
    const reach = 3 * glassLook.blur * grow;
    const [ax, ay] = [Math.max(0, x0 - reach), Math.max(0, y0 - reach)];
    const [bx, by] = [Math.min(${sw}, x0 + w * grow + reach), Math.min(${sh}, y0 + h * grow + reach)];
    const img = backdrop(ax, ay, bx - ax, by - ay, res, view), data = img.data, [iw, ih] = [img.width, img.height];
    const color = [0, 0, 0];
    const sample = (sx, sy) => {
      const fx = Math.min(iw - 1.001, Math.max(0, (sx - ax) * res - 0.5)), fy = Math.min(ih - 1.001, Math.max(0, (sy - ay) * res - 0.5));
      const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
      const p = 4 * (iy * iw + ix), q = p + 4 * iw;
      for (let c = 0; c < 3; c++) color[c] = (data[p + c] * (1 - tx) + data[p + 4 + c] * tx) * (1 - ty) + (data[q + c] * (1 - tx) + data[q + 4 + c] * tx) * ty;
    };
    const [gain, raise, chroma] = ['gain', 'lift', 'chroma'].map((name) => lerp(glassLook.light[name], glassLook.dark[name], view.dark));
    const rows = Array.from({ length: ch }, (_, j) => toneAt(view.dark, (j + 0.5) / ch));
    const half = 0.5 / local;
    const band = (depth, from, to) => Math.max(0, Math.min(to, depth + half) - Math.max(from, depth - half)) * local;
    const pixels = new ImageData(cw, ch), px = pixels.data;
    const [hw, hh] = [w / 2, h / 2];
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const u = (i + 0.5) / local - hw, v = (j + 0.5) / local - hh;
        const qx = Math.abs(u) - (hw - r), qy = Math.abs(v) - (hh - r);
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0), outer = Math.hypot(ox, oy);
        const depth = r - outer - Math.min(Math.max(qx, qy), 0);
        const cover = clamp(0.5 + depth * local);
        if (cover <= 0) continue;
        let nx = 0, ny = 0;
        if (outer > 0) [nx, ny] = [(ox / outer) * Math.sign(u), (oy / outer) * Math.sign(v)];
        else if (qx > qy) nx = Math.sign(u) || 1;
        else ny = Math.sign(v) || 1;
        const inner = Math.max(0, depth), shift = inner < bevel ? inner - bevel * (inner / bevel) ** glassLook.curve : 0;
        sample(x0 + (u + hw + nx * shift) * grow, y0 + (v + hh + ny * shift) * grow);
        const luma = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
        const row = rows[j], bright = gain * luma + raise * 255 + row.glow;
        const ring = row.ring * band(depth, 0, row.ringWidth), shine = row.shine * band(depth, row.ringWidth, row.ringWidth + row.shineWidth);
        const o = 4 * (j * cw + i);
        for (let c = 0; c < 3; c++) {
          const value = bright + chroma * (color[c] - luma);
          px[o + c] = (value + (255 - value) * shine) * (1 - ring);
        }
        px[o + 3] = 255 * cover;
      }
    }
    canvas.getContext('2d').putImageData(pixels, 0, 0);
  };
  window.render = async ({ footage, caret: c, finger: t, dark, lift, bar, keyboard: kb, address }) => {
    const domain = address.split('/')[0];
    if (big.textContent !== domain) big.textContent = small.textContent = domain;
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
    const view = { lift, dark, fade: footage.fade ? footage.fade.opacity : 0, caret: c };
    for (const glass of glasses) lens(glass, view);
  };
</script>`;
}
