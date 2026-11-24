export interface Clock {
  readonly fps: number;
  readonly frame: number;
  readonly speed?: number;
  tick(): Promise<void>;
  resume?(): void;
}

export interface RealtimeClock extends Clock {
  readonly startedAt: number | undefined;
  resume(): void;
}

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
      const due = Math.floor(((performance.now() - start) * rate) / 1000);
      frame = Math.max(frame + 1, due);
      const wait = start + (frame * 1000) / rate - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
  };
}

export function wallPacedClock(advance: (ms: number) => Promise<void>, fps = 60): Clock {
  let start: number | undefined;
  let frame = 0;
  return {
    fps,
    get frame() {
      return frame;
    },
    async tick() {
      start ??= performance.now();
      await advance(1000 / fps);
      frame++;
      const wait = start + (frame * 1000) / fps - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
  };
}
