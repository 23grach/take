// What each cursor looks like in the video. On a Mac: macOS's own cursors, read from the Mac Take runs on,
// so they match a real Mac exactly. Take never ships Apple's drawings: they're drawn
// to PNG once per macOS version into ~/.take/cursors/. Elsewhere, or if that fails: the theme's own arrow,
// hand and text cursor, with every other cursor shown as the arrow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CursorKeyword } from '../drivers/web/cursor.ts';
import type { Theme } from './stage.ts';

/** One cursor drawing. Size and hotspot in CSS pixels of the recorded page (macOS points). */
export interface CursorArt {
  src: string;
  size: [number, number];
  hotspot: [number, number];
  /** A CSS drop-shadow at 1 CSS pixel per unit, scaled with the cursor; macOS adds one to most cursors. */
  shadow?: { y: number; blur: number; alpha: number };
}
export type ArtSet = Partial<Record<CursorKeyword, CursorArt>> & { default: CursorArt };

const HISERVICES = '/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/HIServices.framework/Versions/A/Resources/cursors';

/** Where macOS keeps each cursor, by the CSS cursor Chrome on a Mac shows it for. `progress` and `wait` stay the
 *  arrow: macOS's busy cursor is animated, which Take doesn't draw yet. */
const MACOS: Partial<Record<CursorKeyword, { ns: string } | { dir: string }>> = {
  default: { ns: 'arrowCursor' },
  text: { ns: 'IBeamCursor' },
  'vertical-text': { dir: 'ibeamhorizontal' },
  pointer: { dir: 'pointinghand' },
  grab: { dir: 'openhand' },
  grabbing: { dir: 'closedhand' },
  crosshair: { dir: 'cross' },
  move: { dir: 'move' },
  'not-allowed': { dir: 'notallowed' },
  copy: { dir: 'copy' },
  alias: { dir: 'makealias' },
  'context-menu': { dir: 'contextualmenu' },
  help: { dir: 'help' },
  cell: { dir: 'cell' },
  'zoom-in': { dir: 'zoomin' },
  'zoom-out': { dir: 'zoomout' },
  'ew-resize': { dir: 'resizeeastwest' },
  'ns-resize': { dir: 'resizenorthsouth' },
  'nesw-resize': { dir: 'resizenortheastsouthwest' },
  'nwse-resize': { dir: 'resizenorthwestsoutheast' },
  'col-resize': { dir: 'resizeleftright' },
  'row-resize': { dir: 'resizeupdown' },
  'n-resize': { dir: 'resizenorth' },
  'e-resize': { dir: 'resizeeast' },
  's-resize': { dir: 'resizesouth' },
  'w-resize': { dir: 'resizewest' },
  'ne-resize': { dir: 'resizenortheast' },
  'nw-resize': { dir: 'resizenorthwest' },
  'se-resize': { dir: 'resizesoutheast' },
  'sw-resize': { dir: 'resizesouthwest' },
};

/** The shadow macOS gives a cursor whose info.plist doesn't say. */
const MAC_SHADOW = { y: 1, blur: 2, alpha: 0.45 };

const dataUrl = (file: string, type: string) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;

function macosArt(): ArtSet | undefined {
  if (process.platform !== 'darwin' || !fs.existsSync(HISERVICES)) return undefined;
  const build = execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim();
  const dir = path.join(os.homedir(), '.take', 'cursors', `macos-${build}`);
  const manifest = path.join(dir, 'cursors.json');
  if (!fs.existsSync(manifest)) {
    fs.mkdirSync(dir, { recursive: true });
    const jobs: { name: string; ns?: string; pdf?: string }[] = [];
    const plists: Record<string, string> = {};
    for (const [name, where] of Object.entries(MACOS)) {
      if ('ns' in where) jobs.push({ name, ns: where.ns });
      else {
        // macOS 27 redrew the hands; older versions have only the folder at the top.
        const folder = [path.join(HISERVICES, 'macos27', where.dir), path.join(HISERVICES, where.dir)].find((d) => fs.existsSync(path.join(d, 'cursor.pdf')));
        if (!folder) continue;
        jobs.push({ name, pdf: path.join(folder, 'cursor.pdf') });
        plists[name] = path.join(folder, 'info.plist');
      }
    }
    const script = fileURLToPath(new URL('./macos-cursors.js', import.meta.url));
    const drawn: { name: string; file: string; size: [number, number]; hotspot?: [number, number] }[] =
      JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', script, dir, JSON.stringify(jobs)], { encoding: 'utf8' }));
    const entries = drawn.map((d) => {
      const info = plists[d.name] ? JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plists[d.name]], { encoding: 'utf8' })) : {};
      const hotspot = d.hotspot ?? [info.hotx ?? 0, info.hoty ?? 0];
      const shadow = info.shadowcolor ? { y: -(info.shadowoffsety ?? -1), blur: info.blur ?? 2, alpha: info.shadowcolor[3] ?? 0.45 } : MAC_SHADOW;
      return [d.name, { file: path.basename(d.file), size: d.size, hotspot, shadow }];
    });
    fs.writeFileSync(manifest, JSON.stringify(Object.fromEntries(entries), null, 1));
  }
  const list: Record<string, Omit<CursorArt, 'src'> & { file: string }> = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (!list.default) return undefined;
  return Object.fromEntries(Object.entries(list).map(([name, { file, ...art }]) => [name, { ...art, src: dataUrl(path.join(dir, file), 'image/png') }])) as ArtSet;
}

function themeArt(theme: Theme, themeDir: string): ArtSet {
  const s = theme.cursor.size / 30; // the theme's SVGs are drawn on a 30-unit grid, sized in CSS pixels
  const art = (shape: 'arrow' | 'hand' | 'text'): CursorArt => {
    const c = theme.cursor.shapes[shape];
    return { src: dataUrl(path.join(themeDir, c.file), 'image/svg+xml'), size: [theme.cursor.size, theme.cursor.size], hotspot: [c.hotspot[0] * s, c.hotspot[1] * s], shadow: { y: 1, blur: 2, alpha: 0.25 } };
  };
  return { default: art('arrow'), pointer: art('hand'), text: art('text') };
}

let cached: ArtSet | undefined;

/** The cursor drawings for a video: macOS's when Take runs on a Mac, else the theme's. */
export function cursorArt(theme: Theme, themeDir: string): ArtSet {
  if (theme.cursor.art === 'system') {
    try {
      cached ??= macosArt();
    } catch {
      cached = undefined;
    }
    if (cached) return cached;
  }
  return themeArt(theme, themeDir);
}
