import type { Cursor } from './cursor.ts';
import type { Caret } from './caret.ts';
import type { Device } from '../../take/format.ts';

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

export interface KeyboardUp {
  lift: number;
}

export interface PageEdge {
  cover: string | null;
  depth: number;
  color: string;
}

export interface PageEdges {
  scrollY: number;
  scrollHeight: number;
  inner: number;
  top: PageEdge;
  bottom: PageEdge;
}

export interface StepLog {
  index: number;
  do: string;
  start: number;
  end: number;
  mark?: string;
  note?: string;
  waited?: number;
  target?: Box;
  waitedFor?: Box;
}

export interface EventLog {
  version: 0;
  title: string;
  url: string;
  address: string;
  fps: number;
  device: Device;
  viewport: [number, number];
  scale: number;
  frames: number;
  pointer: [number, number][];
  cursors: [number, Cursor][];
  carets: [number, Caret | null][];
  events: Event[];
  steps: StepLog[];
  marks: Record<string, number>;
  loop: 'crossfade-to-start' | 'none';
  videos?: [number, Box[]][];
  keyboard?: [number, KeyboardUp | null][];
  edges?: [number, PageEdges][];
}
