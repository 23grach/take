import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { showsNoCursor, type Spot, type Step, type Take } from '../take/format.ts';
import { openTake, untilReady } from '../drivers/web/browser.ts';
import { realtimeClock } from '../drivers/web/clock.ts';
import { perform, performSetup } from '../drivers/web/driver.ts';
import { TakeError } from '../drivers/web/take-error.ts';
import { cursorReader, type Cursor } from '../drivers/web/cursor.ts';
import type { Box } from '../drivers/web/events.ts';
import { describe, describeCondition, locate } from '../drivers/web/targets.ts';
import { installCssHandles } from '../drivers/web/css-handle.ts';
import { startPoint } from '../drivers/web/pacing.ts';
import { isolate } from '../drivers/web/focus.ts';
import { focusLook, loadTheme } from '../compose/compose.ts';
import { timeline, type Script } from './script.ts';
import { LONG_OUTLINE, onScreen, shortOutline, SHORT_LENGTH } from './outline.ts';

export async function pageOutline(page: Page): Promise<string> {
  let tree: string;
  try {
    tree = await page.locator('body').ariaSnapshot();
  } catch (e) {
    return `# outline unavailable: ${(e as Error).message}\n`;
  }
  let short = shortOutline(tree);
  if (short.outline.length > LONG_OUTLINE) short = shortOutline(tree, await onScreen(page));
  return (
    (short.outline.includes('…') ? `# Names and text longer than ${SHORT_LENGTH} characters end in "…": target them by their start (names match part of the text).\n` : '') +
    short.outline +
    '\n' +
    (short.leftOut ? `\n# Long page: only what is on screen is listed, plus every heading (${short.leftOut} more lines off screen). A step that scrolls lists what is on screen after it.\n` : '') +
    (await targetHandles(page, tree))
  );
}

export async function targetHandles(page: Page, outline: string): Promise<string> {
  const vp = page.viewportSize();
  if (!vp) return '';
  const counts = new Map<string, number>();
  for (const m of outline.matchAll(/^\s*- (\w+) "((?:[^"\\]|\\.)*)"/gm)) {
    const key = `${m[1]} ${m[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
  await installCssHandles(page);
  const found = await page
    .locator(CONTROLS)
    .evaluateAll(handlesInPage, { shared, vw: vp.width, vh: vp.height })
    .catch(() => ({ unnamed: [] as string[], shared: [] as string[] }));
  return (
    (found.unnamed.length ? `\n# On screen with no name (listed above only as "- button" / "- link"); target them by CSS:\n${found.unnamed.join('\n')}\n` : '') +
    (found.shared.length ? `\n# Several elements share these names, so a role-and-name target matches more than one; target one by CSS:\n${found.shared.join('\n')}\n` : '')
  );
}

const CONTROLS = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=searchbox], [role=textbox]';

