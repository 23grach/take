// Saved logins: a person signs in once, by hand, in a visible browser window; Take saves that browser's login
// and every probe and recording of a take that names it starts signed in. Take never sees or types a password.
// Logins live outside the project (~/.take/logins/<name>.json, readable only by this user), so they never end up
// in git or in a takes folder someone shares.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { applyHarden, chromeUserAgent, hardenClientHints, hardenLaunchOptions } from './harden.ts';
export { isLoginName } from '../../take/format.ts';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface SavedLogin {
  /** The page the person signed in on. */
  url: string;
  savedAt: string;
  /** The browser's user agent while signing in. Recordings reuse it: some sites tie a login to it. */
  userAgent: string;
  /** Cookies, local storage and IndexedDB, as Playwright saves them. */
  state: StorageState;
}

/** How often the open window's login is saved, so quitting the browser instead of closing the window keeps it. */
const SAVE_EVERY_MS = 2000;

export function loginsDir(): string {
  return path.join(process.env.TAKE_HOME ?? path.join(os.homedir(), '.take'), 'logins');
}

export const loginPath = (name: string) => path.join(loginsDir(), `${name}.json`);

/** The name a login gets unless told otherwise: the site's domain, e.g. "boards.app". */
export function defaultLoginName(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

/** The saved login with this name, or undefined if there is none. Throws if the file is unreadable. */
export function readLogin(name: string): SavedLogin | undefined {
  const file = loginPath(name);
  if (!fs.existsSync(file)) return undefined;
  const login = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedLogin;
  if (!login?.state || !Array.isArray(login.state.cookies)) throw new Error(`${file} isn't a saved login`);
  return login;
}

/** Every saved login's name. */
export function savedLogins(): string[] {
  if (!fs.existsSync(loginsDir())) return [];
  return fs.readdirSync(loginsDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

/** Deletes a saved login. False if there was none by that name. */
export function forgetLogin(name: string): boolean {
  const file = loginPath(name);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

function writeLogin(name: string, login: SavedLogin) {
  fs.mkdirSync(loginsDir(), { recursive: true, mode: 0o700 });
  const file = loginPath(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(login), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface SignInResult {
  file: string;
  cookies: number;
  /** Sites the login has cookies for, e.g. ["boards.app"]. */
  sites: string[];
}

/** Opens `url` in a browser window and waits for the person to sign in and close it, saving the login as it goes.
 *  Starts from the saved login of that name if there is one, so signing in again refreshes it.
 *  `act` drives the page instead of a person (tests); it should close the page when done. */
export async function signIn(
  url: string,
  name: string,
  { headless = false, act }: { headless?: boolean; act?: (page: Page) => Promise<unknown> } = {},
): Promise<SignInResult> {
  const previous = readLogin(name);
  // Same harden path as record/probe so the saved login matches what Take films with.
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
    // While the window is open, save only what can be read without opening a tab. Playwright's full
    // storageState() opens a helper tab for every site the sign-in touched that has no tab open, which in a
    // visible window flashes a tab every save and pulls focus from the person signing in.
    let origins = new Map((previous?.state.origins ?? []).map((o) => [o.origin, o]));
    const quickSave = () =>
      (saving ??= quickState(context, origins)
        .then((state) => {
          origins = new Map(state.origins.map((o) => [o.origin, o]));
          keep(state);
        })
        .catch(() => {})
        .finally(() => (saving = undefined)));

    // Done when every tab in the window is closed, or the browser quits.
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
    // The window is closed now, so the full save (IndexedDB too) can open its helper tab without getting in the way.
    if (browser.isConnected()) await context.storageState({ indexedDB: true }).then(keep).catch(() => quickSave());
    if (!last) throw new Error(`the browser closed before anything was saved; run take login ${url} again`);
    const sites = [...new Set(last.cookies.map((c) => c.domain.replace(/^\./, '').replace(/^www\./, '')))].sort();
    return { file: loginPath(name), cookies: last.cookies.length, sites };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Cookies, plus local storage of the sites open in a tab right now, merged over what was saved before. Opens no tab. */
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

async function launchForLogin(headless: boolean) {
  try {
    return await chromium.launch(hardenLaunchOptions({ headed: !headless, preferChromeChannel: true }));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!/executable doesn't exist|Failed to launch|chrome/i.test(msg)) throw e;
    return chromium.launch(hardenLaunchOptions({ headed: !headless, preferChromeChannel: false }));
  }
}
