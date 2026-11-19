import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { serve } from '../examples/demo-app/serve.mjs';
import { record } from '../src/drivers/web/record.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import { mediaTool } from '../src/media-tools.ts';

let app: { url: string; close: () => Promise<unknown> };
let tmp: string;
before(async () => {
  app = await serve(0);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-record-'));
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function take(): Take {
  const r = validateTake({
    version: 0,
    title: 'Quick create',
    target: { kind: 'web', url: app.url, viewport: [800, 600], scale: 1 },
    steps: [
      { do: 'click', target: { role: 'button', name: 'New project' } },
      { do: 'type', target: { label: 'Name' }, text: 'A', cps: 30 },
      { do: 'click', target: { role: 'button', name: 'Create', exact: true }, waitFor: { visible: { role: 'heading', name: 'A', exact: true } } },
    ],
  });
  assert.ok(r.ok);
  return r.take;
}

test('studio mode captures every frame, on page time', async () => {
  const out = path.join(tmp, 'studio');
  const { capture, events } = await record(take(), { mode: 'studio', out });
  assert.equal(capture.frames.length, events.frames);
  assert.equal(capture.images, events.frames);
  assert.deepEqual(capture.size, [800, 600]);
  for (const f of capture.frames) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'capture.json'), 'utf8')), capture);
  const release = events.events.filter((e) => e.type === 'up').at(-1)!.frame;
  const shown = events.steps[2].end + 1;
  assert.ok(Math.abs(shown - release - 42) <= 1, `card appeared ${shown - release} frames after the click`);
});

test('live mode maps real time onto 60 fps frames', async () => {
  const out = path.join(tmp, 'live');
  const { capture, events } = await record(take(), { mode: 'live', out });
  assert.equal(capture.frames.length, events.frames);
  assert.ok(capture.images > 10 && capture.images <= capture.frames.length);
  for (const f of new Set(capture.frames)) assert.ok(fs.existsSync(path.join(out, f)), f);
});

