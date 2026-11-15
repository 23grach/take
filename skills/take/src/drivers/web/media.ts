// Videos inside the page (<video>) play on real time, not on the frozen page clock. Left alone, a final video
// would film them several times too fast and in jumps; in studio mode Take moves them on frame by frame instead.
import type { Page } from 'playwright';
import type { Box } from './events.ts';

/** How long a frame waits for a video to show its next picture (it may still be downloading). */
const SEEK_MS = 3000;

/** Studio: moves every playing video on `ms` of video time and waits until each one on screen shows that moment.
 *  A playing video is held at playback rate 0 (it stays "playing" for the page, no pause events) and Take sets its
 *  time itself, so it plays at its true speed in the final video, frame for frame. Videos off screen keep counting
 *  their time and catch up when they come into view. Returns where the videos on screen are (page pixels, main
 *  page only), so the check can tell a video's own frame rate from a stall. */
export async function stepVideos(page: Page, ms: number): Promise<Box[]> {
  const main = page.mainFrame();
  const boxes = await Promise.all(
    page.frames().map((f) => {
      const stepped = f
        .evaluate((ms) => {
          const moving: Promise<unknown>[] = [];
          const shown: { x: number; y: number; width: number; height: number }[] = [];
          for (const v of document.querySelectorAll('video')) {
            const s = v as HTMLVideoElement & { __takeRate?: number; __takeTime?: number; __takeShown?: number; __takeFrameLen?: number };
            if (v.paused || v.ended || v.readyState < 1) continue;
            if (v.playbackRate !== 0) {
              // Just started, or the page changed its speed: take it over from where it is.
              s.__takeRate = v.playbackRate;
              s.__takeTime = v.currentTime;
              v.playbackRate = 0;
            }
            let t = (s.__takeTime ?? v.currentTime) + (ms / 1000) * (s.__takeRate ?? 1);
            const d = v.duration;
            if (Number.isFinite(d) && d > 0) t = v.loop ? t % d : Math.min(t, d);
            s.__takeTime = t;
            const r = v.getBoundingClientRect();
            const style = getComputedStyle(v);
            const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && style.visibility !== 'hidden' && Number(style.opacity) > 0;
            if (!onScreen) continue;
            shown.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            if (Math.abs(v.currentTime - t) < 1e-4) continue;
            // Most page videos are 24–30 fps, so every other frame still shows the same picture: don't seek then.
            // The picture's length is learnt from the gaps between the pictures shown so far.
            const start = s.__takeShown;
            if (start !== undefined && s.__takeFrameLen && t >= start && t < start + s.__takeFrameLen - 1e-4) continue;
            v.requestVideoFrameCallback((_, meta) => {
              const gap = s.__takeShown === undefined ? 0 : meta.mediaTime - s.__takeShown;
              if (gap > 1e-3 && gap < 0.1) s.__takeFrameLen = Math.min(s.__takeFrameLen ?? Infinity, gap);
              s.__takeShown = meta.mediaTime;
            });
            moving.push(new Promise((done) => v.addEventListener('seeked', done, { once: true })));
            v.currentTime = t;
          }
          return Promise.all(moving).then(() => shown);
        }, ms)
        .catch(() => []);
      // Page timers are frozen, so the time limit is kept here.
      const limited = Promise.race([stepped, new Promise<Box[]>((r) => setTimeout(() => r([]), SEEK_MS))]);
      return f === main ? limited : limited.then(() => []);
    }),
  );
  return boxes.flat().map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }));
}
