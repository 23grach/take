import { test, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { serve } from '../examples/demo-app/serve.mjs';
import { openTake } from '../src/drivers/web/browser.ts';
import { perform } from '../src/drivers/web/driver.ts';
import { TakeError } from '../src/drivers/web/take-error.ts';
import { realtimeClock, type Clock } from '../src/drivers/web/clock.ts';
import { loadTake } from '../src/take/load.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import { withShortFind } from './short-find.ts';
import { frames, PACING, scrollMs } from '../src/drivers/web/pacing.ts';

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
  const clock = realtimeClock();
  const log = await perform(page, r.take, clock);
  const wall = (Date.now() - clock.startedAt!) / 1000;

  assert.equal(await page.getByRole('list', { name: 'Projects' }).getByRole('listitem').count(), 4);
  assert.ok(Math.abs(log.frames / 60 - wall) < 0.2, `${log.frames} frames vs ${wall} s`);
  assert.equal(log.pointer.length, log.frames);
  assert.ok(log.pointer.every((p) => Array.isArray(p) && p.length === 2));
  const kinds = log.events.map((e) => e.type).join(' ');
  assert.equal(kinds, 'down up down up ' + 'key '.repeat(9) + 'down up');
  assert.equal(log.events.filter((e) => e.type === 'key').map((e) => ('key' in e ? e.key : '')).join(''), 'Moodboard');
  assert.deepEqual(Object.keys(log.marks), ['start', 'result']);
  assert.equal(log.marks.result, log.steps[4].start);
  assert.equal(log.steps[4].end, log.frames - 1);
  for (const s of log.steps.filter((s) => s.do === 'click')) {
    const down = log.events.find((e) => e.type === 'down' && e.frame >= s.start && e.frame <= s.end);
    assert.ok(down && 'x' in down && s.target);
    assert.ok(down.x >= s.target.x && down.x <= s.target.x + s.target.width && down.y >= s.target.y && down.y <= s.target.y + s.target.height);
  }
  assert.ok(log.steps[3].waitedFor);
});

test('a scroll lasts its own length even when a slow page makes the clock skip frames', async () => {
  const take = takeOf([{ do: 'scroll', by: [0, 300] }, { do: 'hold', ms: 100 }]);
  const page = await open(take);
  await page.evaluate(() => document.body.style.setProperty('min-height', '4000px'));
  let frame = 0;
  const skipping: Clock = { fps: 60, get frame() { return frame; }, async tick() { frame += 3; await new Promise((r) => setImmediate(r)); } };
  const log = await perform(page, take, skipping, { watch: false });
  const scrollFrames = frames(scrollMs(300)) + frames(PACING.gap);
  assert.ok(log.steps[1].start - log.steps[0].start <= scrollFrames + 6, `the scroll took ${log.steps[1].start - log.steps[0].start} frames, not ${scrollFrames}`);
  assert.equal(await page.evaluate(() => scrollY), 300);
});

test('a scroll given a length moves slowly for all of it, as one move', async () => {
  const take = takeOf([{ do: 'scroll', by: [0, 300], ms: 3000 }, { do: 'hold', ms: 100 }]);
  const page = await open(take);
  await page.evaluate(() => document.body.style.setProperty('min-height', '4000px'));
  const log = await perform(page, take, fastClock(), { watch: false });
  const scrolls = log.events.filter((e) => e.type === 'scroll');
  const span = scrolls.at(-1)!.frame - scrolls[0].frame;
  assert.ok(span > 4 * frames(scrollMs(300)), `the scroll moved for ${span} frames, its usual pace is ${frames(scrollMs(300))}`);
  assert.equal(log.steps[1].start - log.steps[0].start, frames(3000));
  assert.ok(scrolls.every((e, i) => i === 0 || e.frame === scrolls[i - 1].frame + 1), 'once moving, the page moves every frame until it arrives');
  assert.equal(await page.evaluate(() => scrollY), 300);
});

test('typing with no text field focused says so', async () => {
  const take = takeOf([{ do: 'type', text: 'ab', cps: 30 }]);
  const page = await open(take);
  const log = await perform(page, take, fastClock(), { watch: false });
  assert.match(log.steps[0].note ?? '', /no text field had focus/);
});

