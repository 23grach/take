import type { Page } from 'playwright';
import { shownAddress } from '../../take/address.ts';
import { showsNoCursor, type Step, type Take } from '../../take/format.ts';
import type { Clock } from './clock.ts';
import { cursorReader } from './cursor.ts';
import type { Box, EventLog, StepLog } from './events.ts';
import { fillSkipped } from './geometry.ts';
import { ownError } from './page-errors.ts';
import { PACING, frames, startPoint } from './pacing.ts';
import { since, tick, wait, type PerformState } from './perform-state.ts';
import { runStep } from './run-step.ts';
import { TakeError } from './take-error.ts';

const offCameraWait = (s: Step | undefined) => s?.do === 'wait' && s.film === false;

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

function startState(page: Page, take: Take, clock: Clock, glass: PerformState['glass'], { onFrame, watch = true, unfilmed, focus }: PerformOptions): PerformState {
  const phone = take.target.device === 'phone';
  const s: Omit<PerformState, 'eventLog'> = {
    page,
    take,
    clock,
    unfilmed,
    watch,
    phone,
    glass,
    viewport: take.target.viewport,
    speed: clock.speed ?? 1,
    pointer: startPoint(take.target.viewport, focus),
    touching: false,
    current: 0,
    waited: 0,
    keyboardDisagrees: 0,
    reachLift: null,
    path: [],
    events: [],
    steps: [],
    marks: {},
    cursors: [],
    cursorAt: cursorReader(page),
    carets: [],
    keyboard: [],
    tops: [],
    ends: [],
    urls: [[clock.frame, page.url()]],
    appearances: [],
    pageErrors: [],
    onFrame,
  };
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
    pointer: s.path,
    cursors: s.cursors,
    carets: s.carets,
    events: s.events,
    steps: s.steps,
    marks: s.marks,
    loop: take.loop,
    urls: s.urls,
    ...(phone ? { keyboard: s.keyboard, tops: s.tops, ends: s.ends } : {}),
    ...(take.steps.some((step) => step.do === 'appearance') ? { appearances: s.appearances } : {}),
    ...(showsNoCursor(take) ? { noCursor: true as const } : {}),
    ...(focus ? { focus } : {}),
  };
  return { ...s, eventLog };
}

export async function perform(page: Page, take: Take, clock: Clock, options: PerformOptions = {}): Promise<EventLog> {
  const glass = take.target.device === 'phone' ? await page.context().newCDPSession(page) : undefined;
  const s = startState(page, take, clock, glass, options);
  const onError = (e: Error) => void (ownError(e, page.url()) && s.pageErrors.push(e.message));
  page.on('pageerror', onError);
  if (!s.phone) await page.mouse.move(...s.pointer);

  for (const [i, step] of take.steps.entries()) {
    s.current = i;
    s.waited = 0;
    const log: StepLog = { index: i, do: step.do, start: clock.frame, end: clock.frame };
    if (step.mark) {
      log.mark = step.mark;
      s.marks[step.mark] = clock.frame;
    }
    await runStep(s, step, log);
    log.end = Math.max(log.start, clock.frame - 1);
    const length = step.do === 'hold' || step.ms === undefined ? undefined : frames(step.ms);
    if (length !== undefined && since(s, log.start) > length + 1) {
      const over = `takes ${(since(s, log.start) / clock.fps).toFixed(2)} s, longer than the ${+(step.ms! / 1000).toFixed(2)} s its "ms" gives: the action itself${step.waitFor || step.do === 'wait' ? ', with waiting for the app,' : ''} takes that long`;
      log.note = log.note ? `${log.note}; ${over}` : over;
    }
    if (s.waited) log.waited = s.waited;
    s.steps.push(log);
    await options.onStep?.(log, s.pointer);
    if (length !== undefined) while (since(s, log.start) < length) await tick(s);
    else if (step.do !== 'hold' && !offCameraWait(step) && !offCameraWait(take.steps[i + 1]) && i < take.steps.length - 1) await wait(s, PACING.gap);
  }
  page.off('pageerror', onError);
  fillSkipped(s.path);
  while (s.path.length < clock.frame) s.path.push(s.path.at(-1)!);
  s.eventLog.frames = clock.frame;
  return s.eventLog;
}
