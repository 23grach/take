import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bin = fileURLToPath(new URL('../bin/take', import.meta.url));

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

const fixture = fileURLToPath(new URL('./fixtures/create-project.take.json', import.meta.url));
const takeCli = (args: string[], env = process.env, at = bin) => spawnSync(process.execPath, [at, ...args], { encoding: 'utf8', env });

test('an option the command does not use is an error', () => {
  const r = takeCli(['probe', fixture, '--mode', 'live']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^take probe doesn't take --mode \(it takes --out, --theme, --headed\)\n$/);
});

test('a second file name is an error', () => {
  const r = takeCli(['validate', fixture, 'other.json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /too many names/);
});

test('validate names a missing theme and a wrong key, with the right one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'take-cli-'));
  try {
    const file = path.join(dir, 'take.json');
    const base = { version: 0, title: 'T', target: { kind: 'web', url: 'http://127.0.0.1:9/', address: 'x.app' } };
    writeFileSync(file, JSON.stringify({ ...base, theme: 'defualt', steps: [{ do: 'hold', ms: 100 }] }));
    let r = takeCli(['validate', file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /theme: there's no theme "defualt"\. Themes: default/);
    writeFileSync(file, JSON.stringify({ ...base, steps: [{ do: 'press', key: 'Cmd+K' }] }));
    r = takeCli(['validate', file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /steps\[0\]\.key: unknown key "Cmd"; use Meta \(e\.g\. "Meta\+K"\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Take works from a folder whose path has a space, and explains a missing install', () => {
  const home = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'take cli '));
  try {
    for (const f of ['bin', 'src', 'themes', 'package.json']) cpSync(path.join(home, f), path.join(dir, 'my take', f), { recursive: true });
    const copy = path.join(dir, 'my take', 'bin', 'take');
    let r = takeCli(['validate', fixture], process.env, copy);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^✗ Take's packages aren't installed yet\. Run this once:\n {2}cd ".*my take" && npm ci --omit=dev\n$/);
    symlinkSync(path.join(home, 'node_modules'), path.join(dir, 'my take', 'node_modules'));
    r = takeCli(['validate', fixture], process.env, copy);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^✓ /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
