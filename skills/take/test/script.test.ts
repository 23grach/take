import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTake } from '../src/take/format.ts';
import { formatScript, timeline } from '../src/probe/script.ts';
import type { StepLog } from '../src/drivers/web/events.ts';

const take = (() => {
  const r = validateTake({
    version: 0,
    title: 'Create a project',
    target: { kind: 'web', url: 'http://127.0.0.1:4300/' },
    steps: [
      { do: 'hold', ms: 2000, mark: 'start' },
      { do: 'click', target: { role: 'button', name: 'New project' }, waitFor: { text: 'Name' } },
      { do: 'press', key: 'Enter', ms: 500 },
      { do: 'hold', ms: 2000, mark: 'result' },
    ],
  });
  assert.ok(r.ok);
  return r.take;
})();

const log = (index: number, start: number, waited?: number): StepLog => ({ index, do: take.steps[index].do, start, end: start, ...(waited ? { waited } : {}) });

test('the script times each step from its start to the next, and adds the loop', () => {
  const s = timeline(take, [log(0, 0), log(1, 120), log(2, 210), log(3, 240)], 360, { fps: 60, loopFrames: 40 });
  assert.deepEqual(s.lines.map((l) => [l.step, l.start, l.length, l.fixed]), [[1, 0, 2, true], [2, 2, 1.5, false], [3, 3.5, 0.5, true], [4, 4, 2, true]]);
  assert.equal(s.total, 6 + 40 / 60);
  assert.equal(s.estimated, false);
  const text = formatScript(s);
  assert.match(text, /^Script: "Create a project", 6\.67 s \(as recorded\)/);
  assert.match(text, /  2  0:02\.00   1\.50 s   Click button "New project"/);
  assert.match(text, /  3  0:03\.50   0\.50 s\*  Press Enter/);
  assert.match(text, /0:06\.00   0\.67 s   Back to the start \(loop\)/);
  assert.match(text, /0:06\.67            End/);
});

test('a rehearsal scales waits for the app back to the video pace, and shows holds at their real length', () => {
  const s = timeline(take, [log(0, 0), log(1, 30, 40), log(2, 120), log(3, 150)], 180, { fps: 60, speed: 2, rehearsed: true });
  assert.deepEqual(s.lines.map((l) => +(l.length * 60).toFixed(3)), [120, 70, 30, 120]);
  assert.equal(s.estimated, true);
  assert.match(formatScript(s), /from the rehearsal/);
});

test('a step set shorter than its action says how short it can be', () => {
  const s = timeline(take, [log(0, 0), log(1, 120), log(2, 210), log(3, 270)], 390, { fps: 60 });
  assert.equal(s.lines[2].atLeast, 1);
  assert.match(formatScript(s), /1\.00 s\*  Press Enter   ⚠ set shorter than its action needs; it can't be under 1\.00 s/);
});
