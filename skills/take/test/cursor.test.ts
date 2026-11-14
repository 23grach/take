import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { serve } from '../examples/demo-app/serve.mjs';
import { launch } from '../src/drivers/web/browser.ts';
import { cursorReader, parseCursor } from '../src/drivers/web/cursor.ts';
import { cursorOpacity, loadTheme, overlayAt, shapeAt, stageCursors, totalFrames } from '../src/compose/compose.ts';
import { cursorArt } from '../src/compose/cursor-art.ts';
import type { EventLog } from '../src/drivers/web/events.ts';

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

const centre = async (sel: ReturnType<Page['getByRole']>): Promise<[number, number]> => {
  const b = (await sel.boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2];
};

test('the cursor shape follows the page: hand on buttons, text in fields, arrow elsewhere', async () => {
  const cursorAt = (_: Page, p: [number, number]) => cursorReader(page)(p);
  assert.equal(await cursorAt(page, await centre(page.getByRole('button', { name: 'New project' }))), 'pointer');
  assert.equal(await cursorAt(page, await centre(page.getByRole('heading', { name: 'Projects', exact: true }))), 'default', 'plain text keeps the arrow');
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.waitFor();
  assert.equal(await cursorAt(page, await centre(dialog.getByLabel('Name'))), 'text');
  assert.equal(await cursorAt(page, await centre(dialog.getByRole('button', { name: 'Create' }))), 'default', 'a disabled button is not clickable');
  await page.keyboard.press('Escape');
});

test('every cursor the site asks for is kept: crosshair, grab, resize, none, and its own images', async () => {
  const p = await browser.newPage();
  const dot = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>');
  await p.setContent(`<style>div { position: fixed; width: 100px; height: 100px; top: 0; }</style>
    <div style="left: 0; cursor: crosshair"></div><div style="left: 100px; cursor: grabbing"></div>
    <div style="left: 200px; cursor: e-resize"></div><div style="left: 300px; cursor: none"></div>
    <div style="left: 400px; cursor: url('${dot}') 10 10, pointer"></div><div style="left: 500px; cursor: url('/missing.png'), all-scroll"></div>`);
  const at = cursorReader(p);
  assert.equal(await at([50, 50]), 'crosshair');
  assert.equal(await at([150, 50]), 'grabbing');
  assert.equal(await at([250, 50]), 'e-resize');
  assert.equal(await at([350, 50]), 'none');
  assert.deepEqual(await at([450, 50]), { image: dot, hotspot: [10, 10], fallback: 'pointer' });
  assert.equal(await at([550, 50]), 'move', 'an image that won\'t load falls back to the keyword after it');
  await p.close();
});

test('cursor values are read like the browser reads them', () => {
  assert.deepEqual(parseCursor('url("a b.svg") 4 5, url(c.png), pointer'), { images: [{ url: 'a b.svg', hotspot: [4, 5] }, { url: 'c.png' }], keyword: 'pointer' });
  assert.deepEqual(parseCursor('auto'), { images: [], keyword: 'auto' });
});

const { theme } = loadTheme();
function log(): EventLog {
  // Still at frames 0–19 while typing at 5, 8 and 11; moves from frame 20.
  const pointer = Array.from({ length: 40 }, (_, f) => [f < 20 ? 100 : 100 + (f - 19) * 5, 200] as [number, number]);
  return {
    version: 0, title: 't', url: 'http://127.0.0.1/', fps: 60, viewport: [1440, 900], scale: 1, frames: 40, pointer,
    address: '', cursors: [[0, 'text'], [25, 'pointer']], carets: [[0, null]], loop: 'crossfade-to-start',
    events: [5, 8, 11].map((frame) => ({ frame, type: 'key' as const, key: 'a' })),
    steps: [], marks: {},
  };
}

test('the drawn cursor takes the recorded shape', () => {
  const l = log();
  assert.equal(shapeAt(l, 0), 'text');
  assert.equal(shapeAt(l, 24), 'text');
  assert.equal(shapeAt(l, 25), 'pointer');
  assert.equal(overlayAt(l, theme, 30).shape, 'pointer');
});

test('each cursor gets a drawing: its own, the arrow if there is none, nothing for none', () => {
  const { theme, dir } = loadTheme();
  const art = cursorArt({ ...theme, cursor: { ...theme.cursor, art: undefined } }, dir);
  const site = { image: 'data:image/png;base64,AA==', fallback: 'default' as const };
  const { cursors, keyOf } = stageCursors({ ...log(), cursors: [[0, site], [5, 'crosshair']] }, art);
  assert.equal(keyOf('pointer'), 'pointer');
  assert.equal(keyOf('crosshair'), 'default', 'the theme has no crosshair: the arrow');
  assert.equal(keyOf('none'), null);
  assert.equal(cursors[keyOf(site)!].src, site.image);
});

test('on a Mac, every standard cursor is drawn with macOS\'s own', { skip: process.platform !== 'darwin' }, () => {
  const art = cursorArt(theme, '');
  for (const c of ['default', 'pointer', 'text', 'crosshair', 'grab', 'grabbing', 'not-allowed', 'ew-resize', 'zoom-in'] as const)
    assert.match(art[c]?.src ?? '', /^data:image\/png;base64,/, c);
});

test('the cursor fades out when typing starts and back in when it moves', () => {
  const l = log();
  const o = cursorOpacity(l, theme);
  const fade = theme.cursor.hideFade;
  assert.equal(o.length, totalFrames(l, theme));
  assert.equal(o[4], 1);
  assert.ok(o[5] < 1, 'starts fading on the first key');
  assert.equal(o[5 + fade - 1], 0, 'gone after hideFade frames');
  assert.equal(o[19], 0, 'stays hidden while the pointer is still');
  assert.ok(o[20] > 0, 'comes back as soon as it moves');
  assert.equal(o[20 + fade - 1], 1);
  assert.equal(overlayAt(l, theme, 12).opacity, 0);
});
