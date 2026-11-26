import { ownError } from './page-errors.ts';
import type { Locator, Page } from 'playwright';
import { DEFAULTS, PHONE, shownAddress, showsNoCursor, type Appearance, type Condition, type Spot, type Step, type Take, type Target } from '../../take/format.ts';
import type { Clock } from './clock.ts';
import type { Box, Event, EventLog, KeyboardUp, PageTop, StepLog } from './events.ts';
import { pageTop } from './page-top.ts';
import { botCheck, botCheckMessage } from './bot-check.ts';
import { PACING, clickGaps, dragMs, ease, frames, scrollMs, spring, startPoint, swipeProgress, travelMs, typingSchedule } from './pacing.ts';
import { describe, describeCondition, describeMatches, holds, locate } from './targets.ts';
import { cursorReader, sameCursor, type Cursor } from './cursor.ts';
import { caretAt, type Caret } from './caret.ts';

export class TakeError extends Error {
  readonly step: number;
  constructor(step: number, message: string) {
    super(step < 0 ? `opening the app: ${message}` : `step ${step + 1}: ${message}`);
    this.step = step;
  }
}

export function asPressed(key: string): string {
  const parts = key.split('+');
  const last = parts.at(-1)!;
  if (parts.length > 1 && /^[A-Z]$/.test(last) && !parts.slice(0, -1).includes('Shift')) parts[parts.length - 1] = last.toLowerCase();
  return parts.join('+');
}

type Point = [number, number];
const center = (b: Box): Point => [b.x + b.width / 2, b.y + b.height / 2];
const belowLabel = (b: Box): Point => {
  const { right, down, maxRight, maxDown } = PACING.aim;
  const [x, y] = center(b);
  return [x + Math.min(b.width * right, maxRight), y + Math.min(b.height * down, maxDown)];
};
const round = (n: number) => Math.round(n * 10) / 10;
type Span = [number, number];
const fits = (start: number, size: number, [lo, hi]: Span) =>
  size <= hi - lo ? start >= lo - 2 && start + size <= hi + 2 : start + size / 2 >= lo && start + size / 2 <= hi;
const KEYBOARD_DEBOUNCE = 2;

function focusedField(): Span | null {
  let el = document.activeElement as HTMLElement | null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
  if (!el) return null;
  const notText = ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'];
  const takesText = el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !notText.includes((el as HTMLInputElement).type));
  if (!takesText) return null;
  const r = el.getBoundingClientRect();
  return [r.top, r.bottom];
}

const ABOVE_KEYBOARD = PHONE.keyboard.top - PHONE.statusBar - PHONE.keyboard.clearance;

function keyboardLift(field: Span, next?: Span): number {
  const both: Span = next ? [Math.min(field[0], next[0]), Math.max(field[1], next[1])] : field;
  const bottom = both[1] - both[0] <= ABOVE_KEYBOARD ? both[1] : field[1];
  return Math.round(Math.min(ABOVE_KEYBOARD, Math.max(0, bottom - ABOVE_KEYBOARD)));
}

const offCameraWait = (s: Step | undefined) => s?.do === 'wait' && s.film === false;

const BEFORE_NEXT_TAP = new Set<Step['do']>(['type', 'press', 'hold', 'wait']);

export interface PerformOptions {
  onStep?: (log: StepLog, pointer: [number, number]) => Promise<void>;
  onFrame?: (log: EventLog) => void;
  watch?: boolean;
  unfilmed?: Clock;
  focus?: Box;
}

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

