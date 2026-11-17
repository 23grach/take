import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type LaunchOptions } from 'playwright';

export function chromePaths(platform: NodeJS.Platform = process.platform, env = process.env): string[] {
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (platform === 'linux') return ['/opt/google/chrome/chrome'];
  if (platform === 'win32') {
    return [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]
      .filter((dir): dir is string => !!dir)
      .map((dir) => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return [];
}

export function hasChrome(): boolean {
  return chromePaths().some((p) => fs.existsSync(p));
}

export const UNTHROTTLED = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

export const DOWNLOAD_CHROMIUM = 'npx playwright install chromium --no-shell';
export const NO_BROWSER = `no browser to record with: install Google Chrome, or run "${DOWNLOAD_CHROMIUM}" in Take's folder`;

const isMissing = (e: unknown) => /Executable doesn.t exist/i.test(String((e as Error)?.message ?? e));

const chromes = new WeakSet<Browser>();
let chromeFailed = false;

export async function launchBrowser(options: LaunchOptions = {}, { chrome = true } = {}): Promise<Browser> {
  let chromeError: unknown;
  if (chrome && hasChrome()) {
    try {
      const browser = await chromium.launch({ ...options, channel: 'chrome' });
      chromes.add(browser);
      return browser;
    } catch (e) {
      chromeError = e;
      chromeFailed = true;
    }
  }
  try {
    return await chromium.launch({ ...options, channel: 'chromium' });
  } catch (e) {
    if (!isMissing(e)) throw e;
    if (chromeError) throw chromeError;
    throw new Error(NO_BROWSER);
  }
}

export async function browserLabel(): Promise<string> {
  const browser = await launchBrowser();
  try {
    const version = browser.version();
    if (chromes.has(browser)) return `Google Chrome ${version}`;
    return `Chromium ${version} (Playwright${chromeFailed ? "; Google Chrome is installed but didn't start" : ''})`;
  } finally {
    await browser.close();
  }
}
