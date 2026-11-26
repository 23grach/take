export function siteOf(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1)!)) return parts.join('.');
  const second = parts.at(-2)!;
  const keep = parts.at(-1)!.length === 2 && ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu'].includes(second) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

const RECOVERED_BY_REACT = /Minified React error #(418|419|421|422|423|425)\b|Hydration failed|hydrat\w* (mismatch|error)|server.rendered (HTML|text) didn't match|Text content does not match server-rendered/i;

export function breaksApp(error: Error, pageUrl: string): boolean {
  return !RECOVERED_BY_REACT.test(error.message) && ownError(error, pageUrl);
}

function ownError(error: Error, pageUrl: string): boolean {
  let site: string;
  try {
    site = siteOf(new URL(pageUrl).hostname);
  } catch {
    return true;
  }
  const urls = [...(error.stack ?? '').matchAll(/\bhttps?:\/\/[^\s)'"]+/g)].map((m) => m[0]);
  const own = urls.some((u) => {
    try {
      const url = new URL(u);
      return siteOf(url.hostname) === site && !url.pathname.startsWith('/cdn-cgi/');
    } catch {
      return true;
    }
  });
  return urls.length === 0 || own;
}
