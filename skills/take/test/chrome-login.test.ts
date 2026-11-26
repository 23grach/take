import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { chromePaths } from '../src/browser-binary.ts';
import { belongsTo, chromeEndpoint, loginFromChrome } from '../src/drivers/web/chrome-login.ts';

test('cookies belong to the site and its subdomains, not to other sites', () => {
  assert.ok(belongsTo('.social.example', 'https://social.example/home'));
  assert.ok(belongsTo('social.example', 'https://www.social.example/'));
  assert.ok(belongsTo('api.social.example', 'https://social.example/'));
  assert.ok(belongsTo('.boards.app', 'https://app.boards.app/'));
  assert.ok(!belongsTo('.notsocial.example', 'https://social.example/'));
  assert.ok(!belongsTo('.other.example', 'https://social.example/'));
});

test('no connection file: says how to turn remote debugging on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-chrome-'));
  assert.equal(chromeEndpoint(dir), undefined);
  await assert.rejects(loginFromChrome('https://social.example/', ''), /chrome:\/\/inspect\/#remote-debugging/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copies only the site\'s cookies and Chrome\'s user agent from a running Chrome', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-chrome-'));
  const binary = chromePaths().find((p) => fs.existsSync(p)) ?? chromium.executablePath();
  const proc = spawn(binary, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let endpoint: string | undefined;
    for (let i = 0; i < 100 && !(endpoint = chromeEndpoint(dir)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(endpoint, 'Chromium wrote DevToolsActivePort');
    const ws = new WebSocket(endpoint);
    await new Promise((r) => ws.addEventListener('open', r));
    const cookie = (name: string, domain: string) => ({ name, value: `v-${name}`, domain, path: '/', secure: true, httpOnly: true, expires: Date.now() / 1000 + 3600 });
    ws.send(JSON.stringify({ id: 1, method: 'Storage.setCookies', params: { cookies: [cookie('auth_token', '.social.example'), cookie('api', 'api.social.example'), cookie('other', '.example.org')] } }));
    await new Promise((r) => ws.addEventListener('message', r));
    ws.close();

    const login = await loginFromChrome('https://social.example/home', endpoint);
    assert.deepEqual(login.state.cookies.map((c) => c.name).sort(), ['api', 'auth_token']);
    assert.equal(login.state.cookies.find((c) => c.name === 'auth_token')?.value, 'v-auth_token');
    assert.match(login.userAgent, /Chrome\/\d+/);
    assert.doesNotMatch(login.userAgent, /Headless/);
    await assert.rejects(loginFromChrome('https://boards.app/', endpoint), /no login for boards\.app/);
  } finally {
    proc.kill();
    await new Promise((r) => proc.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a connection file macOS won\'t let Take read says what permission to give', { skip: process.getuid?.() === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-chrome-'));
  const file = path.join(dir, 'DevToolsActivePort');
  fs.writeFileSync(file, '9222\n/devtools/browser/x\n');
  fs.chmodSync(file, 0);
  try {
    assert.throws(() => chromeEndpoint(dir), /Full Disk Access/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
