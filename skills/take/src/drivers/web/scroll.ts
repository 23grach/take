import type { Page } from 'playwright';
import type { Point, Span } from './geometry.ts';
import { PACING, ease, frames, scrollMs, swipeProgress } from './pacing.ts';
import { shown, tick, wait, type PerformState } from './perform-state.ts';
import { contact, moveTo } from './pointer.ts';

export async function scroll(s: PerformState, dx: number, dy: number, room = 0) {
  if (!s.phone) return wheel(s, [dx, dy], Math.max(frames(scrollMs(Math.hypot(dx, dy))), room), ease, s.pointer);
  const { lift, reach } = PACING.swipe;
  const [lo, hi] = shown(s);
  let left: Point = [dx, dy];
  const strokes = Math.max(1, Math.ceil((lift * Math.max(Math.abs(dx) / s.viewport[0], Math.abs(dy) / (hi - lo))) / reach));
  for (let i = strokes; i > 0; i--) {
    const part: Point = [Math.round(left[0] / i), Math.round(left[1] / i)];
    left = [left[0] - part[0], left[1] - part[1]];
    await swipe(s, part, Math.round(room / strokes));
  }
}

async function swipe(s: PerformState, [dx, dy]: Point, room = 0) {
  const { lift, slower } = PACING.swipe;
  const across = (along: number, [lo, hi]: Span, now: number) => {
    const size = hi - lo;
    return along ? lo + size / 2 + (lift * along) / 2 : Math.min(lo + size * 0.65, Math.max(lo + size * 0.35, now));
  };
  const start: Point = [across(dx, [0, s.viewport[0]], s.pointer[0]), across(dy, shown(s), s.pointer[1])];
  await moveTo(s, async () => start);
  await wait(s, PACING.settle);
  const n = Math.max(frames(scrollMs(Math.hypot(dx, dy)) * slower), room);
  const held = Math.max(1, Math.round(n * lift));
  contact(s, 'down');
  let lifted = false;
  await wheel(s, [dx, dy], n, swipeProgress, start, (k, p) => {
    if (lifted) return;
    s.pointer = [start[0] - dx * p, start[1] - dy * p];
    if (k >= held) {
      lifted = true;
      contact(s, 'up');
    }
  });
}

function atLeastAPixel(s: PerformState, total: number, due: number, done: number) {
  if (s.phone || !done) return Math.round(due);
  const way = Math.sign(total);
  const left = Math.abs(total - done);
  return left < 0.5 ? 0 : way * Math.min(Math.round(left), Math.max(1, Math.round(way * due)));
}

async function wheel(s: PerformState, [dx, dy]: Point, n: number, progress: (t: number) => number, at: Point, each?: (k: number, p: number) => void) {
  let done: Point = [0, 0];
  let waitForMove = true;
  const f0 = s.clock.frame;
  for (let k = 1; ; k = Math.min(n, s.clock.frame - f0 + 1)) {
    const p = progress(k / n);
    each?.(k, p);
    const step: Point = [atLeastAPixel(s, dx, dx * p - done[0], done[0]), atLeastAPixel(s, dy, dy * p - done[1], done[1])];
    if (step[0] || step[1]) {
      const before = waitForMove ? await scrolledAt(s.page, at) : undefined;
      if (s.phone) await s.glass!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at[0], y: at[1], deltaX: step[0], deltaY: step[1] });
      else await s.page.mouse.wheel(...step);
      if (before !== undefined) waitForMove = await movedFrom(s.page, before, at);
      s.events.push({ frame: s.clock.frame, type: 'scroll', dx: step[0], dy: step[1] });
      done = [done[0] + step[0], done[1] + step[1]];
    }
    await tick(s);
    if (k === n) return;
  }
}

function scrolledAt(page: Page, at: Point): Promise<number> {
  return page
    .evaluate(([x, y]) => {
      let sum = window.scrollX + window.scrollY;
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) sum += el.scrollTop + el.scrollLeft;
      return sum;
    }, at)
    .catch(() => 0);
}

async function movedFrom(page: Page, before: number, at: Point): Promise<boolean> {
  const until = performance.now() + 200;
  while (performance.now() < until) {
    if ((await scrolledAt(page, at)) !== before) return true;
    await new Promise((r) => setTimeout(r, 4));
  }
  return false;
}
