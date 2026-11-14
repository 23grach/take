import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compose, footageAt, loadTheme, loopProgress, overlayAt, totalFrames } from '../src/compose/compose.ts';
import type { CaptureInfo } from '../src/drivers/web/capture.ts';
import { layout } from '../src/compose/stage.ts';
import type { EventLog } from '../src/drivers/web/events.ts';

const { theme } = loadTheme();

function log(frames: number): EventLog {
  return {
    version: 0, title: 't', url: 'http://127.0.0.1:4300/', address: '', fps: 60, viewport: [1440, 900], scale: 1, frames,
    cursors: [[0, 'default']], carets: [[0, null]], loop: 'crossfade-to-start',
    pointer: Array.from({ length: frames }, (_, f) => [100 + f * 10, 200] as [number, number]),
    events: [{ frame: 10, type: 'down', x: 200, y: 200 }, { frame: 15, type: 'up', x: 250, y: 200 }],
    steps: [], marks: {},
  };
}

test('the window fits inside the stage, centred, keeping the page proportions', () => {
  const box = layout(theme, [1440, 900]);
  const [W, H] = theme.stage.size;
  assert.ok(box.left >= theme.stage.padding && box.top >= theme.stage.padding);
  assert.ok(Math.abs(box.left * 2 + box.width - W) <= 1);
  assert.ok(Math.abs(box.top * 2 + box.height - H) <= 1);
  assert.ok(Math.abs((box.height - theme.window.bar.height) / box.width - 900 / 1440) < 0.002);
});

test('the ripple starts before the press and is gone after it', () => {
  const l = log(60);
  const { lead, frames, contact } = theme.ripple;
  assert.equal(overlayAt(l, theme, 10 - lead - 1).ripples.length, 0);
  assert.equal(overlayAt(l, theme, 10 - lead).ripples.length, 1, 'starts `lead` frames early');
  const atPress = overlayAt(l, theme, 10).ripples[0];
  assert.equal(atPress.radius, contact);
  assert.deepEqual([atPress.x, atPress.y], [200, 200]);
  assert.ok(overlayAt(l, theme, 14).ripples[0].radius > contact, 'spreads after the press');
  assert.equal(overlayAt(l, theme, 10 - lead + frames).ripples.length, 0);
});

test('the cursor follows the log and shrinks while pressed', () => {
  const l = log(60);
  assert.deepEqual([overlayAt(l, theme, 3).x, overlayAt(l, theme, 3).y], [130, 200]);
  assert.equal(overlayAt(l, theme, 9).pressed, false);
  assert.equal(overlayAt(l, theme, 10).pressed, true);
  assert.equal(overlayAt(l, theme, 14).pressed, true);
  assert.equal(overlayAt(l, theme, 15).pressed, false);
});

test('the loop crossfades to the first frame and brings the cursor home, with no repeated frame at the seam', () => {
  const l = log(60);
  const C = theme.loop.frames;
  const info = { frames: Array.from({ length: 60 }, (_, i) => `f${i}`) } as CaptureInfo;
  assert.equal(totalFrames(l, theme), 60 + C);
  assert.equal(totalFrames({ ...l, loop: 'none' }, theme), 60);
  assert.equal(footageAt(info, l, theme, 59).fade, null);
  // Opacity rises every frame, starts above 0 and stops short of 1: the next frame is the video's first.
  const ps = Array.from({ length: C }, (_, k) => loopProgress(l, theme, 60 + k));
  assert.ok(ps[0] > 0 && ps.at(-1)! < 1 && ps.every((p, i) => i === 0 || p > ps[i - 1]));
  const last = footageAt(info, l, theme, 60 + C - 1);
  assert.deepEqual([last.src, last.fade?.src], ['f59', 'f0']);
  // The cursor leaves from where the take ended and closes in on where it began.
  const [end, start] = [l.pointer[59], l.pointer[0]];
  const first = overlayAt(l, theme, 60), final = overlayAt(l, theme, 60 + C - 1);
  assert.ok(Math.hypot(first.x - end[0], first.y - end[1]) < 5);
  assert.ok(Math.hypot(final.x - start[0], final.y - start[1]) < 5);
  assert.equal(final.ripples.length, 0);
});

test('composes a capture into a 2560×1440, 60 fps H.264 MP4', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-compose-'));
  try {
    fs.mkdirSync(path.join(dir, 'frames'));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1440x900:rate=60', '-frames:v', '30', path.join(dir, 'frames/f%05d.jpg')]);
    const frames = Array.from({ length: 30 }, (_, i) => `frames/f${String(i + 1).padStart(5, '0')}.jpg`);
    fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 0, mode: 'studio', fps: 60, size: [1440, 900], frames, renderSeconds: 0, images: 30 }));
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(log(30)));
    const out = path.join(dir, 'out.mp4');
    const r = await compose({ capture: dir, out });
    assert.equal(r.frames, 30 + theme.loop.frames);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,color_range', '-of', 'json', out], { encoding: 'utf8' });
    const { side_data_list: _, ...stream } = JSON.parse(probe).streams[0];
    assert.deepEqual(stream, { codec_name: 'h264', width: 2560, height: 1440, pix_fmt: 'yuv420p', color_range: 'tv', avg_frame_rate: '60/1', nb_read_frames: String(30 + theme.loop.frames) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A 30-frame capture of a test pattern, in a fresh folder. */
function testCapture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-compose-'));
  fs.mkdirSync(path.join(dir, 'frames'));
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1440x900:rate=60', '-frames:v', '30', path.join(dir, 'frames/f%05d.jpg')]);
  const frames = Array.from({ length: 30 }, (_, i) => `frames/f${String(i + 1).padStart(5, '0')}.jpg`);
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 0, mode: 'studio', fps: 60, size: [1440, 900], frames, renderSeconds: 0, images: 30 }));
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(log(30)));
  return dir;
}

/** Runs `fn` with only `bin` on the PATH. */
async function withPath<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = bin;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('compose says plainly when ffmpeg is missing', async () => {
  const dir = testCapture();
  try {
    const empty = fs.mkdtempSync(path.join(dir, 'bin-'));
    await assert.rejects(withPath(empty, () => compose({ capture: dir, out: path.join(dir, 'out.mp4') })), /ffmpeg isn't installed .*take doctor/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compose stops with ffmpeg\'s reason when ffmpeg dies mid-video, instead of hanging', async () => {
  const dir = testCapture();
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Reads a little of the video, then gives up.
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nhead -c 100000 > /dev/null\necho "disk full" >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(withPath(`${bin}:/usr/bin:/bin`, () => compose({ capture: dir, out: path.join(dir, 'out.mp4') })), /ffmpeg failed \(1\): disk full/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
