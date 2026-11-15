// Does the finished video show what the rehearsal showed? A recording can go wrong in ways motion checks can't see:
// a panel that never appeared, a map still blank. Each step's rehearsal picture (take probe) is compared with the
// video frame just before the next step starts; a step whose page looks very different is reported, so someone
// looks at it before the video goes out.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CaptureInfo } from '../drivers/web/capture.ts';
import type { EventLog } from '../drivers/web/events.ts';
import type { ProbeResult } from '../probe/probe.ts';

/** Compared at this size, in grey: enough to see a missing panel, too coarse to see a pixel shift. Calibrated on
 *  ten real-site videos: correct ones reach at most 16%, a recording that lost a calendar 32%. Small panels
 *  (a tenth of the page) don't stand out from live content and aren't caught. */
const SIZE = { w: 160, h: 100 };
/** A pixel differs when its grey level is this far off (0–255)… */
const PIXEL = 32;
/** …and a step is reported when this share of the page differs. */
export const STEP_LIMIT = 0.24;
/** Blocks of this many pixels a side (at SIZE), counted as different when this share of their pixels is. */
const BLOCK = 8;
/** Frames looked at per step (see compareWithRehearsal). */
const SAMPLES = 5;
const BLOCK_SHARE = 0.3;

export interface StepMatch {
  /** 0 is the first screen, then one per step, numbered from 1 as on the storyboard. */
  step: number;
  /** The video frame compared. */
  frame: number;
  /** Share of the page (0–1) that looks clearly different from the rehearsal picture. */
  differs: number;
  /** The rehearsal picture. */
  picture: string;
}

/** Undefined when there's no rehearsal to compare with, or it's of a different version of the take. */
export function compareWithRehearsal(captureDir: string, log: EventLog, probeDir: string, takeFile?: string): StepMatch[] | undefined {
  const file = path.join(probeDir, 'probe.json');
  if (!fs.existsSync(file)) return undefined;
  if (takeFile && fs.statSync(file).mtimeMs < fs.statSync(takeFile).mtimeMs) return undefined;
  const probe = JSON.parse(fs.readFileSync(file, 'utf8')) as ProbeResult;
  if (!probe.ok || probe.shots.length !== log.steps.length + 1) return undefined;
  const info = JSON.parse(fs.readFileSync(path.join(captureDir, 'capture.json'), 'utf8')) as CaptureInfo;
  const [vw, vh] = log.viewport;
  const out: StepMatch[] = [];
  for (const shot of probe.shots) {
    // The rehearsal picture is taken once the step's animations have finished; in the video they may still be
    // running when the next step starts. So the closest of a few frames counts, from the step's end until the next
    // step has finished (the first screen: the opening frames). Something that never appears matches none of them.
    const last = info.frames.length - 1;
    const [from, to] = shot.step === 0
      ? [0, Math.min(last, (log.steps[0]?.end ?? 0))]
      : [Math.min(last, log.steps[shot.step - 1].end), Math.min(last, (log.steps[shot.step]?.end ?? log.frames - 1))];
    const a = grey(path.join(probeDir, shot.file));
    let best = { frame: from, differs: Infinity };
    for (let k = 0; k < SAMPLES; k++) {
      const frame = Math.round(from + ((to - from) * k) / (SAMPLES - 1));
      const differs = blockDifference(a, grey(path.join(captureDir, info.frames[frame])), videoMask(log, frame, vw, vh));
      if (differs < best.differs) best = { frame, differs };
      if (differs === 0) break;
    }
    out.push({ step: shot.step, ...best, picture: path.join(probeDir, shot.file) });
  }
  return out;
}

/** Share of the page in blocks that are mostly different. A missing panel or a blank map is a solid block of
 *  difference; live content that moves a little (a photo, a price) scatters it, and doesn't count. */
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

function grey(file: string): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${SIZE.w}:${SIZE.h},format=gray`, '-f', 'rawvideo', '-']);
}

/** Pixels covered by a video playing in the page in that frame: it moves on its own, so it isn't compared. */
function videoMask(log: EventLog, frame: number, vw: number, vh: number): Uint8Array {
  const mask = new Uint8Array(SIZE.w * SIZE.h);
  const list = log.videos ?? [];
  let i = list.length - 1;
  while (i >= 0 && list[i][0] > frame) i--;
  for (const b of i >= 0 ? list[i][1] : []) {
    const [x0, x1] = [Math.floor((b.x / vw) * SIZE.w), Math.ceil(((b.x + b.width) / vw) * SIZE.w)];
    const [y0, y1] = [Math.floor((b.y / vh) * SIZE.h), Math.ceil(((b.y + b.height) / vh) * SIZE.h)];
    for (let y = Math.max(0, y0); y < Math.min(SIZE.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(SIZE.w, x1); x++) mask[y * SIZE.w + x] = 1;
  }
  return mask;
}
