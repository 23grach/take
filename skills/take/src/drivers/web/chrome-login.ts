import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SavedLogin, StorageState } from './login.ts';

export function chromeProfileDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'google-chrome');
}

export const ENABLE_STEPS =
  'In Chrome, open chrome://inspect/#remote-debugging and turn on remote debugging (once), keep Chrome open, then run this again';

export function chromeEndpoint(dir = chromeProfileDir()): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EACCES')
      throw new Error(`macOS won't let Take read Chrome's folder. Give the app you run Take from (Terminal, Claude, your editor) Full Disk Access in System Settings → Privacy & Security, restart that app, then run this again`);
    return undefined;
  }
  const [port, wsPath] = text.split('\n').map((l) => l.trim());
  return /^\d+$/.test(port ?? '') && wsPath?.startsWith('/') ? `ws://127.0.0.1:${port}${wsPath}` : undefined;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function belongsTo(cookieDomain: string, url: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  return d === host || `.${host}`.endsWith(`.${d}`) || d.endsWith(`.${host}`);
}

export function toPlaywright(cookies: CdpCookie[]): StorageState['cookies'] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.session || c.expires <= 0 ? -1 : c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite ?? 'Lax',
  }));
}

const ALLOW_MS = 180_000;

async function ask(endpoint: string, methods: string[]): Promise<unknown[]> {
  const ws = new WebSocket(endpoint);
  return new Promise((resolve, reject) => {
    const answers: unknown[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Chrome didn't answer within 3 minutes. Chrome shows a dialog asking to allow the connection: click Allow, then run this again"));
    }, ALLOW_MS);
    const done = (e?: Error) => {
      clearTimeout(timer);
      ws.close();
      if (e) reject(e);
      else resolve(answers);
    };
    ws.addEventListener('open', () => methods.forEach((method, i) => ws.send(JSON.stringify({ id: i + 1, method }))));
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (!msg.id) return;
      if (msg.error) return done(new Error(`Chrome refused: ${msg.error.message}`));
      answers[msg.id - 1] = msg.result;
      if (answers.filter((a) => a !== undefined).length === methods.length) done();
    });
    ws.addEventListener('error', () => done(new Error("Chrome turned the connection down. If Chrome is showing an Allow dialog from an earlier try, close it, then run this again and click Allow on the new one. If Chrome was restarted, check that remote debugging is still on at chrome://inspect/#remote-debugging")));
    ws.addEventListener('close', () => done(new Error('Chrome closed the connection (was Allow declined?). Run this again and click Allow')));
  });
}

export async function loginFromChrome(url: string, endpoint?: string): Promise<SavedLogin> {
  endpoint ??= chromeEndpoint();
  if (!endpoint) throw new Error(`Take can't reach your Chrome. ${ENABLE_STEPS}`);
  const [cookies, version] = (await ask(endpoint, ['Storage.getCookies', 'Browser.getVersion'])) as [{ cookies: CdpCookie[] }, { userAgent: string }];
  const mine = cookies.cookies.filter((c) => belongsTo(c.domain, url));
  if (!mine.length) throw new Error(`your Chrome has no login for ${new URL(url).hostname}. Sign in there in Chrome first, then run this again`);
  return {
    url,
    savedAt: new Date().toISOString(),
    userAgent: version.userAgent.replace('HeadlessChrome', 'Chrome'),
    state: { cookies: toPlaywright(mine), origins: [] },
  };
}
