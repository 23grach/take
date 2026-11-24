import type { BrowserContext, LaunchOptions as PwLaunchOptions } from 'playwright';
import { PHONE } from '../../take/format.ts';
import { keepAboveSafariBar } from './above-safari-bar.ts';

export function hardenLaunchArgs(extra: string[] = []): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    ...extra,
  ];
}

export const HARDEN_IGNORE_DEFAULT_ARGS = ['--enable-automation'] as const;

export const HARDEN_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch {}
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

export function hardenLaunchOptions(opts: {
  headed?: boolean;
  args?: string[];
}): PwLaunchOptions {
  const headed = opts.headed ?? false;
  const options: PwLaunchOptions = {
    headless: !headed,
    args: hardenLaunchArgs(opts.args ?? []),
    ignoreDefaultArgs: [...HARDEN_IGNORE_DEFAULT_ARGS],
  };
  return options;
}

export async function applyHarden(context: BrowserContext): Promise<void> {
  await context.addInitScript(HARDEN_INIT_SCRIPT);
}

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

export const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

const SAFARI_INIT_SCRIPT = `(() => {
  try { delete Navigator.prototype.userAgentData; } catch {}
  try { delete window.chrome; } catch {}
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '* { -webkit-tap-highlight-color: transparent !important; }';
    document.head.append(style);
  });
})();`;

export async function actLikeIPhone(context: BrowserContext): Promise<void> {
  await context.addInitScript(SAFARI_INIT_SCRIPT);
  await context.addInitScript(keepAboveSafariBar, { bar: PHONE.safariBar, endGap: PHONE.endGap });
}

export async function hardenClientHints(
  context: BrowserContext,
  page: { url: () => string },
  userAgent: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (userAgent === IPHONE_USER_AGENT) {
    const session = await context.newCDPSession(page as never).catch(() => null);
    await session?.send('Network.setUserAgentOverride', { userAgent, acceptLanguage: 'en-US,en', platform: 'iPhone' }).catch(() => {});
    return;
  }
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
  }
}

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