test('a step given a length lasts exactly that long, and typing fits into it', async () => {
  const take = takeOf([
    { ...openDialog, ms: 3000 },
    { do: 'type', target: { label: 'Name' }, text: 'Moodboard', ms: 2500 },
    { do: 'press', key: 'Escape' },
  ]);
  const page = await open(take);
  const log = await perform(page, take, fastClock(), { watch: false });
  const [click, type, press] = log.steps;
  assert.equal(type.start - click.start, 180);
  assert.equal(press.start - type.start, 150);
  const keys = log.events.filter((e) => e.type === 'key' && e.frame < press.start);
  assert.equal(keys.length, 9);
  assert.ok(keys.at(-1)!.frame - keys[0].frame > 50, `typing took ${keys.at(-1)!.frame - keys[0].frame} frames`);
  assert.ok(keys.at(-1)!.frame <= press.start - 27);
});

async function failure(steps: unknown[]): Promise<string> {
  const take = takeOf(steps);
  const page = await open(take);
  const err = await withShortFind(() => perform(page, take, fastClock())).then(() => undefined, (e) => e);
  assert.ok(err instanceof TakeError, `expected a TakeError, got ${err}`);
  return err.message;
}

test('an appearance step tells the page the computer switched mode, and logs the frame; a take that never points hides the cursor', async () => {
  const take = takeOf([{ do: 'appearance', to: 'dark' }, { do: 'hold', ms: 100 }, { do: 'appearance', to: 'light' }, { do: 'hold', ms: 100 }]);
  const page = await open(take);
  await page.evaluate(() => {
    const w = window as unknown as { seen: boolean[] };
    w.seen = [];
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => w.seen.push(e.matches));
  });
  const log = await perform(page, take, realtimeClock(), { watch: false });
  const seen = await page.evaluate(() => (window as unknown as { seen: boolean[] }).seen);
  assert.deepEqual(log.appearances?.map(([, to]) => to), ['dark', 'light']);
  assert.ok(log.appearances![0][0] < log.appearances![1][0]);
  assert.deepEqual(seen, [true, false]);
  assert.equal(log.noCursor, true);
  assert.equal((await perform(page, takeOf([{ do: 'hover', target: [10, 10] }]), fastClock(), { watch: false })).noCursor, undefined);
});

test('says when a target is not on the page', async () => {
  assert.equal(await failure([{ do: 'click', target: { text: 'Archive' } }]), 'step 1: can\'t find text "Archive" (looked for 1.5 s)');
});

test('says when a target matches more than one element', async () => {
  assert.match(await failure([{ do: 'hover', target: { role: 'heading', name: 'r' } }]), /^step 1: 4 elements match heading "r" \("Projects" on screen: \{ "css": ".heading div > h1" \}, "Brand refresh" on screen: .*, "Pricing page" on screen: .*\); make the target more specific/);
});

test('says when a target is covered or disabled', async () => {
  assert.equal(await failure([openDialog, { do: 'click', target: { text: 'Pricing page' } }]), 'step 2: text "Pricing page" is covered by a div (.backdrop.open)');
  assert.equal(await failure([openDialog, { do: 'click', target: { role: 'button', name: 'Create' } }]), 'step 2: button "Create" stayed disabled for 1.5 s');
});

test('says what a wait was waiting for', async () => {
  assert.equal(await failure([{ do: 'wait', for: { text: 'Welcome back' }, timeout: 500 }]), 'step 1: waited 0.5 s for text "Welcome back" to show');
});

