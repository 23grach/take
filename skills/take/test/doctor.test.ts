import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, formatReport, type Probe } from '../src/doctor.ts';

const healthy: Probe = {
  platform: 'darwin',
  nodeVersion: '26.8.2',
  async run(cmd, args) {
    if (args.includes('-encoders')) return ' V....D libx264   libx264 H.264';
    return `${cmd} version 9.0.1 Copyright`;
  },
  async browser() {
    return 'Chromium 156.0.8078.4 (Playwright)';
  },
};

test('all checks pass on a healthy machine', async () => {
  const results = await runChecks(healthy);
  assert.deepEqual(
    results.map((r) => [r.name, r.ok]),
    [['Node', true], ['Browser', true], ['ffmpeg', true], ['H.264 encoder', true], ['ffprobe', true]],
  );
  assert.match(formatReport(results), /All good/);
});

test('missing tools come with a fix', async () => {
  const broken: Probe = {
    ...healthy,
    nodeVersion: '20.11.0',
    async run() {
      return null;
    },
    async browser() {
      throw new Error('Executable doesn’t exist');
    },
  };
  const results = await runChecks(broken);
  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(failed.map((r) => r.name), ['Node', 'Browser', 'ffmpeg', 'ffprobe']);
  assert.ok(failed.every((r) => r.fix));
  assert.equal(results.find((r) => r.name === 'ffmpeg')?.fix, 'brew install ffmpeg');
  assert.match(formatReport(results), /4 problems to fix/);
});

test('ffmpeg without libx264 is flagged', async () => {
  const results = await runChecks({ ...healthy, async run(cmd, args) {
    return args.includes('-encoders') ? ' V....D libvpx' : `${cmd} version 9.0.1`;
  } });
  assert.equal(results.find((r) => r.name === 'H.264 encoder')?.ok, false);
});
