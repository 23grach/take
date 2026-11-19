import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Frame, Page } from 'playwright';
import type { Played } from './media.ts';
import { mediaTool } from '../../media-tools.ts';

export interface SoundLog {
  version: 0;
  clips: Clip[];
}

export interface Clip {
  file: string;
  at: number;
  from: number;
  duration: number;
  rate: number;
  volume: number;
}

export const WEB_AUDIO_SECONDS = 180;

const TAIL_SECONDS = 3;

export interface SoundCatcher {
  moved(played: Played[], filmed: boolean): Promise<void>;
  start(): Promise<void>;
  finish(dir: string): Promise<string[]>;
}

interface Rendered {
  start: number;
  wav: string;
  cut: boolean;
}

interface Source {
  mime: string;
  stream: boolean;
  base64: string;
}

interface PageSound {
  step(): Promise<unknown>;
  finish(): Promise<Rendered[]>;
  source(url: string): Promise<Source | null>;
}

function webAudio([seconds, tail]: [number, number]): void {
  const w = globalThis as unknown as { __takeSound?: PageSound; __takeWebAudio: () => void; AudioContext: unknown; webkitAudioContext?: unknown };
  if (w.__takeSound) return;
  const Offline = OfflineAudioContext;
  const rendered = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime')!.get!;
  const STEP = Symbol('step');
  const FINISH = Symbol('finish');

  const base64 = (bytes: Uint8Array) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const wav = (buffer: AudioBuffer, n: number) => {
    const ch = buffer.numberOfChannels;
    const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    data.setUint32(4, 36 + n * ch * 2, true);
    text(8, 'WAVEfmt ');
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, ch, true);
    data.setUint32(24, buffer.sampleRate, true);
    data.setUint32(28, buffer.sampleRate * ch * 2, true);
    data.setUint16(32, ch * 2, true);
    data.setUint16(34, 16, true);
    text(36, 'data');
    data.setUint32(40, n * ch * 2, true);
    const channels = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
    let loud = false;
    for (let i = 0, o = 44; i < n; i++)
      for (let c = 0; c < ch; c++, o += 2) {
        const v = Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 0x7fff);
        if (v) loud = true;
        data.setInt16(o, v, true);
      }
    return loud ? base64(new Uint8Array(data.buffer)) : '';
  };

  const contexts: TakeAudioContext[] = [];
  class TakeAudioContext extends Offline {
    #start = Date.now();
    #rendering?: Promise<AudioBuffer>;
    #full = false;
    constructor(options: AudioContextOptions = {}) {
      const sampleRate = options.sampleRate ?? 48000;
      super({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate });
      contexts.push(this);
      w.__takeWebAudio();
    }
    override get currentTime() {
      return (Date.now() - this.#start) / 1000;
    }
    override get state(): AudioContextState {
      return 'running';
    }
    get baseLatency() {
      return 0;
    }
    get outputLatency() {
      return 0;
    }
    override resume() {
      return Promise.resolve();
    }
    override suspend() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    getOutputTimestamp() {
      return { contextTime: this.currentTime, performanceTime: performance.now() };
    }
    createMediaElementSource() {
      return this.createGain();
    }
    createMediaStreamSource() {
      return this.createGain();
    }
    #render() {
      if (this.#rendering) void Offline.prototype.resume.call(this).catch(() => {});
      else this.#rendering = Offline.prototype.startRendering.call(this);
    }
    async [STEP]() {
      if (this.#full) return;
      const quantum = 128 / this.sampleRate;
      const to = Math.floor(this.currentTime / quantum) * quantum;
      if (to * this.sampleRate >= this.length) {
        this.#full = true;
        return this.#render();
      }
      if (to <= rendered.call(this) + 1e-9) return;
      const reached = Offline.prototype.suspend.call(this, to);
      this.#render();
      await reached;
    }
    async [FINISH](): Promise<Rendered> {
      const end = Date.now();
      if (!this.#full) this.#render();
      const buffer = await this.#rendering!;
      const n = Math.min(buffer.length, Math.max(0, Math.round(((end - this.#start) / 1000 + tail) * this.sampleRate)));
      return { start: this.#start, wav: wav(buffer, n), cut: (end - this.#start) / 1000 > seconds };
    }
  }
  w.AudioContext = TakeAudioContext;
  w.webkitAudioContext = TakeAudioContext;
  for (const [proto, name] of [[AudioScheduledSourceNode.prototype, 'start'], [AudioBufferSourceNode.prototype, 'start'], [AudioScheduledSourceNode.prototype, 'stop']] as const) {
    if (!Object.hasOwn(proto, name)) continue;
    const native = proto[name] as (when?: number, ...rest: number[]) => void;
    (proto as unknown as Record<string, unknown>)[name] = function (this: AudioScheduledSourceNode, when = 0, ...rest: number[]) {
      const c = this.context;
      return native.call(this, c instanceof TakeAudioContext ? Math.max(when, c.currentTime) : when, ...rest);
    };
  }

  const sources = new Map<string, MediaSource>();
  const buffers = new WeakMap<MediaSource, SourceBuffer[]>();
  const kept = new WeakMap<SourceBuffer, { mime: string; chunks: Uint8Array[] }>();
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (o: Blob | MediaSource) => {
    const url = createObjectURL.call(URL, o);
    if (o instanceof MediaSource) sources.set(url, o);
    return url;
  };
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime: string) {
    const b = addSourceBuffer.call(this, mime);
    if (/^audio\/|codecs=.*\b(mp4a|opus|vorbis|flac|ac-3|ec-3)/i.test(mime)) {
      kept.set(b, { mime, chunks: [] });
      buffers.set(this, [...(buffers.get(this) ?? []), b]);
    }
    return b;
  };
  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data: BufferSource) {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    kept.get(this)?.chunks.push(bytes.slice());
    return appendBuffer.call(this, data);
  };

  w.__takeSound = {
    step: () => Promise.all(contexts.map((c) => c[STEP]())),
    finish: async () => (await Promise.all(contexts.map((c) => c[FINISH]()))).filter((r) => r.wav),
    async source(url) {
      const ms = sources.get(url);
      if (ms) {
        const fed = (buffers.get(ms) ?? []).map((b) => kept.get(b)!).find((k) => k.chunks.length);
        if (!fed) return null;
        const all = new Uint8Array(fed.chunks.reduce((n, c) => n + c.length, 0));
        fed.chunks.reduce((at, c) => (all.set(c, at), at + c.length), 0);
        return { mime: fed.mime, stream: true, base64: base64(all) };
      }
      if (!url.startsWith('blob:')) return null;
      try {
        const r = await fetch(url);
        return { mime: r.headers.get('content-type') ?? '', stream: false, base64: base64(new Uint8Array(await r.arrayBuffer())) };
      } catch {
        return null;
      }
    },
  };
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
  const srcOf = new Map<string, string>();
  const open = new Map<string, Run>();
  const runs: Run[] = [];

  return {
    async moved(played, filmed) {
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
    },
    async finish(dir) {
      for (const run of open.values()) runs.push({ ...run, to: run.to + TAIL_SECONDS * run.rate });
      open.clear();
      const warnings: string[] = [];
      const clips: Clip[] = [];
      const files: [string, Buffer][] = [];
      const seconds = (pageMs: number) => (pageMs - t0) / 1000;

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
