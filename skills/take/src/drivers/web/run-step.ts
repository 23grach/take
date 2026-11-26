import { DEFAULTS, type Condition, type Step } from '../../take/format.ts';
import { botCheck, botCheckMessage } from './bot-check.ts';
import type { Box, StepLog } from './events.ts';
import { roundedBox } from './geometry.ts';
import { PACING, frames, typingSchedule } from './pacing.ts';
import { focusedField, idle, keyboardUp, limit, since, tick, wait, type PerformState } from './perform-state.ts';
import { clickAt, moveTo } from './pointer.ts';
import { boxOf, click, drag, find, inView, toMiddle, travel } from './reach-target.ts';
import { scroll } from './scroll.ts';
import { describe, describeCondition, holds, locate } from './targets.ts';
import { TakeError } from './take-error.ts';

export function asPressed(key: string): string {
  const parts = key.split('+');
  const last = parts.at(-1)!;
  if (parts.length > 1 && /^[A-Z]$/.test(last) && !parts.slice(0, -1).includes('Shift')) parts[parts.length - 1] = last.toLowerCase();
  return parts.join('+');
}

async function offCamera(s: PerformState, c: Condition, timeout: number) {
  const unfilmed = s.unfilmed!;
  unfilmed.resume?.();
  const give = unfilmed.frame + frames(timeout * (unfilmed.speed ?? 1));
  while (!(await holds(s.page, c))) {
    if (unfilmed.frame >= give) {
      const sign = await botCheck(s.page);
      const what = `waited ${timeout / 1000} s, off camera, for ${describeCondition(c)}`;
      throw new TakeError(s.current, sign ? botCheckMessage(what, sign) : what);
    }
    await unfilmed.tick();
  }
  s.clock.resume?.();
}

async function until(s: PerformState, c: Condition, timeout: number): Promise<Box | undefined> {
  const give = s.clock.frame + limit(s, timeout);
  while (!(await holds(s.page, c))) {
    if (s.clock.frame >= give) {
      const sign = await botCheck(s.page);
      const what = `waited ${timeout / 1000} s for ${describeCondition(c)}`;
      throw new TakeError(s.current, sign ? botCheckMessage(what, sign) : what);
    }
    await idle(s);
  }
  if ('visible' in c) {
    const b = await locate(s.page, c.visible).filter({ visible: true }).first().boundingBox();
    if (b) return roundedBox(b);
  }
}

async function typeText(s: PerformState, step: Extract<Step, { do: 'type' }>, log: StepLog, length: number | undefined) {
  const { page, clock } = s;
  if (step.target) log.target = await click(s, await find(s, step.target), step.target);
  if (s.phone && s.watch) await keyboardUp(s, step.target);
  if (step.target) await wait(s, PACING.settle);
  if ((await page.evaluate(focusedField).catch(() => null)) === null)
    log.note = 'no text field had focus when typing started, so the keys went to the page itself (an app may take them as shortcuts): check the picture, and click or open the field first';
  const f0 = clock.frame;
  const chars = [...step.text].length;
  let cps = step.cps;
  if (length !== undefined && chars > 1) {
    const room = Math.max(1, length - since(s, log.start) - frames(PACING.gap));
    const { min, max } = PACING.fittedTyping;
    cps = Math.min(max, Math.max(min, ((chars - 1) * clock.fps) / room));
  }
  const at = typingSchedule(step.text, cps, clock.fps);
  for (const [i, ch] of [...step.text].entries()) {
    while (clock.frame < f0 + at[i]) await tick(s);
    s.events.push({ frame: clock.frame, type: 'key', key: ch });
    await page.keyboard.type(ch);
  }
  await tick(s);
}

async function scrollStep(s: PerformState, step: Extract<Step, { do: 'scroll' }>, log: StepLog, length: number | undefined) {
  const room = length === undefined ? 0 : Math.max(0, length - since(s, log.start) - frames(PACING.gap));
  if ('by' in step) {
    const at = () => s.page.evaluate(() => [scrollX, scrollY]).catch(() => [0, 0]);
    const before = await at();
    await scroll(s, ...step.by, room);
    const after = await at();
    if (before[0] === after[0] && before[1] === after[1])
      log.note = "the page didn't scroll (fine if something under the pointer was meant to, like a map or a list; otherwise the page may be locked, e.g. by an open menu)";
    return;
  }
  const loc = await find(s, step.target);
  const box = await boxOf(s, loc, step.target);
  if (!inView(s, box)) await scroll(s, 0, toMiddle(s, box), room);
  else log.note = `nothing scrolled: ${describe(step.target)} is already on screen; scroll "by" a distance to move the page`;
  log.target = await boxOf(s, loc, step.target);
}

export async function runStep(s: PerformState, step: Step, log: StepLog) {
  const length = step.do === 'hold' || step.ms === undefined ? undefined : frames(step.ms);
  switch (step.do) {
    case 'click': {
      const left = length === undefined ? undefined : () => ((length - frames(PACING.gap) - since(s, log.start)) * 1000) / s.clock.fps;
      log.target = Array.isArray(step.target) ? await clickAt(s, step.target, step.clicks, left) : await click(s, await find(s, step.target), step.target, step.clicks, left);
      break;
    }
    case 'hover':
      if (Array.isArray(step.target)) {
        const point = step.target;
        await moveTo(s, async () => point);
      } else log.target = await travel(s, await find(s, step.target), step.target);
      break;
    case 'drag':
      log.target = await drag(s, step.from, step.to);
      break;
    case 'type':
      await typeText(s, step, log, length);
      break;
    case 'press':
      s.events.push({ frame: s.clock.frame, type: 'key', key: step.key });
      await s.page.keyboard.press(asPressed(step.key)).catch((e: Error) => {
        const unknown = /Unknown key: "([^"]*)"/.exec(e.message)?.[1];
        throw unknown === undefined ? e : new TakeError(s.current, `unknown key "${unknown}" in "${step.key}"; use the browser's key names, e.g. Meta, Control, Alt, Shift, Enter, Escape`);
      });
      await tick(s);
      break;
    case 'scroll':
      await scrollStep(s, step, log, length);
      break;
    case 'wait':
      if (step.film === false && s.unfilmed) await offCamera(s, step.for, step.timeout);
      else log.waitedFor = await until(s, step.for, step.timeout);
      break;
    case 'hold':
      await wait(s, step.ms);
      break;
    case 'appearance':
      await s.page.emulateMedia({ colorScheme: step.to });
      s.appearances.push([s.clock.frame, step.to]);
      await tick(s);
      break;
  }
  if (step.waitFor) log.waitedFor = await until(s, step.waitFor, DEFAULTS.timeout);
}
