import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { serve } from '../examples/demo-app/serve.mjs';
import { launch, openTake } from '../src/drivers/web/browser.ts';
import { record } from '../src/drivers/web/record.ts';
import { compose, loadTheme, themeProblem } from '../src/compose/compose.ts';
import { bandAt, fingerAt, keyboardAt, nextInk, pageTops, phoneLayout, safariAt, safariCollapses, type Ink } from '../src/compose/phone.ts';
import { PHONE, validateTake, type Take } from '../src/take/format.ts';
import type { Event, EventLog, PageTop } from '../src/drivers/web/events.ts';
import { perform } from '../src/drivers/web/driver.ts';
import { frames } from '../src/drivers/web/pacing.ts';
import type { Clock } from '../src/drivers/web/clock.ts';
import { mediaTool } from '../src/media-tools.ts';

const { theme } = loadTheme();
const look = theme.phone!;
let app: { url: string; close: () => Promise<unknown> };
let tmp: string;
before(async () => {
  app = await serve(0);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-phone-'));
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const draft = (target: Record<string, unknown>, steps: unknown[] = [{ do: 'hold', ms: 100 }]) =>
  validateTake({ version: 0, title: 't', target: { kind: 'web', url: 'http://x.test/', ...target }, steps });

function phoneTake(steps: unknown[]): Take {
  const r = validateTake({ version: 0, title: 'Phone', loop: 'none', sound: false, target: { kind: 'web', device: 'phone', url: app.url, scale: 1 }, steps });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.take;
}

test('a take is for a desktop unless it says phone; a phone page is 402×820, the screen below the status bar, and has no hover', () => {
  const desktop = draft({});
  assert.ok(desktop.ok && desktop.take.target.device === 'desktop');
  const phone = draft({ device: 'phone' });
  assert.ok(phone.ok);
  assert.deepEqual(phone.take.target.viewport, [402, 820]);
  const typo = draft({ device: 'phon' });
  assert.ok(!typo.ok && typo.errors.includes('target.device: must be "desktop" or "phone", got "phon" (did you mean "phone"?)'), JSON.stringify(typo));
  const sized = draft({ device: 'phone', viewport: [390, 844] });
  assert.ok(!sized.ok && sized.errors.some((e) => e.startsWith('target.viewport: a phone\'s page is always 402×820')));
  const hover = draft({ device: 'phone' }, [{ do: 'hover', target: { text: 'Pricing' } }]);
  assert.ok(!hover.ok && hover.errors.some((e) => e.startsWith('steps[0].do: a phone has no hover')));
  assert.match(themeProblem('plain', 'phone') ?? '', /no phone look/);
  assert.equal(themeProblem('default', 'phone'), undefined);
});

test('the finger shows only around a touch: it comes down, follows the touch, and lifts off', () => {
  const frames = 80;
  const events: Event[] = [
    { frame: 20, type: 'down', x: 100, y: 300 },
    { frame: 30, type: 'up', x: 100, y: 250 },
    { frame: 60, type: 'down', x: 200, y: 400 },
    { frame: 64, type: 'up', x: 200, y: 400 },
  ];
  const log = { device: 'phone', frames, pointer: Array.from({ length: frames }, (_, f) => [100, 300 - Math.max(0, f - 20) * 5]), events } as unknown as EventLog;
  const finger = (f: number) => fingerAt(log, look.finger, f);
  const { lead, lift } = look.finger;
  assert.equal(finger(20 - lead - 1), null);
  const coming = Array.from({ length: lead }, (_, i) => finger(20 - lead + i)!);
  assert.ok(coming.every((c, i) => c.x === 100 && c.y === 300 && c.opacity > 0 && c.opacity < 1 && (i === 0 || c.opacity > coming[i - 1].opacity && c.scale < coming[i - 1].scale)));
  assert.ok(coming[0].scale > 1.15 && coming[0].opacity < 0.5);
  assert.deepEqual(finger(20), { x: 100, y: 300, opacity: 1, scale: 1 });
  assert.deepEqual(finger(26), { x: 100, y: 270, opacity: 1, scale: 1 });
  const lifting = finger(31)!;
  assert.ok(lifting.x === 100 && lifting.y === 250 && lifting.opacity < 1 && lifting.scale > 1);
  assert.equal(finger(30 + lift - 1), null);
  assert.equal(finger(45), null);
  assert.ok(finger(60 - lead)!.opacity > 0);
});

test('the phone sits in the middle of the stage with the page filling its screen below the status bar', () => {
  const box = phoneLayout(theme, look, [402, 820]);
  const [W, H] = theme.stage.size;
  assert.ok(Math.abs(box.left * 2 + box.width - W) <= 1 && Math.abs(box.top * 2 + box.height - H) <= 1);
  assert.ok(Math.abs(box.top - theme.stage.padding) <= 1);
  assert.ok(Math.abs(box.statusBar - 54) < 0.5, `status bar ${box.statusBar} pt`);
  assert.ok(Math.abs((box.k * 4) / 3 - 1.38) < 0.02, `${box.k} stage px per point`);
});

test('a phone opens the iPhone layout, as Safari', async () => {
  const take = phoneTake([{ do: 'hold', ms: 100 }]);
  const { browser, page } = await openTake(take);
  try {
    const seen = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      agent: navigator.userAgent,
      hints: 'userAgentData' in navigator,
      touch: matchMedia('(pointer: coarse)').matches,
      nav: getComputedStyle(document.querySelector('.nav')!).display,
    }));
    assert.deepEqual({ ...seen, agent: /iPhone.*Version\/\S+ Mobile\/\S+ Safari/.test(seen.agent) }, { width: 402, height: 820, agent: true, hints: false, touch: true, nav: 'none' });
  } finally {
    await browser.close();
  }
});

