// Media in the page (<video>, <audio>, new Audio()) plays on real time, not on the frozen page clock. Left alone, a
// final video would film videos several times too fast and in jumps, and their sound would have no place on the
// video's timeline. In studio mode Take holds every playing element still and moves its time on frame by frame.
import type { Page } from 'playwright';
import type { Box } from './events.ts';

/** How long a frame waits for a video to show its next picture (it may still be downloading). */
const SEEK_MS = 3000;

/** What one media element played during a step: on page time from `at` (ms), from `from` to `to` seconds of its
 *  own time. `src` is sent when it's new for that element. */
export interface Played {
  id: string;
  at: number;
  from: number;
  to: number;
  rate: number;
  /** 0 when muted. */
  volume: number;
  src?: string;
}

/** Studio, in every page and frame before its own scripts: keeps a list of the media elements that start playing
 *  (new Audio() is never in the document, so play() itself is watched too) and the page time each one starts at,
 *  and tells Take once per element, so pages without media get no extra work per frame. */
export function watchMedia(): void {
  type Held = HTMLMediaElement & {
    __take?: {
      id: string;
      /** Its time, as Take counts it, and the rate it plays at (the element itself is held at rate 0). */
      time: number;
      rate: number;
      /** What currentTime read when Take last set or held it: anything else means the page moved it. */
      set?: number;
      /** When it last started playing: page time (ms), and its own time then unless the page has moved it since. */
      since?: { page: number; media?: number };
      sent?: string;
      /** Reached its end on Take's count. */
      ended?: boolean;
      /** Take is moving it to a new time: called when it gets there. */
      seeked?: () => void;
      /** Take's own seek made it wait for data, so the "playing" after that is Take's too. */
      waited?: boolean;
      /** Speed changes Take made that the page hasn't been told about (it never is). */
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
      // A page that starts a video and then moves it (YouTube jumps to the time in its address) or gives it a new
      // file: where it was when it started no longer counts.
      const moved = () => s.since && (s.since.media = undefined);
      el.addEventListener('seeking', moved);
      el.addEventListener('emptied', moved);
      // An element outside the document never reaches the window: it hears Take's seeks, but Take still knows.
      el.addEventListener('seeked', () => s.seeked?.());
    }
    if (el.__take.ended) {
      // Starting over: from wherever it is now.
      el.__take.ended = false;
      el.__take.set = undefined;
    }
    el.__take.since ??= { page: Date.now(), media: now(el) };
  };
  // Take's own seeks (one per frame) and speed changes are hidden from the page: a player that saw them would think
  // it keeps buffering (YouTube then starts the film again the moment it's paused). Listening on the window before
  // the page's own scripts, so nothing in the page hears them; only Take does.
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
  /** Sets its speed without the page hearing of it. */
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
  // Elements that start on their own (autoplay) never call play().
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
        // Just started, or the page changed its speed: hold it, and count its time from here.
        s.time = now(v);
        s.rate = v.playbackRate;
        setRate(v, 0);
        s.set = v.currentTime;
      }
      // Started during this step (or while it was loading, as if the network were instant): from that moment.
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
        // Its end, on page time: let it go there at its own rate, so the page gets its "ended" (at once, or after
        // playing out unheard when its server doesn't let it seek).
        s.ended = true;
        setRate(v, s.rate);
        v.currentTime = d;
        continue;
      }
      if (!(v instanceof HTMLVideoElement)) continue;
      const r = v.getBoundingClientRect();
      const style = getComputedStyle(v);
      const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      // Videos off screen keep counting their time and catch up when they come into view.
      if (!onScreen) continue;
      shown.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      if (Math.abs(v.currentTime - t) < 1e-4) continue;
      // Most page videos are 24–30 fps, so every other frame still shows the same picture: don't seek then.
      // The picture's length is learnt from the gaps between the pictures shown so far.
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

/** Studio: moves every playing media element on `ms` of page time (call it after page time moved on) and waits
 *  until each video on screen shows that moment. A playing element is held at playback rate 0 (it stays "playing"
 *  for the page, no pause events) and Take counts its time, so in the final video it plays at its true speed,
 *  frame for frame. Returns where the videos on screen are (page pixels, main page only), so the check can tell a
 *  video's own frame rate from a stall, and what each element played, for its sound. */
export async function stepMedia(page: Page, ms: number): Promise<{ boxes: Box[]; played: Played[] }> {
  const main = page.mainFrame();
  const none = { shown: [] as Box[], played: [] as Played[] };
  const stepped = await Promise.all(
    page.frames().map((f) => {
      const step = f.evaluate((ms) => (globalThis as unknown as { __takeMedia?: (ms: number) => Promise<typeof none> }).__takeMedia?.(ms), ms).then((r) => r ?? none, () => none);
      // Page timers are frozen, so the time limit is kept here.
      const limited = Promise.race([step, new Promise<typeof none>((r) => setTimeout(() => r(none), SEEK_MS))]);
      return f === main ? limited : limited.then((r) => ({ shown: [], played: r.played }));
    }),
  );
  return {
    boxes: stepped.flatMap((s) => s.shown).map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })),
    played: stepped.flatMap((s) => s.played),
  };
}
