import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Frame, Page } from 'playwright';
import type { Played } from './media.ts';
import { mediaTool } from '../../media-tools.ts';
import { webAudio, type PageSound, type Rendered } from './sound-page-script.ts';

export interface SoundLog {
  version: 0;
  clips: Clip[];
}

interface Clip {
  file: string;
  at: number;
  from: number;
  duration: number;
  rate: number;
  volume: number;
}

const WEB_AUDIO_SECONDS = 180;

const TAIL_SECONDS = 3;

export interface SoundCatcher {
  moved(played: Played[], filmed: boolean, ms: number): Promise<void>;
  start(): Promise<void>;
  finish(dir: string): Promise<string[]>;
}

interface Run {
  src: string;
  at: number;
  from: number;
  to: number;
  rate: number;
  volume: number;
}

export async function catchSound(page: Page): Promise<SoundCatcher> {
  const audible = new Set<Frame>();
  await page.context().exposeBinding('__takeWebAudio', ({ frame }) => void audible.add(frame));
  await page.context().addInitScript(webAudio, [WEB_AUDIO_SECONDS, TAIL_SECONDS] as [number, number]);
  let t0 = 0;
  let started = false;
  let since = 0;
  const unfilmed: [number, number][] = [];
  const srcOf = new Map<string, string>();
  const open = new Map<string, Run>();
  const runs: Run[] = [];

  return {
    async moved(played, filmed, ms) {
      if (started && !filmed) {
        const last = unfilmed.at(-1);
        if (last && last[1] === since) last[1] += ms;
        else unfilmed.push([since, since + ms]);
      }
      if (started) since += ms;
      for (const p of played) if (p.src !== undefined) srcOf.set(p.id, p.src);
      if (filmed) {
        const playing = new Set<string>();
        for (const p of played) {
          playing.add(p.id);
          const src = srcOf.get(p.id) ?? '';
          const run = open.get(p.id);
          if (run && run.src === src && run.rate === p.rate && run.volume === p.volume && Math.abs(p.from - run.to) < 1e-3) {
            run.to = p.to;
            continue;
          }
          if (run) runs.push(run);
          open.set(p.id, { src, at: p.at, from: p.from, to: p.to, rate: p.rate, volume: p.volume });
        }
        for (const [id, run] of open)
          if (!playing.has(id)) {
            runs.push(run);
            open.delete(id);
          }
      }
      for (const f of audible) if (f.isDetached()) audible.delete(f);
      if (audible.size) await Promise.all([...audible].map((f) => f.evaluate(() => (globalThis as unknown as { __takeSound: PageSound }).__takeSound.step()).catch(() => {})));
    },
    async start() {
      t0 = await page.evaluate(() => Date.now());
      started = true;
    },
    async finish(dir) {
      for (const run of open.values()) runs.push({ ...run, to: run.to + TAIL_SECONDS * run.rate });
      open.clear();
      const warnings: string[] = [];
      const clips: Clip[] = [];
      const files: [string, Buffer][] = [];
      const seconds = (pageMs: number) => {
        const t = pageMs - t0;
        return (t - unfilmed.reduce((cut, [a, b]) => cut + Math.max(0, Math.min(b, t) - a), 0)) / 1000;
      };

      for (const f of audible) {
        const all: Rendered[] = await f.evaluate(() => (globalThis as unknown as { __takeSound: PageSound }).__takeSound.finish()).catch(() => []);
        for (const r of all) {
          const file = `sound/webaudio-${files.length}.wav`;
          const bytes = Buffer.from(r.wav, 'base64');
          files.push([file, bytes]);
          clips.push({ file, at: seconds(r.start), from: 0, duration: wavSeconds(bytes), rate: 1, volume: 1 });
          if (r.cut) warnings.push(`the page's Web Audio sound stops ${WEB_AUDIO_SECONDS / 60} min after it started: Take catches that much per sound engine`);
        }
      }

      const heard = runs.filter((r) => r.volume > 0 && r.to > r.from);
      const fileOf = new Map<string, { file: string; stream: boolean }>();
      for (const src of new Set(heard.map((r) => r.src))) {
        const got = await fetchSource(page, src);
        if (!got) {
          warnings.push(src ? `couldn't get the sound file ${src.length > 80 ? `${src.slice(0, 77)}…` : src}, so its sound is missing` : "a media element played a live stream, whose sound Take can't catch");
          continue;
        }
        const file = `sound/media-${files.length}.${extension(got.mime, src)}`;
        files.push([file, got.bytes]);
        fileOf.set(src, { file, stream: got.stream });
      }
      if (!files.length) return warnings;

      fs.mkdirSync(path.join(dir, 'sound'), { recursive: true });
      for (const [file, bytes] of files) fs.writeFileSync(path.join(dir, file), bytes);
      const offsets = new Map([...fileOf.values()].map(({ file, stream }) => [file, stream ? 0 : startTime(path.join(dir, file))]));
      for (const r of heard) {
        const where = fileOf.get(r.src);
        if (where) clips.push({ file: where.file, at: seconds(r.at), from: r.from + offsets.get(where.file)!, duration: r.to - r.from, rate: r.rate, volume: r.volume });
      }
      clips.sort((a, b) => a.at - b.at);
      const log: SoundLog = { version: 0, clips };
      fs.writeFileSync(path.join(dir, 'sound.json'), JSON.stringify(log, null, 1));
      return warnings;
    },
  };

  async function fetchSource(page: Page, src: string): Promise<{ mime: string; bytes: Buffer; stream: boolean } | null> {
    if (src.startsWith('blob:')) {
      for (const f of page.frames()) {
        const got = await f.evaluate((url) => (globalThis as unknown as { __takeSound?: PageSound }).__takeSound?.source(url) ?? null, src).catch(() => null);
        if (got) return { mime: got.mime, bytes: Buffer.from(got.base64, 'base64'), stream: got.stream };
      }
      return null;
    }
    try {
      if (src.startsWith('data:')) {
        const r = await fetch(src);
        return { mime: r.headers.get('content-type') ?? '', bytes: Buffer.from(await r.arrayBuffer()), stream: false };
      }
      if (!/^https?:/.test(src)) return null;
      const r = await page.context().request.get(src);
      if (!r.ok()) return null;
      return { mime: r.headers()['content-type'] ?? '', bytes: await r.body(), stream: false };
    } catch {
      return null;
    }
  }
}

const wavSeconds = (wav: Buffer) => wav.readUInt32LE(40) / wav.readUInt32LE(28);

function startTime(file: string): number {
  const r = spawnSync(mediaTool('ffprobe'), ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const t = parseFloat(r.stdout);
  return Number.isFinite(t) ? t : 0;
}

const EXTENSIONS: Record<string, string> = { mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', wave: 'wav', ogg: 'ogg', webm: 'webm', mp4: 'mp4', aac: 'aac', flac: 'flac' };

function extension(mime: string, src: string): string {
  const sub = /^(?:audio|video)\/([\w.+-]+)/i.exec(mime)?.[1]?.toLowerCase();
  if (sub && EXTENSIONS[sub]) return EXTENSIONS[sub];
  const ext = /\.(\w{2,4})(?:[?#]|$)/.exec(src.startsWith('data:') ? '' : src)?.[1]?.toLowerCase();
  return ext ?? 'media';
}
