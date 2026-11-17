import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { launchBrowser } from '../../browser-binary.ts';
import { applyHarden, chromeUserAgent, hardenClientHints, hardenLaunchOptions } from './harden.ts';
export { isLoginName } from '../../take/format.ts';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface SavedLogin {
  url: string;
  savedAt: string;
  userAgent: string;
  state: StorageState;
}

const SAVE_EVERY_MS = 2000;

export function loginsDir(): string {
  return path.join(process.env.TAKE_HOME ?? path.join(os.homedir(), '.take'), 'logins');
}

export const loginPath = (name: string) => path.join(loginsDir(), `${name}.json`);

export function defaultLoginName(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

export function readLogin(name: string): SavedLogin | undefined {
  const file = loginPath(name);
  if (!fs.existsSync(file)) return undefined;
  const login = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedLogin;
  if (!login?.state || !Array.isArray(login.state.cookies)) throw new Error(`${file} isn't a saved login`);
  return login;
}

export function savedLogins(): string[] {
  if (!fs.existsSync(loginsDir())) return [];
  return fs.readdirSync(loginsDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function forgetLogin(name: string): boolean {
  const file = loginPath(name);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

export function writeLogin(name: string, login: SavedLogin) {
  fs.mkdirSync(loginsDir(), { recursive: true, mode: 0o700 });
  const file = loginPath(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(login), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface SignInResult {
  file: string;
  cookies: number;
  sites: string[];
}

export async function signIn(
  url: string,
  name: string,
  { headless = false, act }: { headless?: boolean; act?: (page: Page) => Promise<unknown> } = {},
): Promise<SignInResult> {
  const previous = readLogin(name);
  const browser = await launchForLogin(headless);
  try {
    const userAgent = previous?.userAgent ?? chromeUserAgent(browser.version());
    const context = await browser.newContext({
      viewport: null,
      locale: 'en-US',
      userAgent,
      ...(previous ? { storageState: previous.state } : {}),
    });
    await applyHarden(context);
    const page = await context.newPage();
    await hardenClientHints(context, page, userAgent);
    let last: StorageState | undefined;
    let saving: Promise<void> | undefined;
    const keep = (state: StorageState) => {
      last = state;
      writeLogin(name, { url, savedAt: new Date().toISOString(), userAgent, state });
    };
    let origins = new Map((previous?.state.origins ?? []).map((o) => [o.origin, o]));
    const quickSave = () =>
      (saving ??= quickState(context, origins)
        .then((state) => {
          origins = new Map(state.origins.map((o) => [o.origin, o]));
          keep(state);
        })
        .catch(() => {})
        .finally(() => (saving = undefined)));

    const closed = new Promise<void>((resolve) => {
      const check = () => setTimeout(() => (context.pages().length === 0 ? resolve() : undefined), 100);
      const watch = (p: Page) => p.on('close', check);
      watch(page);
      context.on('page', watch);
      browser.on('disconnected', () => resolve());
    });
    const timer = setInterval(quickSave, SAVE_EVERY_MS);
    await page.goto(url, { timeout: 60_000 }).catch(() => {});
    if (act) await act(page);
    await closed;
    clearInterval(timer);
    await saving;
    if (browser.isConnected()) await context.storageState({ indexedDB: true }).then(keep).catch(() => quickSave());
    if (!last) throw new Error(`the browser closed before anything was saved; run take login ${url} again`);
    const sites = [...new Set(last.cookies.map((c) => c.domain.replace(/^\./, '').replace(/^www\./, '')))].sort();
    return { file: loginPath(name), cookies: last.cookies.length, sites };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function quickState(context: BrowserContext, before: Map<string, StorageState['origins'][number]>): Promise<StorageState> {
  const origins = new Map(before);
  for (const p of context.pages()) {
    const found = await p
      .evaluate(() => ({ origin: location.origin, localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) }))
      .catch(() => undefined);
    if (!found || !found.origin.startsWith('http')) continue;
    const prior = origins.get(found.origin);
    origins.set(found.origin, { ...prior, origin: found.origin, localStorage: found.localStorage });
  }
  return { cookies: await context.cookies(), origins: [...origins.values()].filter((o) => o.localStorage.length || (o as { indexedDB?: unknown[] }).indexedDB?.length) };
}

function launchForLogin(headless: boolean) {
  return launchBrowser(hardenLaunchOptions({ headed: !headless }));
}