function handlesInPage(els: Element[], { shared, vw, vh }: { shared: string[]; vw: number; vh: number }) {
  const uniqueSelector = (globalThis as unknown as { __takeUniqueSelector: (el: Element) => string | null }).__takeUniqueSelector;
  const roleOf = (el: Element) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    const type = (el as HTMLInputElement).type;
    return type === 'checkbox' || type === 'radio' ? type : type === 'search' ? 'searchbox' : ['button', 'submit', 'reset'].includes(type) ? 'button' : 'textbox';
  };
  const nameOf = (el: Element) => {
    const label = el.getAttribute('aria-label') ?? (el.getAttribute('aria-labelledby') ? el.getAttribute('aria-labelledby')!.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : null);
    const text = label ?? ((el as HTMLElement).innerText || (el as HTMLInputElement).placeholder || el.getAttribute('title') || '');
    return text.replace(/\s+/g, ' ').trim();
  };
  const place = (r: DOMRect) => {
    const [x, y] = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
    const on = x >= 0 && x <= vw && y >= 0 && y <= vh;
    const where = `${y < vh / 3 ? 'top' : y > (2 * vh) / 3 ? 'bottom' : 'middle'} ${x < vw / 3 ? 'left' : x > (2 * vw) / 3 ? 'right' : 'centre'}`;
    return { on, at: on ? `at ${x}, ${y} (${where}, ${Math.round(r.width)}×${Math.round(r.height)})` : y > vh ? `below the screen (y ${y})` : y < 0 ? `above the screen (y ${y})` : `off to the side (x ${x})` };
  };
  const wanted = new Set(shared);
  const groups = new Map<string, Element[]>();
  const unnamed: string[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    if (!name && (role === 'button' || role === 'link')) {
      const p = place(r);
      const css = p.on && unnamed.length < 30 ? uniqueSelector(el) : null;
      if (css) unnamed.push(`#   ${role} at ${p.at.slice(3)}: { "css": ${JSON.stringify(css)} }`);
    } else if (wanted.has(`${role} ${name}`)) {
      const g = groups.get(`${role} ${name}`) ?? [];
      g.push(el);
      groups.set(`${role} ${name}`, g);
    }
  }
  const out: string[] = [];
  for (const [key, g] of groups) {
    if (g.length < 2 || out.length >= 40) continue;
    const places = g.map((el) => place(el.getBoundingClientRect()));
    if (!places.some((p) => p.on)) continue;
    const role = key.slice(0, key.indexOf(' '));
    const name = key.slice(key.indexOf(' ') + 1);
    g.slice(0, 8).forEach((el, i) => {
      const css = uniqueSelector(el);
      if (css) out.push(`#   ${role} "${name}" ${places[i].at}: { "css": ${JSON.stringify(css)} }`);
    });
  }
  return { unnamed, shared: out };
}

export interface ProbeShot {
  step: number;
  label: string;
  at: number;
  file: string;
  outline: string;
  pointer: [number, number];
  cursor: Cursor;
  target?: Box;
  waitedFor?: Box;
  error?: string;
  note?: string;
}

export interface ProbeResult {
  ok: boolean;
  title: string;
  viewport: [number, number];
  shots: ProbeShot[];
  error?: string;
  seconds: number;
  script?: Script;
  visibleWindow?: true;
  phone?: true;
  noCursor?: true;
  focus?: Box;
}

export function describeStep(s: Step): string {
  let text: string;
  switch (s.do) {
    case 'click': text = `${s.clicks === 2 ? 'Double-click' : s.clicks === 3 ? 'Triple-click' : 'Click'} ${Array.isArray(s.target) ? `at ${s.target.join(', ')}` : describe(s.target)}${s.clicks && s.clicks > 3 ? ` ${s.clicks} times quickly` : ''}`; break;
    case 'hover': text = `Hover ${Array.isArray(s.target) ? `at ${s.target.join(', ')}` : describe(s.target)}`; break;
    case 'drag': text = `Drag from ${describeSpot(s.from)} to ${describeSpot(s.to)}`; break;
    case 'type': text = `Type "${s.text}"${s.target ? ` into ${describe(s.target)}` : ''}`; break;
    case 'press': text = `Press ${s.key}`; break;
    case 'scroll': text = 'target' in s ? `Scroll to ${describe(s.target)}` : `Scroll by ${s.by.join(', ')} px`; break;
    case 'wait': text = `Wait for ${describeCondition(s.for)}${s.film === false ? ', not filmed' : ''}`; break;
    case 'hold': text = `Hold ${+(s.ms / 1000).toFixed(2)} s`; break;
    case 'appearance': text = `Switch the computer to ${s.to} mode`; break;
  }
  return s.waitFor ? `${text}, then wait for ${describeCondition(s.waitFor)}` : text;
}

const describeSpot = (s: Spot) => (Array.isArray(s) ? `${s[0]}, ${s[1]}` : describe(s));

async function settle(page: Page) {
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 1500 })
    .catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const REHEARSAL_SPEED = 2;
const REHEARSAL_QUIET_MS = 3000;

