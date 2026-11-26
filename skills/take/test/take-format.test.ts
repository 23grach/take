import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { validateTake, DEFAULTS, followedAddress } from '../src/take/format.ts';
import { loadTake } from '../src/take/load.ts';

const example = fileURLToPath(new URL('./fixtures/create-project.take.json', import.meta.url));
const bin = fileURLToPath(new URL('../bin/take', import.meta.url));

const minimal = () => ({
  version: 0,
  title: 'Minimal',
  target: { kind: 'web', url: 'http://127.0.0.1:4300/' },
  steps: [{ do: 'click', target: { role: 'button', name: 'New project' } }],
});

const errorsOf = (input: unknown) => {
  const r = validateTake(input);
  assert.equal(r.ok, false, 'expected the take to be rejected');
  return r.ok ? [] : r.errors;
};

test('the example take for the demo app is valid', () => {
  const r = loadTake(example);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.equal(r.take.steps.length, 5);
});

test('defaults are filled in', () => {
  const take = { ...minimal(), steps: [{ do: 'type', text: 'hi' }, { do: 'wait', for: { text: 'Done' } }] };
  const r = validateTake(take);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.deepEqual(r.take.target.viewport, DEFAULTS.viewport);
  assert.equal(r.take.target.scale, 1.5);
  assert.equal(r.take.theme, 'default');
  assert.equal(r.take.loop, 'crossfade-to-start');
  assert.equal(r.take.sound, true);
  assert.deepEqual(r.take.steps.map((s) => ('cps' in s ? s.cps : 'timeout' in s ? s.timeout : null)), [14, 10_000]);
});

test('a phone types with thumbs: slower unless the step says otherwise', () => {
  const phone = (steps: unknown[]) => validateTake({ ...minimal(), target: { kind: 'web', device: 'phone', url: 'http://localhost:3000' }, steps });
  const cpsOf = (r: ReturnType<typeof validateTake>) => (r.ok ? r.take.steps.map((s) => ('cps' in s ? s.cps : null)) : r.errors);
  assert.deepEqual(cpsOf(phone([{ do: 'type', text: 'hi' }, { do: 'type', text: 'hi', cps: 20 }])), [7, 20]);
  assert.deepEqual(cpsOf(validateTake({ ...minimal(), steps: [{ do: 'type', text: 'hi' }] })), [14]);
});

test('"sound" turns the page\'s own sound off, and is true or false', () => {
  const r = validateTake({ ...minimal(), sound: false });
  assert.ok(r.ok && r.take.sound === false);
  assert.deepEqual(errorsOf({ ...minimal(), sound: 'off' }), ['sound: must be true or false, got "off"']);
});

test('"target.appearance" picks light or dark, and follows the site when left out', () => {
  const r = validateTake({ ...minimal(), target: { ...minimal().target, appearance: 'dark' } });
  assert.ok(r.ok && r.take.target.appearance === 'dark');
  const left = validateTake(minimal());
  assert.ok(left.ok && !('appearance' in left.take.target));
  assert.deepEqual(errorsOf({ ...minimal(), target: { ...minimal().target, appearance: 'night' } }), ['target.appearance: must be "light" or "dark", or left out to follow the site, got "night"']);
});

test('an "appearance" step switches the computer to light or dark mid-video, on desktop, in the filmed steps', () => {
  const steps = (step: unknown) => ({ ...minimal(), steps: [step] });
  assert.ok(validateTake(steps({ do: 'appearance', to: 'dark' })).ok);
  assert.deepEqual(errorsOf(steps({ do: 'appearance', to: 'night' })), ['steps[0].to: must be "light" or "dark", got "night"']);
  assert.deepEqual(errorsOf(steps({ do: 'appearance' })), ['steps[0]: missing "to" ("light" or "dark": the mode the computer switches to)']);
  assert.deepEqual(errorsOf({ ...steps({ do: 'appearance', to: 'dark' }), target: { kind: 'web', url: 'http://localhost:3000/', device: 'phone' } }),
    ['steps[0].do: switching light and dark mid-video works on desktop only for now; on a phone, set target.appearance for the whole video']);
  assert.deepEqual(errorsOf({ ...minimal(), setup: [{ do: 'appearance', to: 'dark' }] }),
    ['setup[0].do: setup isn\'t filmed, so a switch there only changes how the video starts: set target.appearance instead']);
});

test('typos get a suggestion', () => {
  const take = minimal();
  (take.steps[0] as Record<string, unknown>).taget = take.steps[0].target;
  delete (take.steps[0] as Record<string, unknown>).target;
  const errors = errorsOf(take);
  assert.ok(errors.includes('steps[0]: missing "target" (what to click)'), errors.join('\n'));
  assert.ok(errors.includes('steps[0].taget: unknown field (did you mean "target"?)'), errors.join('\n'));
  assert.match(errorsOf({ ...minimal(), steps: [{ do: 'clik', target: { text: 'x' } }] })[0], /did you mean "click"/);
});

