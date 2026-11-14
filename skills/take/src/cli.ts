// Entry point for the `take` command.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { doctor } from './doctor.ts';
import { loadTake, problems, readyTake } from './take/load.ts';
import { record } from './drivers/web/record.ts';
import { TakeError } from './drivers/web/driver.ts';
import type { Mode } from './drivers/web/capture.ts';
import { compose } from './compose/compose.ts';
import { check, formatReport } from './check/check.ts';
import { contactSheet } from './check/contact.ts';
import { run } from './run.ts';
import { addressWarning } from './take/format.ts';
import { probe } from './probe/probe.ts';
import { storyboard } from './probe/storyboard.ts';
import { defaultLoginName, forgetLogin, isLoginName, loginPath, readLogin, savedLogins, signIn } from './drivers/web/login.ts';
import { loginCommand, VISIBLE_NOTE } from './drivers/web/browser.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const usage = `take ${pkg.version}

Usage: take <command> [file] [options]

Commands:
  doctor    check Node, Chromium and ffmpeg
  login     open <url> in a browser window to sign in by hand; saves the login when you close the window,
            so takes with "login": "<name>" start signed in. --name <name> (default: the site's domain)
  logout    forget a saved login: take logout <name>
  validate  check a take.json and explain any problems
  probe     perform a take without recording and screenshot every step → storyboard
            --out <folder> (default: probe/ next to the take)  --headed (show the browser)
  record    perform a take and capture frames + events
            --mode studio (default, exact, for finals) | live (real time, for drafts)
            --out <folder> (default: capture/ next to the take)  --headed (show the browser)
  compose   turn a capture folder into a finished MP4
            --theme <name> (default: default)  --out <file> (default: out/<take>.mp4 next to the capture)
            --address <text> (address bar text; default: the take's)
  check     report frame rate, length, hitches and loop seam, and make a contact sheet
            --no-loop (the video isn't meant to loop)
  run       all of the above: take.json → recorded, composed and checked MP4
            --mode studio | live (a quick draft: out/<take>-draft.mp4)  --theme  --out <file>  --headed
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      out: { type: 'string' },
      theme: { type: 'string' },
      address: { type: 'string' },
      name: { type: 'string' },
      headed: { type: 'boolean', default: false },
      'no-loop': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (e) {
  process.stderr.write(`take: ${(e as Error).message}\n\n${usage}`);
  process.exit(1);
}
const { values: opts, positionals } = parsed;
const [command, file] = positionals;
const { headed, out: outFlag, theme: themeFlag } = opts;

const commands: Record<string, () => number | Promise<number>> = {
  doctor,
  login: loginCommandLine,
  logout: logoutCommandLine,
  validate: validateCommand,
  probe: probeCommand,
  record: recordCommand,
  compose: composeCommand,
  check: checkCommand,
  run: runCommand,
};

if (opts.version) process.stdout.write(`${pkg.version}\n`);
else if (!command || opts.help) process.stdout.write(usage);
else if (commands[command]) process.exitCode = await Promise.resolve().then(commands[command]).catch(unexpected);
else {
  process.stderr.write(`take: unknown command "${command}"\n\n${usage}`);
  process.exitCode = 1;
}

/** Anything a command didn't handle itself: one plain line instead of a stack trace, plus where it came from. */
function unexpected(e: unknown): number {
  const err = e instanceof Error ? e : new Error(String(e));
  const tool = (err as NodeJS.ErrnoException).code === 'ENOENT' && /\b(ffmpeg|ffprobe)\b/.exec(err.message)?.[1];
  if (tool) return fail(`✗ take ${command}: ${tool} isn't installed (or isn't on the PATH). Run take doctor to see how to install it.`);
  if (err instanceof TakeError) return fail(`✗ take ${command}: ${err.message}`);
  const where = err.stack?.split('\n').find((l) => l.trim().startsWith('at '))?.trim();
  return fail(`✗ take ${command}: ${err.message.split('\n')[0]}${where ? `\n  (${where})` : ''}`);
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function modeOption(name: string): Mode | undefined | false {
  const { mode } = opts;
  if (mode === undefined || mode === 'studio' || mode === 'live') return mode;
  fail(`take ${name}: --mode must be studio or live, got "${mode}"`);
  return false;
}

function validateCommand(): number {
  if (!file) return fail('take validate: give a take.json, e.g. take validate takes/create-project/take.json');
  const result = loadTake(file);
  if (!result.ok) return fail(`✗ ${problems(file, result.errors)}`);
  const { take } = result;
  process.stdout.write(`✓ ${file}: "${take.title}", ${take.steps.length} steps, ${take.target.viewport.join('×')} at ${take.target.scale}×\n`);
  const warning = addressWarning(take.target);
  if (warning) process.stdout.write(`⚠ ${warning}\n`);
  const name = take.target.login;
  if (name) {
    let saved;
    try {
      saved = readLogin(name);
    } catch {}
    if (saved) process.stdout.write(`  starts signed in with the saved login "${name}" (saved ${new Date(saved.savedAt).toLocaleString()})\n`);
    else process.stdout.write(`⚠ no saved login "${name}" yet. Sign in once: ${loginCommand(take.target.url, name)}\n`);
  }
  return 0;
}

async function recordCommand(): Promise<number> {
  if (!file) return fail('take record: give a take.json, e.g. take record takes/create-project/take.json');
  const mode = modeOption('record');
  if (mode === false) return 1;
  const { take, error } = await readyTake(file);
  if (!take) return fail(`✗ take record: ${error}`);
  const out = outFlag ?? path.join(path.dirname(file), 'capture');
  const m = mode ?? 'studio';
  process.stdout.write(`Recording "${take.title}" in ${m} mode…\n`);
  try {
    const { capture } = await record(take, { mode: m, out, headed });
    if (capture.visibleWindow) process.stdout.write(`⚠ ${VISIBLE_NOTE}\n`);
    const secs = capture.frames.length / capture.fps;
    process.stdout.write(`✓ ${capture.frames.length} frames (${secs.toFixed(2)} s at ${capture.fps} fps, ${capture.size.join('×')}) in ${capture.renderSeconds} s → ${out}\n`);
    return 0;
  } catch (e) {
    if (e instanceof TakeError) return fail(`✗ ${e.message}`);
    throw e;
  }
}

async function loginCommandLine(): Promise<number> {
  const url = file;
  if (!url || !/^https?:\/\//.test(url)) return fail('take login: give the page to sign in on, e.g. take login https://boards.app');
  const name = opts.name ?? defaultLoginName(url);
  if (!isLoginName(name)) return fail(`take login: --name must be letters, digits, dots and dashes, e.g. boards.app, got "${name}"`);
  process.stdout.write(`Opening ${url} in a browser window. Sign in there as you normally would, then close the window.\n`);
  process.stdout.write(`The login is saved for "${name}" in ${loginPath(name)}, outside your project, readable only by you.\n`);
  try {
    const r = await signIn(url, name);
    process.stdout.write(`✓ Saved login "${name}": ${r.cookies} cookie${r.cookies === 1 ? '' : 's'}${r.sites.length ? ` for ${r.sites.join(', ')}` : ''}.\n`);
    process.stdout.write(`  Takes start signed in with it when their target has "login": "${name}".\n`);
    return 0;
  } catch (e) {
    return fail(`✗ take login: ${(e as Error).message}`);
  }
}

function logoutCommandLine(): number {
  const saved = savedLogins();
  const list = saved.length ? `saved logins: ${saved.join(', ')}` : 'there are no saved logins';
  if (!file) return fail(`take logout: name the login to forget, e.g. take logout boards.app (${list})`);
  if (!isLoginName(file) || !forgetLogin(file)) return fail(`take logout: no saved login "${file}" (${list})`);
  process.stdout.write(`✓ Forgot the login "${file}". Takes that use it will start signed out until you run take login again.\n`);
  return 0;
}

async function composeCommand(): Promise<number> {
  if (!file) return fail('take compose: give a capture folder, e.g. take compose takes/create-project/capture');
  if (!existsSync(path.join(file, 'capture.json'))) return fail(`take compose: no capture.json in ${file}. Record first: take record <take.json>`);
  const takeDir = path.dirname(path.resolve(file));
  const out = outFlag ?? path.join(takeDir, 'out', `${path.basename(takeDir)}.mp4`);
  process.stdout.write(`Composing ${file}…\n`);
  let r;
  try {
    r = await compose({ capture: file, out, theme: themeFlag, address: opts.address });
  } catch (e) {
    return fail(`✗ take compose: ${(e as Error).message}`);
  }
  process.stdout.write(`✓ ${r.size.join('×')}, ${r.frames} frames (${r.seconds.toFixed(2)} s) in ${r.renderSeconds} s → ${path.relative(process.cwd(), r.file) || r.file}\n`);
  return 0;
}

async function checkCommand(): Promise<number> {
  if (!file) return fail('take check: give a video, e.g. take check takes/create-project/out/create-project.mp4');
  if (!existsSync(file)) return fail(`take check: ${file} not found`);
  const loop = !opts['no-loop'];
  const report = check(file, { loop });
  const base = file.replace(/\.[^./]+$/, '');
  writeFileSync(`${base}.check.json`, JSON.stringify(report, null, 1));
  const sheet = await contactSheet(report, `${base}.contact.jpg`, { loop });
  process.stdout.write(formatReport(report) + `Contact sheet: ${sheet}\n`);
  return report.ok ? 0 : 1;
}

async function runCommand(): Promise<number> {
  if (!file) return fail('take run: give a take.json, e.g. take run takes/create-project/take.json');
  const mode = modeOption('run');
  if (mode === false) return 1;
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const r = await run(file, { mode, theme: themeFlag, out: outFlag, headed, log: say });
  if (r.error) return fail(`✗ ${r.error}`);
  const report = r.report!;
  say('');
  say(formatReport({ ...report, file: path.relative(process.cwd(), report.file) }).trimEnd());
  if (!r.ok && mode === 'live') say('Live drafts stutter where the app animates quickly; record without --mode live for the final video.');
  say(`Contact sheet: ${path.relative(process.cwd(), r.sheet!)}`);
  say(`Done in ${r.seconds} s.`);
  return r.ok ? 0 : 1;
}

async function probeCommand(): Promise<number> {
  if (!file) return fail('take probe: give a take.json, e.g. take probe takes/create-project/take.json');
  const { take, error } = await readyTake(file);
  if (!take) return fail(`✗ take probe: ${error}`);
  const out = outFlag ?? path.join(path.dirname(file), 'probe');
  process.stdout.write(`Probing "${take.title}"…\n`);
  const r = await probe(take, out, { headed });
  if (r.visibleWindow) process.stdout.write(`⚠ ${VISIBLE_NOTE}\n`);
  if (!r.shots.length) return fail(`✗ ${r.error}`);
  for (const s of r.shots.slice(1))
    process.stdout.write(`${s.error ? '✗' : '✓'} ${String(s.step).padStart(2)}  ${s.label}${s.error ? `\n      ${s.error}\n      what the page had at that point: ${path.relative(process.cwd(), path.join(out, s.outline))}` : ''}\n`);
  const sheet = await storyboard(r, out, path.join(out, 'storyboard.jpg'), { theme: themeFlag ?? take.theme });
  const done = r.shots.length - 1 - (r.ok ? 0 : 1);
  process.stdout.write(`${r.ok ? `All ${take.steps.length} steps work` : `Stopped at step ${done + 1} of ${take.steps.length}`} (${r.seconds} s). Storyboard: ${path.relative(process.cwd(), sheet)}\n`);
  return r.ok ? 0 : 1;
}
