import { PACING } from '../src/drivers/web/pacing.ts';

/** Runs fn with a 1.5 s search budget instead of 8 s: a test of a target that's never found needn't wait the
 *  full time to see the failure. */
export async function withShortFind<T>(fn: () => Promise<T>): Promise<T> {
  const saved = PACING.find;
  PACING.find = 1500;
  try {
    return await fn();
  } finally {
    PACING.find = saved;
  }
}
