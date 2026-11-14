// How fast a take is performed. Every timing that shapes the look of a video lives here,
// so one change retimes every take. Times are in milliseconds of video time.

export const PACING = {
  fps: 60,
  /** Pause after each step before the next one starts. */
  gap: 450,
  /** Where the pointer rests before the first step, as a fraction of the viewport. */
  start: [0.62, 0.72] as [number, number],
  /** Cursor travel time grows with distance, but less and less (Fitts's law): base + perDoubling × log2(1 + px / unit). */
  travel: { base: 200, perDoubling: 150, unit: 50, min: 300, max: 1000 },
  /** Sideways bend of the cursor path, as a fraction of the distance travelled. Hands don't move in straight lines. */
  arc: 0.06,
  /** Pause on the target before pressing, so the viewer sees where the click lands. */
  settle: 140,
  /** How long the button stays pressed, so pressed states show. */
  press: 90,
  /** Dragging: a held button makes the hand slower and steadier than a free move (drag time = travel time ×
   *  slower), and it rests a moment after pressing and before letting go so the grab and the drop both read. */
  drag: { slower: 1.6, arc: 0.02, grip: 160 },
  /** Scroll time: base + perPx × distance, clamped. */
  scroll: { base: 300, perPx: 0.6, min: 400, max: 1400 },
  /** How long to look for a target before giving up. */
  find: 8000,
};

/** Milliseconds → whole frames (at least 1). */
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

/** Minimum-jerk curve: how a hand speeds up and slows down on a point-to-point move. */
export const ease = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

/** When each character of a typed text lands, in frames from the first. People don't type evenly: a new word,
 *  a capital (shift), a digit or symbol, or the key after punctuation takes a little longer; a repeated key is
 *  quicker; and every gap varies a bit. The variation is seeded by the text, so every retake types the same way,
 *  and the whole still takes as long as `cps` says (n characters at cps per second). */
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
