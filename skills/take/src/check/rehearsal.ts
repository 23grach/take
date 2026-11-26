import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CaptureInfo } from '../drivers/web/capture.ts';
import type { Box, EventLog } from '../drivers/web/events.ts';
import type { ProbeResult } from '../probe/probe.ts';
import { mediaTool } from '../media-tools.ts';

const SIZE = { w: 160, h: 100 };
const PIXEL = 32;
export const STEP_LIMIT = 0.24;
const BLOCK = 8;
const SAMPLES = 5;
const BLOCK_SHARE = 0.3;

export interface StepMatch {
  step: number;
  frame: number;
  differs: number;
  picture: string;
}

export function compareWithRehearsal(captureDir: string, log: EventLog, probeDir: string, takeFile?: string): StepMatch[] | undefined {
  const file = path.join(probeDir, 'probe.json');
  if (!fs.existsSync(file)) return undefined;
  if (takeFile && fs.statSync(file).mtimeMs < fs.statSync(takeFile).mtimeMs) return undefined;
  const probe = JSON.parse(fs.readFileSync(file, 'utf8')) as ProbeResult;
  if (!probe.ok || probe.shots.length !== log.steps.length + 1) return undefined;
  const info = JSON.parse(fs.readFileSync(path.join(captureDir, 'capture.json'), 'utf8')) as CaptureInfo;
  const view = info.shows ?? { x: 0, y: 0, width: log.viewport[0], height: log.viewport[1] };
  const out: StepMatch[] = [];
  for (const shot of probe.shots) {
    const last = info.frames.length - 1;
    const [from, to] = shot.step === 0
      ? [0, Math.min(last, (log.steps[0]?.end ?? 0))]
      : [Math.min(last, log.steps[shot.step - 1].end), Math.min(last, (log.steps[shot.step]?.end ?? log.frames - 1))];
    const a = grey(path.join(probeDir, shot.file), info.shows);
    let best = { frame: from, differs: Infinity };
    for (let k = 0; k < SAMPLES; k++) {
      const frame = Math.round(from + ((to - from) * k) / (SAMPLES - 1));
      const differs = blockDifference(a, grey(path.join(captureDir, info.frames[frame])), videoMask(log, frame, view));
      if (differs < best.differs) best = { frame, differs };
      if (differs === 0) break;
    }
    out.push({ step: shot.step, ...best, picture: path.join(probeDir, shot.file) });
  }
  return out;
}

function blockDifference(a: Buffer, b: Buffer, masked: Uint8Array): number {
  const [B, share] = [BLOCK, BLOCK_SHARE];
  let blocks = 0;
  let off = 0;
  for (let by = 0; by < SIZE.h; by += B)
    for (let bx = 0; bx < SIZE.w; bx += B) {
      let n = 0;
      let d = 0;
      for (let y = by; y < Math.min(SIZE.h, by + B); y++)
        for (let x = bx; x < Math.min(SIZE.w, bx + B); x++) {
          const i = y * SIZE.w + x;
          if (masked[i]) continue;
          n++;
          if (Math.abs(a[i] - b[i]) > PIXEL) d++;
        }
      if (!n) continue;
      blocks++;
      if (d / n >= share) off++;
    }
  return blocks ? off / blocks : 0;
}

function grey(file: string, crop?: Box): Buffer {
  const cut = crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` : '';
  return execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', file, '-vf', `${cut}scale=${SIZE.w}:${SIZE.h},format=gray`, '-f', 'rawvideo', '-']);
}

function videoMask(log: EventLog, frame: number, view: Box): Uint8Array {
  const mask = new Uint8Array(SIZE.w * SIZE.h);
  const list = log.videos ?? [];
  let i = list.length - 1;
  while (i >= 0 && list[i][0] > frame) i--;
  for (const b of i >= 0 ? list[i][1] : []) {
    const [x0, x1] = [Math.floor(((b.x - view.x) / view.width) * SIZE.w), Math.ceil(((b.x + b.width - view.x) / view.width) * SIZE.w)];
    const [y0, y1] = [Math.floor(((b.y - view.y) / view.height) * SIZE.h), Math.ceil(((b.y + b.height - view.y) / view.height) * SIZE.h)];
    for (let y = Math.max(0, y0); y < Math.min(SIZE.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(SIZE.w, x1); x++) mask[y * SIZE.w + x] = 1;
  }
  return mask;
}
