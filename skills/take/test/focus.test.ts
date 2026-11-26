import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { record } from '../src/drivers/web/record.ts';
import { focusRegion, clipToViewport } from '../src/drivers/web/focus.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import { mediaTool } from '../src/media-tools.ts';
import { clickGaps, PACING } from '../src/drivers/web/pacing.ts';

const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #c33; font: 16px system-ui; }
  header { height: 300px; background: #234; color: #fff; }
  p { position: absolute; left: 600px; top: 500px; margin: 0; }
  #heart { color: #f00; cursor: pointer; }
  .flying { position: fixed; color: #f00; font-size: 24px; }
</style>
<header>Header</header>
<p>Made with <span id="heart" role="button" aria-label="Send a heart">♥</span> by someone</p>
<script>
  document.getElementById('heart').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'flying';
    layer.textContent = '♥';
    Object.assign(layer.style, { left: r.left + 'px', top: r.top - 80 + 'px' });
    document.body.append(layer);
  };
</script>`;

let server: http.Server;
let url: string;
let tmp: string;
before(async () => {
  server = http.createServer((_, res) => res.end(PAGE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-focus-'));
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = (target: Record<string, unknown> = {}, steps: unknown[] = [{ do: 'hold', ms: 100 }]) => ({
  version: 0,
  title: 'Heart',
  target: { kind: 'web', url: 'http://127.0.0.1:1/', focus: { on: { role: 'button', name: 'Send a heart' } }, ...target },
  steps,
});

test('target.focus takes one element and the room around it', () => {
  const r = validateTake(base());
  assert.ok(r.ok);
  assert.deepEqual(r.take.target.focus, { on: { role: 'button', name: 'Send a heart' }, room: [48, 48, 48, 48] });
  const room = (v: unknown) => {
    const t = validateTake(base({ focus: { on: { css: '#heart' }, room: v } }));
    return t.ok ? t.take.target.focus!.room : undefined;
  };
  assert.deepEqual(room(10), [10, 10, 10, 10]);
  assert.deepEqual(room([160, 120]), [160, 120, 160, 120]);
  assert.deepEqual(room([160, 120, 40, 100]), [160, 120, 40, 100]);
  assert.equal(room([1, 2, 3]), undefined);
  assert.equal(room(-5), undefined);
});

test('a component video can\'t scroll, and is desktop only', () => {
  const scroll = validateTake(base({}, [{ do: 'scroll', by: [0, 300] }]));
  assert.ok(!scroll.ok && scroll.errors.some((e) => e.startsWith('steps[0].do') && /camera still/.test(e)));
  const phone = validateTake(base({ device: 'phone' }));
  assert.ok(!phone.ok && phone.errors.some((e) => e.startsWith('target.focus')));
  const empty = validateTake(base({ focus: {} }));
  assert.ok(!empty.ok && empty.errors.some((e) => e.startsWith('target.focus')));
});

test('a click can repeat quickly up to 20 times', () => {
  const click = (clicks: unknown) => validateTake(base({}, [{ do: 'click', target: { css: '#heart' }, clicks }])).ok;
  assert.ok(click(12));
  assert.ok(click(20));
  assert.ok(!click(21));
  assert.ok(!click(1));
  assert.ok(!click(2.5));
});

test('the framed area is 16:9, centred on the element with the same room on opposite sides', () => {
  const size: [number, number] = [1920, 1080];
  const r = focusRegion({ x: 700, y: 400, width: 20, height: 20 }, [100, 50, 20, 50], [1440, 900], size, 5);
  assert.ok(Math.abs(r.width / r.height - 16 / 9) < 0.01);
  assert.ok(Math.abs(r.x + r.width / 2 - 710) < 0.01 && Math.abs(r.y + r.height / 2 - 410) < 0.01, 'centred on the element');
  assert.ok(r.y <= 300 && r.y + r.height >= 520, 'the largest of top and bottom room on both sides');
  const tiny = focusRegion({ x: 700, y: 400, width: 10, height: 10 }, [0, 0, 0, 0], [1440, 900], size, 5);
  assert.equal(tiny.width, 384);
  const huge = focusRegion({ x: 0, y: 0, width: 1400, height: 880 }, [48, 48, 48, 48], [1440, 900], size, 5);
  assert.ok(huge.width <= 1440 && huge.height <= 900);
  const corner = focusRegion({ x: 1420, y: 880, width: 20, height: 20 }, [48, 48, 48, 48], [1440, 900], size, 5);
  assert.deepEqual(clipToViewport(corner, [1440, 900]), { x: corner.x, y: corner.y, width: 1440 - corner.x, height: 900 - corner.y });
});

function pixels(file: string, w = 192, h = 108): Buffer {
  return execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h},format=rgb24`, '-f', 'rawvideo', '-']);
}
const reds = (px: Buffer) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 180 && px[i + 1] < 120 && px[i + 2] < 120) n++;
  return n;
};

test('studio films only the component on white, enlarged to 1920×1080, with what it adds to the page', async () => {
  const r = validateTake({
    ...base({ url, viewport: [1440, 900], scale: 1, focus: { on: { role: 'button', name: 'Send a heart' }, room: [120, 80, 20, 80] } }),
    steps: [{ do: 'hold', ms: 200 }, { do: 'click', target: { role: 'button', name: 'Send a heart' } }, { do: 'hold', ms: 200 }],
    sound: false,
  });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  const out = path.join(tmp, 'studio');
  const { capture, events } = await record(r.take as Take, { mode: 'studio', out });
  assert.deepEqual(capture.size, [1920, 1080]);
  assert.deepEqual(capture.shows, events.focus);
  const region = events.focus!;
  assert.ok(Math.abs(region.width / region.height - 16 / 9) < 0.01);
  const [px, py] = events.pointer[0];
  assert.ok(px > region.x && px < region.x + region.width && py > region.y && py < region.y + region.height, 'the cursor starts inside the picture');

  const first = pixels(path.join(out, capture.frames[0]));
  let white = 0;
  for (let i = 0; i < first.length; i += 3) if (first[i] > 245 && first[i + 1] > 245 && first[i + 2] > 245) white++;
  assert.ok(white / (first.length / 3) > 0.97, `the page's own red background and text are hidden (${white} of ${first.length / 3} white)`);
  assert.ok(reds(first) > 0, 'the heart is in the picture');
  const last = pixels(path.join(out, capture.frames.at(-1)!));
  assert.ok(reds(last) > reds(first), 'the heart the click added to the page shows too');
});

test('quick clicks given a length start slower and speed up to the fastest rhythm', () => {
  assert.deepEqual(clickGaps(12), Array(11).fill(PACING.multiClickGap));
  assert.deepEqual(clickGaps(3, 2000), [PACING.multiClickGap, PACING.multiClickGap]);
  const gaps = clickGaps(16, 3550);
  assert.equal(gaps.length, 15);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] < gaps[i - 1], 'each gap shorter than the one before');
  assert.ok(Math.abs(gaps.at(-1)! - PACING.multiClickGap) < 5, 'ends at the fastest rhythm');
  assert.ok(Math.abs(gaps.reduce((a, b) => a + b, 0) + 16 * PACING.multiClickPress - 3550) < 1, 'fills the time it is given');
  assert.deepEqual(clickGaps(16, 500), Array(15).fill(PACING.multiClickGap), 'too little time: the fastest rhythm throughout');
});
