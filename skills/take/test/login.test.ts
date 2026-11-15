// Saved logins: sign in once in a browser window, and takes that name the login start signed in.
import { test, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';

// Logins go to a scratch folder, never to the real ~/.take.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'take-login-'));
process.env.TAKE_HOME = home;

const { signIn, readLogin, loginPath, defaultLoginName, forgetLogin } = await import('../src/drivers/web/login.ts');
const { openTake } = await import('../src/drivers/web/browser.ts');
const { TakeError } = await import('../src/drivers/web/driver.ts');
const { validateTake } = await import('../src/take/format.ts');

// A site that remembers who signed in: a cookie for the server, a name in local storage for the page.
const SITE = `<!doctype html><meta charset="utf-8"><main id="who"></main><button id="in">Sign in</button><script>
  const signedIn = document.cookie.includes('session=s3cret');
  who.textContent = signedIn ? 'Signed in as ' + localStorage.getItem('name') : 'Signed out';
  document.getElementById('in').onclick = () => { document.cookie = 'session=s3cret; max-age=3600'; localStorage.setItem('name', 'Sam'); location.reload(); };
</script>`;

let server: http.Server;
let base: string;
before(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SITE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  return new Promise((r) => server.close(r));
});

const takeWith = (login: string) => {
  const r = validateTake({ version: 0, title: 't', target: { kind: 'web', url: base, viewport: [800, 600], scale: 1, login }, steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.take;
};

test('a login is named after the site, without www', () => {
  assert.equal(defaultLoginName('https://www.boards.app/projects'), 'boards.app');
  assert.equal(defaultLoginName('http://127.0.0.1:4300/'), '127.0.0.1');
});

test('signing in saves the login, privately, when the window closes', async () => {
  const r = await signIn(base, 'demo', {
    headless: true,
    act: async (page) => {
      await page.click('#in');
      await page.getByText('Signed in as Sam').waitFor();
      await page.close();
    },
  });
  assert.equal(r.file, loginPath('demo'));
  assert.equal(r.cookies, 1);
  assert.deepEqual(r.sites, ['127.0.0.1']);
  assert.equal(fs.statSync(r.file).mode & 0o777, 0o600, 'only this user can read the login');
  const saved = readLogin('demo')!;
  assert.equal(saved.url, base);
  assert.ok(saved.userAgent.includes('Chrome'));
  assert.ok(saved.state.origins.some((o) => o.localStorage.some((i) => i.name === 'name' && i.value === 'Sam')));
});

test('the sign-in window never opens extra tabs while the person is signing in', async () => {
  // Sign in on one site, then move on to another, so the first has no tab open while saves keep running.
  let extraTabs = 0;
  const r = await signIn(base, 'two-sites', {
    headless: true,
    act: async (page) => {
      // Watch the browser itself: Playwright's own helper tabs never show up as context 'page' events.
      const cdp = await page.context().browser()!.newBrowserCDPSession();
      cdp.on('Target.targetCreated', ({ targetInfo }) => void (targetInfo.type === 'page' && extraTabs++));
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      extraTabs = 0; // the window's own tab, reported when discovery starts
      await page.click('#in');
      await page.getByText('Signed in as Sam').waitFor();
      await page.waitForTimeout(2500);
      await page.goto(base.replace('127.0.0.1', 'localhost'));
      await page.waitForTimeout(4500);
      assert.equal(extraTabs, 0, 'a save opened a tab in the sign-in window');
      await page.close();
    },
  });
  assert.equal(r.cookies, 1);
  const saved = readLogin('two-sites')!;
  assert.ok(saved.state.origins.some((o) => o.origin === base.slice(0, -1) && o.localStorage.some((i) => i.value === 'Sam')));
  forgetLogin('two-sites');
});

test('a take that names the login starts signed in, in the same browser', async () => {
  const { browser, page } = await openTake(takeWith('demo'));
  try {
    assert.equal(await page.locator('#who').textContent(), 'Signed in as Sam');
    assert.equal(await page.evaluate(() => navigator.userAgent), readLogin('demo')!.userAgent);
  } finally {
    await browser.close();
  }
});

test('a take without a login still starts signed out', async () => {
  const r = validateTake({ version: 0, title: 't', target: { kind: 'web', url: base, viewport: [800, 600], scale: 1 }, steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(r.ok);
  const { browser, page } = await openTake(r.take);
  try {
    assert.equal(await page.locator('#who').textContent(), 'Signed out');
  } finally {
    await browser.close();
  }
});

test('a missing login stops the take and says how to make it', async () => {
  const err = await openTake(takeWith('nobody.app')).then(() => undefined, (e) => e);
  assert.ok(err instanceof TakeError, `expected a TakeError, got ${err}`);
  assert.match(err.message, /no saved login "nobody\.app" yet\. Sign in once: take login http:\/\/127\.0\.0\.1:\d+\/ --name nobody\.app/);
});

test('validate says whether the login exists', () => {
  const dir = fs.mkdtempSync(path.join(home, 'take-'));
  const file = path.join(dir, 'take.json');
  const bin = fileURLToPath(new URL('../bin/take', import.meta.url));
  const env = { ...process.env, TAKE_HOME: home };
  fs.writeFileSync(file, JSON.stringify({ version: 0, title: 't', target: { kind: 'web', url: base, login: 'demo' }, steps: [{ do: 'hold', ms: 100 }] }));
  assert.match(spawnSync(process.execPath, [bin, 'validate', file], { encoding: 'utf8', env }).stdout, /starts signed in with the saved login "demo"/);
  fs.writeFileSync(file, JSON.stringify({ version: 0, title: 't', target: { kind: 'web', url: base, login: 'other' }, steps: [{ do: 'hold', ms: 100 }] }));
  assert.match(spawnSync(process.execPath, [bin, 'validate', file], { encoding: 'utf8', env }).stdout, /⚠ no saved login "other" yet/);
});

test('login names that could escape the logins folder are rejected', () => {
  for (const login of ['../secrets', 'a/b', '', 'with space']) {
    const r = validateTake({ version: 0, title: 't', target: { kind: 'web', url: base, login }, steps: [{ do: 'hold', ms: 100 }] });
    assert.equal(r.ok, false, `"${login}" should be rejected`);
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith('target.login')), JSON.stringify(r));
  }
  const typo = validateTake({ version: 0, title: 't', target: { kind: 'web', url: base, logn: 'demo' }, steps: [{ do: 'hold', ms: 100 }] });
  assert.ok(!typo.ok && typo.errors.some((e) => e.includes('did you mean "login"')));
});

test('logout forgets a login and names the ones left', () => {
  const bin = fileURLToPath(new URL('../bin/take', import.meta.url));
  const env = { ...process.env, TAKE_HOME: home };
  const out = (name: string) => spawnSync(process.execPath, [bin, 'logout', name], { encoding: 'utf8', env });
  fs.copyFileSync(loginPath('demo'), loginPath('spare'));
  const ok = out('spare');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /Forgot the login "spare"/);
  assert.equal(readLogin('spare'), undefined);
  const missing = out('spare');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no saved login "spare" \(saved logins: demo\)/);
});
