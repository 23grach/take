import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SoundLog } from '../drivers/web/sound.ts';
import { mediaTool } from '../media-tools.ts';

const RATE = 48000;
const END_FADE = 0.05;

export function readSound(capture: string): SoundLog | undefined {
  const file = path.join(capture, 'sound.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

export interface Placement {
  seconds: number;
  offset: number;
  fadeFrom?: number;
}

function tempo(rate: number): string[] {
  const steps: string[] = [];
  for (; rate < 0.5; rate /= 0.5) steps.push('atempo=0.5');
  return rate === 1 ? steps : [...steps, `atempo=${rate}`];
}

export async function addSound(video: string, out: string, sound: SoundLog, capture: string, { seconds, offset, fadeFrom = seconds - END_FADE }: Placement): Promise<boolean> {
  const inputs: string[] = [];
  const chains: string[] = [];
  for (const clip of sound.clips) {
    let at = clip.at - offset;
    let { from, duration } = clip;
    if (at < 0) {
      from -= at * clip.rate;
      duration += at * clip.rate;
      at = 0;
    }
    duration = Math.min(duration, (seconds - at) * clip.rate);
    if (duration <= 0) continue;
    inputs.push('-seek_timestamp', '1', '-ss', from.toFixed(6), '-t', duration.toFixed(6), '-i', path.join(capture, clip.file));
    const n = chains.length;
    const filters = [`aresample=${RATE}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', ...tempo(clip.rate), ...(clip.volume === 1 ? [] : [`volume=${clip.volume}`]), `adelay=delays=${Math.round(at * RATE)}S:all=1`];
    chains.push(`[${n + 1}:a]${filters.join(',')}[s${n}]`);
  }
  if (!chains.length) return false;
  const fade = Math.max(0, Math.min(fadeFrom, seconds));
  const graph = `${chains.join(';')};${chains.map((_, i) => `[s${i}]`).join('')}amix=inputs=${chains.length}:normalize=0:duration=longest,`
    + `alimiter=limit=0.95:level=false:latency=true,apad,afade=t=out:st=${fade.toFixed(6)}:d=${Math.max(0.001, seconds - fade).toFixed(6)}[a]`;
  await ffmpeg([
    '-v', 'error', '-y', '-i', video, ...inputs,
    '-filter_complex', graph,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE),
    '-t', seconds.toFixed(6), '-movflags', '+faststart', '-f', 'mp4', out,
  ]);
  return true;
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(mediaTool('ffmpeg'), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg couldn't add the sound (${code}): ${err.trim()}`))));
  });
}