export async function perform(page: Page, take: Take, clock: Clock, { onStep, onFrame, watch = true, unfilmed, focus }: PerformOptions = {}): Promise<EventLog> {
  const [vw, vh] = take.target.viewport;
  const phone = take.target.device === 'phone';
  const glass = phone ? await page.context().newCDPSession(page) : undefined;
  let touching = false;
  let pointer: Point = startPoint([vw, vh], focus);
  const path: Point[] = [];
  const events: Event[] = [];
  const steps: StepLog[] = [];
  const marks: Record<string, number> = {};
  const cursors: [number, Cursor][] = [];
  const cursorAt = cursorReader(page);
  const carets: [number, Caret | null][] = [];
  const keyboard: [number, KeyboardUp | null][] = [];
  const tops: [number, PageTop][] = [];
  const ends: [number, boolean][] = [];
  const urls: [number, string][] = [[clock.frame, page.url()]];
  const appearances: [number, Appearance][] = [];
  let keyboardDisagrees = 0;
  let reachLift: number | null = null;
  const pageErrors: string[] = [];
  const onError = (e: Error) => void (ownError(e, page.url()) && pageErrors.push(e.message));
  page.on('pageerror', onError);
  const eventLog: EventLog = {
    version: 0,
    title: take.title,
    url: take.target.url,
    address: shownAddress(take.target),
    fps: clock.fps,
    device: take.target.device,
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
    urls,
    ...(phone ? { keyboard, tops, ends } : {}),
    ...(take.steps.some((s) => s.do === 'appearance') ? { appearances } : {}),
    ...(showsNoCursor(take) ? { noCursor: true as const } : {}),
    ...(focus ? { focus } : {}),
  };
  let current = 0;
  let waited = 0;
  const speed = clock.speed ?? 1;
  if (!phone) await page.mouse.move(...pointer);

  async function tick() {
    path[clock.frame] = [round(pointer[0]), round(pointer[1])];
    if (watch) {
      const shape = phone ? 'default' : await cursorAt(pointer).catch((): Cursor => cursors.at(-1)?.[1] ?? 'default');
      if (!sameCursor(cursors.at(-1)?.[1], shape)) cursors.push([clock.frame, shape]);
      const caret = await caretAt(page).catch(() => null);
      if (!carets.length || JSON.stringify(carets.at(-1)![1]) !== JSON.stringify(caret)) carets.push([clock.frame, caret]);
      if (phone) await followKeyboard();
    }
    await clock.tick();
    if (phone && watch) await followTop(clock.frame - 1);
    if (phone && watch) await followEnd(clock.frame - 1);
    if (urls.at(-1)![1] !== page.url()) urls.push([clock.frame - 1, page.url()]);
    eventLog.frames = clock.frame;
    onFrame?.(eventLog);
    if (pageErrors.length)
      throw new TakeError(current, `the app threw an error: "${pageErrors[0]}". Take stops rather than film a broken app; fix the app, or the step that sets it off`);
  }
  async function followKeyboard() {
    const field = await page.evaluate(focusedField).catch(() => null);
    const now = keyboardNow();
    if (field !== null && now && reachLift === null) {
      const opening = keyboard.at(-1)!;
      if (!keyboard.at(-2)?.[1] && clock.frame < opening[0] + frames(PHONE.keyboard.slide)) opening[1] = { lift: keyboardLift(field, await nextTap()) };
      else if (!fits(field[0], field[1] - field[0], [now.lift, now.lift + ABOVE_KEYBOARD])) keyboard.push([clock.frame, { lift: keyboardLift(field) }]);
    }
    if ((field !== null) === !!now) return void (keyboardDisagrees = 0);
    if (++keyboardDisagrees < KEYBOARD_DEBOUNCE) return;
    keyboardDisagrees = 0;
    reachLift = null;
    keyboard.push([clock.frame, field === null ? null : { lift: keyboardLift(field, await nextTap()) }]);
  }
  async function nextTap(): Promise<Span | undefined> {
    const next = take.steps.slice(current + 1).find((s) => !BEFORE_NEXT_TAP.has(s.do));
    if (next?.do !== 'click' || Array.isArray(next.target)) return undefined;
    const loc = locate(page, next.target).filter({ visible: true });
    if ((await loc.count().catch(() => 0)) !== 1) return undefined;
    const b = await loc.boundingBox().catch(() => null);
    return b && b.y >= 0 && b.y + b.height <= vh ? [b.y, b.y + b.height] : undefined;
  }
  async function followEnd(frame: number) {
    const atEnd = await page.evaluate(() => scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 2).catch(() => false);
    if (atEnd !== (ends.at(-1)?.[1] ?? false)) ends.push([frame, atEnd]);
  }
  async function followTop(frame: number) {
    const last = tops.at(-1)?.[1];
    const now = await page.evaluate(pageTop).catch(() => last);
    if (now && JSON.stringify(now) !== JSON.stringify(last)) tops.push([frame, now]);
  }
  const keyboardNow = () => keyboard.at(-1)?.[1] ?? null;

  function shown(): Span {
    if (!phone) return [0, vh];
    const up = keyboardNow();
    return up ? [up.lift, up.lift + PHONE.keyboard.top - PHONE.statusBar] : [0, vh - PHONE.safariBar];
  }

  async function keyboardUp(t: Target | undefined) {
    const give = clock.frame + limit(PACING.find);
    const slide = frames(PHONE.keyboard.slide);
    for (;;) {
      const opened = keyboard.findLast(([, up], i) => up && !keyboard[i - 1]?.[1]);
      if (keyboardNow() && opened && clock.frame >= opened[0] + slide) return;
      if (clock.frame >= give)
        throw new TakeError(current, `the keyboard didn't come up: ${t ? `${describe(t)} doesn't take text` : 'no text field has focus'}; on a phone, typing goes into the focused text field`);
      await idle();
    }
  }

  async function idle() {
    await tick();
    waited++;
  }
  const limit = (ms: number) => frames(ms * speed);
  const since = (start: number) => clock.frame - start - waited * (1 - 1 / speed);

  async function wait(ms: number) {
    const end = clock.frame + frames(ms);
    while (clock.frame < end) await tick();
  }

  async function find(t: Target): Promise<Locator> {
    const loc = locate(page, t).filter({ visible: true });
    const give = clock.frame + limit(PACING.find);
    for (;;) {
      const n = await loc.count();
      if (n === 1) return loc;
      if (clock.frame >= give) {
        if (n === 0) {
          const sign = await botCheck(page);
          throw new TakeError(current, sign ? botCheckMessage(`can't find ${describe(t)}`, sign) : `can't find ${describe(t)} (looked for ${PACING.find / 1000} s)`);
        }
        const matches = await describeMatches(page, loc, n, shown());
        throw new TakeError(current, `${n} elements match ${describe(t)} (${matches.join(', ')}${n > matches.length ? ', …' : ''}); make the target more specific: the full name with "exact": true, or the "css" given for the one on screen`);
      }
      await idle();
    }
  }

  async function boxOf(loc: Locator, t: Target): Promise<Box> {
    for (let attempt = 0; ; attempt++) {
      const b = await loc.boundingBox({ timeout: 500 }).catch(() => null);
      if (b && b.width > 0 && b.height > 0) return { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
      if (attempt > 0) throw new TakeError(current, `${describe(t)} has no size on screen`);
      await find(t);
    }
  }

  const inView = (b: Box) => fits(b.x, b.width, [0, vw]) && fits(b.y, b.height, shown());
  const toMiddle = (b: Box) => {
    const [lo, hi] = shown();
    return Math.round(center(b)[1] - (lo + hi) / 2);
  };

  async function bringIntoView(loc: Locator, t: Target) {
    let box = await boxOf(loc, t);
    if (inView(box)) return;
    const up = keyboardNow();
    if (up && box.y >= 0 && box.y + box.height <= vh) {
      reachLift = box.y < up.lift ? Math.max(0, Math.round(box.y - PHONE.keyboard.clearance)) : keyboardLift([box.y, box.y + box.height]);
      keyboard.push([clock.frame, { lift: reachLift }]);
      await wait(PHONE.keyboard.slide);
      return;
    }
    if (!fits(box.y, box.height, shown())) {
      await scroll(0, toMiddle(box));
      box = await boxOf(loc, t);
      if (inView(box)) return;
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await tick();
    const give = clock.frame + limit(PACING.find);
    while (!inView(await boxOf(loc, t))) {
      if (clock.frame >= give) throw new TakeError(current, `${describe(t)} stays off screen (waited ${PACING.find / 1000} s for it to come into view)`);
      await idle();
    }
  }

  const whatIsAt = ([x, y]: Point) =>
    page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return 'nothing (outside the page)';
      const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      return name ? `${role} "${name}"` : `a ${role}${el.classList.length ? ` (.${[...el.classList].slice(0, 2).join('.')})` : ''}`;
    }, [x, y] as Point);

  async function moveTo(to: () => Promise<Point>, { drag = false } = {}): Promise<void> {
    const from = pointer;
    let dest = await to();
    const dist = Math.hypot(dest[0] - from[0], dest[1] - from[1]);
    const n = frames(drag ? dragMs(dist) : travelMs(dist));
    const arc = drag ? PACING.drag.arc : PACING.arc;
    const f0 = clock.frame;
    for (;;) {
      const k = Math.min(n, clock.frame - f0 + 1);
      const p = spring(k / n);
      const [dx, dy] = [dest[0] - from[0], dest[1] - from[1]];
      const bend = Math.sin(Math.PI * p) * arc;
      pointer = [from[0] + dx * p - dy * bend, from[1] + dy * p + dx * bend];
      if (!phone) await page.mouse.move(...pointer);
      else if (touching) await touch('touchMove');
      if (k === n) return;
      await tick();
      dest = await to();
    }
  }

  async function travel(loc: Locator, t: Target): Promise<Box> {
    await bringIntoView(loc, t);
    let box = await boxOf(loc, t);
    await moveTo(async () => belowLabel((box = await boxOf(loc, t))));
    return box;
  }

  async function reach(loc: Locator, t: Target): Promise<Box> {
    let last = await travel(loc, t);
    let since = clock.frame;
    await wait(PACING.settle);
    const give = clock.frame + limit(PACING.find);
    let movingSince: number | undefined;
    for (;;) {
      const box = await boxOf(loc, t);
      const inside = pointer[0] >= box.x && pointer[0] <= box.x + box.width && pointer[1] >= box.y && pointer[1] <= box.y + box.height;
      if (!inside) {
        last = await travel(loc, t);
        since = clock.frame;
        await wait(PACING.settle);
        continue;
      }
      const moving = Math.max(Math.abs(box.x - last.x), Math.abs(box.y - last.y)) > PACING.still.pxPerFrame * Math.max(1, clock.frame - since);
      [last, since] = [box, clock.frame];
      if (moving) movingSince ??= clock.frame;
      if (moving && clock.frame < movingSince! + limit(PACING.still.longest)) {
        await idle();
        continue;
      }
      const onTarget = await loc.evaluate((el, [x, y]) => {
        const hit = document.elementFromPoint(x, y);
        const labels = [...((el as HTMLInputElement).labels ?? [])];
        return !!hit && (el === hit || el.contains(hit) || labels.some((l) => l === hit || l.contains(hit)));
      }, pointer);
      const disabled = onTarget && (await loc.isDisabled());
      if (onTarget && !disabled) return box;
      if (clock.frame >= give) {
        const why = disabled ? `stayed disabled for ${PACING.find / 1000} s` : `is covered by ${await whatIsAt(pointer)}`;
        throw new TakeError(current, `${describe(t)} ${why}`);
      }
      await idle();
    }
  }

  const contact = (type: 'down' | 'up') => events.push({ frame: clock.frame, type, x: round(pointer[0]), y: round(pointer[1]) });

  async function touch(type: 'touchStart' | 'touchMove' | 'touchEnd') {
    await glass!.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: pointer[0], y: pointer[1] }] });
  }

  async function press(clickCount = 1) {
    contact('down');
    if (!phone) return page.mouse.down({ clickCount });
    await touch('touchStart');
    touching = true;
  }
  async function release(clickCount = 1) {
    contact('up');
    if (!phone) return page.mouse.up({ clickCount });
    touching = false;
    await touch('touchEnd');
  }

  const pressFor = (clicks: number) => (phone ? PACING.tap : clicks > 1 ? PACING.multiClickPress : PACING.press);

  async function click(loc: Locator, t: Target, clicks = 1, left?: () => number): Promise<Box> {
    const box = await reach(loc, t);
    const gaps = clickGaps(clicks, left?.());
    for (let n = 1; n <= clicks; n++) {
      if (n > 1) await wait(gaps[n - 2]);
      await press(n);
      await wait(pressFor(clicks));
      await release(n);
    }
    await tick();
    return box;
  }

  async function clickAt(point: Point, clicks = 1, left?: () => number): Promise<undefined> {
    await moveTo(async () => point);
    await wait(PACING.settle);
    const gaps = clickGaps(clicks, left?.());
    for (let n = 1; n <= clicks; n++) {
      if (n > 1) await wait(gaps[n - 2]);
      await press(n);
      await wait(pressFor(clicks));
      await release(n);
    }
    await tick();
    return undefined;
  }

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

  async function scroll(dx: number, dy: number, room = 0) {
    if (!phone) return wheel([dx, dy], Math.max(frames(scrollMs(Math.hypot(dx, dy))), room), ease, pointer);
    const { lift, reach } = PACING.swipe;
    const [lo, hi] = shown();
    let left: Point = [dx, dy];
    const strokes = Math.max(1, Math.ceil((lift * Math.max(Math.abs(dx) / vw, Math.abs(dy) / (hi - lo))) / reach));
    for (let i = strokes; i > 0; i--) {
      const part: Point = [Math.round(left[0] / i), Math.round(left[1] / i)];
      left = [left[0] - part[0], left[1] - part[1]];
      await swipe(part, Math.round(room / strokes));
    }
  }

  async function swipe([dx, dy]: Point, room = 0) {
    const { lift, slower } = PACING.swipe;
    const across = (along: number, [lo, hi]: Span, now: number) => {
      const size = hi - lo;
      return along ? lo + size / 2 + (lift * along) / 2 : Math.min(lo + size * 0.65, Math.max(lo + size * 0.35, now));
    };
    const start: Point = [across(dx, [0, vw], pointer[0]), across(dy, shown(), pointer[1])];
    await moveTo(async () => start);
    await wait(PACING.settle);
    const n = Math.max(frames(scrollMs(Math.hypot(dx, dy)) * slower), room);
    const held = Math.max(1, Math.round(n * lift));
    contact('down');
    let lifted = false;
    await wheel([dx, dy], n, swipeProgress, start, (k, p) => {
      if (lifted) return;
      pointer = [start[0] - dx * p, start[1] - dy * p];
      if (k >= held) [lifted] = [true, contact('up')];
    });
  }

  const atLeastAPixel = (total: number, due: number, done: number) => {
    if (phone || !done) return Math.round(due);
    const way = Math.sign(total);
    const left = Math.abs(total - done);
    return left < 0.5 ? 0 : way * Math.min(Math.round(left), Math.max(1, Math.round(way * due)));
  };

  async function wheel([dx, dy]: Point, n: number, progress: (t: number) => number, at: Point, each?: (k: number, p: number) => void) {
    let done: Point = [0, 0];
    let waitForMove = true;
    const f0 = clock.frame;
    for (let k = 1; ; k = Math.min(n, clock.frame - f0 + 1)) {
      const p = progress(k / n);
      each?.(k, p);
      const step: Point = [atLeastAPixel(dx, dx * p - done[0], done[0]), atLeastAPixel(dy, dy * p - done[1], done[1])];
      if (step[0] || step[1]) {
        const before = waitForMove ? await scrolledAt(at) : undefined;
        if (phone) await glass!.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at[0], y: at[1], deltaX: step[0], deltaY: step[1] });
        else await page.mouse.wheel(...step);
        if (before !== undefined) waitForMove = await movedFrom(before, at);
        events.push({ frame: clock.frame, type: 'scroll', dx: step[0], dy: step[1] });
        done = [done[0] + step[0], done[1] + step[1]];
      }
      await tick();
      if (k === n) return;
    }
  }

  function scrolledAt(at: Point): Promise<number> {
    return page
      .evaluate(([x, y]) => {
        let sum = window.scrollX + window.scrollY;
        for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) sum += el.scrollTop + el.scrollLeft;
        return sum;
      }, at)
      .catch(() => 0);
  }

  async function movedFrom(before: number, at: Point): Promise<boolean> {
    const until = performance.now() + 200;
    while (performance.now() < until) {
      if ((await scrolledAt(at)) !== before) return true;
      await new Promise((r) => setTimeout(r, 4));
    }
    return false;
  }

  async function offCamera(c: Condition, timeout: number) {
    unfilmed!.resume?.();
    const give = unfilmed!.frame + frames(timeout * (unfilmed!.speed ?? 1));
    while (!(await holds(page, c))) {
      if (unfilmed!.frame >= give) {
        const sign = await botCheck(page);
        const what = `waited ${timeout / 1000} s, off camera, for ${describeCondition(c)}`;
        throw new TakeError(current, sign ? botCheckMessage(what, sign) : what);
      }
      await unfilmed!.tick();
    }
    clock.resume?.();
  }

  async function until(c: Condition, timeout: number): Promise<Box | undefined> {
    const give = clock.frame + limit(timeout);
    while (!(await holds(page, c))) {
      if (clock.frame >= give) {
        const sign = await botCheck(page);
        throw new TakeError(current, sign ? botCheckMessage(`waited ${timeout / 1000} s for ${describeCondition(c)}`, sign) : `waited ${timeout / 1000} s for ${describeCondition(c)}`);
      }
      await idle();
    }
    if ('visible' in c) {
      const b = await locate(page, c.visible).filter({ visible: true }).first().boundingBox();
      if (b) return { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
    }
  }

  async function run(s: Step, log: StepLog) {
    const length = s.do === 'hold' || s.ms === undefined ? undefined : frames(s.ms);
    switch (s.do) {
      case 'click': {
        const left = length === undefined ? undefined : () => ((length - frames(PACING.gap) - since(log.start)) * 1000) / clock.fps;
        log.target = Array.isArray(s.target) ? await clickAt(s.target, s.clicks, left) : await click(await find(s.target), s.target, s.clicks, left);
        break;
      }
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
        if (phone && watch) await keyboardUp(s.target);
        if (s.target) await wait(PACING.settle);
        if ((await page.evaluate(focusedField).catch(() => null)) === null)
          log.note = 'no text field had focus when typing started, so the keys went to the page itself (an app may take them as shortcuts): check the picture, and click or open the field first';
        const f0 = clock.frame;
        const chars = [...s.text].length;
        let cps = s.cps;
        if (length !== undefined && chars > 1) {
          const room = Math.max(1, length - since(log.start) - frames(PACING.gap));
          const { min, max } = PACING.fittedTyping;
          cps = Math.min(max, Math.max(min, ((chars - 1) * clock.fps) / room));
        }
        const at = typingSchedule(s.text, cps, clock.fps);
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
          const unknown = /Unknown key: "([^"]*)"/.exec(e.message)?.[1];
          throw unknown === undefined ? e : new TakeError(current, `unknown key "${unknown}" in "${s.key}"; use the browser's key names, e.g. Meta, Control, Alt, Shift, Enter, Escape`);
        });
        await tick();
        break;
      case 'scroll': {
        const room = length === undefined ? 0 : Math.max(0, length - since(log.start) - frames(PACING.gap));
        if ('by' in s) {
          const at = () => page.evaluate(() => [scrollX, scrollY]).catch(() => [0, 0]);
          const before = await at();
          await scroll(...s.by, room);
          const after = await at();
          if (before[0] === after[0] && before[1] === after[1])
            log.note = "the page didn't scroll (fine if something under the pointer was meant to, like a map or a list; otherwise the page may be locked, e.g. by an open menu)";
        } else {
          const loc = await find(s.target);
          const box = await boxOf(loc, s.target);
          if (!inView(box)) await scroll(0, toMiddle(box), room);
          else log.note = `nothing scrolled: ${describe(s.target)} is already on screen; scroll "by" a distance to move the page`;
          log.target = await boxOf(loc, s.target);
        }
        break;
      }
      case 'wait':
        if (s.film === false && unfilmed) await offCamera(s.for, s.timeout);
        else log.waitedFor = await until(s.for, s.timeout);
        break;
      case 'hold':
        await wait(s.ms);
        break;
      case 'appearance':
        await page.emulateMedia({ colorScheme: s.to });
        appearances.push([clock.frame, s.to]);
        await tick();
        break;
    }
    if (s.waitFor) log.waitedFor = await until(s.waitFor, DEFAULTS.timeout);
  }

  for (const [i, s] of take.steps.entries()) {
    current = i;
    waited = 0;
    const log: StepLog = { index: i, do: s.do, start: clock.frame, end: clock.frame };
    if (s.mark) {
      log.mark = s.mark;
      marks[s.mark] = clock.frame;
    }
    await run(s, log);
    log.end = Math.max(log.start, clock.frame - 1);
    const length = s.do === 'hold' || s.ms === undefined ? undefined : frames(s.ms);
    if (length !== undefined && since(log.start) > length + 1) {
      const over = `takes ${(since(log.start) / clock.fps).toFixed(2)} s, longer than the ${+(s.ms! / 1000).toFixed(2)} s its "ms" gives: the action itself${s.waitFor || s.do === 'wait' ? ', with waiting for the app,' : ''} takes that long`;
      log.note = log.note ? `${log.note}; ${over}` : over;
    }
    if (waited) log.waited = waited;
    steps.push(log);
    await onStep?.(log, pointer);
    if (length !== undefined) while (since(log.start) < length) await tick();
    else if (s.do !== 'hold' && !offCameraWait(s) && !offCameraWait(take.steps[i + 1]) && i < take.steps.length - 1) await wait(PACING.gap);
  }
  page.off('pageerror', onError);
  fillSkipped(path);
  while (path.length < clock.frame) path.push(path.at(-1)!);
  eventLog.frames = clock.frame;
  return eventLog;
}

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