test('a phone take swipes, taps and types like a finger, and composes into the phone on the 2560×1440 video', async () => {
  const take = phoneTake([
    { do: 'scroll', by: [0, 300] },
    { do: 'scroll', by: [0, -300] },
    { do: 'click', target: { role: 'button', name: 'New project' }, waitFor: { visible: { role: 'dialog', name: 'New project' } } },
    { do: 'type', target: { label: 'Name' }, text: 'Ab', cps: 30 },
  ]);
  const out = path.join(tmp, 'capture');
  const { events, capture } = await record(take, { mode: 'studio', out });
  assert.equal(events.device, 'phone');
  assert.deepEqual(events.viewport, [402, 820]);
  assert.deepEqual(capture.size, [402, 820]);
  assert.deepEqual(events.cursors, [[0, 'default']]);
  const touches = events.events.filter((e) => e.type === 'down' || e.type === 'up');
  assert.deepEqual(touches.map((e) => e.type), ['down', 'up', 'down', 'up', 'down', 'up', 'down', 'up']);
  for (const [i, sign] of [[0, 1], [2, -1]] as const) {
    const [down, up] = [touches[i], touches[i + 1]];
    assert.ok(down.type === 'down' && up.type === 'up');
    const moved = events.events.filter((e) => e.type === 'scroll' && e.frame >= down.frame && e.frame <= up.frame).reduce((sum, e) => sum + (e.type === 'scroll' ? e.dy : 0), 0);
    assert.ok(sign * (down.y - up.y) > 60 && Math.abs(down.y - up.y - moved) <= 1.5, `finger moved ${down.y - up.y}, content ${moved}`);
    const above = 820 - PHONE.safariBar;
    assert.ok(down.y - (down.y - up.y) / 2 > above * 0.4 && down.y - (down.y - up.y) / 2 < above * 0.6, 'swipes run in the middle of the page above Safari\'s bar');
    assert.ok(Math.max(down.y, up.y) < above, 'the finger never touches Safari\'s bar');
    const glide = events.events.filter((e) => e.type === 'scroll' && e.frame > up.frame && e.frame < touches[i + 2].frame);
    assert.ok(glide.length > 5, 'the content glides on after the finger lifts');
  }
  const tops = events.tops!.map(([, t]) => t);
  assert.deepEqual([tops[0].cover, tops[0].depth, tops[0].color], [null, 0, 'rgb(255 255 255 / 1)'], 'at rest the top of the page is its white header');
  assert.ok(Math.max(...tops.map((t) => t.scrollY)) >= 250 && tops.some((t) => t.scrollY === 0 && t !== tops[0]), 'the page scrolls down and back up');
  const backdrop = tops.find((t) => /^rgb\(\d+ \d+ \d+ \/ 0\.\d+\)$/.test(t.cover ?? ''));
  assert.ok(backdrop && backdrop.depth === 820, 'the dialog\'s see-through backdrop covers the whole page');
  const typed = events.events.filter((e) => e.type === 'key').map((e) => (e.type === 'key' ? e.key : ''));
  assert.deepEqual(typed, ['A', 'b']);
  const video = path.join(tmp, 'phone.mp4');
  const c = await compose({ capture: out, out: video, range: [0, 5] });
  assert.deepEqual(c.size, [2560, 1440]);
  const probe = execFileSync(mediaTool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  assert.match(probe, /^2560,1440/);
});

function fastClock(): Clock {
  let frame = 0;
  return { fps: 60, get frame() { return frame; }, async tick() { frame++; await new Promise((r) => setImmediate(r)); } };
}

test('a text field brings up the keyboard over the page: typing waits for it, the field rises above it, and it goes when the field loses focus', async () => {
  const take = phoneTake([
    { do: 'click', target: { role: 'button', name: 'New project' }, waitFor: { visible: { role: 'dialog', name: 'New project' } } },
    { do: 'type', target: { label: 'Name' }, text: 'Ab', cps: 30 },
    { do: 'click', target: { role: 'button', name: 'Cancel' } },
    { do: 'hold', ms: 600 },
  ]);
  const { browser, page } = await openTake(take);
  try {
    const page_: number[][] = [];
    const log = await perform(page, take, fastClock(), {
      onStep: async (step) => void (step.do === 'type' && page_.push(await page.evaluate(() => [innerWidth, innerHeight, visualViewport!.height, document.activeElement!.getBoundingClientRect().bottom]))),
    });
    const [[width, height, visible, fieldBottom]] = page_;
    assert.deepEqual([width, height, visible], [402, 820, 820], 'the page keeps its size while the keyboard is up, as in Safari');
    const changes = log.keyboard!;
    const [click, type, cancel] = log.steps;
    const opened = changes.find(([, up]) => up)!;
    assert.ok(opened[0] >= click.start, 'the keyboard comes up once the field has focus');
    const keys = log.events.filter((e) => e.type === 'key');
    assert.ok(keys[0].frame >= opened[0] + frames(PHONE.keyboard.slide), `typing starts at ${keys[0].frame}, the keyboard was up at ${opened[0] + frames(PHONE.keyboard.slide)}`);
    const { lift } = changes.filter(([frame]) => frame <= type.end).at(-1)![1]!;
    const clear = PHONE.keyboard.top - PHONE.statusBar - PHONE.keyboard.clearance;
    assert.ok(fieldBottom > clear && lift > 0, 'the field starts out under the keyboard');
    assert.ok(fieldBottom - lift <= clear + 2, `the field ends ${fieldBottom - lift} pt down, above the keyboard at ${clear}`);
    const [closed, gone] = changes.at(-1)!;
    assert.equal(gone, null);
    assert.ok(closed >= cancel.start && closed <= cancel.end + frames(100), 'the keyboard goes when the tap takes focus away');
    const tap = log.events.filter((e) => e.type === 'down' && e.frame >= cancel.start)[0];
    const liftAtTap = changes.filter(([frame]) => frame <= tap.frame).at(-1)![1]!.lift;
    assert.ok(tap.type === 'down' && tap.y - liftAtTap < clear + PHONE.keyboard.clearance, 'the finger taps above the keyboard, never through it');
  } finally {
    await browser.close();
  }
});

test('on the demo the keyboard lifts the page once, high enough for the field and the button tapped next, and the toast lands above Safari\'s bar', async () => {
  const take = phoneTake([
    { do: 'click', target: { role: 'button', name: 'New project' }, waitFor: { visible: { role: 'dialog', name: 'New project' } } },
    { do: 'type', target: { label: 'Name' }, text: 'Moodboard', cps: 30 },
    { do: 'click', target: { role: 'button', name: 'Create', exact: true }, waitFor: { visible: { role: 'status' } } },
  ]);
  const { events } = await record(take, { mode: 'studio', out: path.join(tmp, 'lift') });
  const lifts = Array.from({ length: events.frames }, (_, f) => keyboardAt(events, look.keyboard, f, 0).lift);
  const closed = events.keyboard!.findIndex(([, up], i) => i > 0 && !up);
  const until = closed < 0 ? events.frames : events.keyboard![closed][0];
  const rising = lifts.slice(0, until);
  assert.ok(rising.every((l, f) => f === 0 || l >= rising[f - 1] - 0.01), `the lift only ever rises while the keyboard is up: ${rising.map((l) => l.toFixed(0)).join(' ')}`);
  const moving = rising.map((l, f) => f > 0 && l > rising[f - 1] + 0.01);
  const rises = moving.filter((m, f) => m && !moving[f - 1]).length;
  assert.equal(rises, 1, 'one rise, no second step');
  const [, , create] = events.steps;
  const field = events.steps[1].target!;
  const top = Math.max(...rising);
  const clear = PHONE.keyboard.top - PHONE.statusBar - PHONE.keyboard.clearance;
  assert.ok(field.y + field.height - top <= clear + 2 && create.target!.y + create.target!.height - top <= clear + 2, 'the field and Create both sit above the keyboard');
  const toast = create.waitedFor!;
  assert.ok(toast.y + toast.height <= 820 - PHONE.safariBar, `the toast ends at ${toast.y + toast.height} pt, above Safari's bar`);
});

test('the Safari bar folds into the address while the page scrolls down and opens again on the way up', () => {
  const scroll = (frame: number, dy: number): Event => ({ frame, type: 'scroll', dx: 0, dy });
  const events = [scroll(10, 6), scroll(11, 20), scroll(12, 40), scroll(40, -10), scroll(60, 30), scroll(80, -200)];
  assert.deepEqual(safariCollapses(events, look.safari.collapseAfter), [[11, true], [40, false], [60, true], [80, false]]);
  const log = { frames: 120, events } as unknown as EventLog;
  const bar = (f: number) => safariAt(log, look.safari, f, 0);
  const n = look.safari.morph;
  assert.equal(bar(10), 0);
  assert.ok(bar(11) > 0 && bar(11) < bar(14) && bar(14) < 1, 'it folds over a few frames');
  assert.equal(bar(11 + n - 1), 1);
  assert.equal(bar(39), 1);
  assert.equal(bar(40 + n - 1), 0);
  assert.equal(bar(79), 1);
  assert.equal(bar(119), 0);
});

test('the status bar ink switches only on a clear change of shade, and fades over a few frames', () => {
  const rule = { toDark: 0.45, toLight: 0.6, fade: 4 };
  const inkSeries = (lumas: number[]) => lumas.reduce<Ink[]>((out, luma) => [...out, nextInk(out.at(-1), luma, rule)], []);
  const inks = inkSeries([0.9, 0.5, 0.46, 0.44, 0.5, 0.59, 0.6, 0.61, 0.61, 0.61, 0.61, 0.61]);
  assert.deepEqual(inks.map((i) => i.dark), [false, false, false, true, true, true, true, false, false, false, false, false]);
  assert.deepEqual(inks.map((i) => i.amount), [0, 0, 0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0, 0]);
  assert.ok(inkSeries([0.7, 0.5, 0.55, 0.5, 0.55, 0.46]).every((i) => !i.dark), 'a shade between the two thresholds never flickers');
  assert.deepEqual(inkSeries([0.1]), [{ dark: true, amount: 1 }]);
});

test('the keyboard slides, presses the key being typed, shifts for capitals, switches to numbers and shows the word', () => {
  const key = (frame: number, k: string): Event => ({ frame, type: 'key', key: k });
  const log = {
    frames: 200,
    events: [key(40, 'A'), key(45, 'b'), key(60, '4'), key(70, ' '), key(80, 'x')],
    keyboard: [[10, { lift: 30 }], [50, { lift: 30 }], [100, null]],
  } as unknown as EventLog;
  const kb = (f: number) => keyboardAt(log, look.keyboard, f, 0);
  const slide = frames(PHONE.keyboard.slide);
  assert.equal(kb(9).up, 0);
  assert.ok(kb(15).up > 0 && kb(15).up < 1 && kb(15).opacity === 1);
  assert.deepEqual({ up: kb(10 + slide).up, lift: kb(10 + slide).lift }, { up: 1, lift: 30 });
  assert.deepEqual(kb(40), { up: 1, opacity: 1, lift: 30, layout: 'letters', shift: true, pressed: 'a', callout: true, word: 'A' });
  assert.equal(kb(40 - look.keyboard.lead).shift, true, 'shift goes on just before the capital');
  assert.deepEqual([kb(52).layout, kb(56).layout, kb(60).pressed, kb(60).word], ['letters', 'numbers', '4', 'Ab4']);
  assert.deepEqual([kb(70).pressed, kb(70).callout, kb(70).word, kb(80).word], ['space', false, '', 'x']);
  assert.equal(kb(100 + slide).up, 0);
});

const WHITE = 'rgb(255 255 255 / 1)';
const at = (scrollY: number, more: Partial<PageTop> = {}): PageTop => ({ scrollY, scrollHeight: 2000, inner: 0, cover: null, depth: 0, color: WHITE, ...more });

test('at rest the status bar takes the colour of the top of the page', () => {
  const tops = [at(0), at(0, { color: 'rgb(16 16 20 / 1)' })];
  assert.deepEqual(bandAt(tops, 0), { pieces: [{ top: 0, height: 54, color: WHITE }], cover: null });
  assert.deepEqual(bandAt(tops, 1), { pieces: [{ top: 0, height: 54, color: 'rgb(16 16 20 / 1)' }], cover: null });
});

test('content that has scrolled up past the page shows behind the status bar, taken from the nearest earlier frame it was on screen', () => {
  const tops = pageTops([[0, at(0, { color: 'rgb(1 2 3 / 1)' })], [1, at(30)], [2, at(100)], [4, at(1000)]], 5);
  assert.deepEqual(bandAt(tops, 1), { pieces: [{ top: 0, height: 24, color: 'rgb(1 2 3 / 1)' }, { top: 24, height: 30, frame: 0, row: 0 }], cover: null });
  assert.deepEqual(bandAt(tops, 3), { pieces: [{ top: 0, height: 54, frame: 1, row: 16 }], cover: null }, 'still the same rows once the page stops');
  assert.deepEqual(bandAt(tops, 4).pieces, [{ top: 0, height: 54, color: WHITE }], 'rows never on screen take the colour at the top of the page');
  assert.deepEqual(bandAt([at(200), at(0, { scrollHeight: 2300 }), at(200, { scrollHeight: 2300 })], 2).pieces, [{ top: 0, height: 54, frame: 1, row: 146 }], 'frames from before the page grew or shrank are never used');
});

test('a header pinned to the top fills the status bar with its colour; a see-through one tints what is behind it', () => {
  const header = 'rgb(24 24 29 / 1)';
  const backdrop = 'rgb(20 20 30 / 0.32)';
  const tops = [at(0), at(200), at(200, { cover: header, depth: 56 }), at(200, { cover: backdrop, depth: 820 })];
  assert.deepEqual(bandAt(tops, 2), { pieces: [{ top: 0, height: 54, color: header }], cover: null });
  assert.deepEqual(bandAt(tops, 3), { pieces: [{ top: 0, height: 54, frame: 0, row: 146 }], cover: backdrop });
  assert.deepEqual(bandAt([at(0, { cover: header, depth: 60 }), at(30)], 1).pieces, [{ top: 0, height: 54, color: WHITE }], 'rows filmed under a pinned header are never reused');
});

test('content scrolling inside a box rather than the page leaves the status bar its colour', () => {
  const inside = 'rgb(9 9 9 / 1)';
  const tops = [at(0), at(300), at(300, { inner: 40, color: inside }), at(0, { inner: 80 })];
  assert.deepEqual(bandAt(tops, 2).pieces, [{ top: 0, height: 54, color: inside }]);
  assert.deepEqual(bandAt(tops, 3).pieces, [{ top: 0, height: 54, color: WHITE }]);
});

test('a page that scrolls can rise 8 pt above Safari\'s bar at its end, as in iOS Safari; one that fits gets no extra room', async () => {
  const { browser, context } = await launch({ viewport: { width: 402, height: 820 }, device: 'phone' });
  try {
    const page = await context.newPage();
    const body = (height: number) => `<!doctype html><meta name="viewport" content="width=device-width"><style>body { margin: 0 } div { height: ${height}px }</style><div></div>`;
    await page.route('http://long.test/', (route) => route.fulfill({ contentType: 'text/html', body: body(3000) }));
    await page.route('http://short.test/', (route) => route.fulfill({ contentType: 'text/html', body: body(400) }));
    const settled = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.goto('http://long.test/');
    await settled();
    await page.evaluate(() => scrollTo(0, 1e6));
    assert.equal(await page.evaluate(() => document.querySelector('div')!.getBoundingClientRect().bottom), 820 - PHONE.safariBar - PHONE.endGap);
    await page.goto('http://short.test/');
    await settled();
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 820);
  } finally {
    await browser.close();
  }
});

