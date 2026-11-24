import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../examples/demo-app/serve.mjs';
import { describeStep, probe } from '../src/probe/probe.ts';
import { shortOutline } from '../src/probe/outline.ts';
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
  assert.ok(r.script && r.script.estimated);
  assert.deepEqual(r.script.lines.map((l) => l.step), [1, 2, 3]);
  assert.ok(r.script.lines.every((l, i) => l.length > 0 && (i === 0 || Math.abs(l.start - r.script!.lines[i - 1].start - r.script!.lines[i - 1].length) < 1e-9)));
  assert.ok(Math.abs(r.script.total - (r.script.lines.at(-1)!.start + r.script.lines.at(-1)!.length + r.script.loop)) < 1e-9);
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

test('outlines keep what targets use and drop what they never do', () => {
  const outline = [
    '- banner:',
    '  - list:',
    '    - listitem:',
    '      - link "Home":',
    '        - /url: /home',
    '        - img "Home"',
    '    - listitem:',
    '      - link "Search and explore":',
    '        - /url: /explore',
    '        - text: Explore',
    '- separator',
    '- heading "Projects" [level=1]:',
    '  - text: Projects',
    '- paragraph: Everything you are working on, sorted by the date you last opened it, newest first.',
    '- textbox "Name": Moodboard',
    '- \'article "Note: a long name that goes on and on past sixty characters for sure"\':',
    '  - button "Create"',
    '  - img',
  ].join('\n');
  assert.equal(shortOutline(outline).outline, [
    '- banner:',
    '  - link "Home"',
    '  - link "Search and explore"',
    '- heading "Projects" [level=1]',
    '- text: Everything you are working on, sorted by the date you last o…',
    '- textbox "Name": Moodboard',
    '- \'article "Note: a long name that goes on and on past sixty characters…"\':',
    '  - button "Create"',
  ].join('\n'));
});

test('on a long page the outline keeps what is on screen and every heading', () => {
  const outline = [
    '- heading "Top" [level=1]',
    '- link "Shown"',
    '- link "Far below"',
    '- paragraph: A sentence that is on the screen right now.',
    '- paragraph: A sentence that is far below the screen.',
    '- text: ","',
    '- list:',
    '  - listitem:',
    '    - button',
    '    - link "Also shown"',
    '- heading "Further" [level=2]',
  ].join('\n');
  const r = shortOutline(outline, { text: 'Top Shown , A sentence that is on the screen right now. Also shown', pieces: ['Top', 'Shown', ',', 'Also shown'] });
  assert.equal(r.outline, ['- heading "Top" [level=1]', '- link "Shown"', '- text: A sentence that is on the screen right now.', '- button', '- link "Also shown"', '- heading "Further" [level=2]'].join('\n'));
  assert.equal(r.leftOut, 3);
});

test('on a long page, a name that adds hidden text to what is shown still counts as on screen', () => {
  const outline = ['- navigation "Repository":', '  - link "Code"', '  - link "Issues (871)"', '  - link "Security and quality (10)"', '- link "Far below"'].join('\n');
  const r = shortOutline(outline, { text: 'Code Issues 871 Security and quality 10', pieces: ['Code', 'Issues\n871 (871)', 'Security and quality\n10 (10)'] });
  assert.equal(r.outline, ['- navigation "Repository":', '  - link "Code"', '  - link "Issues (871)"', '  - link "Security and quality (10)"'].join('\n'));
});

test('probe clears only its own files from --out, never the take next to them', async () => {
  const { clearProbe } = await import('../src/probe/probe.ts');
  const dir = path.join(tmp, 'own-folder');
  fs.mkdirSync(dir);
  for (const f of ['take.json', 'scenario.md', 'step-01.png', 'step-01.outline.yml', 'probe.json', 'storyboard.jpg']) fs.writeFileSync(path.join(dir, f), 'x');
  clearProbe(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['scenario.md', 'take.json']);
});

