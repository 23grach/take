import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../examples/demo-app/serve.mjs';
import { run } from '../src/run.ts';
import { withShortFind } from './short-find.ts';

let app: { url: string; close: () => Promise<unknown> };
let tmp: string;
before(async () => {
  app = await serve(0);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-run-'));
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Writes a take into its own folder, the way takes/<name>/take.json is laid out. */
function writeTake(name: string, steps: unknown[], url = app.url): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'take.json');
  fs.writeFileSync(file, JSON.stringify({ version: 0, title: name, target: { kind: 'web', url, viewport: [640, 400], scale: 1 }, steps }));
  return file;
}

test('run goes from take.json to a checked MP4 with a contact sheet', async () => {
  const file = writeTake('quick', [
    { do: 'click', target: { role: 'button', name: 'New project' } },
    { do: 'type', target: { label: 'Name' }, text: 'A', cps: 30 },
    { do: 'hold', ms: 300 },
  ]);
  const lines: string[] = [];
  const r = await run(file, { log: (l) => lines.push(l) });
  assert.equal(r.error, undefined);
  assert.equal(r.ok, true, JSON.stringify(r.report?.findings));
  const dir = path.dirname(file);
  assert.equal(r.video, path.join(dir, 'out', 'quick.mp4'));
  for (const f of ['capture/capture.json', 'capture/events.json', 'out/quick.mp4', 'out/quick.check.json', 'out/quick.contact.jpg'])
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.deepEqual(lines.filter((l) => l.startsWith('✓')).map((l) => l.split(/\s+/)[1]), ['recorded', 'composed', 'checked']);
  assert.ok(lines.some((l) => l.startsWith('⚠ no address')), 'warns that the address bar will be blank');
});

test('run stops with the failing step when the app does not match the take', async () => {
  const file = writeTake('missing', [{ do: 'click', target: { role: 'button', name: 'Delete everything' } }]);
  const r = await withShortFind(() => run(file));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /^step 1: .*Delete everything/);
  assert.equal(r.video, undefined);
});

test('run says so when the app is not running', async () => {
  const r = await run(writeTake('down', [{ do: 'hold', ms: 100 }], 'http://127.0.0.1:9/'));
  assert.match(r.error ?? '', /nothing answers at http:\/\/127\.0\.0\.1:9\/\. Is the app running\?/);
});

test('run explains a broken take before opening a browser', async () => {
  const r = await run(writeTake('broken', [{ do: 'clik', target: { text: 'x' } }]));
  assert.match(r.error ?? '', /problem/);
  assert.match(r.error ?? '', /click/);
});
