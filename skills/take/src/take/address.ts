import type { WebTarget } from './format.ts';

export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') || host === '[::1]' || host === '0.0.0.0'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export function addressWarning(target: WebTarget): string | undefined {
  if (target.address !== undefined || !isLocalUrl(target.url)) return undefined;
  return `no address: the app runs at ${new URL(target.url).host}, which isn't shown, so the address bar will be blank. Add the product's domain as target.address, e.g. "boards.app"`;
}

export function shownAddress(target: WebTarget): string {
  if (target.address !== undefined) return target.address;
  if (isLocalUrl(target.url)) return '';
  const u = new URL(target.url);
  return (u.host + u.pathname).replace(/\/$/, '');
}

export function followedAddress(shown: string, firstUrl: string, url: string): string {
  const [first, now] = [new URL(firstUrl), new URL(url)];
  const path = now.pathname.replace(/\/$/, '');
  if (now.host !== first.host) return now.host + path;
  if (now.pathname === first.pathname) return shown;
  const domain = shown.split('/')[0];
  return domain ? domain + path : '';
}
