// Runs after `npm install`. With Google Chrome installed, Take records with it and downloads nothing.
// Without it, Playwright's Chromium is downloaded once, without Playwright's separate headless-only build.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hasChrome } from './browser-binary.ts';

if (hasChrome()) {
  console.log('Take will record with your Google Chrome: nothing to download.');
} else {
  console.log('Google Chrome not found: downloading Chromium for Take (once, about 200 MB).');
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
