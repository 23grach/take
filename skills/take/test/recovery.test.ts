import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openTake } from '../src/drivers/web/browser.ts';
import { realtimeClock } from '../src/drivers/web/clock.ts';
import { perform, TakeError } from '../src/drivers/web/driver.ts';
import { validateTake, type Take } from '../src/take/format.ts';
import { withShortFind } from './short-find.ts';

const page = (body: string, script = '') => `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; font: 16px system-ui; } button { font: inherit; padding: 10px 16px; cursor: pointer; }
  #toast { position: fixed; left: 0; right: 0; top: 0; height: 200px; background: #222; color: #fff; }
</style>${body}<p id="log"></p><script>
  const log = (t) => (document.getElementById('log').textContent += t + ';');
  ${script}
</script>`;

const PAGES: Record<string, string> = {
  '/slow': page('<main id="m">Loading…</main>', `
    fetch('/data').then((r) => r.text()).then((t) => { m.innerHTML = '<button onclick="log(\\'go\\')">' + t + '</button>'; });`),
  '/below': page('<div style="height: 1800px">Top</div><button onclick="log(\'far\')">Far down</button><div style="height: 600px"></div>'),
  '/covered': page('<div style="padding-top: 80px"><button onclick="log(\'save\')">Save</button></div><div id="toast">Saved a draft</div>', `
    setTimeout(() => toast.remove(), 2500);`),
  '/late': page('<button id="b" disabled onclick="log(\'send\')">Send</button>', `
    setTimeout(() => (b.disabled = false), 2500);`),
  '/rerender': page('<div id="w"></div>', `
    const draw = () => (w.innerHTML = '<button onclick="log(\\'ok\\')">Again</button>');
    draw();
    addEventListener('mousemove', () => { const t = setInterval(draw, 120); setTimeout(() => clearInterval(t), 500); }, { once: true });`),
  '/blocked': page('<div style="padding-top: 80px"><button>Save</button></div><div id="toast" aria-label="Cookie banner">We use cookies</div>'),
  '/twins': page('<button>Create</button><button>Create project</button>'),
  '/throws': page('<button onclick="null.x">Break</button>'),
  '/load-error': page('<p>Hi</p>', `undefinedFunction();`),
};

let server: http.Server;
let base: string;
let noHiddenHits = 0;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/data') return void setTimeout(() => res.end('Ready'), 1500);
    if (req.url === '/broken') return void res.writeHead(500).end('Internal error');
    if (req.url === '/forbidden') return void res.writeHead(403).end('Forbidden');
    if (req.url === '/no-hidden') {
      noHiddenHits += 1;
      if (noHiddenHits === 1) return void res.writeHead(403).end('Forbidden');
      return void res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>Welcome</p>');
    }
    const html = PAGES[req.url ?? ''];
    if (!html) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise((r) => server.close(r)));

function take(path: string, steps: unknown[]): Take {
  const r = validateTake({ version: 0, title: 't', target: { kind: 'web', url: base + path, viewport: [800, 600], scale: 1 }, steps });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.take;
}

async function play(path: string, steps: unknown[]) {
  const { browser, page } = await openTake(take(path, steps));
  try {
    const log = await perform(page, take(path, steps), realtimeClock());
    return { log, clicked: await page.locator('#log').textContent() };
  } finally {
    await browser.close();
  }
}

async function failure(path: string, steps: unknown[]): Promise<string> {
  const err = await withShortFind(() => play(path, steps)).then(() => undefined, (e) => e);
  assert.ok(err instanceof TakeError, `expected a TakeError, got ${err}`);
  return err.message;
}

const click = (name: string) => ({ do: 'click', target: { role: 'button', name, exact: true } });

test('waits for a slow app to finish loading before the first step', async () => {
  const { clicked } = await play('/slow', [click('Ready')]);
  assert.equal(clicked, 'go;');
});

test('scrolls to a button below the fold, like a person would', async () => {
  const { log, clicked } = await play('/below', [click('Far down')]);
  assert.equal(clicked, 'far;');
  assert.ok(log.events.some((e) => e.type === 'scroll'), 'the scroll is in the video, not a jump');
});

test('waits for a toast passing over the button, then clicks', async () => {
  assert.equal((await play('/covered', [click('Save')])).clicked, 'save;');
});

test('waits for a button that enables a moment later', async () => {
  assert.equal((await play('/late', [click('Send')])).clicked, 'send;');
});

test('follows a button that is re-rendered while the cursor travels to it', async () => {
  assert.equal((await play('/rerender', [click('Again')])).clicked, 'ok;');
});

test('says what is in the way when something stays on top', async () => {
  assert.match(await failure('/blocked', [click('Save')]), /^step 1: button "Save" is covered by div "Cookie banner"$/);
});

test('names the matches when a target is ambiguous', async () => {
  assert.equal(
    await failure('/twins', [{ do: 'click', target: { role: 'button', name: 'Create' } }]),
    'step 1: 2 elements match button "Create" ("Create", "Create project"); make the target more specific (add "exact": true, or use a role and name)',
  );
});

test('stops with a clear message when the app throws', async () => {
  assert.match(await failure('/throws', [click('Break'), { do: 'hold', ms: 300 }]), /^step 1: the app threw an error: ".*null.*"\. Take stops rather than film a broken app/);
});

test('opening the app: error pages and errors while loading are explained', async () => {
  const open = (path: string) => openTake(take(path, [{ do: 'hold', ms: 100 }])).then(() => '', (e) => (e instanceof TakeError ? e.message : `not a TakeError: ${e}`));
  assert.match(await open('/broken'), /^opening the app: .*\/broken answered with error 500/);
  assert.match(await open('/load-error'), /^opening the app: the app threw an error while loading: ".*undefinedFunction.*"/);
});

test('a site that refuses the hidden browser opens in a visible window instead', async () => {
  noHiddenHits = 0;
  const t = take('/no-hidden', [{ do: 'hold', ms: 100 }]);
  const { browser, page, visible } = await openTake(t);
  try {
    assert.equal(visible, true);
    assert.equal(await page.locator('p').textContent(), 'Welcome');
  } finally {
    await browser.close();
  }
  const err = await openTake(take('/forbidden', [{ do: 'hold', ms: 100 }])).then(() => undefined, (e) => e);
  assert.ok(err instanceof TakeError);
  assert.match(err.message, /^opening the app: .*\/forbidden answered with error 403; check the address/);
});
