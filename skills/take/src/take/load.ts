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
  try {
    await fetch(loaded.take.target.url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return { error: `nothing answers at ${loaded.take.target.url}. Is the app running?` };
  }
  return { take: loaded.take };
}
