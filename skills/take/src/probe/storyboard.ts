import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../browser-binary.ts';
import { loadTheme } from '../compose/compose.ts';
import { cursorArt } from '../compose/cursor-art.ts';
import type { ProbeResult } from './probe.ts';
import { escapeHtml } from '../escape-html.ts';

const COLS = 3;
const W = 560;

export async function storyboard(result: ProbeResult, dir: string, out: string, { theme = 'default' } = {}): Promise<string> {
  const html = storyboardHtml(result, dir, theme);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: COLS * (W + 20) + 56, height: 600 } });
    await page.setContent(html);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await page.screenshot({ path: out, fullPage: true, type: 'jpeg', quality: 88 });
  } finally {
    await browser.close();
  }
  return out;
}

export function storyboardHtml(result: ProbeResult, dir: string, themeName: string): string {
  const { theme, dir: themeDir } = loadTheme(themeName);
  const view = result.focus ?? { x: 0, y: 0, width: result.viewport[0], height: result.viewport[1] };
  const k = W / view.width;
  const H = Math.round(view.height * k);
  const [ox, oy] = [view.x * k, view.y * k];
  const data = (file: string, type: string) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  const art = cursorArt(theme, themeDir);
  const box = (b: { x: number; y: number; width: number; height: number }, cls: string) =>
    `<div class="${cls}" style="left:${b.x * k - ox - 3}px;top:${b.y * k - oy - 3}px;width:${b.width * k + 6}px;height:${b.height * k + 6}px"></div>`;

  const shots = result.shots[1] && !result.shots[1].error && /^Hold /.test(result.shots[1].label) ? result.shots.slice(1) : result.shots;
  const cards = shots.map((s) => {
    const c: { src: string; hotspot: [number, number]; size?: [number, number] } | null = typeof s.cursor === 'object' ? { src: s.cursor.image, hotspot: s.cursor.hotspot ?? [0, 0] } : s.cursor === 'none' ? null : art[s.cursor] ?? art.default;
    const touched = s.step > 0 && !/^Hold /.test(s.label);
    const cursor = result.phone
      ? touched ? `<div class="finger" style="left:${s.pointer[0] * k - ox}px;top:${s.pointer[1] * k - oy}px"></div>` : ''
      : c && !result.noCursor ? `<img class="cursor" src="${escapeHtml(c.src)}" style="left:${s.pointer[0] * k - ox}px;top:${s.pointer[1] * k - oy}px;${c.size ? `width:${c.size[0]}px;height:${c.size[1]}px;` : ''}transform:scale(${k}) translate(${-c.hotspot[0]}px,${-c.hotspot[1]}px)">` : '';
    return `<figure class="${s.error ? 'failed' : ''}">
      <div class="shot"><img src="${data(path.join(dir, s.file), 'image/png')}">${s.target ? box(s.target, 'target') : ''}${s.waitedFor ? box(s.waitedFor, 'waited') : ''}${cursor}</div>
      <figcaption><b>${s.step === 0 ? 'Start' : s.step}</b><span>${escapeHtml(s.label)}${s.error ? `<em>${escapeHtml(s.error)}</em>` : ''}</span><i>${s.at.toFixed(1)} s</i></figcaption>
    </figure>`;
  });
  const steps = result.shots.length - 1;
  const verdict = result.ok
    ? `<div class="ok">✓ All ${steps} step${steps === 1 ? '' : 's'} work</div>`
    : `<div class="bad">✗ ${escapeHtml(result.error ?? 'failed')}</div>`;

  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 28px; width: ${COLS * (W + 20)}px; font: 14px/1.4 system-ui, sans-serif; color: #222; background: #fafaf8; }
    h1 { font-size: 22px; margin: 0 0 4px; } .ok, .bad { margin-bottom: 18px; font-weight: 600; } .ok { color: #1a7f4b; } .bad { color: #c0362c; }
    .legend { color: #777; font-size: 12px; margin: -10px 0 16px; } .legend span { display: inline-block; width: 14px; height: 10px; vertical-align: -1px; margin: 0 4px 0 12px; border-radius: 3px; }
    .grid { display: grid; grid-template-columns: repeat(${COLS}, ${W}px); gap: 22px 20px; }
    figure { margin: 0; } .shot { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; border-radius: 6px; box-shadow: 0 0 0 1px #ddd; background: #fff; }
    .shot > img:first-child { position: absolute; left: ${-ox}px; top: ${-oy}px; width: ${result.viewport[0] * k}px; height: ${result.viewport[1] * k}px; display: block; }
    .target, .waited { position: absolute; border-radius: 6px; box-sizing: border-box; }
    .target { border: 2.5px solid #2f6bff; } .waited { border: 2px dashed #1a9f5b; }
    .cursor { position: absolute; transform-origin: 0 0; filter: drop-shadow(0 1px 1px rgb(0 0 0 / .3)); }
    .finger { position: absolute; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; background: rgb(255 255 255 / .55); box-shadow: 0 0 0 1px rgb(0 0 0 / .25), 0 1px 4px rgb(0 0 0 / .3); }
    figcaption { display: flex; gap: 8px; align-items: baseline; margin-top: 7px; }
    figcaption b { flex: none; min-width: 22px; height: 22px; padding: 0 6px; box-sizing: border-box; border-radius: 11px; background: #222; color: #fff; font-size: 12px; display: inline-grid; place-items: center; }
    figcaption span { flex: 1; } figcaption i { flex: none; color: #888; font-style: normal; font-size: 12px; font-variant-numeric: tabular-nums; }
    figcaption em { display: block; font-style: normal; color: #c0362c; }
    .failed .shot { box-shadow: 0 0 0 3px #c0362c; } .failed b { background: #c0362c; }
  </style>
  <h1>${escapeHtml(result.title)}: storyboard</h1>
  ${verdict}
  <div class="legend">Each picture is the page after that step.<span style="border:2px solid #2f6bff"></span>acted on<span style="border:2px dashed #1a9f5b"></span>waited for</div>
  <div class="grid">${cards.join('')}</div>`;
}

export const passedSheet = (sheet: string) => sheet.replace(/\.jpg$/, '.passed.jpg');

export function keepPassing(ok: boolean, sheet: string): string | undefined {
  if (ok) return void fs.copyFileSync(sheet, passedSheet(sheet));
  return fs.existsSync(passedSheet(sheet)) ? passedSheet(sheet) : undefined;
}
