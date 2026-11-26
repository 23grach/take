import type { Page } from 'playwright';
import type { Box } from './events.ts';

const SEEK_MS = 3000;

export interface Played {
  id: string;
  at: number;
  from: number;
  to: number;
  rate: number;
  volume: number;
  src?: string;
}

export function watchMedia(): void {
  type Held = HTMLMediaElement & {
    __take?: {
      id: string;
      time: number;
      rate: number;
      set?: number;
      since?: { page: number; media?: number };
      sent?: string;
      ended?: boolean;
      seeked?: () => void;
      waited?: boolean;
      rates?: number;
    };
  };
  const w = globalThis as unknown as { __takeMedia?: (ms: number) => Promise<{ shown: Box[]; played: Played[] }>; __takeMediaPlays: () => void };
  if (w.__takeMedia) return;
  const media = new Set<Held>();
  const token = Math.random().toString(36).slice(2, 8);
  const now = (el: Held) => {
    const s = el.__take;
    return s?.set !== undefined && Math.abs(el.currentTime - s.set) < 0.05 ? s.time : el.currentTime;
  };
  const started = (el: Held) => {
    if (!el.__take) {
      const s: NonNullable<Held['__take']> = (el.__take = { id: `${token}-${media.size}`, time: el.currentTime, rate: el.playbackRate || 1 });
      media.add(el);
      w.__takeMediaPlays();
      const moved = () => s.since && (s.since.media = undefined);
      el.addEventListener('seeking', moved);
      el.addEventListener('emptied', moved);
      el.addEventListener('seeked', () => s.seeked?.());
    }
    if (el.__take.ended) {
      el.__take.ended = false;
      el.__take.set = undefined;
    }
    el.__take.since ??= { page: Date.now(), media: now(el) };
  };
  const hidden = (e: Event) => {
    const el = e.target as Held;
    const s = el?.__take;
    if (!s) return;
    const mine =
      e.type === 'ratechange' ? !!s.rates && s.rates-- > 0
      : e.type === 'playing' ? s.waited && !(s.waited = false)
      : !!s.seeked;
    if (e.type === 'waiting' && s.seeked) s.waited = true;
    if (e.type === 'seeked') s.seeked?.();
    if (mine) e.stopImmediatePropagation();
  };
  for (const type of ['seeking', 'waiting', 'seeked', 'playing', 'ratechange']) addEventListener(type, hidden, true);
  const setRate = (el: Held, rate: number) => {
    if (el.playbackRate === rate) return;
    el.__take!.rates = (el.__take!.rates ?? 0) + 1;
    el.playbackRate = rate;
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: Held) {
    if (this.paused || this.__take?.ended) started(this);
    return play.call(this);
  };
  document.addEventListener('play', (e) => e.target instanceof HTMLMediaElement && started(e.target as Held), true);

  w.__takeMedia = (ms) => {
    const end = Date.now();
    const moving: Promise<unknown>[] = [];
    const shown: Box[] = [];
    const played: Played[] = [];
    for (const v of media) {
      const s = v.__take!;
      if (v.paused || v.ended || s.ended || v.readyState < 1) continue;
      if (v.playbackRate !== 0) {
        s.time = now(v);
        s.rate = v.playbackRate;
        setRate(v, 0);
        s.set = v.currentTime;
      }
      const at = s.since ? Math.min(s.since.page, end) : end - ms;
      const from = s.since?.media ?? now(v);
      s.since = undefined;
      let to = from + ((end - at) / 1000) * s.rate;
      let t = to;
      const d = v.duration;
      if (Number.isFinite(d) && d > 0) {
        if (v.loop) t %= d;
        else to = t = Math.min(t, d);
      }
      s.time = t;
      const src = v.currentSrc || v.src;
      played.push({ id: s.id, at, from, to, rate: s.rate, volume: v.muted ? 0 : v.volume, ...(src !== s.sent ? { src } : {}) });
      s.sent = src;
      if (!v.loop && t >= d) {
        s.ended = true;
        setRate(v, s.rate);
        v.currentTime = d;
        continue;
      }
      if (!(v instanceof HTMLVideoElement)) continue;
      const r = v.getBoundingClientRect();
      const style = getComputedStyle(v);
      const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      if (!onScreen) continue;
      shown.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      if (Math.abs(v.currentTime - t) < 1e-4) continue;
      const f = v as HTMLVideoElement & { __takeShown?: number; __takeFrameLen?: number };
      const start = f.__takeShown;
      if (start !== undefined && f.__takeFrameLen && t >= start && t < start + f.__takeFrameLen - 1e-4) continue;
      v.requestVideoFrameCallback((_, meta) => {
        const gap = f.__takeShown === undefined ? 0 : meta.mediaTime - f.__takeShown;
        if (gap > 1e-3 && gap < 0.1) f.__takeFrameLen = Math.min(f.__takeFrameLen ?? Infinity, gap);
        f.__takeShown = meta.mediaTime;
      });
      moving.push(new Promise<void>((done) => (s.seeked = () => {
        s.seeked = undefined;
        done();
      })));
      v.currentTime = t;
      s.set = v.currentTime;
    }
    return Promise.all(moving).then(() => ({ shown, played }));
  };
}

export async function stepMedia(page: Page, ms: number): Promise<{ boxes: Box[]; played: Played[] }> {
  const main = page.mainFrame();
  const none = { shown: [] as Box[], played: [] as Played[] };
  const stepped = await Promise.all(
    page.frames().map((f) => {
      const step = f.evaluate((ms) => (globalThis as unknown as { __takeMedia?: (ms: number) => Promise<typeof none> }).__takeMedia?.(ms), ms).then((r) => r ?? none, () => none);
      const limited = Promise.race([step, new Promise<typeof none>((r) => setTimeout(() => r(none), SEEK_MS))]);
      return f === main ? limited : limited.then((r) => ({ shown: [], played: r.played }));
    }),
  );
  return {
    boxes: stepped.flatMap((s) => s.shown).map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })),
    played: stepped.flatMap((s) => s.played),
  };
}
