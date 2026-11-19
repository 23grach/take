import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { run } from '../src/run.ts';
import type { EventLog } from '../src/drivers/web/events.ts';
import { mediaTool } from '../src/media-tools.ts';

const page = `<!doctype html><body style="font:24px sans-serif">
<button id="chime">Chime</button> <button id="tone">Tone</button> <button id="stream">Stream</button>
<p id="state">loading</p><audio id="player"></audio>
<script>
  chime.onclick = () => new Audio('/chime.wav').play();
  let ctx;
  tone.onclick = () => {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator();
    o.connect(ctx.destination);
    o.start(ctx.currentTime + 0.25);
    o.stop(ctx.currentTime + 0.45);
  };
  const source = new MediaSource();
  player.src = URL.createObjectURL(source);
  source.addEventListener('sourceopen', async () => {
    const buffer = source.addSourceBuffer('audio/webm; codecs="opus"');
    const bytes = new Uint8Array(await (await fetch('/stream.webm')).arrayBuffer());
    const n = Math.ceil(bytes.length / 3);
    for (let i = 0; i < 3; i++) {
      buffer.appendBuffer(bytes.subarray(i * n, (i + 1) * n));
      await new Promise((r) => buffer.addEventListener('updateend', r, { once: true }));
    }
    source.endOfStream();
    player.currentTime = 10;
    state.textContent = 'stream ready';
  });
  stream.onclick = () => player.play();
</script>`;

let tmp: string;
let server: http.Server;
let url: string;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'take-sound-'));
  execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=1000:d=0.2', '-ar', '48000', path.join(tmp, 'chime.wav')]);
  execFileSync(mediaTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=600:d=0.3', '-c:a', 'libopus', '-output_ts_offset', '10', path.join(tmp, 'stream.webm')]);
  const files: Record<string, string> = { '/chime.wav': 'audio/wav', '/stream.webm': 'audio/webm' };
  server = http.createServer((req, res) => {
    const type = files[req.url ?? ''];
    if (type) res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(path.join(tmp, req.url!)));
    else res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const click = (name: string) => ({ do: 'click', target: { role: 'button', name } });

async function runTake(name: string, steps: unknown[], extra: Record<string, unknown> = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'take.json');
  fs.writeFileSync(file, JSON.stringify({ version: 0, title: name, target: { kind: 'web', url, viewport: [640, 400], scale: 1 }, ready: { text: 'stream ready' }, loop: 'none', steps, ...extra }));
  const { video, capture, error } = await run(file);
  if (!video || !capture) throw new Error(error);
  return { video, capture, events: JSON.parse(fs.readFileSync(path.join(capture, 'events.json'), 'utf8')) as EventLog };
}

function streams(video: string): { codec_type: string; codec_name: string; duration: string }[] {
  return JSON.parse(execFileSync(mediaTool('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', video], { encoding: 'utf8' })).streams;
}

function soundStarts(video: string, length: number): number[] {
  const r = spawnSync(mediaTool('ffmpeg'), ['-hide_banner', '-i', video, '-af', 'silencedetect=n=-40dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' });
  return [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]).filter((t) => t < length - 0.01);
}

test('the page\'s own sounds land on the frames they were made on, under the video', async () => {
  const { video, capture, events } = await runTake('three-ways', [
    { do: 'hold', ms: 300 }, click('Chime'), { do: 'hold', ms: 500 }, click('Tone'), { do: 'hold', ms: 700 }, click('Stream'), { do: 'hold', ms: 600 },
  ]);
  const clicks = events.events.filter((e) => e.type === 'up').map((e) => e.frame / events.fps);
  assert.equal(clicks.length, 3);
  const expected = [clicks[0], clicks[1] + 0.25, clicks[2]];
  const length = events.frames / events.fps;
  const starts = soundStarts(video, length);
  assert.equal(starts.length, 3, `sound starts at ${starts.join(', ')} s; expected ${expected.map((t) => t.toFixed(3)).join(', ')} s`);
  starts.forEach((t, i) => assert.ok(Math.abs(t - expected[i]) <= 1 / 60, `sound ${i + 1} starts at ${t} s, expected ${expected[i].toFixed(3)} s`));

  const s = streams(video);
  assert.deepEqual(s.map((x) => [x.codec_type, x.codec_name]), [['video', 'h264'], ['audio', 'aac']]);
  assert.ok(Math.abs(+s[1].duration - length) <= 1 / 60, `sound lasts ${s[1].duration} s, the video ${length} s`);
  assert.ok(fs.existsSync(path.join(capture, 'sound.json')));
});

test('"sound": false leaves the video silent, and catches nothing', async () => {
  const { video, capture } = await runTake('no-sound', [{ do: 'hold', ms: 200 }, click('Chime'), { do: 'hold', ms: 300 }], { sound: false });
  assert.deepEqual(streams(video).map((x) => x.codec_type), ['video']);
  assert.ok(!fs.existsSync(path.join(capture, 'sound.json')));
});

test('a page that makes no sound gets no sound track', async () => {
  const { video, capture } = await runTake('silent', [{ do: 'hold', ms: 300 }]);
  assert.deepEqual(streams(video).map((x) => x.codec_type), ['video']);
  assert.ok(!fs.existsSync(path.join(capture, 'sound.json')) && !fs.existsSync(path.join(capture, 'sound')));
});