const REHEARSAL_HOLD_MS = 500;

export function rehearsal(take: Take): Take {
  const last = take.steps.length - 1;
  const steps = take.steps.map((s, i) => (s.do === 'hold' && (i === 0 || i === last) && s.ms > REHEARSAL_HOLD_MS ? { ...s, ms: REHEARSAL_HOLD_MS } : s));
  return { ...take, steps };
}

export function clearProbe(out: string) {
  if (!fs.existsSync(out)) return;
  for (const f of fs.readdirSync(out))
    if (/^step-\d+\.(png|outline\.yml)$/.test(f) || f === 'probe.json' || f === 'storyboard.jpg') fs.rmSync(path.join(out, f), { force: true });
}

export async function probe(take: Take, out: string, { headed = false, speed = REHEARSAL_SPEED } = {}): Promise<ProbeResult> {
  clearProbe(out);
  fs.mkdirSync(out, { recursive: true });
  const t0 = performance.now();
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
    fs.writeFileSync(path.join(out, outline), await pageOutline(page));
    shots.push({ step, label, at: +(clock.frame / clock.fps).toFixed(2), file, outline, pointer, cursor: await cursorAt(pointer), ...extra });
  };
  let error: string | undefined;
  let script: Script | undefined;
  let focus: Box | undefined;
  try {
    await page.waitForLoadState('load');
    try {
      if (await performSetup(page, take, realtimeClock(60, speed))) await page.waitForTimeout(600 / speed);
      await untilReady(page, take.ready, (ms) => page.waitForTimeout(ms));
    } catch (e) {
      if (!(e instanceof TakeError)) throw e;
      error = e.message;
    }
    const look = take.target.focus && !error ? focusLook(take.theme) : undefined;
    if (look) try {
      focus = await isolate(page, take.target.focus!, take.target.viewport, look);
    } catch (e) {
      if (!(e instanceof TakeError)) throw e;
      error = e.message;
    }
    await settle(page);
    let pointer: [number, number] = startPoint(take.target.viewport, focus);
    if (take.target.device !== 'phone') await page.mouse.move(...pointer);
    await shoot(0, 'First screen', pointer, error ? { error } : {});
    if (!error) try {
      const log = await perform(page, rehearsal(take), clock, {
        unfilmed: realtimeClock(60, speed),
        ...(focus ? { focus } : {}),
        watch: false,
        onStep: async (log, p) => {
          pointer = p;
          await settle(page);
          const s = take.steps[log.index];
          let target: Box | undefined;
          if ('target' in s && s.target && !Array.isArray(s.target)) {
            const loc = locate(page, s.target).filter({ visible: true });
            if ((await loc.count()) === 1) target = (await loc.boundingBox()) ?? undefined;
          }
          await shoot(log.index + 1, describeStep(s), p, { target, waitedFor: log.waitedFor, ...(log.note ? { note: log.note } : {}) });
          clock.resume();
        },
      });
      const loopFrames = take.loop === 'none' ? 0 : loadTheme(take.theme).theme.loop.frames;
      script = timeline(take, log.steps, log.frames, { fps: clock.fps, speed, loopFrames, rehearsed: true });
    } catch (e) {
      if (!(e instanceof TakeError)) throw e;
      error = e.message;
      await shoot(e.step + 1, describeStep(take.steps[e.step]), pointer, { error: e.message.replace(/^step \d+: /, '') });
    }
  } finally {
    await browser.close();
  }
  const result: ProbeResult = { ok: !error, title: take.title, viewport: take.target.viewport, shots, error, ...(focus ? { focus } : {}), ...(script ? { script } : {}), ...(take.target.device === 'phone' ? { phone: true as const } : {}), ...(showsNoCursor(take) ? { noCursor: true as const } : {}), seconds: +((performance.now() - t0) / 1000).toFixed(1), ...(visible && !headed ? { visibleWindow: true as const } : {}) };
  fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(result, null, 1));
  return result;
}