test('"ready" lets the page load before filming, unfilmed', async () => {
  const r = validateTake({
    version: 0, title: 'Ready', loop: 'none',
    target: { kind: 'web', url: app.url, viewport: [800, 600], scale: 1 },
    ready: { text: '3 projects' },
    steps: [{ do: 'hold', ms: 100 }],
  });
  assert.ok(r.ok);
  assert.deepEqual(r.take.ready, [{ text: '3 projects' }]);
  const { capture } = await record(r.take, { mode: 'studio', out: path.join(tmp, 'ready') });
  assert.equal(capture.frames.length, 6);
  const bad = validateTake({ version: 0, title: 't', target: { kind: 'web', url: app.url }, ready: [], steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(!bad.ok && bad.errors.some((e) => /^ready: give a condition/.test(e)));
  const typo = validateTake({ version: 0, title: 't', target: { kind: 'web', url: app.url }, ready: [{ txt: 'x' }], steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(!typo.ok && typo.errors.some((e) => e.startsWith('ready[0]')));
});

test('the browser\'s own caret is never filmed, and the drawn one keeps the page\'s caret colour', async () => {
  const html = '<!doctype html><body style="margin:40px;background:#fff"><input aria-label="Name" style="font:40px sans-serif;caret-color:rgb(255,0,0);border:1px solid #000">';
  const server = http.createServer((_, res) => res.end(html));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = validateTake({
      version: 0, title: 'Caret', loop: 'none',
      target: { kind: 'web', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, viewport: [480, 320], scale: 1 },
      steps: [{ do: 'type', target: { label: 'Name' }, text: 'Ab', cps: 10 }, { do: 'hold', ms: 800 }],
    });
    assert.ok(r.ok);
    const out = path.join(tmp, 'caret');
    const { capture, events } = await record(r.take, { mode: 'studio', out });
    const carets = events.carets.filter(([, c]) => c);
    assert.ok(carets.length > 0 && carets.every(([, c]) => c!.color === 'rgb(255, 0, 0)'), JSON.stringify(events.carets));
    const from = carets[0][0];
    const rgb = execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-start_number', String(from), '-i', path.join(out, 'frames/f%05d.jpg'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 2 ** 30 });
    const [w, h] = capture.size;
    assert.equal(rgb.length, (capture.frames.length - from) * w * h * 3);
    for (let i = 0; i < rgb.length; i += 3)
      assert.ok(!(rgb[i] > 180 && rgb[i + 1] < 90 && rgb[i + 2] < 90), `frame ${from + Math.floor(i / (w * h * 3))} shows the browser's caret`);
  } finally {
    server.close();
  }
});

test('a failed re-record keeps the earlier capture whole, and the capture names its theme', async () => {
  const { withShortFind } = await import('./short-find.ts');
  const out = path.join(tmp, 'rerecord');
  await record(take(), { mode: 'studio', out });
  const before = fs.readFileSync(path.join(out, 'capture.json'), 'utf8');
  assert.equal(JSON.parse(before).theme, 'default');
  const frames = fs.readdirSync(path.join(out, 'frames')).length;
  const broken = validateTake({ version: 0, title: 'Broken', target: { kind: 'web', url: app.url, viewport: [800, 600], scale: 1 }, steps: [{ do: 'click', target: { text: 'Nowhere' } }] });
  assert.ok(broken.ok);
  await assert.rejects(withShortFind(() => record(broken.take, { mode: 'studio', out })), /step 1/);
  assert.equal(fs.readFileSync(path.join(out, 'capture.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(out, 'frames')).length, frames);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.endsWith('.recording')), [], 'no staging folder left behind');
});

test('a studio recording starts the page clock at the real time', async () => {
  const { freezePage } = await import('../src/drivers/web/capture.ts');
  const { openTake } = await import('../src/drivers/web/browser.ts');
  const before = Date.now();
  const { browser, page } = await openTake(take(), { prepare: (p) => freezePage(p) });
  try {
    const shown = await page.evaluate(() => Date.now());
    assert.ok(shown >= before - 1000 && shown <= Date.now() + 2000, `page time ${new Date(shown).toISOString()}`);
  } finally {
    await browser.close();
  }
});

test('the frozen clock runs a chain of page timers without the 4 ms clamp', async () => {
  const { freezePage, quickTimerYield } = await import('../src/drivers/web/capture.ts');
  const { openTake } = await import('../src/drivers/web/browser.ts');
  const { browser, page } = await openTake(take(), { prepare: (p) => freezePage(p) });
  try {
    await page.evaluate(() => {
      const w = window as unknown as { n: number };
      w.n = 0;
      const next = () => ++w.n < 200 && setTimeout(next, 1);
      setTimeout(next, 1);
    });
    const t = performance.now();
    await page.clock.runFor(250);
    const ms = performance.now() - t;
    assert.equal(await page.evaluate(() => (window as unknown as { n: number }).n), 200);
    assert.ok(ms < 400, `200 chained timers took ${Math.round(ms)} ms (clamped they take 800+)`);
    assert.equal(await page.evaluate(quickTimerYield), true);
  } finally {
    await browser.close();
  }
});

test('a video in the page plays at its true speed in studio mode, and the log says where it was', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'video-'));
  execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=4', '-c:v', 'libvpx', '-b:v', '200k', path.join(dir, 'v.webm')]);
  const page = '<!doctype html><body style="margin:0"><video src="v.webm" autoplay muted loop style="width:320px;height:240px"></video>'
    + '<script>window.heard = []; for (const t of ["seeking", "seeked", "waiting", "ratechange"]) document.querySelector("video").addEventListener(t, () => heard.push(t));</script>';
  const server = http.createServer((req, res) => {
    if (req.url === '/v.webm') {
      const data = fs.readFileSync(path.join(dir, 'v.webm'));
      res.writeHead(200, { 'content-type': 'video/webm', 'content-length': data.length, 'accept-ranges': 'bytes' }).end(data);
    } else res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const r = validateTake({ version: 0, title: 'Video', target: { kind: 'web', url, viewport: [480, 360], scale: 1 }, loop: 'none', steps: [{ do: 'hold', ms: 1000 }] });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const { freezePage } = await import('../src/drivers/web/capture.ts');
    const { openTake } = await import('../src/drivers/web/browser.ts');
    const { stepMedia } = await import('../src/drivers/web/media.ts');
    const opened = await openTake(r.take, { prepare: (p) => freezePage(p) });
    try {
      const p = opened.page;
      for (let i = 0; i < 100 && !(await p.evaluate(() => !document.querySelector('video')!.paused)); i++) await new Promise((res) => setTimeout(res, 50));
      const start = (await stepMedia(p, 0), await p.evaluate(() => document.querySelector('video')!.currentTime));
      let boxes;
      for (let f = 0; f < 60; f++) ({ boxes } = await stepMedia(p, Math.round((f + 1) * (1000 / 60)) - Math.round(f * (1000 / 60))));
      const now = await p.evaluate(() => document.querySelector('video')!.currentTime);
      assert.ok(Math.abs(now - start - 1) < 0.07, `60 frames moved the video on ${(now - start).toFixed(3)} s, not 1 s`);
      assert.deepEqual(boxes, [{ x: 0, y: 0, width: 320, height: 240 }]);
      assert.deepEqual(await p.evaluate(() => (window as unknown as { heard: string[] }).heard), []);
    } finally {
      await opened.browser.close();
    }
    const { events } = await record(r.take, { mode: 'studio', out: path.join(tmp, 'video-capture') });
    assert.deepEqual(events.videos?.find(([, boxes]) => boxes.length)?.[1], [{ x: 0, y: 0, width: 320, height: 240 }]);
  } finally {
    server.close();
  }
});

test('a scroll-driven animation records (it follows the scroll, not page time)', async () => {
  const page = `<!doctype html><style>
    @keyframes grow { from { width: 0 } to { width: 100% } }
    .bar { position: fixed; top: 0; left: 0; height: 8px; background: #36f; animation: grow linear; animation-timeline: scroll(); }
    main { height: 3000px }
  </style><div class="bar"></div><main><h1>Long page</h1></main>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({ version: 0, title: 'Scroll', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none', steps: [{ do: 'scroll', by: [0, 600] }] });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const { capture } = await record(r.take, { mode: 'studio', out: path.join(tmp, 'scroll-driven') });
    assert.ok(capture.frames.length > 10);
  } finally {
    server.close();
  }
});

test('studio mode: idle work gets done, and an animation timed by the page clock starts at once', async () => {
  const page = `<!doctype html><div id="box" style="width:50px;height:50px;background:#36f"></div><script>
    let left = 20;
    const work = (d) => { while (left > 0 && d.timeRemaining() > 0) left--; if (left > 0) requestIdleCallback(work); else document.title = 'idle done'; };
    requestIdleCallback(work);
    window.fade = () => { const a = box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' }); a.startTime = document.timeline.currentTime + 5000; };
  </script>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const r = validateTake({ version: 0, title: 'Idle', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  const { freezePage, studio } = await import('../src/drivers/web/capture.ts');
  const { openTake } = await import('../src/drivers/web/browser.ts');
  let cdp;
  const opened = await openTake(r.take, { prepare: async (p) => (cdp = await freezePage(p)) });
  try {
    const rec = await studio(opened.page, path.join(tmp, 'idle'), cdp!, [800, 600], 1);
    await opened.page.evaluate(() => (window as unknown as { fade: () => void }).fade());
    for (let i = 0; i < 30; i++) await rec.clock.tick();
    assert.equal(await opened.page.title(), 'idle done');
    assert.equal(await opened.page.evaluate(() => getComputedStyle(document.getElementById('box')!).opacity), '1');
    await rec.finish();
  } finally {
    await opened.browser.close();
    server.close();
  }
});

test('a picture that never finishes downloading holds page time once, not on every frame', async () => {
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/never.png') return void held.push(res.writeHead(200, { 'content-type': 'image/png' }));
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>Page</h1><script>addEventListener("load", () => document.body.insertAdjacentHTML("beforeend", \'<img src="/never.png" width="80" height="80">\'))</script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({ version: 0, title: 'Never', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none', steps: [{ do: 'hold', ms: 1000 }] });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const t = performance.now();
    const { capture } = await record(r.take, { mode: 'studio', out: path.join(tmp, 'never') });
    const s = (performance.now() - t) / 1000;
    assert.equal(capture.frames.length, 60);
    assert.ok(s < 30, `60 frames took ${s.toFixed(0)} s (waiting 3 s a frame would take 180 s)`);
  } finally {
    for (const res of held) res.destroy();
    server.close();
  }
});

test('setup steps close a banner before filming, and are not filmed', async () => {
  const page = `<!doctype html><button style="margin:200px">Go</button>
    <div id="banner" style="position:fixed;inset:0;background:#fffe;display:grid;place-items:center"><button onclick="banner.remove()">Reject all</button></div>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({
      version: 0, title: 'Setup', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none',
      setup: [{ do: 'click', target: { role: 'button', name: 'Reject all' } }],
      steps: [{ do: 'click', target: { role: 'button', name: 'Go' } }],
    });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const { events } = await record(r.take, { mode: 'studio', out: path.join(tmp, 'setup') });
    assert.equal(events.steps.length, 1);
    assert.equal(events.events.filter((e) => e.type === 'down').length, 1, 'only the filmed click is in the log');
    const bad = validateTake({ version: 0, title: 'S', target: { kind: 'web', url }, setup: [], steps: [{ do: 'hold', ms: 100 }] });
    assert.ok(!bad.ok && bad.errors.some((e) => e.startsWith('setup')));
  } finally {
    server.close();
  }
});

function boxLeft(out: string, capture: { size: [number, number]; frames: string[] }): number {
  const [w, h] = capture.size;
  const rgb = execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', path.join(out, capture.frames.at(-1)!), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 2 ** 30 });
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 3;
      if (rgb[i] < 90 && rgb[i + 1] > 70 && rgb[i + 1] < 140 && rgb[i + 2] > 200) return x;
    }
  return -1;
}

test('a view transition records: the page replaced document.timeline, and the transition still finishes', async () => {
  const page = `<!doctype html><style>::view-transition-group(*) { animation-duration: .4s }</style>
    <button style="margin:200px">Go</button><div id="box" style="width:60px;height:60px;background:#36f;view-transition-name:box"></div>
    <div id="banner" style="position:fixed;inset:0;background:#fffe;display:grid;place-items:center"><button onclick="banner.remove()">Reject all</button></div>
    <script>
      Object.defineProperty(document, 'timeline', { value: { currentTime: undefined } });
      setTimeout(() => document.startViewTransition(() => { box.style.marginLeft = '300px'; }), 100);
    </script>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({
      version: 0, title: 'Transition', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none',
      setup: [{ do: 'click', target: { role: 'button', name: 'Reject all' } }],
      steps: [{ do: 'click', target: { role: 'button', name: 'Go' } }],
    });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const out = path.join(tmp, 'transition');
    const { capture } = await record(r.take, { mode: 'studio', out });
    assert.ok(capture.frames.length > 10);
    assert.ok(Math.abs(boxLeft(out, capture) - 308) <= 2, `the box ends at ${boxLeft(out, capture)} px, not 308`);
  } finally {
    server.close();
  }
});

test('a view transition mid-take: recorded again at 60 Hz, or handed back once frames were passed on', async () => {
  const page = `<!doctype html><button onclick="document.startViewTransition(() => box.style.marginLeft = '300px')">Move</button>
    <div id="box" style="width:60px;height:60px;background:#36f;view-transition-name:box"></div>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({ version: 0, title: 'Move', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none', steps: [{ do: 'click', target: { role: 'button', name: 'Move' } }, { do: 'hold', ms: 500 }] });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const out = path.join(tmp, 'mid-take');
    const { capture, events } = await record(r.take, { mode: 'studio', out });
    assert.equal(capture.frames.length, events.frames);
    assert.ok(Math.abs(boxLeft(out, capture) - 308) <= 2, `the box ends at ${boxLeft(out, capture)} px, not 308`);
    const { NeedsFrameLimit } = await import('../src/drivers/web/capture.ts');
    await assert.rejects(record(r.take, { mode: 'studio', out: path.join(tmp, 'mid-take-2'), onFrame: () => {} }), NeedsFrameLimit);
  } finally {
    server.close();
  }
});
