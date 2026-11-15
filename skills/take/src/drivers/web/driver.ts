// Performs a take in a real page at a human pace, one frame at a time, and logs what happened.
// The real mouse follows the same path the cursor will be drawn on, so hover states show in the footage.
import { ownError } from './page-errors.ts';
import type { Locator, Page } from 'playwright';
import { DEFAULTS, shownAddress, type Condition, type Spot, type Step, type Take, type Target } from '../../take/format.ts';
import type { Clock } from './clock.ts';
import type { Box, Event, EventLog, StepLog } from './events.ts';
import { PACING, dragMs, ease, frames, scrollMs, travelMs, typingSchedule } from './pacing.ts';
import { describe, describeCondition, holds, locate } from './targets.ts';
import { cursorReader, sameCursor, type Cursor } from './cursor.ts';
import { caretAt, type Caret } from './caret.ts';

/** A take that can't be performed, with the step and the reason in plain words. */
export class TakeError extends Error {
  readonly step: number;
  /** step -1: before the first step, while opening the app. */
  constructor(step: number, message: string) {
    super(step < 0 ? `opening the app: ${message}` : `step ${step + 1}: ${message}`);
    this.step = step;
  }
}

/** The key as a keyboard sends it: with Cmd, Ctrl or Alt held, a letter key gives its lowercase letter ("Meta+K"
 *  → "Meta+k"), as on a real keyboard; Playwright would send a capital K, which shortcuts listening for "k" ignore.
 *  With Shift held the capital stays. */
export function asPressed(key: string): string {
  const parts = key.split('+');
  const last = parts.at(-1)!;
  if (parts.length > 1 && /^[A-Z]$/.test(last) && !parts.slice(0, -1).includes('Shift')) parts[parts.length - 1] = last.toLowerCase();
  return parts.join('+');
}

type Point = [number, number];
const center = (b: Box): Point => [b.x + b.width / 2, b.y + b.height / 2];
const round = (n: number) => Math.round(n * 10) / 10;

export interface PerformOptions {
  /** Called after each step finishes (before the pause to the next), with where the pointer is. `take probe` screenshots here. */
  onStep?: (log: StepLog, pointer: [number, number]) => Promise<void>;
  /** Called after every frame with the log so far (`frames`: how many frames there are so far). The log is the
   *  one perform returns, growing: `take run` composes from it while recording. */
  onFrame?: (log: EventLog) => void;
  /** Read the cursor and caret every frame for the event log (default). A rehearsal, which films nothing, skips it. */
  watch?: boolean;
}

/** The take's setup steps (closing a cookie banner, a welcome pop-up), done on `clock` without recording anything:
 *  the caller's clock moves page time on without filming. A failure says "setup step N". */
export async function performSetup(page: Page, take: Take, clock: Clock): Promise<boolean> {
  if (!take.setup?.length) return false;
  try {
    await perform(page, { ...take, steps: take.setup, loop: 'none' }, clock, { watch: false });
  } catch (e) {
    if (e instanceof TakeError && e.step >= 0) throw new TakeError(-1, `setup ${e.message}`);
    throw e;
  }
  return true;
}

