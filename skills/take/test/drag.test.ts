import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openTake } from '../src/drivers/web/browser.ts';
import { realtimeClock } from '../src/drivers/web/clock.ts';
import { perform, TakeError } from '../src/drivers/web/driver.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import { withShortFind } from './short-find.ts';

const PAGE = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; font: 16px system-ui; } #pad { position: absolute; left: 0; top: 0; width: 800px; height: 600px; background: #eee; }
  #handle { position: absolute; left: 900px; top: 100px; padding: 8px; background: #36f; color: #fff; cursor: grab; }
  #bin { position: absolute; left: 900px; top: 400px; width: 120px; height: 80px; border: 2px dashed #999; }
</style><canvas id="pad" width="800" height="600"></canvas><div id="handle">Card</div><div id="bin" aria-label="Done column">Done</div><p id="log" style="position:absolute;top:620px"></p><script>
  const log = (t) => (document.getElementById('log').textContent += t + ';');
  let moves = 0, start;
  pad.addEventListener('pointerdown', (e) => { moves = 0; start = e.clientX + ',' + e.clientY; });
  pad.addEventListener('pointermove', (e) => { if (e.buttons) moves++; });
  pad.addEventListener('pointerup', (e) => log('stroke ' + start + ' > ' + e.clientX + ',' + e.clientY + ' (' + (moves > 10 ? 'many' : moves) + ' moves)'));
  handle.addEventListener('pointerdown', () => addEventListener('pointerup', (e) => {
    const b = bin.getBoundingClientRect();
    log(e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom ? 'dropped in done' : 'dropped elsewhere');
  }, { once: true }));
</script>`;

let server: http.Server;
let base: string;
before(async () => {
  server = http.createServer((_, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise((r) => server.close(r)));

function take(steps: unknown[]): Take {
  const r = validateTake({ version: 0, title: 'drag', target: { kind: 'web', url: base, scale: 1 }, steps });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.take;
}

async function run(steps: unknown[]) {
  const t = take(steps);
  const { browser, page } = await openTake(t);
  try {
    const log = await perform(page, t, realtimeClock(60));
    return { log, text: await page.locator('#log').textContent() };
  } finally {
    await browser.close();
  }
}

test('drags between two points with the button held the whole way', async () => {
  const { log, text } = await run([{ do: 'drag', from: [200, 150], to: [500, 400] }]);
  assert.equal(text, 'stroke 200,150 > 500,400 (many moves);');
  const [down, up] = log.events;
  assert.equal(down.type, 'down');
  assert.equal(up.type, 'up');
  assert.ok(up.frame - down.frame > 30, `held for ${up.frame - down.frame} frames: long enough to see the drag`);
});

test('drags an element onto another element', async () => {
  const { log, text } = await run([{ do: 'drag', from: { text: 'Card' }, to: { label: 'Done column' } }]);
  assert.equal(text, 'dropped in done;');
  assert.ok(log.steps[0].target, 'the grabbed element is logged for the storyboard');
});

test('a drag target that is missing stops with its name', async () => {
  await assert.rejects(withShortFind(() => run([{ do: 'drag', from: { text: 'Card' }, to: { label: 'Archive column' } }])), (e: unknown) =>
    e instanceof TakeError && /can't find .*Archive column/.test(e.message));
});

test('drag points are checked against the page size', () => {
  const r = validateTake({ version: 0, title: 'd', target: { kind: 'web', url: 'http://x.test/' }, steps: [
    { do: 'drag', from: [10, 10], to: [2000, 10] },
    { do: 'drag', from: 'here', to: [1, 2, 3] },
    { do: 'drag', to: [1, 1] },
  ] });
  assert.equal(r.ok, false);
  const errors = r.ok ? [] : r.errors;
  assert.ok(errors.some((e) => e === 'steps[0].to: point [2000, 10] is outside the 1440×900 page'), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('steps[1].from: must be an object')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('steps[1].to: must be a target such as')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('steps[2]: missing "from"')), errors.join('\n'));
});
