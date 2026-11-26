import type { CDPSession, Page } from 'playwright';
import { PHONE, type Appearance, type Step, type Take, type Target } from '../../take/format.ts';
import { measureCaret, type Caret } from './caret.ts';
import type { Clock } from './clock.ts';
import { sameCursor, type Cursor, type cursorReader } from './cursor.ts';
import type { Event, EventLog, KeyboardUp, PageTop, StepLog } from './events.ts';
import { fits, round, type Point, type Span } from './geometry.ts';
import { pageTop } from './page-top.ts';
import { PACING, frames } from './pacing.ts';
import { describe, locate } from './targets.ts';
import { TakeError } from './take-error.ts';

export interface PerformState {
  page: Page;
  take: Take;
  clock: Clock;
  unfilmed?: Clock;
  watch: boolean;
  phone: boolean;
  glass?: CDPSession;
  viewport: [number, number];
  speed: number;
  pointer: Point;
  touching: boolean;
  current: number;
  waited: number;
  keyboardDisagrees: number;
  reachLift: number | null;
  path: Point[];
  events: Event[];
  steps: StepLog[];
  marks: Record<string, number>;
  cursors: [number, Cursor][];
  cursorAt: ReturnType<typeof cursorReader>;
  carets: [number, Caret | null][];
  keyboard: [number, KeyboardUp | null][];
  tops: [number, PageTop][];
  ends: [number, boolean][];
  urls: [number, string][];
  appearances: [number, Appearance][];
  pageErrors: string[];
  eventLog: EventLog;
  onFrame?: (log: EventLog) => void;
}

const KEYBOARD_DEBOUNCE = 2;
const ABOVE_KEYBOARD = PHONE.keyboard.top - PHONE.statusBar - PHONE.keyboard.clearance;
const BEFORE_NEXT_TAP = new Set<Step['do']>(['type', 'press', 'hold', 'wait']);

export function focusedField(): Span | null {
  let el = document.activeElement as HTMLElement | null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
  if (!el) return null;
  const notText = ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'];
  const takesText = el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !notText.includes((el as HTMLInputElement).type));
  if (!takesText) return null;
  const r = el.getBoundingClientRect();
  return [r.top, r.bottom];
}

export function keyboardLift(field: Span, next?: Span): number {
  const both: Span = next ? [Math.min(field[0], next[0]), Math.max(field[1], next[1])] : field;
  const bottom = both[1] - both[0] <= ABOVE_KEYBOARD ? both[1] : field[1];
  return Math.round(Math.min(ABOVE_KEYBOARD, Math.max(0, bottom - ABOVE_KEYBOARD)));
}

export async function tick(s: PerformState) {
  const { page, clock, phone, watch, cursors, carets } = s;
  s.path[clock.frame] = [round(s.pointer[0]), round(s.pointer[1])];
  if (watch) {
    const shape = phone ? 'default' : await s.cursorAt(s.pointer).catch((): Cursor => cursors.at(-1)?.[1] ?? 'default');
    if (!sameCursor(cursors.at(-1)?.[1], shape)) cursors.push([clock.frame, shape]);
    const caret = await measureCaret(page).catch(() => null);
    if (!carets.length || JSON.stringify(carets.at(-1)![1]) !== JSON.stringify(caret)) carets.push([clock.frame, caret]);
    if (phone) await followKeyboard(s);
  }
  await clock.tick();
  if (phone && watch) await followTop(s, clock.frame - 1);
  if (phone && watch) await followEnd(s, clock.frame - 1);
  if (s.urls.at(-1)![1] !== page.url()) s.urls.push([clock.frame - 1, page.url()]);
  s.eventLog.frames = clock.frame;
  s.onFrame?.(s.eventLog);
  if (s.pageErrors.length)
    throw new TakeError(s.current, `the app threw an error: "${s.pageErrors[0]}". Take stops rather than film a broken app; fix the app, or the step that sets it off`);
}

export async function idle(s: PerformState) {
  await tick(s);
  s.waited++;
}

export async function wait(s: PerformState, ms: number) {
  const end = s.clock.frame + frames(ms);
  while (s.clock.frame < end) await tick(s);
}

export const limit = (s: PerformState, ms: number) => frames(ms * s.speed);

export const since = (s: PerformState, start: number) => s.clock.frame - start - s.waited * (1 - 1 / s.speed);

export const keyboardNow = (s: PerformState) => s.keyboard.at(-1)?.[1] ?? null;

export function shown(s: PerformState): Span {
  const vh = s.viewport[1];
  if (!s.phone) return [0, vh];
  const up = keyboardNow(s);
  return up ? [up.lift, up.lift + PHONE.keyboard.top - PHONE.statusBar] : [0, vh - PHONE.safariBar];
}

async function followKeyboard(s: PerformState) {
  const { keyboard, clock } = s;
  const field = await s.page.evaluate(focusedField).catch(() => null);
  const now = keyboardNow(s);
  if (field !== null && now && s.reachLift === null) {
    const opening = keyboard.at(-1)!;
    if (!keyboard.at(-2)?.[1] && clock.frame < opening[0] + frames(PHONE.keyboard.slide)) opening[1] = { lift: keyboardLift(field, await nextTap(s)) };
    else if (!fits(field[0], field[1] - field[0], [now.lift, now.lift + ABOVE_KEYBOARD])) keyboard.push([clock.frame, { lift: keyboardLift(field) }]);
  }
  if ((field !== null) === !!now) return void (s.keyboardDisagrees = 0);
  if (++s.keyboardDisagrees < KEYBOARD_DEBOUNCE) return;
  s.keyboardDisagrees = 0;
  s.reachLift = null;
  keyboard.push([clock.frame, field === null ? null : { lift: keyboardLift(field, await nextTap(s)) }]);
}

async function nextTap(s: PerformState): Promise<Span | undefined> {
  const next = s.take.steps.slice(s.current + 1).find((step) => !BEFORE_NEXT_TAP.has(step.do));
  if (next?.do !== 'click' || Array.isArray(next.target)) return undefined;
  const loc = locate(s.page, next.target).filter({ visible: true });
  if ((await loc.count().catch(() => 0)) !== 1) return undefined;
  const b = await loc.boundingBox().catch(() => null);
  return b && b.y >= 0 && b.y + b.height <= s.viewport[1] ? [b.y, b.y + b.height] : undefined;
}

async function followEnd(s: PerformState, frame: number) {
  const atEnd = await s.page.evaluate(() => scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 2).catch(() => false);
  if (atEnd !== (s.ends.at(-1)?.[1] ?? false)) s.ends.push([frame, atEnd]);
}

async function followTop(s: PerformState, frame: number) {
  const last = s.tops.at(-1)?.[1];
  const now = await s.page.evaluate(pageTop).catch(() => last);
  if (now && JSON.stringify(now) !== JSON.stringify(last)) s.tops.push([frame, now]);
}

export async function keyboardUp(s: PerformState, t: Target | undefined) {
  const give = s.clock.frame + limit(s, PACING.find);
  const slide = frames(PHONE.keyboard.slide);
  for (;;) {
    const opened = s.keyboard.findLast(([, up], i) => up && !s.keyboard[i - 1]?.[1]);
    if (keyboardNow(s) && opened && s.clock.frame >= opened[0] + slide) return;
    if (s.clock.frame >= give)
      throw new TakeError(s.current, `the keyboard didn't come up: ${t ? `${describe(t)} doesn't take text` : 'no text field has focus'}; on a phone, typing goes into the focused text field`);
    await idle(s);
  }
}
