import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bin = new URL('../bin/take', import.meta.url).pathname;

test('take --help prints usage', () => {
  const out = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.match(out, /Usage: take <command>/);
});

test('take --version prints the package version', () => {
  const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test('a mistyped option is an error, not silently ignored', () => {
  const r = spawnSync(process.execPath, [bin, 'run', 'take.json', '--mod', 'live'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown option '--mod'/);
});

test('a wrong --mode is named', () => {
  const r = spawnSync(process.execPath, [bin, 'record', 'take.json', '--mode', 'fast'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--mode must be studio or live, got "fast"/);
});

test('a missing ffprobe is one plain line pointing to take doctor, not a stack trace', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'take-cli-'));
  try {
    const video = path.join(dir, 'v.mp4');
    writeFileSync(video, '');
    const r = spawnSync(process.execPath, [bin, 'check', video], { encoding: 'utf8', env: { ...process.env, PATH: dir } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^✗ take check: ffprobe isn't installed .*take doctor to see how to install it\.\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
