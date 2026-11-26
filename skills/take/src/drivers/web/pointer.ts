import { round, type Point } from './geometry.ts';
import { PACING, clickGaps, dragMs, frames, spring, travelMs } from './pacing.ts';
import { tick, wait, type PerformState } from './perform-state.ts';

export async function moveTo(s: PerformState, to: () => Promise<Point>, { drag = false } = {}): Promise<void> {
  const from = s.pointer;
  let dest = await to();
  const dist = Math.hypot(dest[0] - from[0], dest[1] - from[1]);
  const n = frames(drag ? dragMs(dist) : travelMs(dist));
  const arc = drag ? PACING.drag.arc : PACING.arc;
  const f0 = s.clock.frame;
  for (;;) {
    const k = Math.min(n, s.clock.frame - f0 + 1);
    const p = spring(k / n);
    const [dx, dy] = [dest[0] - from[0], dest[1] - from[1]];
    const bend = Math.sin(Math.PI * p) * arc;
    s.pointer = [from[0] + dx * p - dy * bend, from[1] + dy * p + dx * bend];
    if (!s.phone) await s.page.mouse.move(...s.pointer);
    else if (s.touching) await touch(s, 'touchMove');
    if (k === n) return;
    await tick(s);
    dest = await to();
  }
}

export const contact = (s: PerformState, type: 'down' | 'up') =>
  s.events.push({ frame: s.clock.frame, type, x: round(s.pointer[0]), y: round(s.pointer[1]) });

async function touch(s: PerformState, type: 'touchStart' | 'touchMove' | 'touchEnd') {
  await s.glass!.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: s.pointer[0], y: s.pointer[1] }] });
}

export async function press(s: PerformState, clickCount = 1) {
  contact(s, 'down');
  if (!s.phone) return s.page.mouse.down({ clickCount });
  await touch(s, 'touchStart');
  s.touching = true;
}

export async function release(s: PerformState, clickCount = 1) {
  contact(s, 'up');
  if (!s.phone) return s.page.mouse.up({ clickCount });
  s.touching = false;
  await touch(s, 'touchEnd');
}

const pressFor = (s: PerformState, clicks: number) => (s.phone ? PACING.tap : clicks > 1 ? PACING.multiClickPress : PACING.press);

export async function clickHere(s: PerformState, clicks = 1, left?: () => number) {
  const gaps = clickGaps(clicks, left?.());
  for (let n = 1; n <= clicks; n++) {
    if (n > 1) await wait(s, gaps[n - 2]);
    await press(s, n);
    await wait(s, pressFor(s, clicks));
    await release(s, n);
  }
  await tick(s);
}

export async function clickAt(s: PerformState, point: Point, clicks = 1, left?: () => number): Promise<undefined> {
  await moveTo(s, async () => point);
  await wait(s, PACING.settle);
  await clickHere(s, clicks, left);
  return undefined;
}
