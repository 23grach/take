import type { Box } from './events.ts';
import { PACING } from './pacing.ts';

export type Point = [number, number];
export type Span = [number, number];

export const round = (n: number) => Math.round(n * 10) / 10;

export const center = (b: Box): Point => [b.x + b.width / 2, b.y + b.height / 2];

export const belowLabel = (b: Box): Point => {
  const { right, down, maxRight, maxDown } = PACING.aim;
  const [x, y] = center(b);
  return [x + Math.min(b.width * right, maxRight), y + Math.min(b.height * down, maxDown)];
};

export const fits = (start: number, size: number, [lo, hi]: Span) =>
  size <= hi - lo ? start >= lo - 2 && start + size <= hi + 2 : start + size / 2 >= lo && start + size / 2 <= hi;

export const roundedBox = (b: Box): Box => ({ x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) });

export function fillSkipped(path: Point[]) {
  for (let f = 1; f < path.length; f++) {
    if (path[f]) continue;
    let g = f;
    while (!path[g]) g++;
    const [a, b] = [path[f - 1], path[g]];
    for (let h = f; h < g; h++) {
      const t = (h - f + 1) / (g - f + 1);
      path[h] = [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
    }
    f = g;
  }
}
