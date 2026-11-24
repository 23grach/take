import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressWarning, isLocalUrl, shownAddress, validateTake, type WebTarget } from '../src/take/format.ts';
import { stageHtml, layout } from '../src/compose/stage.ts';
import { loadTheme } from '../src/compose/compose.ts';

const web = (url: string, address?: string): WebTarget => ({ kind: 'web', device: 'desktop', url, viewport: [1440, 900], scale: 2, ...(address !== undefined ? { address } : {}) });

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
  const { theme, dir } = loadTheme();
  const html = stageHtml(theme, 'boards.app/<x>', layout(theme, [1440, 900]), {}, dir);
  assert.match(html, /<div class="address glass"><i class="icon"><svg[^]*?<\/svg><\/i><span id="address">boards\.app\/&#60;x&#62;<\/span><\/div>/);
});

test('the window has close, minimize and zoom buttons in the theme\'s colours', () => {
  const { theme, dir } = loadTheme();
  const html = stageHtml(theme, '', layout(theme, [1440, 900]), {}, dir);
  assert.match(html, /<span class="dot close"><\/span><span class="dot minimize"><\/span><span class="dot zoom"><\/span>/);
  for (const b of ['close', 'minimize', 'zoom'] as const)
    assert.ok(html.includes(`.dot.${b} { background: ${theme.window.dots[b].fill}; box-shadow: inset 0 0 0 0.5px ${theme.window.dots[b].outline}; }`), b);
});
