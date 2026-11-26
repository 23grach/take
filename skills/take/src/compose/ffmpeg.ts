import { spawn, spawnSync } from 'node:child_process';
import type { Appearance } from '../take/format.ts';
import { mediaTool } from '../media-tools.ts';

const NO_FFMPEG = "ffmpeg isn't installed (or isn't on the PATH). Run take doctor to see how to install it.";

export function ffmpegProblem(): string | undefined {
  const r = spawnSync(mediaTool('ffmpeg'), ['-hide_banner', '-version'], { stdio: 'ignore' });
  return r.error ? NO_FFMPEG : undefined;
}

export function pageAppearance(frame: string): Appearance {
  const r = spawnSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', frame, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1024 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error(NO_FFMPEG);
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr?.toString().trim() || r.error?.message}`);
  return r.stdout[0] < 128 ? 'dark' : 'light';
}

export function encoder(out: string, fps: number) {
  const proc = spawn(mediaTool('ffmpeg'), [
    '-v', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv:flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=yuv420p,'
      + 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=iec61966-2-1',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high',
    '-r', String(fps), '-fps_mode', 'cfr',
    '-movflags', '+faststart', '-f', 'mp4', out,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let failure: Error | undefined;
  proc.stderr.on('data', (d) => (err += d));
  proc.stdin.on('error', () => {});
  const done = new Promise<void>((resolve, reject) => {
    const fail = (e: Error) => reject((failure ??= e));
    proc.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? new Error(NO_FFMPEG) : e));
    proc.on('close', (code) => (code === 0 ? resolve() : fail(new Error(`ffmpeg failed (${code}): ${err.trim()}`))));
  });
  done.catch(() => {});
  return Object.assign(proc, { done, failed: () => failure }) as typeof proc & {
    stdin: NodeJS.WritableStream & { destroy(): void };
    done: Promise<void>;
    failed: () => Error | undefined;
  };
}
