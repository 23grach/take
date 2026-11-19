import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mediaTool } from '../media-tools.ts';

export type Status = 'pass' | 'warn' | 'fail';
export interface Finding {
  name: string;
  status: Status;
  detail: string;
}
export interface Report {
  file: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  seconds: number;
  findings: Finding[];
  hitches: number[];
  ok: boolean;
}

export interface CheckOptions {
  loop?: boolean;
  fps?: number;
  pageVideos?: (f: number) => [number, number, number, number][];
}

const GRID = { w: 320, h: 180, cols: 8, rows: 5 };
const STILL = 0.15;
const MOVING = 2.5;
const LONGEST_STILL_S = 4;

export function check(file: string, { loop = true, fps: expectedFps = 60, pageVideos }: CheckOptions = {}): Report {
  const findings: Finding[] = [];
  const add = (name: string, status: Status, detail: string) => findings.push({ name, status, detail });

  const probe = JSON.parse(
    execFileSync(mediaTool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,profile,width,height,pix_fmt,color_range,r_frame_rate,avg_frame_rate:format=duration,bit_rate',
      '-of', 'json', file], { encoding: 'utf8' }),
  );
  const s = probe.streams[0];
  if (!s) throw new Error(`${file} has no video`);
  const rate = (r: string) => {
    const [a, b] = r.split('/').map(Number);
    return b ? a / b : a;
  };
  const fps = rate(s.r_frame_rate);

  add('codec', s.codec_name === 'h264' ? 'pass' : 'fail', `${s.codec_name}${s.profile ? ` (${s.profile})` : ''}${s.codec_name === 'h264' ? '' : '; expected H.264, which plays everywhere'}`);
  const evenSize = s.width % 2 === 0 && s.height % 2 === 0;
  add('size', evenSize ? 'pass' : 'fail', `${s.width}×${s.height}${evenSize ? '' : '; width and height must be even for H.264 players'}`);
  add('colour', s.pix_fmt === 'yuv420p' && s.color_range === 'tv' ? 'pass' : 'warn',
    `${s.pix_fmt}, ${s.color_range === 'tv' ? 'limited' : s.color_range ?? 'unknown'} range${s.pix_fmt === 'yuv420p' && s.color_range === 'tv' ? '' : '; expected yuv420p limited range, or some players shift the contrast'}`);

  const durations = execFileSync(mediaTool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .trim().split('\n').map(Number).sort((a, b) => a - b);
  const steps = new Set(durations.slice(1).map((p, i) => p - durations[i]));
  const constant = steps.size <= 1 && Math.abs(rate(s.avg_frame_rate) - fps) < 0.01;
  add('frame rate', !constant ? 'fail' : Math.abs(fps - expectedFps) > 0.01 ? 'warn' : 'pass',
    `${+fps.toFixed(3)} fps, ${constant ? 'constant' : 'variable (frames of different lengths: playback will judder)'}${constant && Math.abs(fps - expectedFps) > 0.01 ? `; expected ${expectedFps}` : ''}`);

  const fast = fastStart(file);
  add('fast start', fast ? 'pass' : 'warn', fast ? 'plays before it has fully downloaded' : 'the index is at the end, so browsers must download the whole file before playing; re-encode with +faststart');

  const change = tileChanges(file);
  const n = change.length + 1;
  const seconds = n / fps;
  add('length', 'pass', `${n} frames, ${seconds.toFixed(2)} s, ${Math.round(Number(probe.format.bit_rate) / 1000)} kbit/s`);

  const pairs = loop ? [...change, tileDiff(file, n - 1, 0)] : change;
  const hitches: number[] = [];
  let videoRepeats = 0;
  for (let i = 0; i < pairs.length; i++) {
    const [before, now, after] = [pairs[(i - 1 + pairs.length) % pairs.length], pairs[i], pairs[(i + 1) % pairs.length]];
    if (!loop && (i === 0 || i === pairs.length - 1)) continue;
    const f = (i + 1) % n;
    const stalled = Array.from(now, (v, t) => v < STILL && before[t] > MOVING && after[t] > MOVING);
    if (!stalled.some(Boolean)) continue;
    const areas = pageVideos?.(f) ?? [];
    const inVideo = (t: number) => {
      const [tw, th] = [s.width / GRID.cols, s.height / GRID.rows];
      const [tx, ty] = [(t % GRID.cols) * tw, Math.floor(t / GRID.cols) * th];
      return areas.some(([x, y, w, h]) => x < tx + tw && x + w > tx && y < ty + th && y + h > ty);
    };
    if (stalled.some((st, t) => st && !inVideo(t))) hitches.push(f);
    else videoRepeats++;
  }
  const at = (f: number) => `${(f / fps).toFixed(2)} s (frame ${f})`;
  add('smoothness', hitches.length ? 'fail' : 'pass',
    hitches.length ? `${hitches.length} doubled frame${hitches.length > 1 ? 's' : ''}: motion stalls for one frame at ${hitches.slice(0, 5).map(at).join(', ')}${hitches.length > 5 ? '…' : ''}` : `motion never stalls mid-move${videoRepeats ? ' (a video in the page shows at its own frame rate)' : ''}`);

  let longest = { start: 0, length: 0 };
  for (let i = 0, run = 0; i < change.length; i++) {
    run = Math.max(...change[i]) < STILL ? run + 1 : 0;
    if (run > longest.length) longest = { start: i - run + 1, length: run };
  }
  const stillS = (longest.length + 1) / fps;
  add('stillness', stillS > LONGEST_STILL_S ? 'warn' : 'pass',
    longest.length ? `longest still stretch ${stillS.toFixed(2)} s from ${(longest.start / fps).toFixed(2)} s${stillS > LONGEST_STILL_S ? '; viewers may think it froze' : ''}` : 'something moves in every frame');

  if (loop) {
    const size = (c: Float32Array) => Math.max(...c);
    const seam = size(pairs[pairs.length - 1]);
    const near = [...change.slice(-6), ...change.slice(0, 6)].map(size);
    const typical = Math.max(1, ...near);
    const smooth = seam <= 3 * typical;
    add('loop seam', smooth ? 'pass' : 'fail', smooth
      ? `the end runs into the start smoothly (largest change ${seam.toFixed(1)}, neighbours up to ${Math.max(...near).toFixed(1)})`
      : `jumps when it loops: the last frame differs from the first by ${seam.toFixed(1)} grey levels in one area, the frames around it by at most ${Math.max(...near).toFixed(1)}`);
  }

  return { file, width: s.width, height: s.height, fps, frames: n, seconds, findings, hitches, ok: findings.every((f) => f.status !== 'fail') };
}

