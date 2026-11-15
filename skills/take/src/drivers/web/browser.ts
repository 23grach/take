// Launches Chromium the way every capture will: fixed viewport, sRGB colours, no scrollbars.
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from '../../browser-binary.ts';
import type { Take } from '../../take/format.ts';
import { TakeError } from './driver.ts';
import { describeCondition, holds } from './targets.ts';
import type { Condition } from '../../take/format.ts';
import { applyHarden, chromeUserAgent, hardenClientHints, hardenLaunchOptions } from './harden.ts';
import { defaultLoginName, readLogin, type SavedLogin } from './login.ts';

/** How long the app gets to load, and then to go quiet on the network, before the first frame. */
const LOAD_MS = 30_000;
const QUIET_MS = 10_000;

export interface LaunchOptions {
  viewport?: { width: number; height: number };
  scale?: number;
  /** Show the browser window (to watch a take play). */
  headed?: boolean;
  /** Start signed in: the saved login's cookies and storage, and the browser it was made in. */
  login?: SavedLogin;
  /** More browser switches. */
  args?: string[];
  /**
   * Prefer the installed Chrome binary (fresh Take profile — not the person's everyday Chrome).
   * Falls back to Playwright Chromium when Chrome isn't installed. Default true.
   */
  preferChromeChannel?: boolean;
}

export async function launch({
  viewport = { width: 1440, height: 900 },
  scale = 1,
  headed = false,
  login,
  args = [],
  preferChromeChannel = true,
}: LaunchOptions = {}): Promise<{
  browser: Browser;
  context: BrowserContext;
  userAgent: string;
}> {
  const extra = [...(scale > 1 ? [`--force-device-scale-factor=${scale}`] : []), ...args];
  // Without --force-device-scale-factor, screencast frames arrive at CSS-pixel size even with deviceScaleFactor 2.
  const browser = await launchHardened({ headed, extra, preferChromeChannel });
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

/** Launch with harden flags: installed Google Chrome first (fresh profile), else Playwright's Chromium. */
function launchHardened({ headed, extra, preferChromeChannel }: { headed: boolean; extra: string[]; preferChromeChannel: boolean }): Promise<Browser> {
  return launchBrowser(hardenLaunchOptions({ headed, args: extra }), { chrome: preferChromeChannel });
}

/** Launches Chromium for a take and opens its start page, ready to film: loaded, network quiet (or 10 s passed),
 *  fonts in. Fails with a plain TakeError if the app doesn't load, answers with an error, or throws while loading.
 *  `prepare` runs before the page loads (studio mode freezes time there).
 *  Some sites refuse a hidden browser with 403 but serve a visible one; then it opens again in a visible window,
 *  and `visible` says so, so the person can be told not to click in it. */
export async function openTake(
  take: Take,
  { headed = false, prepare, args = [] }: { headed?: boolean; prepare?: (page: Page) => Promise<unknown>; args?: string[] } = {},
): Promise<{ browser: Browser; page: Page; visible: boolean }> {
  try {
    return { ...(await open(take, headed, prepare, args)), visible: headed };
  } catch (e) {
    if (headed || !(e instanceof RefusedHidden)) throw e;
    return { ...(await open(take, true, prepare, args)), visible: true };
  }
}

class RefusedHidden extends TakeError {}

/** What to tell the person when a take had to run in a visible window. */
export const VISIBLE_NOTE = "the site refused Take's hidden browser (error 403), so it ran in a visible window. Don't click in it or close it while Take works; the video isn't affected.";

async function open(take: Take, headed: boolean, prepare: ((page: Page) => Promise<unknown>) | undefined, args: string[]): Promise<{ browser: Browser; page: Page }> {
  const [width, height] = take.target.viewport;
  const login = savedLogin(take);
  const { browser, context, userAgent } = await launch({ viewport: { width, height }, scale: take.target.scale, headed, login, args });
  const page = await context.newPage();
  await hardenClientHints(context, page, userAgent);
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(e.message);
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
    // Slow apps keep loading after the load event (data, images, lazy code). Give them until the network is
    // quiet, but don't wait forever for apps that poll.
    await page.waitForLoadState('networkidle', { timeout: QUIET_MS }).catch(() => {});
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

/** How long a take's `ready` conditions get, in page time, before the take stops; then how long fades get to finish. */
export const READY_MS = 30_000;
const SETTLE_MS = 500;

/** Lets the page run, without filming, until the take's `ready` condition holds: sites that fill in after loading
 *  (balances, banners) open the video finished. `pass` moves page time on by `ms` (studio) or just waits (live). */
export async function untilReady(page: Page, ready: Condition[] | undefined, pass: (ms: number) => Promise<unknown>) {
  if (!ready) return;
  let t = 0;
  for (const c of ready)
    for (; !(await holds(page, c)); t += 100) {
      if (t >= READY_MS) throw new TakeError(-1, `waited ${READY_MS / 1000} s for ${describeCondition(c)} before filming (the take's "ready"); check it matches the loaded page`);
      await pass(100);
    }
  // Pictures and fonts that are downloading finish, so none is half drawn on the first frame.
  for (; !(await downloadsDone(page)) && t < READY_MS; t += 100) await pass(100);
  // What just appeared may still be fading in.
  for (let s = 0; s < SETTLE_MS; s += 100) await pass(100);
}

/** Have the fonts, and the pictures on or near the screen, finished downloading? A picture that hasn't started
 *  (a lazy image Chrome didn't notice coming near while page time was frozen) is told to load now, and counts as
 *  not finished. */
export function downloadsDone(page: Page): Promise<boolean> {
  return page
    .evaluate(() => document.fonts.status !== 'loading' && [...document.images].every((img) => {
      if (img.complete) return true;
      const r = img.getBoundingClientRect();
      // On screen or about to be (within a screen of it, like a carousel's next slide), as Chrome reckons for lazy images.
      if (!(r.width > 0 && r.bottom > -innerHeight && r.right > -innerWidth && r.top < 2 * innerHeight && r.left < 2 * innerWidth)) return true;
      if (!img.currentSrc && img.loading === 'lazy') img.loading = 'eager';
      return false;
    }))
    .catch(() => true);
}

/** The take's saved login, if it names one. A plain TakeError when it hasn't been made yet. */
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

/** The command that makes (or refreshes) a login. */
export function loginCommand(url: string, name: string): string {
  return `take login ${url}${name === defaultLoginName(url) ? '' : ` --name ${name}`}`;
}
