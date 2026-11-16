// The timecoded script: every step of a take with when it starts in the video and how long it lasts, plus the
// loop back to the start and the total. A rehearsal prints it so the user can change the timing before recording
// (a step's "ms" in take.json); a recording prints it again as it came out.
import type { Take } from '../take/format.ts';
import type { StepLog } from '../drivers/web/events.ts';
import { frames } from '../drivers/web/pacing.ts';
import { describeStep } from './probe.ts';

export interface ScriptLine {
  /** Numbered from 1, as in the probe's list and the storyboard. */
  step: number;
  label: string;
  mark?: string;
  /** Seconds into the video. */
  start: number;
  length: number;
  /** The length is fixed by the take ("ms", or a hold's own length); the others follow the action and the app. */
  fixed: boolean;
  /** Set when the step was given a length shorter than its action needs: the shortest it can be, in seconds. */
  atLeast?: number;
}

export interface Script {
  title: string;
  lines: ScriptLine[];
  /** Seconds the loop back to the start adds at the end (0 without a loop). */
  loop: number;
  /** The whole video, loop included, in seconds. */
  total: number;
  /** From a fast-forwarded rehearsal: waits for the app are scaled back, so those are estimates. */
  estimated: boolean;
}

/** Builds the script from the step logs of a performance that finished. `speed` is how fast it played (a
 *  rehearsal fast-forwards); `loopFrames` what the theme adds for the loop (0 for none). Holds count at their
 *  length in the take, since a rehearsal cuts the opening and closing ones short. */
export function timeline(take: Take, logs: StepLog[], total: number, { fps, speed = 1, loopFrames = 0 }: { fps: number; speed?: number; loopFrames?: number }): Script {
  let at = 0;
  const lines = logs.map((log, i): ScriptLine => {
    const s = take.steps[log.index];
    const raw = (logs[i + 1]?.start ?? total) - log.start;
    const span = s.do === 'hold' ? frames(s.ms) : Math.round(raw - (log.waited ?? 0) * (1 - 1 / speed));
    const line: ScriptLine = { step: log.index + 1, label: describeStep(s), start: at / fps, length: span / fps, fixed: s.ms !== undefined };
    if (s.mark) line.mark = s.mark;
    if (s.do !== 'hold' && s.ms !== undefined && span > frames(s.ms) + 1) line.atLeast = span / fps;
    at += span;
    return line;
  });
  return { title: take.title, lines, loop: loopFrames / fps, total: (at + loopFrames) / fps, estimated: speed !== 1 };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const secs = (s: number) => `${s.toFixed(2)} s`;

/** The script as a plain-text table, for the terminal and for showing the user. */
export function formatScript(script: Script): string {
  const rows = script.lines.map((l) => {
    const len = `${secs(l.length)}${l.fixed ? '*' : ' '}`;
    const warn = l.atLeast ? `   ⚠ set shorter than its action needs; it can't be under ${secs(l.atLeast)}` : '';
    return `  ${String(l.step).padStart(2)}  ${clock(l.start)}  ${len.padStart(8)}  ${l.label}${l.mark ? ` [${l.mark}]` : ''}${warn}`;
  });
  const end = script.total - script.loop;
  if (script.loop) rows.push(`      ${clock(end)}  ${secs(script.loop).padStart(7)}   Back to the start (loop)`);
  rows.push(`      ${clock(script.total)}            End`);
  return [
    `Script: "${script.title}", ${secs(script.total)}${script.estimated ? ' (from the rehearsal: steps that wait for the app may come out a little different)' : ' (as recorded)'}`,
    '   #  start      length  step',
    ...rows,
    '  * length set in take.json ("ms"); the others last as long as the action, plus a 0.45 s pause',
  ].join('\n') + '\n';
}
