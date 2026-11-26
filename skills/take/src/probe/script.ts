import type { Take } from '../take/format.ts';
import type { StepLog } from '../drivers/web/events.ts';
import { frames } from '../drivers/web/pacing.ts';
import { describeStep } from './probe.ts';

interface ScriptLine {
  step: number;
  label: string;
  mark?: string;
  start: number;
  length: number;
  fixed: boolean;
  atLeast?: number;
}

export interface Script {
  title: string;
  lines: ScriptLine[];
  loop: number;
  total: number;
  estimated: boolean;
}

export function timeline(take: Take, logs: StepLog[], total: number, { fps, speed = 1, loopFrames = 0, rehearsed = false }: { fps: number; speed?: number; loopFrames?: number; rehearsed?: boolean }): Script {
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
  return { title: take.title, lines, loop: loopFrames / fps, total: (at + loopFrames) / fps, estimated: rehearsed };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const secs = (s: number) => `${s.toFixed(2)} s`;

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
