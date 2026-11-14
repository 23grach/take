import type { Cursor } from './cursor.ts';
import type { Caret } from './caret.ts';

// The event log a performance leaves behind (events.json). Everything the compositor draws
// afterwards (cursor, click ripples, zoom, the loop) comes from here. Positions and boxes are in CSS pixels
// of the page viewport; times are frame numbers at the log's fps.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Event =
  | { frame: number; type: 'down' | 'up'; x: number; y: number }
  | { frame: number; type: 'key'; key: string }
  | { frame: number; type: 'scroll'; dx: number; dy: number };

export interface StepLog {
  index: number;
  do: string;
  /** First and last frame of the step, including any waitFor, excluding the gap after it. */
  start: number;
  end: number;
  mark?: string;
  /** The element acted on, where it was when the action happened. */
  target?: Box;
  /** The element waitFor was waiting for, where it was when it showed. */
  waitedFor?: Box;
}

export interface EventLog {
  version: 0;
  title: string;
  url: string;
  /** What the address bar shows (see shownAddress). */
  address: string;
  fps: number;
  viewport: [number, number];
  scale: number;
  /** Total length in frames. */
  frames: number;
  /** Pointer position in every frame from 0 to frames - 1: [x, y]. */
  pointer: [number, number][];
  /** Which cursor the page shows under the pointer, as changes: [frame, cursor], starting at frame 0. */
  cursors: [number, Cursor][];
  /** Where the text caret is (null: no caret), as changes: [frame, caret]. The compositor draws it and its blink. */
  carets: [number, Caret | null][];
  events: Event[];
  steps: StepLog[];
  /** Named moments: mark → frame. */
  marks: Record<string, number>;
  /** How the video should end, from the take. */
  loop: 'crossfade-to-start' | 'none';
}