test('a shortcut letter is sent lowercase, as a real keyboard does, unless Shift is held', async () => {
  const { asPressed } = await import('../src/drivers/web/run-step.ts');
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

test('page errors: other sites\' scripts are ignored, the app\'s own still stop the take', async () => {
  const { siteOf, breaksApp } = await import('../src/drivers/web/page-errors.ts');
  assert.equal(siteOf('www.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('app.example.com'), 'example.com');
  const at = (url: string) => Object.assign(new Error('x'), { stack: `Error: x\n    at f (${url}:1:2)` });
  assert.equal(breaksApp(at('https://challenges.cloudflare.com/turnstile/v0/api.js'), 'https://coolors.co/generate'), false);
  assert.equal(breaksApp(at('https://static.example.com/app.js'), 'https://www.example.com/'), true);
  assert.equal(breaksApp(new Error('no stack lines'), 'https://example.com/'), true);
  const turnstile = Object.assign(new Error('[Cloudflare Turnstile] Error: 600010.'), {
    stack: 'TurnstileError: x\n    at x (https://challenges.cloudflare.com/turnstile/v0/api.js:1:17327)\n    at c (https://coolors.co/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js:0:9404)',
  });
  assert.equal(breaksApp(turnstile, 'https://coolors.co/generate'), false);
  assert.equal(breaksApp(new Error('Minified React error #418; visit https://react.dev/errors/418?args[]=text for the full message'), 'https://example.com/'), false);
  assert.equal(breaksApp(new Error("Hydration failed because the server rendered text didn't match the client."), 'https://example.com/'), false);
  const react310 = Object.assign(new Error('Minified React error #310; visit https://react.dev/errors/310'), {
    stack: 'Error: Minified React error #310; visit https://react.dev/errors/310\n    at f (https://example.com/_next/static/chunks/app.js:1:2)',
  });
  assert.equal(breaksApp(react310, 'https://example.com/'), true);

  const http = await import('node:http');
  const { validateTake } = await import('../src/take/format.ts');
  const widget = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/javascript' }).end('setTimeout(() => { throw new Error("widget broke"); }, 10);'));
  await new Promise<void>((r) => widget.listen(0, '127.0.0.1', r));
  const wport = (widget.address() as { port: number }).port;
  const app = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><button onclick="setTimeout(() => { throw new Error('app broke'); })">Break</button><script src="http://localhost:${wport}/w.js"></script>`),
  );
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}/`;
  const make = (steps: unknown[]) => {
    const r = validateTake({ version: 0, title: 'E', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, steps });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    return r.take;
  };
  try {
    const quiet = make([{ do: 'hold', ms: 300 }]);
    let opened = await openTake(quiet);
    try {
      await perform(opened.page, quiet, realtimeClock());
    } finally {
      await opened.browser.close();
    }
    const breaking = make([{ do: 'click', target: { role: 'button', name: 'Break' } }, { do: 'hold', ms: 300 }]);
    opened = await openTake(breaking);
    try {
      await assert.rejects(perform(opened.page, breaking, realtimeClock()), /app broke/);
    } finally {
      await opened.browser.close();
    }
  } finally {
    app.close();
    widget.close();
  }
});

test('a double-click selects a word; a scroll with nothing to move says so', async () => {
  const http = await import('node:http');
  const { validateTake } = await import('../src/take/format.ts');
  const html = `<!doctype html><p style="font:20px sans-serif;margin:100px"><span>Get</span> <span id="w">started</span></p><h2>Examples</h2>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const r = validateTake({ version: 0, title: 'D', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, steps: [
    { do: 'click', target: { css: '#w' }, clicks: 2 },
    { do: 'scroll', target: { role: 'heading', name: 'Examples' } },
    { do: 'scroll', by: [0, 300] },
  ] });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.ok(!validateTake({ version: 0, title: 'D', target: { kind: 'web', url }, steps: [{ do: 'click', target: { css: 'p' }, clicks: 21 }] }).ok);
  const { browser, page } = await openTake(r.take);
  try {
    const log = await perform(page, r.take, realtimeClock());
    assert.equal(await page.evaluate(() => String(getSelection()).trim()), 'started');
    assert.match(log.steps[1].note ?? '', /already on screen/);
    assert.match(log.steps[2].note ?? '', /didn't scroll/);
  } finally {
    await browser.close();
    server.close();
  }
});

test('a click can aim at a point on the page', async () => {
  const http = await import('node:http');
  const { validateTake } = await import('../src/take/format.ts');
  const html = `<!doctype html><div id="lock" style="position:absolute;left:300px;top:200px;width:40px;height:40px;background:#333" onclick="this.dataset.locked='yes'"></div>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const r = validateTake({ version: 0, title: 'P', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, steps: [{ do: 'click', target: [320, 220] }] });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.ok(!validateTake({ version: 0, title: 'P', target: { kind: 'web', url, viewport: [800, 600] }, steps: [{ do: 'click', target: [900, 220] }] }).ok, 'a point off the page is caught');
  const { browser, page } = await openTake(r.take);
  try {
    const log = await perform(page, r.take, realtimeClock());
    assert.equal(await page.getAttribute('#lock', 'data-locked'), 'yes');
    assert.equal(log.events.filter((e) => e.type === 'down').length, 1);
  } finally {
    await browser.close();
    server.close();
  }
});
