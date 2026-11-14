import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressWarning, isLocalUrl, shownAddress, validateTake, type WebTarget } from '../src/take/format.ts';
import { stageHtml, layout } from '../src/compose/stage.ts';
import { loadTheme } from '../src/compose/compose.ts';

const web = (url: string, address?: string): WebTarget => ({ kind: 'web', url, viewport: [1440, 900], scale: 2, ...(address !== undefined ? { address } : {}) });

test('the address bar never shows where the app runs locally', () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:4300/', 'http://app.test/', 'http://boards.local/x', 'http://192.168.1.20/', 'http://10.0.0.5:8080/'])
    assert.ok(isLocalUrl(url), url);
  assert.equal(shownAddress(web('http://127.0.0.1:4300/')), '');
  assert.match(addressWarning(web('http://127.0.0.1:4300/')) ?? '', /blank.*target\.address/);
});

test('the take\'s address wins; a public URL shows its own domain', () => {
  assert.equal(shownAddress(web('http://127.0.0.1:4300/', 'boards.app')), 'boards.app');
  assert.equal(shownAddress(web('https://staging.boards.app/', 'boards.app/projects')), 'boards.app/projects');
  assert.equal(shownAddress(web('https://boards.app/')), 'boards.app');
  assert.equal(shownAddress(web('https://boards.app/projects/')), 'boards.app/projects');
  assert.equal(addressWarning(web('https://boards.app/')), undefined);
  assert.equal(addressWarning(web('http://localhost:3000/', 'boards.app')), undefined);
});

test('address is checked like the rest of the take', () => {
  const take = (address: unknown) => validateTake({ version: 0, title: 't', target: { kind: 'web', url: 'http://localhost:3000/', address }, steps: [{ do: 'hold', ms: 100 }] });
  const ok = take('  boards.app ');
  assert.ok(ok.ok && ok.take.target.address === 'boards.app');
  for (const bad of ['https://boards.app', 'boards app', 42]) {
    const r = take(bad);
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith('target.address')), String(bad));
  }
});

test('the stage puts the address in the bar, escaped', () => {
  const { theme } = loadTheme();
  const html = stageHtml(theme, 'boards.app/<x>', layout(theme, [1440, 900]), {});
  assert.match(html, /<div class="address">boards\.app\/&#60;x&#62;<\/div>/);
});
