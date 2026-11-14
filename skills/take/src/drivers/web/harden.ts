// Hardens Take's Chromium so ordinary bot checks see less of an automation fingerprint.
// Still Playwright-driven; still a fresh Take profile (never the person's everyday Chrome).
// Honest limit: x.com-grade walls can still challenge; hand-clear in `take login` is the fallback.
import type { BrowserContext, LaunchOptions as PwLaunchOptions } from 'playwright';

/** Chromium flags that make the browser look less like a test harness. */
export function hardenLaunchArgs(extra: string[] = []): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    // Keep Take's usual look for captures.
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    ...extra,
  ];
}

/**
 * Playwright's default args include `--enable-automation`, which sets `navigator.webdriver`
 * and shows the "controlled by automated test software" affordance. Drop that one.
 */
export const HARDEN_IGNORE_DEFAULT_ARGS = ['--enable-automation'] as const;

/** Init script applied to every new document in the context. */
export const HARDEN_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch {}
  // Headless Chromium often lacks window.chrome; many checks treat that as a bot.
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {} },
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
  } catch {}
  try {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
    if (desc?.get && navigator.plugins?.length === 0) {
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get() {
          return [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
        },
        configurable: true,
      });
    }
  } catch {}
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(Navigator.prototype, 'languages', {
        get: () => Object.freeze(['en-US', 'en']),
        configurable: true,
      });
    }
  } catch {}
})();`;

/** Launch options shared by record/probe and `take login`. */
export function hardenLaunchOptions(opts: {
  headed?: boolean;
  /** Extra Chromium args (e.g. device scale). */
  args?: string[];
  /** Prefer installed Chrome binary when present (still a fresh profile). */
  preferChromeChannel?: boolean;
}): PwLaunchOptions {
  const headed = opts.headed ?? false;
  const options: PwLaunchOptions = {
    headless: !headed,
    args: hardenLaunchArgs(opts.args ?? []),
    ignoreDefaultArgs: [...HARDEN_IGNORE_DEFAULT_ARGS],
  };
  // Channel "chrome" uses installed Google Chrome with a fresh Playwright profile, never the person's everyday one.
  if (opts.preferChromeChannel !== false) {
    options.channel = 'chrome';
  }
  return options;
}

/** Apply harden init scripts to a context. Call once after `newContext`. */
export async function applyHarden(context: BrowserContext): Promise<void> {
  await context.addInitScript(HARDEN_INIT_SCRIPT);
}

/**
 * Playwright's headless Chromium puts `HeadlessChrome` in the UA — an easy bot check.
 * When the take doesn't already pin a saved-login UA, use a normal Chrome UA for this binary.
 */
export function chromeUserAgent(browserVersion: string, platform: NodeJS.Platform = process.platform): string {
  const ver = browserVersion.replace(/^HeadlessChrome\//i, '').replace(/^Chrome\//i, '') || browserVersion;
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
}

/**
 * Client hints (`sec-ch-ua`) still say HeadlessChrome even after a UA override.
 * Fix them via CDP before the first navigation. Call after `newPage`, before `goto`.
 */
export async function hardenClientHints(
  context: BrowserContext,
  page: { url: () => string },
  userAgent: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const ver = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? '156.0.0.0';
  const major = ver.split('.')[0] ?? '156';
  const metaPlatform = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  const platformVersion = platform === 'darwin' ? '14.0.0' : platform === 'win32' ? '15.0.0' : '6.12.0';
  try {
    const session = await context.newCDPSession(page as never);
    await session.send('Network.setUserAgentOverride', {
      userAgent,
      acceptLanguage: 'en-US,en',
      platform: metaPlatform === 'macOS' ? 'MacIntel' : metaPlatform === 'Windows' ? 'Win32' : 'Linux x86_64',
      userAgentMetadata: {
        brands: [
          { brand: 'Not:A-Brand', version: '8' },
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
        ],
        fullVersionList: [
          { brand: 'Not:A-Brand', version: '10.0.0.0' },
          { brand: 'Chromium', version: ver },
          { brand: 'Google Chrome', version: ver },
        ],
        platform: metaPlatform,
        platformVersion,
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      },
    });
  } catch {
    // Older Chromium builds may reject metadata fields; UA + init script still apply.
  }
}

/** Read a few signals the page sees — for spikes and tests. */
export async function automationSignals(page: {
  evaluate: (fn: () => unknown) => Promise<unknown>;
}): Promise<{
  webdriver: unknown;
  hasChrome: boolean;
  languages: string[];
  plugins: number;
  userAgent: string;
}> {
  return page.evaluate(() => ({
    webdriver: (navigator as Navigator & { webdriver?: unknown }).webdriver,
    hasChrome: typeof (window as Window & { chrome?: unknown }).chrome === 'object',
    languages: [...navigator.languages],
    plugins: navigator.plugins?.length ?? 0,
    userAgent: navigator.userAgent,
  })) as Promise<{
    webdriver: unknown;
    hasChrome: boolean;
    languages: string[];
    plugins: number;
    userAgent: string;
  }>;
}
