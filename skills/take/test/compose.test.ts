import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compose, composeWorkers, following, footageAt, loadTheme, loopProgress, overlayAt, pageAppearance, totalFrames } from '../src/compose/compose.ts';
import type { CaptureInfo } from '../src/drivers/web/capture.ts';
import { layout, themeFor } from '../src/compose/stage.ts';
import type { EventLog } from '../src/drivers/web/events.ts';
import { mediaTool } from '../src/media-tools.ts';

const { theme } = loadTheme();

function log(frames: number): EventLog {
  return {
    version: 0, title: 't', url: 'http://127.0.0.1:4300/', address: '', fps: 60, device: 'desktop', viewport: [1440, 900], scale: 1, frames,
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

test('a dark page gets the dark background and window; everything else stays the same', () => {
  const dark = themeFor(theme, 'dark');
  assert.equal(theme.stage.background, '#f2f2f2');
  assert.equal(dark.stage.background, '#181b25');
  assert.notEqual(dark.window.bar.background, theme.window.bar.background);
  assert.deepEqual(dark.stage.size, theme.stage.size);
  assert.equal(dark.window.bar.height, theme.window.bar.height);
  assert.deepEqual(dark.window.dots, theme.window.dots);
  assert.equal(themeFor(theme, 'light'), theme);
});

test('the opening frame decides whether the site is light or dark', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-appearance-'));
  const frame = (name: string, color: string) => {
    const file = path.join(dir, name);
    execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x200`, '-frames:v', '1', file]);
    return file;
  };
  assert.equal(pageAppearance(frame('light.jpg', '0xf7f7f8')), 'light');
  assert.equal(pageAppearance(frame('dark.jpg', '0x15171c')), 'dark');
  fs.rmSync(dir, { recursive: true, force: true });
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
  const ps = Array.from({ length: C }, (_, k) => loopProgress(l, theme, 60 + k));
  assert.ok(ps[0] > 0 && ps.at(-1)! < 1 && ps.every((p, i) => i === 0 || p > ps[i - 1]));
  const last = footageAt(info, l, theme, 60 + C - 1);
  assert.deepEqual([last.src, last.fade?.src], ['f59', 'f0']);
  const [end, start] = [l.pointer[59], l.pointer[0]];
  const first = overlayAt(l, theme, 60), final = overlayAt(l, theme, 60 + C - 1);
  assert.ok(Math.hypot(first.x - end[0], first.y - end[1]) < 5);
  assert.ok(Math.hypot(final.x - start[0], final.y - start[1]) < 5);
});

test('composes a capture into a 2560×1440, 60 fps H.264 MP4', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-compose-'));
  try {
    fs.mkdirSync(path.join(dir, 'frames'));
    execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1440x900:rate=60', '-frames:v', '30', path.join(dir, 'frames/f%05d.jpg')]);
    const frames = Array.from({ length: 30 }, (_, i) => `frames/f${String(i + 1).padStart(5, '0')}.jpg`);
    fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 0, mode: 'studio', fps: 60, size: [1440, 900], frames, renderSeconds: 0, images: 30 }));
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(log(30)));
    const out = path.join(dir, 'out.mp4');
    const r = await compose({ capture: dir, out });
    assert.equal(r.frames, 30 + theme.loop.frames);
    const probe = execFileSync(mediaTool('ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,color_range', '-of', 'json', out], { encoding: 'utf8' });
    const { side_data_list: _, ...stream } = JSON.parse(probe).streams[0];
    assert.deepEqual(stream, { codec_name: 'h264', width: 2560, height: 1440, pix_fmt: 'yuv420p', color_range: 'tv', avg_frame_rate: '60/1', nb_read_frames: String(30 + theme.loop.frames) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the plain theme is just the page: a 1920×1080 page fills the 1920×1080 video to its edges, and the video it replaces is kept as .previous', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-compose-'));
  try {
    fs.mkdirSync(path.join(dir, 'frames'));
    execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x303030:size=1920x1080:rate=60', '-frames:v', '10', '-q:v', '2', path.join(dir, 'frames/f%05d.jpg')]);
    const frames = Array.from({ length: 10 }, (_, i) => `frames/f${String(i + 1).padStart(5, '0')}.jpg`);
    fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 0, mode: 'studio', fps: 60, size: [1920, 1080], frames, renderSeconds: 0, images: 10 }));
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({ ...log(10), viewport: [1920, 1080], loop: 'none', events: [], pointer: Array(10).fill([960, 540]) }));
    const out = path.join(dir, 'out.mp4');
    fs.writeFileSync(out, 'the video before');
    await compose({ capture: dir, out, theme: 'plain' });
    assert.equal(fs.readFileSync(path.join(dir, 'out.previous.mp4'), 'utf8'), 'the video before');
    const probe = JSON.parse(execFileSync(mediaTool('ffprobe'), ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'json', out], { encoding: 'utf8' }));
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [1920, 1080]);
    for (const crop of ['1920:8:0:0', '1920:8:0:1072', '8:1080:0:0', '8:1080:1912:0']) {
      const stats = execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', out, '-frames:v', '1', '-vf', `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-`, '-f', 'null', '-'], { encoding: 'utf8' });
      const max = Number(/YMAX=([\d.]+)/.exec(stats)![1]);
      assert.ok(max < 70, `edge ${crop} has something lighter than the page (brightest ${max})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('several browsers share the frames, and the video keeps them in order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-compose-'));
  try {
    fs.mkdirSync(path.join(dir, 'frames'));
    execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', "color=c=black:size=1440x900:rate=60,format=gray,geq=lum='16+N*6'", '-frames:v', '30', '-q:v', '2', path.join(dir, 'frames/f%05d.jpg')]);
    const frames = Array.from({ length: 30 }, (_, i) => `frames/f${String(i + 1).padStart(5, '0')}.jpg`);
    fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 0, mode: 'studio', fps: 60, size: [1440, 900], frames, renderSeconds: 0, images: 30 }));
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({ ...log(30), loop: 'none', pointer: Array(30).fill([20, 20]) }));
    const out = path.join(dir, 'out.mp4');
    await compose({ capture: dir, out, workers: 3 });
    const stats = execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', out, '-vf', 'crop=400:400:1080:520,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const shades = [...stats.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    assert.equal(shades.length, 30);
    for (let i = 1; i < shades.length; i++) assert.ok(shades[i] > shades[i - 1], `frame ${i} is out of order: ${shades.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compose follows a recording as it happens: same frames, in order, and nothing left if it fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-compose-'));
  try {
    fs.mkdirSync(path.join(dir, 'frames'));
    execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', "color=c=black:size=1440x900:rate=60,format=gray,geq=lum='16+N*6'", '-frames:v', '30', '-start_number', '0', '-q:v', '2', path.join(dir, 'frames/f%05d.jpg')]);
    const done: EventLog = { ...log(30), loop: 'none', pointer: Array(30).fill([20, 20]) };
    const live: EventLog = { ...done, frames: 0, pointer: [], events: [] };
    const out = path.join(dir, 'out.mp4');
    const recording = following();
    const composing = compose({ capture: dir, out, follow: recording.follow });
    for (let f = 0; f < 30; f++) {
      live.pointer.push(done.pointer[f]);
      live.events.push(...done.events.filter((e) => e.frame === f));
      live.frames = f + 1;
      recording.frame(live, f + 1);
      await new Promise((r) => setTimeout(r, 10));
    }
    recording.end(live);
    const r = await composing;
    assert.equal(r.frames, 30);
    const stats = execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-i', out, '-vf', 'crop=400:400:1080:520,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const shades = [...stats.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    assert.equal(shades.length, 30);
    for (let i = 1; i < shades.length; i++) assert.ok(shades[i] > shades[i - 1], `frame ${i} is out of order: ${shades.join(', ')}`);

    const failed = path.join(dir, 'failed.mp4');
    const broken = following();
    const stopped = compose({ capture: dir, out: failed, follow: broken.follow });
    broken.frame({ ...live, frames: 1 }, 1);
    broken.fail(new Error('step 2: can\'t find button "Save"'));
    await assert.rejects(stopped, /can't find button "Save"/);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('failed')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('up to 4 browsers compose at once, fewer on small machines and short videos', () => {
  const GB = 2 ** 30;
  assert.equal(composeWorkers(600, 10, 16 * GB), 4);
  assert.equal(composeWorkers(600, 16, 64 * GB), 4);
  assert.equal(composeWorkers(600, 10, 8 * GB), 2);
  assert.equal(composeWorkers(600, 4, 16 * GB), 2);
  assert.equal(composeWorkers(600, 2, 4 * GB), 1);
  assert.equal(composeWorkers(200, 10, 16 * GB), 2, 'one browser per 2 s of video');
  assert.equal(composeWorkers(70, 10, 16 * GB), 1);
});

function testCapture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-compose-'));
  fs.mkdirSync(path.join(dir, 'frames'));
  execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1440x900:rate=60', '-frames:v', '30', path.join(dir, 'frames/f%05d.jpg')]);
  const frames = Array.from({ length: 30 }, (_, i) => `frames/f${String(i + 1).padStart(5, '0')}.jpg`);
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 0, mode: 'studio', fps: 60, size: [1440, 900], frames, renderSeconds: 0, images: 30 }));
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(log(30)));
  return dir;
}

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
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nhead -c 100000 > /dev/null\necho "disk full" >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(withPath(`${bin}:/usr/bin:/bin`, () => compose({ capture: dir, out: path.join(dir, 'out.mp4') })), /ffmpeg failed \(1\): disk full/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
