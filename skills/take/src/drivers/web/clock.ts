// The driver works frame by frame: it sets the pointer, presses keys, then calls tick() to move
// one frame (1/60 s) on. What a tick means is up to the clock:
// - realtimeClock waits for the wall clock (live mode; rehearsals, which may play faster);
// - the studio clock advances the frozen page clock and captures the frame.
// Whatever is done while clock.frame is f shows in frame f.

export interface Clock {
  readonly fps: number;
  /** The frame being prepared. Starts at 0. */
  readonly frame: number;
  /** Frames shown per frame of wall time (realtimeClock: >1 fast-forwards). Time limits are in wall time, so the
   *  driver stretches them by this much. */
  readonly speed?: number;
  tick(): Promise<void>;
}

export interface RealtimeClock extends Clock {
  /** Wall time (ms since 1970) when frame 0 ended being prepared and started showing; set on the first tick. */
  readonly startedAt: number | undefined;
  /** Picks up from now without skipping frames for the time since the last tick (a rehearsal taking its screenshot). */
  resume(): void;
}

/** `speed` 2 plays the take twice as fast as the video will (rehearsals). */
export function realtimeClock(fps = 60, speed = 1): RealtimeClock {
  let start: number | undefined;
  let startedAt: number | undefined;
  let frame = 0;
  const rate = fps * speed;
  return {
    fps,
    speed,
    get frame() {
      return frame;
    },
    get startedAt() {
      return startedAt;
    },
    resume() {
      if (start !== undefined) start = performance.now() - (frame * 1000) / rate;
    },
    async tick() {
      if (start === undefined) [start, startedAt] = [performance.now(), Date.now()];
      // If the driver fell behind, skip ahead so the pace stays true to the wall clock.
      const due = Math.floor(((performance.now() - start) * rate) / 1000);
      frame = Math.max(frame + 1, due);
      const wait = start + (frame * 1000) / rate - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
  };
}
