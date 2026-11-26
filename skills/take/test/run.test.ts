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
  assert.match(r.report?.findings.find((f) => f.name === 'rehearsal')?.detail ?? '', /^not compared with the rehearsal/);
});

test('run stops with the failing step when the app does not match the take', async () => {
  const file = writeTake('missing', [{ do: 'click', target: { role: 'button', name: 'Delete everything' } }]);
  const r = await withShortFind(() => run(file));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /^step 1: .*Delete everything/);
  assert.equal(r.video, undefined);
  const failed = path.join(path.dirname(file), 'failed');
  assert.match(r.error ?? '', /the screen it stopped on: .*failed\/screen\.png/);
  assert.ok(fs.statSync(path.join(failed, 'screen.png')).size > 1000);
  assert.match(fs.readFileSync(path.join(failed, 'screen.outline.yml'), 'utf8'), /button "New project"/);
});

test('run says so when the app is not running', async () => {
  const r = await run(writeTake('down', [{ do: 'hold', ms: 100 }], 'http://127.0.0.1:9/'));
  assert.match(r.error ?? '', /nothing answers at http:\/\/127\.0\.0\.1:9\/\. Is the app running\?/);
});

test('a public site that does not answer is not asked whether it is running', async () => {
  const { answers } = await import('../src/take/load.ts');
  const problem = await answers('https://take-nowhere.invalid/', 5000);
  assert.match(problem ?? '', /^nothing answers at https:\/\/take-nowhere\.invalid\/\. Check the address and the internet connection$/);
});

test('run explains a broken take before opening a browser', async () => {
  const r = await run(writeTake('broken', [{ do: 'clik', target: { text: 'x' } }]));
  assert.match(r.error ?? '', /problem/);
  assert.match(r.error ?? '', /click/);
});

test('run names a missing theme at once, before opening a browser', async () => {
  const file = writeTake('bad-theme', [{ do: 'hold', ms: 100 }]);
  const r = await run(file, { theme: 'defualt' });
  assert.match(r.error ?? '', /no theme "defualt"\. Themes: default/);
  assert.ok(r.seconds < 2, `took ${r.seconds} s`);
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'capture')), false);
});
