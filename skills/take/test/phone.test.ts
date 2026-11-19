import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { serve } from '../examples/demo-app/serve.mjs';
import { openTake } from '../src/drivers/web/browser.ts';
import { record } from '../src/drivers/web/record.ts';
import { compose, loadTheme, themeProblem } from '../src/compose/compose.ts';
import { fingerAt, phoneLayout } from '../src/compose/phone.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import type { Event, EventLog } from '../src/drivers/web/events.ts';

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

test('a take is for a desktop unless it says phone; a phone page is 402×812 and has no hover', () => {
  const desktop = draft({});
  assert.ok(desktop.ok && desktop.take.target.device === 'desktop');
  const phone = draft({ device: 'phone' });
  assert.ok(phone.ok);
  assert.deepEqual(phone.take.target.viewport, [402, 812]);
  const typo = draft({ device: 'phon' });
  assert.ok(!typo.ok && typo.errors.includes('target.device: must be "desktop" or "phone", got "phon" (did you mean "phone"?)'), JSON.stringify(typo));
  const sized = draft({ device: 'phone', viewport: [390, 844] });
  assert.ok(!sized.ok && sized.errors.some((e) => e.startsWith('target.viewport: a phone\'s page is always 402×812')));
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
  const box = phoneLayout(theme, look, [402, 812]);
  const [W, H] = theme.stage.size;
  assert.ok(Math.abs(box.left * 2 + box.width - W) <= 1 && Math.abs(box.top * 2 + box.height - H) <= 1);
  assert.ok(Math.abs(box.top - theme.stage.padding) <= 1);
  assert.ok(Math.abs(box.statusBar - 62) < 0.5, `status bar ${box.statusBar} pt`);
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
    assert.deepEqual({ ...seen, agent: /iPhone.*Version\/\S+ Mobile\/\S+ Safari/.test(seen.agent) }, { width: 402, height: 812, agent: true, hints: false, touch: true, nav: 'none' });
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
  assert.deepEqual(events.viewport, [402, 812]);
  assert.deepEqual(capture.size, [402, 812]);
  assert.deepEqual(events.cursors, [[0, 'default']]);
  const touches = events.events.filter((e) => e.type === 'down' || e.type === 'up');
  assert.deepEqual(touches.map((e) => e.type), ['down', 'up', 'down', 'up', 'down', 'up', 'down', 'up']);
  for (const [i, sign] of [[0, 1], [2, -1]] as const) {
    const [down, up] = [touches[i], touches[i + 1]];
    assert.ok(down.type === 'down' && up.type === 'up');
    const moved = events.events.filter((e) => e.type === 'scroll' && e.frame >= down.frame && e.frame <= up.frame).reduce((sum, e) => sum + (e.type === 'scroll' ? e.dy : 0), 0);
    assert.ok(sign * (down.y - up.y) > 60 && Math.abs(down.y - up.y - moved) <= 1.5, `finger moved ${down.y - up.y}, content ${moved}`);
    assert.ok(down.y - (down.y - up.y) / 2 > 812 * 0.4 && down.y - (down.y - up.y) / 2 < 812 * 0.6);
    const glide = events.events.filter((e) => e.type === 'scroll' && e.frame > up.frame && e.frame < touches[i + 2].frame);
    assert.ok(glide.length > 5, 'the content glides on after the finger lifts');
  }
  const typed = events.events.filter((e) => e.type === 'key').map((e) => (e.type === 'key' ? e.key : ''));
  assert.deepEqual(typed, ['A', 'b']);
  const video = path.join(tmp, 'phone.mp4');
  const c = await compose({ capture: out, out: video, range: [0, 5] });
  assert.deepEqual(c.size, [2560, 1440]);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  assert.match(probe, /^2560,1440/);
});
