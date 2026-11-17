import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from '../src/drivers/web/browser.ts';

test('Chromium opens a page and takes a 2x screenshot', async () => {
  const { browser, context } = await launch({ viewport: { width: 320, height: 200 }, scale: 2 });
  try {
    const page = await context.newPage();
    await page.setContent('<button>New project</button>');
    await page.getByRole('button', { name: 'New project' }).click();
    const png = await page.screenshot();
    assert.equal(png.readUInt32BE(16), 640);
    assert.equal(png.readUInt32BE(20), 400);
  } finally {
    await browser.close();
  }
});