test('a failed probe points to the storyboard of the last probe that passed', async () => {
  const { keepPassing } = await import('../src/probe/storyboard.ts');
  const dir = path.join(tmp, 'passing');
  fs.mkdirSync(dir);
  const sheet = path.join(dir, 'storyboard.jpg');
  fs.writeFileSync(sheet, 'good');
  assert.equal(keepPassing(true, sheet), undefined);
  fs.writeFileSync(sheet, 'failed');
  assert.equal(keepPassing(false, sheet), path.join(dir, 'storyboard.passed.jpg'));
  assert.equal(fs.readFileSync(path.join(dir, 'storyboard.passed.jpg'), 'utf8'), 'good');
});

test('a rehearsal cuts the opening and closing holds short, and keeps the ones between steps', async () => {
  const { rehearsal } = await import('../src/probe/probe.ts');
  const t = take([{ do: 'hold', ms: 2000 }, { do: 'click', target: { role: 'button', name: 'New project' } }, { do: 'hold', ms: 1500 }, { do: 'press', key: 'Escape' }, { do: 'hold', ms: 2000 }]);
  assert.deepEqual(rehearsal(t).steps.map((s) => (s.do === 'hold' ? s.ms : s.do)), [500, 'click', 1500, 'press', 500]);
  assert.equal(t.steps[0].do === 'hold' && t.steps[0].ms, 2000, 'the take itself is unchanged');
});

test('buttons with no name are listed with a CSS target and where they are', async () => {
  const { openTake } = await import('../src/drivers/web/browser.ts');
  const { targetHandles } = await import('../src/probe/probe.ts');
  const unnamedHandles = async (p: typeof page) => targetHandles(p, await p.locator('body').ariaSnapshot());
  const { browser, page } = await openTake(take([{ do: 'hold', ms: 100 }]));
  try {
    assert.equal(await unnamedHandles(page), '');
    await page.evaluate(() => {
      const panel = Object.assign(document.createElement('div'), { className: 'panel' });
      panel.style.cssText = 'position:fixed;top:10px;right:10px';
      panel.innerHTML = '<button class="icon close"><svg width="16" height="16"></svg></button>';
      const other = Object.assign(document.createElement('button'), { className: 'icon' });
      other.innerHTML = '<svg width="16" height="16"></svg>';
      other.style.cssText = 'position:fixed;bottom:10px;left:10px';
      document.body.append(panel, other);
    });
    const listed = await unnamedHandles(page);
    const targets = [...listed.matchAll(/\{ "css": (".*?") \}/g)].map((m) => JSON.parse(m[1]) as string);
    assert.equal(targets.length, 2, listed);
    for (const css of targets) assert.equal(await page.locator(css).count(), 1, css);
    assert.match(listed, /button at \d+, \d+ \(top right/);
  } finally {
    await browser.close();
  }
});

test('elements that share a name get a CSS target each, with where they are', async () => {
  const { openTake } = await import('../src/drivers/web/browser.ts');
  const { targetHandles: sharedNameHandles } = await import('../src/probe/probe.ts');
  const { browser, page } = await openTake(take([{ do: 'hold', ms: 100 }]));
  try {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('afterbegin', '<header><button class="cta">Sign up</button></header>');
      document.body.insertAdjacentHTML('beforeend', '<div style="height:3000px"></div><footer><button class="cta">Sign up</button></footer>');
    });
    const outline = await page.locator('body').ariaSnapshot();
    const listed = await sharedNameHandles(page, outline);
    const targets = [...listed.matchAll(/button "Sign up" (at \d+, \d+ \([^)]*\)|below the screen[^:]*): \{ "css": (".*?") \}/g)];
    assert.equal(targets.length, 2, listed);
    for (const [, , css] of targets) assert.equal(await page.locator(JSON.parse(css)).count(), 1, css);
    assert.match(listed, /below the screen/);
  } finally {
    await browser.close();
  }
});
