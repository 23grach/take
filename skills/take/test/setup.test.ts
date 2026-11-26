import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { record } from '../src/drivers/web/record.ts';
import { validateTake } from '../src/take/format.ts';
import { mediaTool } from '../src/media-tools.ts';

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-setup-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
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

test('"ready" is checked after setup, so a consent page closed in setup does not hold it up', async () => {
  const page = `<!doctype html><div id="consent"><button onclick="consent.remove(); document.body.insertAdjacentHTML('beforeend', '<button>Layers</button>')">Accept all</button></div>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({
      version: 0, title: 'Consent', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none',
      ready: { visible: { role: 'button', name: 'Layers' } },
      setup: [{ do: 'click', target: { role: 'button', name: 'Accept all' } }],
      steps: [{ do: 'click', target: { role: 'button', name: 'Layers' } }],
    });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const t0 = performance.now();
    await record(r.take, { mode: 'studio', out: path.join(tmp, 'consent') });
    assert.ok(performance.now() - t0 < 20_000);
  } finally {
    server.close();
  }
});

test('setup runs like a real browser: a late banner slides in, is clicked once still, and animates out', async () => {
  const page = `<!doctype html><style>
      @keyframes up { from { transform: translateY(50px) } } @keyframes down { to { transform: translateY(160px) } }
      #banner { position: fixed; right: 20px; bottom: 20px; padding: 20px; background: #eee; animation: up 2s linear .3s both }
      #banner.out { animation: down .4s ease-in both }
    </style><button style="margin:200px">Go</button>
    <script>fetch('/banner').then((r) => r.text()).then((html) => {
      document.body.insertAdjacentHTML('beforeend', html);
      reject.onclick = () => { banner.classList.add('out'); banner.onanimationend = () => banner.remove(); };
    })</script>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/banner') return void setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="banner"><button id="reject">Reject all</button></div>'), 1500);
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({
      version: 0, title: 'Late banner', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none',
      setup: [{ do: 'click', target: { role: 'button', name: 'Reject all' } }, { do: 'wait', for: { hidden: { role: 'button', name: 'Reject all' } } }],
      steps: [{ do: 'click', target: { role: 'button', name: 'Go' } }],
    });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const { events } = await record(r.take, { mode: 'studio', out: path.join(tmp, 'late-banner') });
    assert.equal(events.events.filter((e) => e.type === 'down').length, 1);
  } finally {
    server.close();
  }
});

test('a wait with "film": false runs on without filming: the ad is never in the video', async () => {
  const page = `<!doctype html><style>body { margin: 0 } #stage { width: 800px; height: 600px; background: #fff }</style>
    <div id="stage"><button style="margin:200px" onclick="setTimeout(() => { stage.style.background = '#f00'; stage.innerHTML = '<p>Ad playing</p>'; }, 100); setTimeout(() => { stage.style.background = '#00f'; stage.innerHTML = '<p>Video</p>'; }, 3000)">Play</button></div>`;
  const server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = validateTake({
      version: 0, title: 'Ad', target: { kind: 'web', url, viewport: [800, 600], scale: 1 }, loop: 'none',
      steps: [
        { do: 'click', target: { role: 'button', name: 'Play' } },
        { do: 'wait', for: { text: 'Video' }, film: false },
        { do: 'hold', ms: 500 },
      ],
    });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    const out = path.join(tmp, 'off-camera');
    const { capture, events } = await record(r.take, { mode: 'studio', out });
    assert.ok(events.frames < 150, `${events.frames} frames: the 3 s ad was filmed`);
    const red = capture.frames.filter((f) => {
      const rgb = execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', path.join(out, f), '-vf', 'crop=2:2:700:500', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return rgb[0] > 200 && rgb[2] < 80;
    });
    assert.equal(red.length, 0, `${red.length} frames show the ad`);
    assert.equal(events.steps[1].end, events.steps[1].start, 'the wait takes no time in the video');
    const bad = validateTake({ version: 0, title: 'A', target: { kind: 'web', url }, steps: [{ do: 'wait', for: { text: 'Video' }, film: true }] });
    assert.ok(!bad.ok && bad.errors.some((e) => e.includes('film')));
  } finally {
    server.close();
  }
});
