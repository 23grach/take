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

export async function readyTake(file: string): Promise<{ take: Take; error?: undefined } | { take?: undefined; error: string }> {
  const loaded = loadTake(file);
  if (!loaded.ok) return { error: problems(file, loaded.errors) };
  const problem = await answers(loaded.take.target.url);
  return problem ? { error: problem } : { take: loaded.take };
}

const ANSWER_MS = 30_000;

export async function answers(url: string, ms = ANSWER_MS): Promise<string | undefined> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return undefined;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (/CERT|SSL|TLS/i.test(err.cause?.code ?? '')) return undefined;
    const local = onThisComputer(url);
    if (err.name === 'TimeoutError')
      return local ? `${url} didn't answer within ${ms / 1000} s. Is the app running, and does its first page load in a browser?` : `${url} didn't answer within ${ms / 1000} s. Check that it opens in a browser; a busy site often answers on a second try`;
    return local ? `nothing answers at ${url}. Is the app running?` : `nothing answers at ${url}. Check the address and the internet connection`;
  }
}

function onThisComputer(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0' || host.startsWith('127.');
}
