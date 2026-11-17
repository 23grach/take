import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from '../../browser-binary.ts';
import type { Take } from '../../take/format.ts';
import { ownError } from './page-errors.ts';
import { TakeError } from './driver.ts';
import { describeCondition, holds } from './targets.ts';
import type { Condition } from '../../take/format.ts';
import { applyHarden, chromeUserAgent, hardenClientHints, hardenLaunchOptions } from './harden.ts';
import { defaultLoginName, readLogin, type SavedLogin } from './login.ts';

const LOAD_MS = 30_000;
const QUIET_MS = 10_000;

export interface LaunchOptions {
  viewport?: { width: number; height: number };
  scale?: number;
  headed?: boolean;
  login?: SavedLogin;
  args?: string[];
}

export async function launch({
  viewport = { width: 1440, height: 900 },
  scale = 1,
  headed = false,
  login,
  args = [],
}: LaunchOptions = {}): Promise<{
  browser: Browser;
  context: BrowserContext;
  userAgent: string;
}> {
  const extra = [...(scale > 1 ? [`--force-device-scale-factor=${scale}`] : []), ...args];
  const browser = await launchHardened({ headed, extra });
  const userAgent = login?.userAgent ?? chromeUserAgent(browser.version());
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    locale: 'en-US',
    userAgent,
    ...(login ? { storageState: login.state } : {}),
  });
  await applyHarden(context);
  return { browser, context, userAgent };
}

function launchHardened({ headed, extra }: { headed: boolean; extra: string[] }): Promise<Browser> {
  return launchBrowser(hardenLaunchOptions({ headed, args: extra }));
}

export async function openTake(
  take: Take,
  { headed = false, prepare, args = [], quietMs = QUIET_MS }: { headed?: boolean; prepare?: (page: Page) => Promise<unknown>; args?: string[]; quietMs?: number } = {},
): Promise<{ browser: Browser; page: Page; visible: boolean }> {
  try {
    return { ...(await open(take, headed, prepare, args, quietMs)), visible: headed };
  } catch (e) {
    if (headed || !(e instanceof RefusedHidden)) throw e;
    return { ...(await open(take, true, prepare, args, quietMs)), visible: true };
  }
}

class RefusedHidden extends TakeError {}

export const VISIBLE_NOTE = "the site refused Take's hidden browser (error 403), so it ran in a visible window. Don't click in it or close it while Take works; the video isn't affected.";

async function open(take: Take, headed: boolean, prepare: ((page: Page) => Promise<unknown>) | undefined, args: string[], quietMs: number): Promise<{ browser: Browser; page: Page }> {
  const [width, height] = take.target.viewport;
  const login = savedLogin(take);
  const { browser, context, userAgent } = await launch({ viewport: { width, height }, scale: take.target.scale, headed, login, args });
  const page = await context.newPage();
  await hardenClientHints(context, page, userAgent);
  const errors: string[] = [];
  const onError = (e: Error) => void (ownError(e, page.url()) && errors.push(e.message));
  page.on('pageerror', onError);
  try {
    await prepare?.(page);
    const url = take.target.url;
    const response = await page.goto(url, { timeout: LOAD_MS }).catch((e: Error) => {
      if (/timeout/i.test(e.message)) throw new TakeError(-1, `${url} didn't finish loading in ${LOAD_MS / 1000} s`);
      throw new TakeError(-1, `couldn't open ${url}: ${e.message.split('\n')[0]}`);
    });
    if (response?.status() === 403 && !headed) throw new RefusedHidden(-1, `${url} answered with error 403`);
    if (response && response.status() >= 400) throw new TakeError(-1, `${url} answered with error ${response.status()}; check the address and that the app is running`);
    await page.waitForLoadState('networkidle', { timeout: quietMs }).catch(() => {});
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    if (errors.length) throw new TakeError(-1, `the app threw an error while loading: "${errors[0]}". Take stops rather than film a broken app`);
  } catch (e) {
    await browser.close();
    throw e;
  } finally {
    page.off('pageerror', onError);
  }
  return { browser, page };
}

export const READY_MS = 30_000;
const SETTLE_MS = 500;

export async function untilReady(page: Page, ready: Condition[] | undefined, pass: (ms: number) => Promise<unknown>) {
  if (!ready) return;
  let t = 0;
  for (const c of ready)
    for (; !(await holds(page, c)); t += 100) {
      if (t >= READY_MS) throw new TakeError(-1, `waited ${READY_MS / 1000} s for ${describeCondition(c)} before filming (the take's "ready"); check it matches the loaded page`);
      await pass(100);
    }
  for (; !(await downloadsDone(page)) && t < READY_MS; t += 100) await pass(100);
  if (!(await downloadsDone(page))) await giveUpDownloads(page);
  for (let s = 0; s < SETTLE_MS; s += 100) await pass(100);
}

export function downloadsDone(page: Page): Promise<boolean> {
  return page
    .evaluate(() => (document.fonts.status !== 'loading' || (window as unknown as { __takeFontsGaveUp?: true }).__takeFontsGaveUp === true) && [...document.images].every((img) => {
      if (img.complete || (img as HTMLImageElement & { __takeGaveUp?: true }).__takeGaveUp) return true;
      const r = img.getBoundingClientRect();
      if (!(r.width > 0 && r.bottom > -innerHeight && r.right > -innerWidth && r.top < 2 * innerHeight && r.left < 2 * innerWidth)) return true;
      if (!img.currentSrc && img.loading === 'lazy') img.loading = 'eager';
      return false;
    }))
    .catch(() => true);
}

export async function giveUpDownloads(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      if (document.fonts.status === 'loading') (window as unknown as { __takeFontsGaveUp?: true }).__takeFontsGaveUp = true;
      for (const img of document.images) if (!img.complete) (img as HTMLImageElement & { __takeGaveUp?: true }).__takeGaveUp = true;
    })
    .catch(() => {});
}

function savedLogin(take: Take): SavedLogin | undefined {
  const name = take.target.login;
  if (!name) return undefined;
  let login: SavedLogin | undefined;
  try {
    login = readLogin(name);
  } catch (e) {
    throw new TakeError(-1, `the saved login "${name}" can't be read (${(e as Error).message}); sign in again: ${loginCommand(take.target.url, name)}`);
  }
  if (!login) throw new TakeError(-1, `there's no saved login "${name}" yet. Sign in once: ${loginCommand(take.target.url, name)}`);
  return login;
}

export function loginCommand(url: string, name: string): string {
  return `take login ${url}${name === defaultLoginName(url) ? '' : ` --name ${name}`}`;
}
