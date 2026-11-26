import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { serve } from '../examples/demo-app/serve.mjs';
import { launch } from '../src/drivers/web/browser.ts';
import { measureCaret } from '../src/drivers/web/caret.ts';
import { typingSchedule } from '../src/drivers/web/pacing.ts';
import { loadTheme } from '../src/compose/compose.ts';
import { caretOnFrame, totalFrames } from '../src/compose/timeline.ts';
import type { EventLog } from '../src/drivers/web/events.ts';

test('typing is uneven like a person, the same every retake, and as long as cps says', () => {
  const a = typingSchedule('Hello from Take', 14);
  assert.deepEqual(a, typingSchedule('Hello from Take', 14), 'repeatable');
  assert.equal(a[0], 0);
  assert.equal(a.at(-1), Math.round((14 * 60) / 14), 'ends when even typing would');
  const gaps = a.slice(1).map((v, i) => v - a[i]);
  assert.ok(gaps.every((g) => g >= 1), 'one character per frame at most');
  assert.ok(new Set(gaps).size > 2, 'not evenly spaced');
  const space = 'Hello from Take'.indexOf(' ');
  assert.ok(gaps[space] > gaps[space - 1], 'pause before a new word');
  assert.deepEqual(typingSchedule('A', 14), [0]);
});

let app: { url: string; close: () => Promise<unknown> };
let browser: Browser;
let page: Page;
before(async () => {
  app = await serve(0);
  const l = await launch();
  browser = l.browser;
  page = await l.context.newPage();
  await page.goto(app.url);
});
after(async () => {
  await browser.close();
  await app.close();
});

test('the caret is measured where the browser draws it', async () => {
  assert.equal(await measureCaret(page), null, 'no field focused: no caret');
  await page.getByRole('button', { name: 'New project' }).click();
  const field = page.getByRole('dialog').getByLabel('Name');
  await field.click();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const box = (await field.boundingBox())!;
  const empty = (await measureCaret(page))!;
  assert.ok(empty.x > box.x && empty.x < box.x + 30, 'empty field: caret at the start, inside the padding');
  assert.ok(empty.y > box.y && empty.y + empty.height < box.y + box.height, 'vertically inside the field');
  await page.keyboard.type('Moodboard');
  const typed = (await measureCaret(page))!;
  assert.ok(typed.x > empty.x + 50, 'moves right as text is typed');
  assert.equal(typed.y, empty.y);
  await page.keyboard.press('Shift+Home');
  assert.equal(await measureCaret(page), null, 'a selection is not a caret');
});

test('the drawn caret is solid while typing, then blinks, and fades out with the loop', () => {
  const { theme } = loadTheme();
  const c = { x: 10, y: 10, height: 18, color: 'rgb(0, 0, 0)' };
  const log: EventLog = {
    version: 0, title: 't', url: 'http://x/', fps: 60, device: 'desktop', viewport: [1440, 900], scale: 1, frames: 200,
    pointer: Array.from({ length: 200 }, () => [0, 0] as [number, number]),
    address: '', cursors: [[0, 'default']], carets: [[0, null], [10, c], [12, { ...c, x: 20 }]], loop: 'crossfade-to-start',
    events: [], steps: [], marks: {},
  };
  const { solidFrames: s, blinkFrames: b } = theme.caret;
  assert.equal(caretOnFrame(log, theme, 5), null);
  assert.equal(caretOnFrame(log, theme, 11)!.x, 10);
  assert.equal(caretOnFrame(log, theme, 12 + s - 1)!.opacity, 1, 'solid after the last keystroke');
  assert.equal(caretOnFrame(log, theme, 12 + s)!.opacity, 0, 'then off');
  assert.equal(caretOnFrame(log, theme, 12 + s + b)!.opacity, 1, 'then on again');
  const last = totalFrames(log, theme) - 1;
  assert.ok((caretOnFrame(log, theme, last)?.opacity ?? 0) < 0.1, 'fades out with the loop');
});
