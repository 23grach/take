import { PACING } from '../src/drivers/web/pacing.ts';

export async function withShortFind<T>(fn: () => Promise<T>): Promise<T> {
  const saved = PACING.find;
  PACING.find = 1500;
  try {
    return await fn();
  } finally {
    PACING.find = saved;
  }
}
