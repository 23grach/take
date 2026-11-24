import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallPacedClock } from '../src/drivers/web/clock.ts';

test('a wall-paced clock never runs ahead of real time, however quick each frame is', async () => {
  let advanced = 0;
  const clock = wallPacedClock(async (ms) => void (advanced += ms));
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) await clock.tick();
  assert.equal(clock.frame, 30);
  assert.ok(Math.abs(advanced - 500) < 1e-6);
  assert.ok(performance.now() - t0 >= 495, `30 frames took ${(performance.now() - t0).toFixed(0)} ms of real time`);
});
