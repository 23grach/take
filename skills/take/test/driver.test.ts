import { test, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { serve } from '../examples/demo-app/serve.mjs';
import { openTake } from '../src/drivers/web/browser.ts';
import { perform, TakeError } from '../src/drivers/web/driver.ts';
import { realtimeClock, type Clock } from '../src/drivers/web/clock.ts';
import { loadTake } from '../src/take/load.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import { withShortFind } from './short-find.ts';

let app: { url: string; close: () => Promise<unknown> };
let browser: Browser | undefined;
before(async () => (app = await serve(0)));
after(async () => app.close());

async function open(take: Take): Promise<Page> {
  await browser?.close();
  const opened = await openTake({ ...take, target: { ...take.target, url: app.url, scale: 1 } });
  browser = opened.browser;
  return opened.page;
}
after(async () => browser?.close());

/** Doesn't wait: for tests that only check what goes wrong. */
function fastClock(): Clock {
  let frame = 0;
  return { fps: 60, get frame() { return frame; }, async tick() { frame++; await new Promise((r) => setImmediate(r)); } };
}

function takeOf(steps: unknown[]): Take {
  const r = validateTake({ version: 0, title: 't', target: { kind: 'web', url: 'http://x/' }, steps });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.take;
}

const openDialog = { do: 'click', target: { role: 'button', name: 'New project' }, waitFor: { visible: { role: 'dialog' } } };

test('performs the example take in real time and logs it', async () => {
  const r = loadTake(fileURLToPath(new URL('./fixtures/create-project.take.json', import.meta.url)));
  assert.ok(r.ok);
  const page = await open(r.take);
  const t0 = performance.now();
  const log = await perform(page, r.take, realtimeClock());
  const wall = (performance.now() - t0) / 1000;

  // The app ended up where the take says.
  assert.equal(await page.getByRole('list', { name: 'Projects' }).getByRole('listitem').count(), 4);
  // Video time matches the wall clock, and every frame has a pointer position.
  assert.ok(Math.abs(log.frames / 60 - wall) < 0.2, `${log.frames} frames vs ${wall} s`);
  assert.equal(log.pointer.length, log.frames);
  assert.ok(log.pointer.every((p) => Array.isArray(p) && p.length === 2));
  // Two clicks, each a press then a release; then the typed name.
  const kinds = log.events.map((e) => e.type).join(' ');
  assert.equal(kinds, 'down up down up ' + 'key '.repeat(9) + 'down up');
  assert.equal(log.events.filter((e) => e.type === 'key').map((e) => ('key' in e ? e.key : '')).join(''), 'Moodboard');
  // Marks and steps line up.
  assert.deepEqual(Object.keys(log.marks), ['start', 'result']);
  assert.equal(log.marks.result, log.steps[4].start);
  assert.equal(log.steps[4].end, log.frames - 1);
  // Clicks land inside the element they were aimed at.
  for (const s of log.steps.filter((s) => s.do === 'click')) {
    const down = log.events.find((e) => e.type === 'down' && e.frame >= s.start && e.frame <= s.end);
    assert.ok(down && 'x' in down && s.target);
    assert.ok(down.x >= s.target.x && down.x <= s.target.x + s.target.width && down.y >= s.target.y && down.y <= s.target.y + s.target.height);
  }
  // The new card was waited for, and its place logged for the camera.
  assert.ok(log.steps[3].waitedFor);
});

async function failure(steps: unknown[]): Promise<string> {
  const take = takeOf(steps);
  const page = await open(take);
  const err = await withShortFind(() => perform(page, take, fastClock())).then(() => undefined, (e) => e);
  assert.ok(err instanceof TakeError, `expected a TakeError, got ${err}`);
  return err.message;
}

test('says when a target is not on the page', async () => {
  assert.equal(await failure([{ do: 'click', target: { text: 'Archive' } }]), 'step 1: can\'t find text "Archive" (looked for 1.5 s)');
});

test('says when a target matches more than one element', async () => {
  assert.match(await failure([{ do: 'hover', target: { role: 'heading', name: 'r' } }]), /^step 1: 4 elements match heading "r" \("Projects", "Brand refresh", "Onboarding flow", …\); make the target more specific/);
});

test('says when a target is covered or disabled', async () => {
  assert.equal(await failure([openDialog, { do: 'click', target: { text: 'Pricing page' } }]), 'step 2: text "Pricing page" is covered by a div (.backdrop.open)');
  assert.equal(await failure([openDialog, { do: 'click', target: { role: 'button', name: 'Create' } }]), 'step 2: button "Create" stayed disabled for 1.5 s');
});

test('says what a wait was waiting for', async () => {
  assert.equal(await failure([{ do: 'wait', for: { text: 'Welcome back' }, timeout: 500 }]), 'step 1: waited 0.5 s for text "Welcome back" to show');
});

test('a shortcut letter is sent lowercase, as a real keyboard does, unless Shift is held', async () => {
  const { asPressed } = await import('../src/drivers/web/driver.ts');
  assert.equal(asPressed('Meta+K'), 'Meta+k');
  assert.equal(asPressed('Control+Alt+P'), 'Control+Alt+p');
  assert.equal(asPressed('Shift+Meta+P'), 'Shift+Meta+P');
  assert.equal(asPressed('K'), 'K');
  assert.equal(asPressed('Enter'), 'Enter');
});

test('Meta+K reaches a site that listens for "k", and a radio hidden under its label is clicked through the label', async () => {
  const http = await import('node:http');
  const { validateTake } = await import('../src/take/format.ts');
  const html = `<!doctype html><style>.opt{position:relative;display:inline-block;margin:40px}.opt input{position:absolute;inset:0;opacity:0}
    .opt label{position:relative;display:block;padding:20px 40px;border:1px solid #888}</style>
    <div class="opt"><input type="radio" name="c" id="blue" aria-label="Blue"><label for="blue">Blue</label></div>
    <p id="out">waiting</p>
    <script>addEventListener('keydown', (e) => { if (e.metaKey && e.key === 'k') out.textContent = 'search open'; });</script>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const r = validateTake({ version: 0, title: 'Keys', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, steps: [
    { do: 'press', key: 'Meta+K', waitFor: { text: 'search open' } },
    { do: 'click', target: { role: 'radio', name: 'Blue' } },
  ] });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  const { browser, page } = await openTake(r.take);
  try {
    await perform(page, r.take, realtimeClock());
    assert.equal(await page.isChecked('#blue'), true);
  } finally {
    await browser.close();
    server.close();
  }
});