/** Opens nothing and closes nothing: the page must already show take.target.url. */
export async function perform(page: Page, take: Take, clock: Clock, { onStep, onFrame, watch = true }: PerformOptions = {}): Promise<EventLog> {
  const [vw, vh] = take.target.viewport;
  let pointer: Point = [Math.round(vw * PACING.start[0]), Math.round(vh * PACING.start[1])];
  const path: Point[] = [];
  const events: Event[] = [];
  const steps: StepLog[] = [];
  const marks: Record<string, number> = {};
  const cursors: [number, Cursor][] = [];
  const cursorAt = cursorReader(page);
  const carets: [number, Caret | null][] = [];
  const pageErrors: string[] = [];
  const onError = (e: Error) => void (ownError(e, page.url()) && pageErrors.push(e.message));
  page.on('pageerror', onError);
  const eventLog: EventLog = {
    version: 0,
    title: take.title,
    url: take.target.url,
    address: shownAddress(take.target),
    fps: clock.fps,
    viewport: take.target.viewport,
    scale: take.target.scale,
    frames: clock.frame,
    pointer: path,
    cursors,
    carets,
    events,
    steps,
    marks,
    loop: take.loop,
  };
  let current = 0; // index of the step being performed, for messages
  await page.mouse.move(...pointer);

  /** Records where the pointer is in this frame, then moves one frame on. */
  async function tick() {
    path[clock.frame] = [round(pointer[0]), round(pointer[1])];
    // The page under a still pointer can change too (a dialog opens), so look every frame.
    // While a link opens the next page there is no page to ask: keep the cursor it had.
    if (watch) {
      const shape = await cursorAt(pointer).catch((): Cursor => cursors.at(-1)?.[1] ?? 'default');
      if (!sameCursor(cursors.at(-1)?.[1], shape)) cursors.push([clock.frame, shape]);
      const caret = await caretAt(page).catch(() => null);
      if (!carets.length || JSON.stringify(carets.at(-1)![1]) !== JSON.stringify(caret)) carets.push([clock.frame, caret]);
    }
    await clock.tick();
    eventLog.frames = clock.frame;
    onFrame?.(eventLog);
    if (pageErrors.length)
      throw new TakeError(current, `the app threw an error: "${pageErrors[0]}". Take stops rather than film a broken app; fix the app, or the step that sets it off`);
  }
  /** A time limit in frames: limits are wall time, so a fast-forwarding clock gets as many seconds as a normal one. */
  const limit = (ms: number) => frames(ms * (clock.speed ?? 1));

  async function wait(ms: number) {
    const end = clock.frame + frames(ms);
    while (clock.frame < end) await tick();
  }

  /** Waits for exactly one visible element to match, and returns it. Several matches can be a moment in a
   *  transition (an old and a new copy of a list), so they too get until the deadline to settle to one. */
  async function find(t: Target): Promise<Locator> {
    const loc = locate(page, t).filter({ visible: true });
    const give = clock.frame + limit(PACING.find);
    for (;;) {
      const n = await loc.count();
      if (n === 1) return loc;
      if (clock.frame >= give) {
        if (n === 0) throw new TakeError(current, `can't find ${describe(t)} (looked for ${PACING.find / 1000} s)`);
        const names = await loc.evaluateAll((els) => els.slice(0, 3).map((e) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.tagName.toLowerCase()).trim().replace(/\s+/g, ' ').slice(0, 40)));
        throw new TakeError(current, `${n} elements match ${describe(t)} (${names.map((x) => `"${x}"`).join(', ')}${n > 3 ? ', …' : ''}); make the target more specific (add "exact": true, or use a role and name)`);
      }
      await tick();
    }
  }

  /** Where the element is now. If it went away for a moment (re-rendered, replaced), find it again. */
  async function boxOf(loc: Locator, t: Target): Promise<Box> {
    for (let attempt = 0; ; attempt++) {
      const b = await loc.boundingBox({ timeout: 500 }).catch(() => null);
      if (b && b.width > 0 && b.height > 0) return { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
      if (attempt > 0) throw new TakeError(current, `${describe(t)} has no size on screen`);
      await find(t); // waits until exactly one is back; the locator then points at it
    }
  }

  /** Is the element on screen along one axis? Fully, with a couple of pixels' grace for rounding at the window's
   *  edge; or, for something bigger than the screen (a canvas, a long panel), its middle. */
  const fitsAxis = (start: number, size: number, screen: number) =>
    size <= screen ? start >= -2 && start + size <= screen + 2 : start + size / 2 >= 0 && start + size / 2 <= screen;

  /** Like a person: if the element is off screen, scroll it to the middle first. A scroll the wheel can't do
   *  (the pointer isn't over the part that scrolls, or it's off to the side) falls back to jumping there. */
  async function bringIntoView(loc: Locator, t: Target) {
    let box = await boxOf(loc, t);
    const ok = (b: Box) => fitsAxis(b.x, b.width, vw) && fitsAxis(b.y, b.height, vh);
    if (ok(box)) return;
    if (!fitsAxis(box.y, box.height, vh)) {
      await scroll(0, Math.round(center(box)[1] - vh / 2));
      box = await boxOf(loc, t);
      if (ok(box)) return;
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await tick();
  }

  /** What's at a point, in words, for "covered by …" messages. */
  const whatIsAt = ([x, y]: Point) =>
    page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return 'nothing (outside the page)';
      const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      return name ? `${role} "${name}"` : `a ${role}${el.classList.length ? ` (.${[...el.classList].slice(0, 2).join('.')})` : ''}`;
    }, [x, y] as Point);

  /** Moves the pointer along a gently curved, eased path to a place that may itself be moving (a dialog scaling
   *  in): `to` is read again every frame. A drag moves slower and straighter than a free hand. */
  async function moveTo(to: () => Promise<Point>, { drag = false } = {}): Promise<void> {
    const from = pointer;
    let dest = await to();
    const dist = Math.hypot(dest[0] - from[0], dest[1] - from[1]);
    const n = frames(drag ? dragMs(dist) : travelMs(dist));
    const arc = drag ? PACING.drag.arc : PACING.arc;
    const f0 = clock.frame;
    for (;;) {
      const k = Math.min(n, clock.frame - f0 + 1);
      const p = ease(k / n);
      const [dx, dy] = [dest[0] - from[0], dest[1] - from[1]];
      const bend = Math.sin(Math.PI * p) * arc; // bends to the right of the direction of travel
      pointer = [from[0] + dx * p - dy * bend, from[1] + dy * p + dx * bend];
      await page.mouse.move(...pointer);
      if (k === n) return;
      await tick();
      dest = await to();
    }
  }

  /** Moves the pointer onto the element, following it if it moves. */
  async function travel(loc: Locator, t: Target): Promise<Box> {
    await bringIntoView(loc, t);
    let box = await boxOf(loc, t);
    await moveTo(async () => center((box = await boxOf(loc, t))));
    return box;
  }

  /** Brings the pointer onto the element and waits until a press there would land on it. Something passing over
   *  it (a toast, a closing overlay) or a button that enables a moment later gets time to clear; if the element
   *  moved meanwhile, follow it. Only then give up, saying what's in the way. */
  async function reach(loc: Locator, t: Target): Promise<Box> {
    await travel(loc, t);
    await wait(PACING.settle);
    const give = clock.frame + limit(PACING.find);
    for (;;) {
      const box = await boxOf(loc, t);
      const inside = pointer[0] >= box.x && pointer[0] <= box.x + box.width && pointer[1] >= box.y && pointer[1] <= box.y + box.height;
      if (!inside) {
        await travel(loc, t);
        await wait(PACING.settle);
        continue;
      }
      const onTarget = await loc.evaluate((el, [x, y]) => {
        const hit = document.elementFromPoint(x, y);
        // A radio or checkbox hidden under its own label is clicked through the label, as a person would.
        const labels = [...((el as HTMLInputElement).labels ?? [])];
        return !!hit && (el === hit || el.contains(hit) || labels.some((l) => l === hit || l.contains(hit)));
      }, pointer);
      const disabled = onTarget && (await loc.isDisabled());
      if (onTarget && !disabled) return box;
      if (clock.frame >= give) {
        const why = disabled ? `stayed disabled for ${PACING.find / 1000} s` : `is covered by ${await whatIsAt(pointer)}`;
        throw new TakeError(current, `${describe(t)} ${why}`);
      }
      await tick();
    }
  }

  async function press(clickCount = 1) {
    events.push({ frame: clock.frame, type: 'down', x: round(pointer[0]), y: round(pointer[1]) });
    await page.mouse.down({ clickCount });
  }
  async function release(clickCount = 1) {
    events.push({ frame: clock.frame, type: 'up', x: round(pointer[0]), y: round(pointer[1]) });
    await page.mouse.up({ clickCount });
  }

  /** `clicks` 2 or 3: a double- or triple-click, quick as a person's (each press shorter, a short gap between). */
  async function click(loc: Locator, t: Target, clicks = 1): Promise<Box> {
    const box = await reach(loc, t);
    for (let n = 1; n <= clicks; n++) {
      if (n > 1) await wait(PACING.multiClickGap);
      await press(n);
      await wait(clicks > 1 ? PACING.multiClickPress : PACING.press);
      await release(n);
    }
    await tick();
    return box;
  }

  /** A click at a point on the page, for things no target names (an icon that only shows on hover). */
  async function clickAt(point: Point, clicks = 1): Promise<undefined> {
    await moveTo(async () => point);
    await wait(PACING.settle);
    for (let n = 1; n <= clicks; n++) {
      if (n > 1) await wait(PACING.multiClickGap);
      await press(n);
      await wait(clicks > 1 ? PACING.multiClickPress : PACING.press);
      await release(n);
    }
    await tick();
    return undefined;
  }

  /** Press at `from`, move to `to` with the button held, let go: draws a shape, moves a slider, reorders a list. */
  async function drag(from: Spot, to: Spot): Promise<Box | undefined> {
    let box: Box | undefined;
    if (Array.isArray(from)) {
      await moveTo(async () => from);
      await wait(PACING.settle);
    } else box = await reach(await find(from), from);
    await press();
    await wait(PACING.drag.grip);
    if (Array.isArray(to)) await moveTo(async () => to, { drag: true });
    else {
      const loc = await find(to);
      await moveTo(async () => center(await boxOf(loc, to)), { drag: true });
    }
    await wait(PACING.drag.grip);
    await release();
    await tick();
    return box;
  }

  async function scroll(dx: number, dy: number) {
    const n = frames(scrollMs(Math.hypot(dx, dy)));
    let done: Point = [0, 0];
    let waitForMove = true;
    for (let k = 1; k <= n; k++) {
      const p = ease(k / n);
      const step: Point = [Math.round(dx * p - done[0]), Math.round(dy * p - done[1])];
      if (step[0] || step[1]) {
        const before = waitForMove ? await scrolledAt(pointer) : undefined;
        await page.mouse.wheel(...step);
        // Sites with their own wheel handlers (x.com) apply a wheel nudge a moment later; capturing before
        // it lands shows a stalled frame, then a double step. Wait until the page has moved.
        if (before !== undefined) waitForMove = await movedFrom(before, pointer);
        events.push({ frame: clock.frame, type: 'scroll', dx: step[0], dy: step[1] });
        done = [done[0] + step[0], done[1] + step[1]];
      }
      await tick();
    }
  }

  /** How far everything that scrolls under the pointer, and the page itself, is scrolled. */
  function scrolledAt(at: Point): Promise<number> {
    return page
      .evaluate(([x, y]) => {
        let sum = window.scrollX + window.scrollY;
        for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) sum += el.scrollTop + el.scrollLeft;
        return sum;
      }, at)
      .catch(() => 0);
  }

  /** Waits (wall time, up to 200 ms) for a scroll to show. False if nothing moved: the page can't scroll there. */
  async function movedFrom(before: number, at: Point): Promise<boolean> {
    const until = performance.now() + 200;
    while (performance.now() < until) {
      if ((await scrolledAt(at)) !== before) return true;
      await new Promise((r) => setTimeout(r, 4));
    }
    return false;
  }

  async function until(c: Condition, timeout: number): Promise<Box | undefined> {
    const give = clock.frame + limit(timeout);
    while (!(await holds(page, c))) {
      if (clock.frame >= give) throw new TakeError(current, `waited ${timeout / 1000} s for ${describeCondition(c)}`);
      await tick();
    }
    if ('visible' in c) {
      const b = await locate(page, c.visible).filter({ visible: true }).first().boundingBox();
      if (b) return { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
    }
  }

  async function run(s: Step, log: StepLog) {
    switch (s.do) {
      case 'click':
        log.target = Array.isArray(s.target) ? await clickAt(s.target, s.clicks) : await click(await find(s.target), s.target, s.clicks);
        break;
      case 'hover':
        if (Array.isArray(s.target)) {
          const point = s.target;
          await moveTo(async () => point);
        } else log.target = await travel(await find(s.target), s.target);
        break;
      case 'drag':
        log.target = await drag(s.from, s.to);
        break;
      case 'type': {
        if (s.target) log.target = await click(await find(s.target), s.target);
        if (s.target) await wait(PACING.settle);
        // Characters land on whole frames, at a person's uneven rhythm that averages the typing speed.
        const f0 = clock.frame;
        const at = typingSchedule(s.text, s.cps, clock.fps);
        for (const [i, ch] of [...s.text].entries()) {
          while (clock.frame < f0 + at[i]) await tick();
          events.push({ frame: clock.frame, type: 'key', key: ch });
          await page.keyboard.type(ch);
        }
        await tick();
        break;
      }
      case 'press':
        events.push({ frame: clock.frame, type: 'key', key: s.key });
        await page.keyboard.press(asPressed(s.key)).catch((e: Error) => {
          // validate catches most; the browser may still refuse one, so say which step and which key.
          const unknown = /Unknown key: "([^"]*)"/.exec(e.message)?.[1];
          throw unknown === undefined ? e : new TakeError(current, `unknown key "${unknown}" in "${s.key}"; use the browser's key names, e.g. Meta, Control, Alt, Shift, Enter, Escape`);
        });
        await tick();
        break;
      case 'scroll':
        if ('by' in s) {
          const at = () => page.evaluate(() => [scrollX, scrollY]).catch(() => [0, 0]);
          const before = await at();
          await scroll(...s.by);
          const after = await at();
          if (before[0] === after[0] && before[1] === after[1])
            log.note = "the page didn't scroll (fine if something under the pointer was meant to, like a map or a list; otherwise the page may be locked, e.g. by an open menu)";
        } else {
          const loc = await find(s.target);
          const box = await boxOf(loc, s.target);
          const inView = fitsAxis(box.x, box.width, vw) && fitsAxis(box.y, box.height, vh);
          // Bring it to the middle of the screen, which reads better than the edge.
          if (!inView) await scroll(0, Math.round(center(box)[1] - vh / 2));
          else log.note = `nothing scrolled: ${describe(s.target)} is already on screen; scroll "by" a distance to move the page`;
          log.target = await boxOf(loc, s.target);
        }
        break;
      case 'wait':
        log.waitedFor = await until(s.for, s.timeout);
        break;
      case 'hold':
        await wait(s.ms);
        break;
    }
    if (s.waitFor) log.waitedFor = await until(s.waitFor, DEFAULTS.timeout);
  }

  for (const [i, s] of take.steps.entries()) {
    current = i;
    const log: StepLog = { index: i, do: s.do, start: clock.frame, end: clock.frame };
    if (s.mark) {
      log.mark = s.mark;
      marks[s.mark] = clock.frame;
    }
    await run(s, log);
    log.end = Math.max(log.start, clock.frame - 1);
    steps.push(log);
    await onStep?.(log, pointer);
    // No gap after a hold: a hold already is a pause, and the last one ends the take.
    if (s.do !== 'hold' && i < take.steps.length - 1) await wait(PACING.gap);
  }
  page.off('pageerror', onError);
  fillSkipped(path);
  // In live mode the last frame can skip too: hold the pointer where it was up to the end.
  while (path.length < clock.frame) path.push(path.at(-1)!);
  eventLog.frames = clock.frame;
  return eventLog;
}

/** In live mode a slow frame makes the clock skip ahead. Fill those frames in between their neighbours,
 *  so the cursor drawn later moves smoothly even where the footage hitched. */
function fillSkipped(path: Point[]) {
  for (let f = 1; f < path.length; f++) {
    if (path[f]) continue;
    let g = f;
    while (!path[g]) g++;
    const [a, b] = [path[f - 1], path[g]];
    for (let h = f; h < g; h++) {
      const t = (h - f + 1) / (g - f + 1);
      path[h] = [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
    }
    f = g;
  }
}
