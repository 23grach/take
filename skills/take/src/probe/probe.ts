import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Spot, Step, Take } from '../take/format.ts';
import { openTake, untilReady } from '../drivers/web/browser.ts';
import { realtimeClock } from '../drivers/web/clock.ts';
import { perform, performSetup, TakeError } from '../drivers/web/driver.ts';
import { cursorReader, type Cursor } from '../drivers/web/cursor.ts';
import type { Box } from '../drivers/web/events.ts';
import { describe, describeCondition, locate } from '../drivers/web/targets.ts';
import { PACING } from '../drivers/web/pacing.ts';
import { loadTheme } from '../compose/compose.ts';
import { timeline, type Script } from './script.ts';

export function withoutAddresses(outline: string): string {
  const lines = outline.split('\n').filter((l) => !/^\s*- \/url: /.test(l));
  const indent = (l: string) => l.length - l.trimStart().length;
  return lines.map((l, i) => (l.endsWith(':') && !(indent(lines[i + 1] ?? '') > indent(l)) ? l.slice(0, -1) : l)).join('\n');
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
    let path = el.tagName.toLowerCase() + (el.classList[0] ? `.${CSS.escape(el.classList[0])}` : '');
    for (let p = el.parentElement, depth = 0; p && p !== document.body && depth < 4; p = p.parentElement, depth++) {
      for (const sel of own(p)) if (one(sel) && one(`${sel} ${path}`)) return `${sel} ${path}`;
      path = `${p.tagName.toLowerCase()}${p.classList[0] ? `.${CSS.escape(p.classList[0])}` : ''} > ${path}`;
    }
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
    if (!(r.width > 0 && r.height > 0) || getComputedStyle(el).visibility === 'hidden') continue;
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
}

export function describeStep(s: Step): string {
  let text: string;
  switch (s.do) {
    case 'click': text = `${s.clicks === 2 ? 'Double-click' : s.clicks === 3 ? 'Triple-click' : 'Click'} ${Array.isArray(s.target) ? `at ${s.target.join(', ')}` : describe(s.target)}`; break;
    case 'hover': text = `Hover ${Array.isArray(s.target) ? `at ${s.target.join(', ')}` : describe(s.target)}`; break;
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

async function settle(page: Page) {
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 1500 })
    .catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

export const REHEARSAL_SPEED = 2;
const REHEARSAL_QUIET_MS = 3000;

export const REHEARSAL_HOLD_MS = 500;

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
    const tree = await page.locator('body').ariaSnapshot().then(withoutAddresses, (e) => `# outline unavailable: ${e.message}\n`);
    fs.writeFileSync(path.join(out, outline), tree + (await targetHandles(page, tree)));
    shots.push({ step, label, at: +(clock.frame / clock.fps).toFixed(2), file, outline, pointer, cursor: await cursorAt(pointer), ...extra });
  };
  let error: string | undefined;
  let script: Script | undefined;
  try {
    await page.waitForLoadState('load');
    try {
      await untilReady(page, take.ready, (ms) => page.waitForTimeout(ms));
      if (await performSetup(page, take, realtimeClock(60, speed))) await page.waitForTimeout(600 / speed);
    } catch (e) {
      if (!(e instanceof TakeError)) throw e;
      error = e.message;
    }
    await settle(page);
    const [vw, vh] = take.target.viewport;
    let pointer: [number, number] = [Math.round(vw * PACING.start[0]), Math.round(vh * PACING.start[1])];
    await page.mouse.move(...pointer);
    await shoot(0, 'First screen', pointer, error ? { error } : {});
    if (!error) try {
      const log = await perform(page, rehearsal(take), clock, {
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
      script = timeline(take, log.steps, log.frames, { fps: clock.fps, speed, loopFrames });
    } catch (e) {
      if (!(e instanceof TakeError)) throw e;
      error = e.message;
      await shoot(e.step + 1, describeStep(take.steps[e.step]), pointer, { error: e.message.replace(/^step \d+: /, '') });
    }
  } finally {
    await browser.close();
  }
  const result: ProbeResult = { ok: !error, title: take.title, viewport: take.target.viewport, shots, error, ...(script ? { script } : {}), seconds: +((performance.now() - t0) / 1000).toFixed(1), ...(visible && !headed ? { visibleWindow: true as const } : {}) };
  fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(result, null, 1));
  return result;
}
