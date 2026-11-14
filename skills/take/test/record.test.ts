import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../examples/demo-app/serve.mjs';
import { record } from '../src/drivers/web/record.ts';
import { validateTake, type Take } from '../src/take/format.ts';

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
  // The app's 700 ms "saving" delay takes exactly 42 frames of video, however long rendering took.
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
  assert.equal(capture.frames.length, 6); // only the hold is filmed
  const bad = validateTake({ version: 0, title: 't', target: { kind: 'web', url: app.url }, ready: [], steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(!bad.ok && bad.errors.some((e) => /^ready: give a condition/.test(e)));
  const typo = validateTake({ version: 0, title: 't', target: { kind: 'web', url: app.url }, ready: [{ txt: 'x' }], steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(!typo.ok && typo.errors.some((e) => e.startsWith('ready[0]')));
});
