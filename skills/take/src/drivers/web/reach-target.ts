import type { Locator } from 'playwright';
import { PHONE, type Spot, type Target } from '../../take/format.ts';
import { botCheck, botCheckMessage } from './bot-check.ts';
import type { Box } from './events.ts';
import { belowLabel, center, fits, roundedBox, type Point } from './geometry.ts';
import { PACING } from './pacing.ts';
import { idle, keyboardLift, keyboardNow, limit, shown, tick, wait, type PerformState } from './perform-state.ts';
import { clickHere, moveTo, press, release } from './pointer.ts';
import { scroll } from './scroll.ts';
import { describe, describeMatches, locate } from './targets.ts';
import { TakeError } from './take-error.ts';

export async function find(s: PerformState, t: Target): Promise<Locator> {
  const loc = locate(s.page, t).filter({ visible: true });
  const give = s.clock.frame + limit(s, PACING.find);
  for (;;) {
    const n = await loc.count();
    if (n === 1) return loc;
    if (s.clock.frame >= give) {
      if (n === 0) {
        const sign = await botCheck(s.page);
        throw new TakeError(s.current, sign ? botCheckMessage(`can't find ${describe(t)}`, sign) : `can't find ${describe(t)} (looked for ${PACING.find / 1000} s)`);
      }
      const matches = await describeMatches(s.page, loc, n, shown(s));
      throw new TakeError(s.current, `${n} elements match ${describe(t)} (${matches.join(', ')}${n > matches.length ? ', …' : ''}); make the target more specific: the full name with "exact": true, or the "css" given for the one on screen`);
    }
    await idle(s);
  }
}

export async function boxOf(s: PerformState, loc: Locator, t: Target): Promise<Box> {
  for (let attempt = 0; ; attempt++) {
    const b = await loc.boundingBox({ timeout: 500 }).catch(() => null);
    if (b && b.width > 0 && b.height > 0) return roundedBox(b);
    if (attempt > 0) throw new TakeError(s.current, `${describe(t)} has no size on screen`);
    await find(s, t);
  }
}

export const inView = (s: PerformState, b: Box) => fits(b.x, b.width, [0, s.viewport[0]]) && fits(b.y, b.height, shown(s));

export const toMiddle = (s: PerformState, b: Box) => {
  const [lo, hi] = shown(s);
  return Math.round(center(b)[1] - (lo + hi) / 2);
};

async function bringIntoView(s: PerformState, loc: Locator, t: Target) {
  let box = await boxOf(s, loc, t);
  if (inView(s, box)) return;
  const up = keyboardNow(s);
  if (up && box.y >= 0 && box.y + box.height <= s.viewport[1]) {
    s.reachLift = box.y < up.lift ? Math.max(0, Math.round(box.y - PHONE.keyboard.clearance)) : keyboardLift([box.y, box.y + box.height]);
    s.keyboard.push([s.clock.frame, { lift: s.reachLift }]);
    await wait(s, PHONE.keyboard.slide);
    return;
  }
  if (!fits(box.y, box.height, shown(s))) {
    await scroll(s, 0, toMiddle(s, box));
    box = await boxOf(s, loc, t);
    if (inView(s, box)) return;
  }
  await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await tick(s);
  const give = s.clock.frame + limit(s, PACING.find);
  while (!inView(s, await boxOf(s, loc, t))) {
    if (s.clock.frame >= give) throw new TakeError(s.current, `${describe(t)} stays off screen (waited ${PACING.find / 1000} s for it to come into view)`);
    await idle(s);
  }
}

const whatIsAt = (s: PerformState, [x, y]: Point) =>
  s.page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'nothing (outside the page)';
    const name = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    return name ? `${role} "${name}"` : `a ${role}${el.classList.length ? ` (.${[...el.classList].slice(0, 2).join('.')})` : ''}`;
  }, [x, y] as Point);

export async function travel(s: PerformState, loc: Locator, t: Target): Promise<Box> {
  await bringIntoView(s, loc, t);
  let box = await boxOf(s, loc, t);
  await moveTo(s, async () => belowLabel((box = await boxOf(s, loc, t))));
  return box;
}

async function reach(s: PerformState, loc: Locator, t: Target): Promise<Box> {
  let last = await travel(s, loc, t);
  let lastAt = s.clock.frame;
  await wait(s, PACING.settle);
  const give = s.clock.frame + limit(s, PACING.find);
  let movingSince: number | undefined;
  for (;;) {
    const box = await boxOf(s, loc, t);
    const [px, py] = s.pointer;
    const inside = px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
    if (!inside) {
      last = await travel(s, loc, t);
      lastAt = s.clock.frame;
      await wait(s, PACING.settle);
      continue;
    }
    const moving = Math.max(Math.abs(box.x - last.x), Math.abs(box.y - last.y)) > PACING.still.pxPerFrame * Math.max(1, s.clock.frame - lastAt);
    [last, lastAt] = [box, s.clock.frame];
    if (moving) movingSince ??= s.clock.frame;
    if (moving && s.clock.frame < movingSince! + limit(s, PACING.still.longest)) {
      await idle(s);
      continue;
    }
    const onTarget = await loc.evaluate((el, [x, y]) => {
      const hit = document.elementFromPoint(x, y);
      const labels = [...((el as HTMLInputElement).labels ?? [])];
      return !!hit && (el === hit || el.contains(hit) || labels.some((l) => l === hit || l.contains(hit)));
    }, s.pointer);
    const disabled = onTarget && (await loc.isDisabled());
    if (onTarget && !disabled) return box;
    if (s.clock.frame >= give) {
      const why = disabled ? `stayed disabled for ${PACING.find / 1000} s` : `is covered by ${await whatIsAt(s, s.pointer)}`;
      throw new TakeError(s.current, `${describe(t)} ${why}`);
    }
    await idle(s);
  }
}

export async function click(s: PerformState, loc: Locator, t: Target, clicks = 1, left?: () => number): Promise<Box> {
  const box = await reach(s, loc, t);
  await clickHere(s, clicks, left);
  return box;
}

export async function drag(s: PerformState, from: Spot, to: Spot): Promise<Box | undefined> {
  let box: Box | undefined;
  if (Array.isArray(from)) {
    await moveTo(s, async () => from);
    await wait(s, PACING.settle);
  } else box = await reach(s, await find(s, from), from);
  await press(s);
  await wait(s, PACING.drag.grip);
  if (Array.isArray(to)) await moveTo(s, async () => to, { drag: true });
  else {
    const loc = await find(s, to);
    await moveTo(s, async () => center(await boxOf(s, loc, to)), { drag: true });
  }
  await wait(s, PACING.drag.grip);
  await release(s);
  await tick(s);
  return box;
}