test('a target needs exactly one way to find the element', () => {
  assert.match(errorsOf({ ...minimal(), steps: [{ do: 'click', target: {} }] })[0], /give exactly one of role, label, text, placeholder, css$/);
  assert.match(errorsOf({ ...minimal(), steps: [{ do: 'click', target: { role: 'button', text: 'Save' } }] })[0], /\(got role and text\)/);
  assert.match(errorsOf({ ...minimal(), steps: [{ do: 'click', target: { role: 'Button' } }] })[0], /roles are lowercase, e.g. "button"/);
});

test('each problem is reported with where it is', () => {
  const errors = errorsOf({
    version: 1,
    title: '',
    target: { kind: 'ios', url: 'localhost:3000', viewport: [1440], scale: 3 },
    steps: [{ do: 'hold' }, { do: 'scroll' }, { do: 'press', key: 'Enter', mark: 'a' }, { do: 'hold', ms: -5, mark: 'a' }],
    loop: 'bounce',
  });
  assert.deepEqual(errors, [
    'version: must be 0, got 1',
    'take.title: must be non-empty text, got ""',
    'target.kind: must be "web", got "ios"',
    'target.url: must start with http:// or https://, got "localhost:3000"',
    'target.viewport: must be [width, height] in whole pixels between 320 and 3840, e.g. [1440, 900], got [1440]',
    'target.scale: must be 1, 1.5 or 2, got 3',
    'steps[0]: missing "ms"',
    'steps[1]: give either "target" (scroll it into view) or "by": [x, y] in pixels',
    'steps[3].ms: must be a number above 0, got -5',
    'steps: mark "a" is used more than once; marks must be unique',
    'loop: must be one of crossfade-to-start, none, got "bounce"',
  ]);
});

test('take validate reports a good and a broken take', () => {
  const out = execFileSync(process.execPath, [bin, 'validate', example], { encoding: 'utf8' });
  assert.match(out, /✓ .*"Create a project", 5 steps, 1440×900 at 1\.5×/);
  const bad = spawnSync(process.execPath, [bin, 'validate', bin], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not valid JSON/);
});

test('press keys use the browser\'s names; common other names get the right one', async () => {
  const { keyProblem } = await import('../src/take/format.ts');
  for (const ok of ['Enter', 'Meta+A', 'Shift+Tab', 'ControlOrMeta+K', 'a', 'Meta++', '+', 'F5', 'Space']) assert.equal(keyProblem(ok), undefined, ok);
  assert.match(keyProblem('Cmd+K') ?? '', /unknown key "Cmd"; use Meta/);
  assert.match(keyProblem('Esc') ?? '', /use Escape/);
  assert.match(keyProblem('Ctrl+Shift+P') ?? '', /use Control \(e\.g\. "Control\+Shift\+P"\)/);
  assert.match(keyProblem('Enterr') ?? '', /use Enter/);
});

test('any step can be given a length in ms; a type step takes cps or ms, not both', () => {
  const take = (steps: unknown[]) => ({ ...minimal(), steps });
  const r = validateTake(take([{ do: 'click', target: { role: 'button', name: 'New project' }, ms: 3000 }, { do: 'type', text: 'Hi', ms: 2000 }]));
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.equal(r.take.steps[0].ms, 3000);
  assert.deepEqual(errorsOf(take([{ do: 'press', key: 'Enter', ms: 0 }])), ['steps[0].ms: must be a number above 0, got 0']);
  assert.deepEqual(errorsOf(take([{ do: 'type', text: 'Hi', cps: 8, ms: 2000 }])), ['steps[0]: give "cps" (typing speed) or "ms" (how long the step lasts: the typing speed follows), not both']);
});

test('the address follows the page: same site keeps the shown domain with the new path, another site shows its own', () => {
  assert.equal(followedAddress('stripe.com', 'https://stripe.com/', 'https://stripe.com/payments'), 'stripe.com/payments');
  assert.equal(followedAddress('github.com/facebook/react', 'https://github.com/react/react', 'https://github.com/react/react/issues/38261'), 'github.com/react/react/issues/38261');
  assert.equal(followedAddress('boards.app', 'http://localhost:5173/', 'http://localhost:5173/projects/'), 'boards.app/projects');
  assert.equal(followedAddress('github.com/facebook/react', 'https://github.com/react/react', 'https://github.com/react/react#readme'), 'github.com/facebook/react');
  assert.equal(followedAddress('boards.app', 'http://localhost:5173/', 'https://docs.example.com/start'), 'docs.example.com/start');
  assert.equal(followedAddress('', 'http://localhost:5173/', 'http://localhost:5173/projects'), '');
});
