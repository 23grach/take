import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from '../src/drivers/web/browser.ts';
import {
  automationSignals,
  chromeUserAgent,
  HARDEN_IGNORE_DEFAULT_ARGS,
  hardenLaunchArgs,
} from '../src/drivers/web/harden.ts';

test('harden launch args drop the automation blink feature and keep capture flags', () => {
  const args = hardenLaunchArgs(['--force-device-scale-factor=2']);
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(args.includes('--hide-scrollbars'));
  assert.ok(args.includes('--force-color-profile=srgb'));
  assert.ok(args.includes('--force-device-scale-factor=2'));
  assert.deepEqual([...HARDEN_IGNORE_DEFAULT_ARGS], ['--enable-automation']);
});

test('chromeUserAgent never says HeadlessChrome', () => {
  const ua = chromeUserAgent('156.0.8078.4', 'linux');
  assert.match(ua, /Chrome\/156\.0\.8078\.4/);
  assert.doesNotMatch(ua, /HeadlessChrome/);
});

test('a hardened context hides the obvious automation signals', async () => {
  const { browser, context, userAgent } = await launch({
    viewport: { width: 400, height: 300 },
    scale: 1,
    preferChromeChannel: false,
  });
  try {
    const page = await context.newPage();
    const { hardenClientHints } = await import('../src/drivers/web/harden.ts');
    await hardenClientHints(context, page, userAgent);
    await page.setContent('<p>hi</p>');
    const s = await automationSignals(page);
    assert.equal(s.webdriver, undefined, `webdriver should be undefined, got ${String(s.webdriver)}`);
    assert.equal(s.hasChrome, true);
    assert.ok(s.plugins >= 1, `expected plugins, got ${s.plugins}`);
    assert.ok(s.languages.length >= 1);
    assert.match(s.userAgent, /Chrome\//);
    assert.doesNotMatch(s.userAgent, /HeadlessChrome/);
  } finally {
    await browser.close();
  }
});

test('client hints no longer advertise HeadlessChrome', async () => {
  const http = await import('node:http');
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(String(req.headers['sec-ch-ua'] ?? ''));
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const { browser, context, userAgent } = await launch({ preferChromeChannel: false });
  try {
    const page = await context.newPage();
    const { hardenClientHints } = await import('../src/drivers/web/harden.ts');
    await hardenClientHints(context, page, userAgent);
    await page.goto(`http://127.0.0.1:${port}/`);
    assert.ok(seen[0], 'expected a sec-ch-ua header');
    assert.doesNotMatch(seen[0], /HeadlessChrome/);
    assert.match(seen[0], /Google Chrome/);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
