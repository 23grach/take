// Reads a take.json from disk and validates it.
import { readFileSync } from 'node:fs';
import { validateTake, type Result, type Take } from './format.ts';

export function loadTake(file: string): Result {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, errors: [`can't read ${file}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`${file} is not valid JSON: ${(e as Error).message}`] };
  }
  return validateTake(json);
}

export function problems(file: string, errors: string[]): string {
  return `${file}: ${errors.length} problem${errors.length === 1 ? '' : 's'}\n${errors.map((e) => `  ${e}`).join('\n')}`;
}

/** A take that is valid and whose app answers: what probe, record and run need before they open a browser. */
export async function readyTake(file: string): Promise<{ take: Take; error?: undefined } | { take?: undefined; error: string }> {
  const loaded = loadTake(file);
  if (!loaded.ok) return { error: problems(file, loaded.errors) };
  const problem = await answers(loaded.take.target.url);
  return problem ? { error: problem } : { take: loaded.take };
}

/** How long the app gets to answer: a dev server's first page can take a while to build. */
export const ANSWER_MS = 30_000;

/** Is something answering at the address? Undefined when it is; otherwise why not, in words. */
export async function answers(url: string, ms = ANSWER_MS): Promise<string | undefined> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return undefined;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    // A certificate Node doesn't trust (self-signed, or one the Mac trusts but Node doesn't, as mkcert makes):
    // the app is up. The browser judges the certificate itself and explains if it refuses the page.
    if (/CERT|SSL|TLS/i.test(err.cause?.code ?? '')) return undefined;
    if (err.name === 'TimeoutError') return `${url} didn't answer within ${ms / 1000} s. Is the app running, and does its first page load in a browser?`;
    return `nothing answers at ${url}. Is the app running?`;
  }
}
