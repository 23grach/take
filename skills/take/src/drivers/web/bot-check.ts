import type { Page } from 'playwright';

const SIGNS = [
  'click the button below to continue shopping',
  'enter the characters you see below',
  "make sure you're not a robot",
  'verify you are human',
  'checking your browser',
  'checking if the site connection is secure',
  'unusual traffic from your computer network',
  'are you a robot',
  'press & hold to confirm you are a human',
  'access to this page has been denied',
];

export async function botCheck(page: Page): Promise<string | undefined> {
  const seen = await page
    .evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText ?? '').slice(0, 3000),
      challenge: !!document.querySelector('#challenge-form, #challenge-stage, iframe[src*="challenges.cloudflare.com"], #px-captcha, iframe[src*="geo.captcha-delivery.com"]'),
    }))
    .catch(() => undefined);
  if (!seen) return undefined;
  const text = `${seen.title}\n${seen.text}`.replace(/[’‘]/g, "'");
  const line = text.split('\n').find((l) => SIGNS.some((s) => l.toLowerCase().includes(s)));
  if (line) return line.trim().slice(0, 80);
  if (seen.challenge || /^just a moment\.\.\.$/i.test(seen.title.trim()) || (/^access denied$/i.test(seen.title.trim()) && /reference #/i.test(seen.text))) return seen.title.trim() || 'a challenge page';
  return undefined;
}

export const botCheckMessage = (what: string, sign: string) =>
  `${what}: the site is showing a bot check instead of the page ("${sign}"). Take doesn't get past bot checks. Too many visits in a row set them off: wait a few minutes and try once more; if it stays, tell the user the site blocks automated browsers`;
