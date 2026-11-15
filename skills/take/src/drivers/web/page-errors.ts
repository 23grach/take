// Take stops when the app throws an error, rather than film a broken app. Errors from other sites' scripts on the
// page (a bot-check widget, an ad, a chat bubble) aren't the app's: they're ignored. An error is the app's when
// its stack mentions a script from the page's own site, or no script at all.

/** "app.example.co.uk" → "example.co.uk", "www.01.tech" → "01.tech": the part of a host name a site owns. */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1)!)) return parts.join('.');
  // Two-letter country endings with a generic label before them (co.uk, com.au) take one more label.
  const second = parts.at(-2)!;
  const keep = parts.at(-1)!.length === 2 && ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu'].includes(second) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/** Is this page error the app's own (Take stops) rather than another site's script (ignored)? */
export function ownError(error: Error, pageUrl: string): boolean {
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
      // Cloudflare serves its own helpers (a script loader, a bot check) from the site's address under /cdn-cgi/:
      // they show up in every stack on such sites, but aren't the app's code.
      return siteOf(url.hostname) === site && !url.pathname.startsWith('/cdn-cgi/');
    } catch {
      return true;
    }
  });
  return urls.length === 0 || own;
}
