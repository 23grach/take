import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, formatReport } from '../src/check/check.ts';
import { contactSheet } from '../src/check/contact.ts';
import { mediaTool } from '../src/media-tools.ts';

let dir: string;
before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-check-'))));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function video(name: string, { filter = '', rate = 60, extra = [] as string[], faststart = true } = {}): string {
  const out = path.join(dir, `${name}.mp4`);
  execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}:duration=2`,
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
  const pan = video('pan', { filter: 'scroll=horizontal=0.002' });
  assert.equal(status(check(pan), 'loop seam'), 'fail');
  const back = path.join(dir, 'back.mp4');
  execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-y', '-i', pan, '-filter_complex', '[0]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18', back]);
  assert.equal(status(check(back), 'loop seam'), 'pass');
});

test('a doubled frame mid-motion is caught, with its time', () => {
  const r = check(video('doubled', { filter: 'loop=loop=1:size=1:start=30,setpts=N/60/TB' }), { loop: false });
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
  const file = video('sheet', { filter: 'loop=loop=1:size=1:start=30,setpts=N/60/TB' });
  const r = check(file, { loop: false });
  const out = await contactSheet(r, path.join(dir, 'sheet.jpg'), { loop: false });
  assert.ok(fs.statSync(out).size > 50_000);
});

test('a step that looks different from its rehearsal is caught; one that matches is not', async () => {
  const { compareWithRehearsal, STEP_LIMIT } = await import('../src/check/rehearsal.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-rehearsal-'));
  try {
    const probe = path.join(dir, 'probe');
    const capture = path.join(dir, 'capture');
    fs.mkdirSync(probe);
    fs.mkdirSync(path.join(capture, 'frames'), { recursive: true });
    const img = (file: string, panel: boolean) =>
      execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=320x200', ...(panel ? ['-vf', 'drawbox=x=0:y=0:w=320:h=100:color=black:t=fill'] : []), '-frames:v', '1', '-y', file]);
    img(path.join(probe, 'step-00.png'), false);
    img(path.join(probe, 'step-01.png'), false);
    img(path.join(probe, 'step-02.png'), true);
    const frames = Array.from({ length: 30 }, (_, i) => `frames/f${String(i).padStart(5, '0')}.jpg`);
    for (const f of frames) img(path.join(capture, f), false);
    fs.writeFileSync(path.join(capture, 'capture.json'), JSON.stringify({ version: 0, mode: 'studio', fps: 60, size: [320, 200], frames, renderSeconds: 1, images: 30 }));
    fs.writeFileSync(path.join(probe, 'probe.json'), JSON.stringify({ ok: true, title: 't', viewport: [320, 200], seconds: 1,
      shots: [0, 1, 2].map((step) => ({ step, label: '', at: 0, file: `step-0${step}.png`, outline: '', pointer: [0, 0], cursor: 'default' })) }));
    const log = { version: 0, title: 't', url: '', address: '', fps: 60, viewport: [320, 200], scale: 1, frames: 30, pointer: [], cursors: [], carets: [], events: [], marks: {}, loop: 'none',
      steps: [{ index: 0, do: 'click', start: 0, end: 9 }, { index: 1, do: 'click', start: 10, end: 19 }] };
    const m = compareWithRehearsal(capture, log as never, probe)!;
    assert.deepEqual(m.map((s) => s.differs > STEP_LIMIT), [false, false, true]);
    assert.ok(m[2].frame >= 19 && m[2].frame <= 29, `compared frame ${m[2].frame}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
