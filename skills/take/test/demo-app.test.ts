import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { serve } from '../examples/demo-app/serve.mjs';
import { launch } from '../src/drivers/web/browser.ts';

let app: { url: string; close: () => Promise<unknown> };
let browser: Browser;
let context: Awaited<ReturnType<typeof launch>>['context'];

before(async () => {
  app = await serve(0);
  ({ browser, context } = await launch());
});
after(async () => {
  await browser.close();
  await app.close();
});

test('demo app: create a project', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(app.url);

  const projects = page.getByRole('list', { name: 'Projects' });
  assert.equal(await projects.getByRole('listitem').count(), 3);

  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.waitFor();
  const create = dialog.getByRole('button', { name: 'Create' });
  assert.equal(await create.isDisabled(), true, 'Create is disabled until a name is typed');

  await dialog.getByLabel('Name').fill('Moodboard');
  await create.click();

  await projects.getByRole('heading', { name: 'Moodboard' }).waitFor();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await projects.getByRole('listitem').count(), 4);
  assert.equal(await page.getByText('4 projects').count(), 1);
  assert.match((await page.getByRole('status').textContent()) ?? '', /Moodboard/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('demo app: Escape closes the dialog without adding', async () => {
  const page = await context.newPage();
  await page.goto(app.url);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill('Draft');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('list', { name: 'Projects' }).getByRole('listitem').count(), 3);
  await page.close();
});