export function formatReport(r: Report): string {
  const icon = { pass: '✓', warn: '⚠', fail: '✗' };
  const lines = r.findings.map((f) => `${icon[f.status]} ${f.name.padEnd(11)} ${f.detail}`);
  const fails = r.findings.filter((f) => f.status === 'fail').length;
  const warns = r.findings.filter((f) => f.status === 'warn').length;
  lines.push(fails ? `${fails} problem${fails > 1 ? 's' : ''} to fix.` : warns ? `Ready, with ${warns} thing${warns > 1 ? 's' : ''} to look at.` : 'Ready to share.');
  return `${r.file}\n${lines.join('\n')}\n`;
}

function fastStart(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(8);
    for (let pos = 0; fs.readSync(fd, head, 0, 8, pos) === 8; ) {
      const type = head.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      let size = head.readUInt32BE(0);
      if (size === 1) {
        const big = Buffer.alloc(8);
        fs.readSync(fd, big, 0, 8, pos + 8);
        size = Number(big.readBigUInt64BE(0));
      }
      if (size < 8) return false;
      pos += size;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function greyFrames(file: string): Buffer {
  return execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', file, '-vf', `scale=${GRID.w}:${GRID.h},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 31 });
}

let cache: { file: string; grey: Buffer } | undefined;
const grey = (file: string) => (cache?.file === file ? cache.grey : (cache = { file, grey: greyFrames(file) }).grey);

function tileDiff(file: string, a: number, b: number): Float32Array {
  const g = grey(file);
  const S = GRID.w * GRID.h;
  const [tw, th] = [GRID.w / GRID.cols, GRID.h / GRID.rows];
  const out = new Float32Array(GRID.cols * GRID.rows);
  for (let y = 0; y < GRID.h; y++)
    for (let x = 0; x < GRID.w; x++) out[Math.floor(y / th) * GRID.cols + Math.floor(x / tw)] += Math.abs(g[a * S + y * GRID.w + x] - g[b * S + y * GRID.w + x]);
  for (let t = 0; t < out.length; t++) out[t] /= tw * th;
  return out;
}

function tileChanges(file: string): Float32Array[] {
  const n = grey(file).length / (GRID.w * GRID.h);
  return Array.from({ length: n - 1 }, (_, i) => tileDiff(file, i, i + 1));
}
