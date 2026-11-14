// take probe: performs a take in a real browser at real pace, without recording a video, and screenshots the
// page after every step. The screenshots become a storyboard: the one approval before recording (SKILL.md),
// and the agent's check that every target resolves and every step does what the scenario says.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Spot, Step, Take } from '../take/format.ts';
import { openTake, untilReady } from '../drivers/web/browser.ts';
import { realtimeClock } from '../drivers/web/clock.ts';
import { perform, TakeError } from '../drivers/web/driver.ts';
import { cursorReader, type Cursor } from '../drivers/web/cursor.ts';
import type { Box } from '../drivers/web/events.ts';
import { describe, describeCondition, locate } from '../drivers/web/targets.ts';
import { PACING } from '../drivers/web/pacing.ts';

export interface ProbeShot {
  /** 0 is the first screen, before any step; then one per step, numbered from 1. */
  step: number;
  /** What the step does, in plain words. */
  label: string;
  /** Seconds into the take when the step ended (about where it lands in the video). */
  at: number;
  file: string;
  /** The page's accessibility outline after the step (roles and names, as targets use them), for writing and fixing targets. */
  outline: string;
  pointer: [number, number];
  cursor: Cursor;
  target?: Box;
  waitedFor?: Box;
  /** Set on the step that failed. */
  error?: string;
}

export interface ProbeResult {
  ok: boolean;
  title: string;
  viewport: [number, number];
  shots: ProbeShot[];
  error?: string;
  seconds: number;
  /** The site refused the hidden browser, so it ran in a visible window. */
  visibleWindow?: true;
}

/** "Click button "New project"", "Type "Moodboard" into field labelled "Name"", … */
export function describeStep(s: Step): string {
  let text: string;
  switch (s.do) {
    case 'click': text = `Click ${describe(s.target)}`; break;
    case 'hover': text = `Hover ${describe(s.target)}`; break;
    case 'drag': text = `Drag from ${describeSpot(s.from)} to ${describeSpot(s.to)}`; break;
    case 'type': text = `Type "${s.text}"${s.target ? ` into ${describe(s.target)}` : ''}`; break;
    case 'press': text = `Press ${s.key}`; break;
    case 'scroll': text = 'target' in s ? `Scroll to ${describe(s.target)}` : `Scroll by ${s.by.join(', ')} px`; break;
    case 'wait': text = `Wait for ${describeCondition(s.for)}`; break;
    case 'hold': text = `Hold ${+(s.ms / 1000).toFixed(2)} s`; break;
  }
  return s.waitFor ? `${text}, then wait for ${describeCondition(s.waitFor)}` : text;
}

const describeSpot = (s: Spot) => (Array.isArray(s) ? `${s[0]}, ${s[1]}` : describe(s));

/** Lets the page's own transitions finish (a dialog fading in), so each screenshot shows where the step lands. */
async function settle(page: Page) {
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 1500 })
    .catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

export async function probe(take: Take, out: string, { headed = false } = {}): Promise<ProbeResult> {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  // Scale 1: the layout is the same as at 2×, and the storyboard shows small pictures.
  let opened;
  try {
    opened = await openTake({ ...take, target: { ...take.target, scale: 1 } }, { headed });
  } catch (e) {
    if (!(e instanceof TakeError)) throw e;
    const result: ProbeResult = { ok: false, title: take.title, viewport: take.target.viewport, shots: [], error: e.message, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
    fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(result, null, 1));
    return result;
  }
  const { browser, page, visible } = opened;
  const shots: ProbeShot[] = [];
  const clock = realtimeClock();
  const cursorAt = cursorReader(page);
  const shoot = async (step: number, label: string, pointer: [number, number], extra: Partial<ProbeShot> = {}) => {
    const name = `step-${String(step).padStart(2, '0')}`;
    const file = `${name}.png`;
    const outline = `${name}.outline.yml`;
    await page.screenshot({ path: path.join(out, file) });
    fs.writeFileSync(path.join(out, outline), await page.locator('body').ariaSnapshot().catch((e) => `# outline unavailable: ${e.message}\n`));
    shots.push({ step, label, at: +(clock.frame / clock.fps).toFixed(2), file, outline, pointer, cursor: await cursorAt(pointer), ...extra });
  };
  let error: string | undefined;
  try {
    await page.waitForLoadState('load');
    try {
      await untilReady(page, take.ready, (ms) => page.waitForTimeout(ms));
    } catch (e) {
      if (!(e instanceof TakeError)) throw e;
      error = e.message;
    }
    await settle(page);
    // Where the driver puts the pointer before the first step.
    const [vw, vh] = take.target.viewport;
    let pointer: [number, number] = [Math.round(vw * PACING.start[0]), Math.round(vh * PACING.start[1])];
    await page.mouse.move(...pointer);
    await shoot(0, 'First screen', pointer, error ? { error } : {});
    if (!error) try {
      await perform(page, take, clock, {
        onStep: async (log, p) => {
          pointer = p;
          await settle(page);
          // Outline the element where it is now, in the picture; if the step made it go away (Create closes its
          // dialog), outlining where it was would point at nothing.
          const s = take.steps[log.index];
          let target: Box | undefined;
          if ('target' in s && s.target) {
            const loc = locate(page, s.target).filter({ visible: true });
            if ((await loc.count()) === 1) target = (await loc.boundingBox()) ?? undefined;
          }
          await shoot(log.index + 1, describeStep(s), p, { target, waitedFor: log.waitedFor });
        },
      });
    } catch (e) {
      if (!(e instanceof TakeError)) throw e;
      error = e.message;
      await shoot(e.step + 1, describeStep(take.steps[e.step]), pointer, { error: e.message.replace(/^step \d+: /, '') });
    }
  } finally {
    await browser.close();
  }
  const result: ProbeResult = { ok: !error, title: take.title, viewport: take.target.viewport, shots, error, seconds: +((performance.now() - t0) / 1000).toFixed(1), ...(visible && !headed ? { visibleWindow: true as const } : {}) };
  fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(result, null, 1));
  return result;
}
