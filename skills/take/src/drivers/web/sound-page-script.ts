export interface Rendered {
  start: number;
  wav: string;
  cut: boolean;
}

interface Source {
  mime: string;
  stream: boolean;
  base64: string;
}

export interface PageSound {
  step(): Promise<unknown>;
  finish(): Promise<Rendered[]>;
  source(url: string): Promise<Source | null>;
}

export function webAudio([seconds, tail]: [number, number]): void {
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