test('at the end of the page the Safari bar opens again', () => {
  const scroll = (frame: number, dy: number): Event => ({ frame, type: 'scroll', dx: 0, dy });
  const events = [scroll(10, 30), scroll(11, 40), scroll(30, 50)];
  assert.deepEqual(safariCollapses(events, look.safari.collapseAfter, [[30, true]]), [[10, true], [30, false]]);
});

test('elements pinned to the bottom of the page sit above Safari\'s bar, as in iOS Safari; full-height overlays stay put', async () => {
  const { browser, context } = await launch({ viewport: { width: 402, height: 820 }, device: 'phone' });
  try {
    const page = await context.newPage();
    await page.route('http://bar.test/', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width">
      <style>
        body { margin: 0; height: 3000px; }
        nav { position: fixed; left: 0; right: 0; bottom: 0; height: 60px; background: #eee; }
        .fab { position: fixed; right: 16px; bottom: 90px; width: 56px; height: 56px; translate: 4px 0; }
        .overlay { position: fixed; inset: 0; background: rgb(0 0 0 / 0.3); }
        .toast { position: fixed; left: 20px; bottom: 24px; height: 40px; transition: translate 0.3s, opacity 0.3s; }
      </style>
      <nav></nav><div class="fab"></div><div class="overlay"></div>` }));
    await page.goto('http://bar.test/');
    const box = (selector: string) => page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return [r.left, r.top, r.bottom];
    }, selector);
    assert.deepEqual(await box('nav'), [0, 820 - 60 - PHONE.safariBar, 820 - PHONE.safariBar], 'a bottom nav sits on top of Safari\'s bar');
    assert.deepEqual(await box('.fab'), [402 - 16 - 56 + 4, 820 - 90 - 56 - PHONE.safariBar, 820 - 90 - PHONE.safariBar], 'it moves up with its own offset kept');
    assert.deepEqual(await box('.overlay'), [0, 0, 820], 'a full-height overlay is not moved');
    const toast = await page.evaluate(async () => {
      const el = Object.assign(document.createElement('div'), { className: 'toast' });
      document.body.append(el);
      await Promise.resolve();
      return { bottom: el.getBoundingClientRect().bottom, sliding: el.getAnimations().length };
    });
    assert.deepEqual(toast, { bottom: 820 - 24 - PHONE.safariBar, sliding: 0 }, 'a toast is above the bar before it is first drawn, without sliding there');
  } finally {
    await browser.close();
  }
});
