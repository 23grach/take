// Contact sheet: evenly spaced frames of a video on one image, each labelled with its time,
// plus the loop seam (the last frames running into the first) and any hitches, so a reviewer
// (a person or the agent) can judge the whole video at a glance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import type { Report } from './check.ts';

const COLS = 6;
const TILE = 300;

export async function contactSheet(report: Report, out: string, { loop = true } = {}): Promise<string> {
  const n = report.frames;
  const picks = Array.from({ length: 24 }, (_, i) => Math.round((i * (n - 1)) / 23));
  const seam = loop ? [n - 3, n - 2, n - 1, 0, 1, 2] : [];
  const hitches = report.hitches.slice(0, 6).flatMap((f) => [Math.max(0, f - 1), f, Math.min(n - 1, f + 1)]);
  const wanted = [...new Set([...picks, ...seam, ...hitches])].sort((a, b) => a - b);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-contact-'));
  try {
    // One ffmpeg pass pulls every wanted frame as a small JPEG, in frame order.
    execFileSync('ffmpeg', ['-v', 'error', '-i', report.file, '-vf', `select='${wanted.map((f) => `eq(n\\,${f})`).join('+')}',scale=${TILE * 2}:-2`,
      '-fps_mode', 'passthrough', '-q:v', '3', path.join(tmp, 'p%04d.jpg')]);
    const img = new Map(wanted.map((f, i) => [f, `data:image/jpeg;base64,${fs.readFileSync(path.join(tmp, `p${String(i + 1).padStart(4, '0')}.jpg`)).toString('base64')}`]));
    const time = (f: number) => `${(f / report.fps).toFixed(2)} s`;
    const tile = (f: number, note = '') => `<figure><img src="${img.get(f)}"><figcaption>${time(f)} · ${f}${note}</figcaption></figure>`;
    const status = { pass: '#1a7f4b', warn: '#a86b00', fail: '#c0362c' };
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; padding: 24px; width: ${COLS * (TILE + 12)}px; font: 13px/1.4 system-ui, sans-serif; color: #222; background: #fafaf8; }
      h1 { font-size: 18px; margin: 0 0 4px; } .meta { color: #666; margin-bottom: 10px; }
      ul { list-style: none; padding: 0; margin: 0 0 16px; columns: 2; } li { margin: 2px 0; }
      h2 { font-size: 14px; margin: 16px 0 8px; }
      .grid { display: grid; grid-template-columns: repeat(${COLS}, ${TILE}px); gap: 12px; }
      figure { margin: 0; } img { width: ${TILE}px; display: block; border-radius: 4px; box-shadow: 0 0 0 1px #ddd; }
      figcaption { color: #666; font-size: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; }
    </style>
    <h1>${path.basename(report.file)}</h1>
    <div class="meta">${report.width}×${report.height} · ${+report.fps.toFixed(3)} fps · ${report.seconds.toFixed(2)} s · ${report.frames} frames</div>
    <ul>${report.findings.map((f) => `<li><b style="color:${status[f.status]}">${f.status === 'pass' ? '✓' : f.status === 'warn' ? '⚠' : '✗'} ${f.name}</b> ${f.detail}</li>`).join('')}</ul>
    <h2>Every ${((picks[1] - picks[0]) / report.fps).toFixed(2)} s</h2>
    <div class="grid">${picks.map((f) => tile(f)).join('')}</div>
    ${loop ? `<h2>Loop seam: the last three frames, then the first three</h2><div class="grid">${seam.map((f, i) => tile(f, i === 3 ? ' · start' : '')).join('')}</div>` : ''}
    ${hitches.length ? `<h2>Hitches: frame before, doubled frame, frame after</h2><div class="grid">${hitches.map((f) => tile(f)).join('')}</div>` : ''}`;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: COLS * (TILE + 12) + 48, height: 600 } });
      await page.setContent(html);
      await page.screenshot({ path: out, fullPage: true, type: 'jpeg', quality: 88 });
    } finally {
      await browser.close();
    }
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
