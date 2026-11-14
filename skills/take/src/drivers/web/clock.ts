// The driver works frame by frame: it sets the pointer, presses keys, then calls tick() to move
// one frame (1/60 s) on. What a tick means is up to the clock:
// - realtimeClock waits for the wall clock (live mode, rehearsals);
// - the studio clock advances the frozen page clock and captures the frame.
// Whatever is done while clock.frame is f shows in frame f.

export interface Clock {
  readonly fps: number;
  /** The frame being prepared. Starts at 0. */
  readonly frame: number;
  tick(): Promise<void>;
}

export interface RealtimeClock extends Clock {
  /** Wall time (ms since 1970) when frame 0 ended being prepared and started showing; set on the first tick. */
  readonly startedAt: number | undefined;
}

export function realtimeClock(fps = 60): RealtimeClock {
  let start: number | undefined;
  let startedAt: number | undefined;
  let frame = 0;
  return {
    fps,
    get frame() {
      return frame;
    },
    get startedAt() {
      return startedAt;
    },
    async tick() {
      if (start === undefined) [start, startedAt] = [performance.now(), Date.now()];
      // If the driver fell behind, skip ahead so the pace stays true to the wall clock.
      const due = Math.floor(((performance.now() - start) * fps) / 1000);
      frame = Math.max(frame + 1, due);
      const wait = start + (frame * 1000) / fps - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
  };
}
