export const PACING = {
  fps: 60,
  gap: 450,
  start: [0.62, 0.72] as [number, number],
  travel: { base: 200, perDoubling: 150, unit: 50, min: 300, max: 1000 },
  arc: 0.06,
  stiffness: 7,
  settle: 140,
  press: 90,
  multiClickPress: 60,
  multiClickGap: 70,
  drag: { slower: 1.6, arc: 0.02, grip: 160 },
  scroll: { base: 300, perPx: 0.6, min: 400, max: 1400 },
  fittedTyping: { min: 5, max: 40 },
  find: 8000,
};

export const frames = (ms: number) => Math.max(1, Math.round((ms * PACING.fps) / 1000));

export function travelMs(distance: number): number {
  const t = PACING.travel;
  return Math.min(t.max, Math.max(t.min, t.base + t.perDoubling * Math.log2(1 + distance / t.unit)));
}

export const dragMs = (distance: number) => travelMs(distance) * PACING.drag.slower;

export function scrollMs(distance: number): number {
  const s = PACING.scroll;
  return Math.min(s.max, Math.max(s.min, s.base + s.perPx * Math.abs(distance)));
}

export const ease = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

export function spring(t: number, stiffness = PACING.stiffness): number {
  const settled = (x: number) => 1 - (1 + x) * Math.exp(-x);
  return settled(stiffness * t) / settled(stiffness);
}

export function typingSchedule(text: string, cps: number, fps = PACING.fps): number[] {
  const chars = [...text];
  if (chars.length <= 1) return chars.map(() => 0);
  let seed = 2166136261;
  for (const ch of text + cps) seed = Math.imul(seed ^ ch.codePointAt(0)!, 16777619);
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const weights = chars.slice(1).map((ch, i) => {
    const prev = chars[i];
    let w = 1;
    if (/[.,!?;:]/.test(prev)) w *= 1.6;
    else if (prev === ' ') w *= 1.35;
    if (ch === ' ') w *= 0.85;
    else if (ch !== ch.toLowerCase()) w *= 1.3;
    else if (/[0-9#@$%&*()_+=\-[\]{}<>/\\|]/.test(ch)) w *= 1.2;
    if (ch === prev) w *= 0.8;
    return w * (0.75 + 0.5 * random());
  });
  const total = ((chars.length - 1) * fps) / cps;
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = [0];
  let t = 0;
  for (const w of weights) {
    t += (w / sum) * total;
    out.push(Math.max(out[out.length - 1] + 1, Math.round(t)));
  }
  return out;
}
