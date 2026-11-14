import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, formatReport } from '../src/check/check.ts';
import { contactSheet } from '../src/check/contact.ts';

let dir: string;
before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-check-'))));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A 2 s moving test pattern, encoded the way Take encodes unless told otherwise. */
function video(name: string, { filter = '', rate = 60, extra = [] as string[], faststart = true } = {}): string {
  const out = path.join(dir, `${name}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}:duration=2`,
    '-vf', `${filter ? `${filter},` : ''}format=yuv420p`, '-c:v', 'libx264', '-crf', '18', '-color_range', 'tv',
    ...(faststart ? ['-movflags', '+faststart'] : []), ...extra, out]);
  return out;
}
const status = (r: ReturnType<typeof check>, name: string) => r.findings.find((f) => f.name === name)?.status;

test('a clean video passes', () => {
  const file = video('clean');
  const r = check(file, { loop: false });
  assert.equal(r.ok, true, formatReport(r));
  assert.deepEqual([r.width, r.height, r.fps, r.frames], [640, 360, 60, 120]);
});

test('a loop that jumps back is caught; one that returns smoothly passes', () => {
  // A slow pan: small steps between frames, but the end is far from the start.
  const pan = video('pan', { filter: 'scroll=horizontal=0.002' });
  assert.equal(status(check(pan), 'loop seam'), 'fail');
  // The same pan forwards then backwards ends where it began.
  const back = path.join(dir, 'back.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', pan, '-filter_complex', '[0]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18', back]);
  assert.equal(status(check(back), 'loop seam'), 'pass');
});

test('a doubled frame mid-motion is caught, with its time', () => {
  const r = check(video('doubled', { filter: 'loop=loop=1:size=1:start=30' }), { loop: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.hitches, [30]);
  assert.match(formatReport(r), /✗ smoothness +1 doubled frame: motion stalls for one frame at 0\.50 s \(frame 30\)/);
});

test('wrong frame rate, colour and missing fast start are flagged', () => {
  const r = check(video('off', { rate: 30, extra: ['-pix_fmt', 'yuv444p'], faststart: false }), { loop: false });
  assert.equal(status(r, 'frame rate'), 'warn');
  assert.equal(status(r, 'colour'), 'warn');
  assert.equal(status(r, 'fast start'), 'warn');
});

test('the contact sheet is written', async () => {
  const file = video('sheet', { filter: 'loop=loop=1:size=1:start=30' });
  const r = check(file, { loop: false });
  const out = await contactSheet(r, path.join(dir, 'sheet.jpg'), { loop: false });
  assert.ok(fs.statSync(out).size > 50_000);
});
