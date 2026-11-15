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

/** The page outline without link addresses (`- /url: …` under every link): targets never use them, and on a
 *  big site they're a good share of what the agent reads after each step. A link left with nothing under it
 *  loses its trailing colon. */
export function withoutAddresses(outline: string): string {
  const lines = outline.split('\n').filter((l) => !/^\s*- \/url: /.test(l));
  const indent = (l: string) => l.length - l.trimStart().length;
  return lines.map((l, i) => (l.endsWith(':') && !(indent(lines[i + 1] ?? '') > indent(l)) ? l.slice(0, -1) : l)).join('\n');
}

/** Visible buttons and links with no name, which the outline lists only as `- button`: each with a CSS selector
 *  that matches only it, and where it is on screen, so a target can still reach it (a close "×"). */
export async function unnamedHandles(page: Page): Promise<string> {
  const [vw, vh] = page.viewportSize() ? [page.viewportSize()!.width, page.viewportSize()!.height] : [0, 0];
  const lines: string[] = [];
  for (const role of ['button', 'link'] as const) {
    const found = page.getByRole(role, { name: /^$/ }).filter({ visible: true });
    for (const el of (await found.all().catch(() => [])).slice(0, 30)) {
      const css = await el.evaluate(uniqueSelector).catch(() => null);
      const box = await el.boundingBox().catch(() => null);
      if (!css || !box || box.x + box.width < 0 || box.y + box.height < 0 || box.x > vw || box.y > vh) continue;
      const [x, y] = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
      const where = `${y < vh / 3 ? 'top' : y > (2 * vh) / 3 ? 'bottom' : 'middle'} ${x < vw / 3 ? 'left' : x > (2 * vw) / 3 ? 'right' : 'centre'}`;
      lines.push(`#   ${role} at ${x}, ${y} (${where}, ${Math.round(box.width)}×${Math.round(box.height)}): { "css": ${JSON.stringify(css)} }`);
    }
  }
  return lines.length ? `\n# On screen with no name (listed above only as "- button" / "- link"); target them by CSS:\n${lines.join('\n')}\n` : '';
}

/** A short CSS selector that matches only `el` in its document, or null. Runs in the page. */
function uniqueSelector(el: Element): string | null {
  const one = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const own = (e: Element): string[] => {
    const tag = e.tagName.toLowerCase();
    const out: string[] = [];
    for (const a of ['data-testid', 'data-test', 'data-qa', 'aria-controls', 'title', 'name'])
      if (e.getAttribute(a)) out.push(`${tag}[${a}=${JSON.stringify(e.getAttribute(a))}]`);
    if (e.id && !/\d{3,}|:/.test(e.id)) out.push(`#${CSS.escape(e.id)}`);
    const classes = [...e.classList].filter((c) => !/^(is-|has-)|\d{4,}/.test(c)).map((c) => `.${CSS.escape(c)}`);
    for (const c of classes) out.push(c, `${tag}${c}`);
    for (let i = 0; i < classes.length; i++) for (let j = i + 1; j < classes.length; j++) out.push(`${tag}${classes[i]}${classes[j]}`);
    return out;
  };
  for (const sel of own(el)) if (one(sel)) return sel;
  // Inside a nearby ancestor that has a unique selector of its own.
  let path = el.tagName.toLowerCase() + (el.classList[0] ? `.${CSS.escape(el.classList[0])}` : '');
  for (let p = el.parentElement, depth = 0; p && p !== document.body && depth < 4; p = p.parentElement, depth++) {
    for (const sel of own(p)) if (one(sel) && one(`${sel} ${path}`)) return `${sel} ${path}`;
    path = `${p.tagName.toLowerCase()}${p.classList[0] ? `.${CSS.escape(p.classList[0])}` : ''} > ${path}`;
  }
  // Last resort: its place among its siblings, up to an ancestor that can be named (or the body).
  const nth = (e: Element) => `${e.tagName.toLowerCase()}:nth-of-type(${[...(e.parentElement?.children ?? [])].filter((x) => x.tagName === e.tagName).indexOf(e) + 1})`;
  let chain = nth(el);
  for (let p = el.parentElement, depth = 0; p && depth < 6; p = p.parentElement, depth++) {
    const named = p === document.body ? 'body' : own(p).find(one);
    if (named && one(`${named} > ${chain}`)) return `${named} > ${chain}`;
    if (p === document.body) break;
    chain = `${nth(p)} > ${chain}`;
  }
  return null;
}

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

/** How much faster than the video a rehearsal plays: the storyboard shows where each step ends, not how it moves.
 *  Time limits (finding a target, waiting for something) stay as long in real seconds. */
export const REHEARSAL_SPEED = 2;
/** How long a rehearsal waits for the network to go quiet after loading (a recording waits up to 10 s). Sites
 *  that stream a video or poll never go quiet; the driver waits for each step's target anyway. */
const REHEARSAL_QUIET_MS = 3000;

/** The longest an opening or closing hold lasts in a rehearsal. */
export const REHEARSAL_HOLD_MS = 500;

/** The take as rehearsed: the opening and closing holds (2 s each in a video) are cut short, since the storyboard
 *  shows only where each step ends. Holds between steps are played in full, and labels keep the real lengths. */
export function rehearsal(take: Take): Take {
  const last = take.steps.length - 1;
  const steps = take.steps.map((s, i) => (s.do === 'hold' && (i === 0 || i === last) && s.ms > REHEARSAL_HOLD_MS ? { ...s, ms: REHEARSAL_HOLD_MS } : s));
  return { ...take, steps };
}

/** Removes an earlier probe's files from `out`, and nothing else: `--out` may point at a folder that holds
 *  other things, the take itself included. */
export function clearProbe(out: string) {
  if (!fs.existsSync(out)) return;
  for (const f of fs.readdirSync(out))
    if (/^step-\d+\.(png|outline\.yml)$/.test(f) || f === 'probe.json' || f === 'storyboard.jpg') fs.rmSync(path.join(out, f), { force: true });
}

export async function probe(take: Take, out: string, { headed = false, speed = REHEARSAL_SPEED } = {}): Promise<ProbeResult> {
  clearProbe(out);
  fs.mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  // Scale 1: the layout is the same as at 2×, and the storyboard shows small pictures.
  let opened;
  try {
    opened = await openTake({ ...take, target: { ...take.target, scale: 1 } }, { headed, quietMs: REHEARSAL_QUIET_MS });
  } catch (e) {
    if (!(e instanceof TakeError)) throw e;
    const result: ProbeResult = { ok: false, title: take.title, viewport: take.target.viewport, shots: [], error: e.message, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
    fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(result, null, 1));
    return result;
  }
  const { browser, page, visible } = opened;
  const shots: ProbeShot[] = [];
  const clock = realtimeClock(60, speed);
  const cursorAt = cursorReader(page);
  const shoot = async (step: number, label: string, pointer: [number, number], extra: Partial<ProbeShot> = {}) => {
    const name = `step-${String(step).padStart(2, '0')}`;
    const file = `${name}.png`;
    const outline = `${name}.outline.yml`;
    await page.screenshot({ path: path.join(out, file) });
    const tree = await page.locator('body').ariaSnapshot().then(withoutAddresses, (e) => `# outline unavailable: ${e.message}\n`);
    fs.writeFileSync(path.join(out, outline), tree + (await unnamedHandles(page)));
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
      await perform(page, rehearsal(take), clock, {
        watch: false,
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
          // Screenshots and outlines aren't part of the take: times on the storyboard stay video time.
          clock.resume();
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
