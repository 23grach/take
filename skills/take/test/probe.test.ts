import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../examples/demo-app/serve.mjs';
import { describeStep, probe, withoutAddresses } from '../src/probe/probe.ts';
import { storyboard } from '../src/probe/storyboard.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import { withShortFind } from './short-find.ts';

let app: { url: string; close: () => Promise<unknown> };
let tmp: string;
before(async () => {
  app = await serve(0);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-probe-'));
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function take(steps: unknown[]): Take {
  const r = validateTake({ version: 0, title: 'Quick', target: { kind: 'web', url: app.url, viewport: [800, 600] }, steps });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.take;
}

test('steps are described in plain words', () => {
  const t = take([
    { do: 'click', target: { role: 'button', name: 'New project' }, waitFor: { visible: { role: 'dialog' } } },
    { do: 'type', target: { label: 'Name' }, text: 'Moodboard' },
    { do: 'press', key: 'Enter' },
    { do: 'scroll', by: [0, 400] },
    { do: 'hold', ms: 1500 },
  ]);
  assert.deepEqual(t.steps.map(describeStep), [
    'Click button "New project", then wait for a dialog to show',
    'Type "Moodboard" into field labelled "Name"',
    'Press Enter',
    'Scroll by 0, 400 px',
    'Hold 1.5 s',
  ]);
});

test('probe screenshots the first screen and every step, and makes a storyboard', async () => {
  const out = path.join(tmp, 'ok');
  const r = await probe(take([
    { do: 'click', target: { role: 'button', name: 'New project' }, waitFor: { visible: { role: 'dialog', name: 'New project' } } },
    { do: 'type', target: { label: 'Name' }, text: 'A', cps: 30 },
    { do: 'click', target: { role: 'button', name: 'Create', exact: true }, waitFor: { visible: { role: 'heading', name: 'A', exact: true } } },
  ]), out);
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(r.shots.map((s) => s.step), [0, 1, 2, 3]);
  for (const s of r.shots) assert.ok(fs.existsSync(path.join(out, s.file)) && fs.existsSync(path.join(out, s.outline)), s.file);
  assert.match(fs.readFileSync(path.join(out, r.shots[1].outline), 'utf8'), /dialog "New project"/, 'the outline after step 1 shows the open dialog');
  assert.ok(r.shots[1].target, 'the New project button is still on screen: outlined');
  assert.ok(r.shots[1].waitedFor, 'the dialog it waited for is outlined');
  assert.equal(r.shots[2].cursor, 'text', 'the cursor is a text cursor on the field');
  assert.equal(r.shots[3].target, undefined, 'Create closed with its dialog: nothing to outline');
  assert.ok(r.shots.every((s, i) => i === 0 || s.at >= r.shots[i - 1].at), 'times only go forward');
  const sheet = await storyboard(r, out, path.join(out, 'storyboard.jpg'));
  assert.ok(fs.statSync(sheet).size > 10_000);
});

test('probe stops at a step that fails and shows why', async () => {
  const out = path.join(tmp, 'bad');
  const r = await withShortFind(() => probe(take([
    { do: 'click', target: { role: 'button', name: 'New project' } },
    { do: 'click', target: { role: 'button', name: 'Save' } },
    { do: 'hold', ms: 100 },
  ]), out));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /^step 2: can't find button "Save"/);
  assert.deepEqual(r.shots.map((s) => s.step), [0, 1, 2]);
  assert.match(r.shots[2].error ?? '', /^can't find button "Save"/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'probe.json'), 'utf8')).error);
});

test('outlines leave out link addresses, which targets never use', () => {
  const outline = [
    '- banner:',
    '  - link "Home":',
    '    - /url: /home',
    '  - link "Search and explore":',
    '    - /url: /explore',
    '    - text: Explore',
    '- textbox "Name": Moodboard',
    '- button "Create"',
  ].join('\n');
  assert.equal(withoutAddresses(outline), [
    '- banner:',
    '  - link "Home"',
    '  - link "Search and explore":',
    '    - text: Explore',
    '- textbox "Name": Moodboard',
    '- button "Create"',
  ].join('\n'));
});

test('probe clears only its own files from --out, never the take next to them', async () => {
  const { clearProbe } = await import('../src/probe/probe.ts');
  const dir = path.join(tmp, 'own-folder');
  fs.mkdirSync(dir);
  for (const f of ['take.json', 'scenario.md', 'step-01.png', 'step-01.outline.yml', 'probe.json', 'storyboard.jpg']) fs.writeFileSync(path.join(dir, f), 'x');
  clearProbe(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['scenario.md', 'take.json']);
});
