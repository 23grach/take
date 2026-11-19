import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { browserLabel, DOWNLOAD_CHROMIUM } from './browser-binary.ts';
import { isBundled, mediaTool, type MediaTool } from './media-tools.ts';

const execFileAsync = promisify(execFile);

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface Probe {
  platform: NodeJS.Platform;
  nodeVersion: string;
  run(tool: MediaTool, args: string[]): Promise<string | null>;
  bundled(tool: MediaTool): boolean;
  browser(): Promise<string>;
}

export const MIN_NODE_MAJOR = 24;

export const realProbe: Probe = {
  platform: process.platform,
  nodeVersion: process.versions.node,
  async run(tool, args) {
    try {
      const { stdout, stderr } = await execFileAsync(mediaTool(tool), args, { maxBuffer: 16 * 1024 * 1024 });
      return stdout || stderr;
    } catch {
      return null;
    }
  },
  bundled: isBundled,
  browser: browserLabel,
};

export const DOWNLOAD_FFMPEG = 'node src/install-ffmpeg.ts';

const missingFix = `run in Take's folder: ${DOWNLOAD_FFMPEG}`;
const version = (probe: Probe, tool: MediaTool, number: string) => (probe.bundled(tool) ? `${number} (Take's own copy)` : number);

export async function runChecks(probe: Probe = realProbe): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const major = Number(probe.nodeVersion.split('.')[0]);
  results.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'Node', ok: true, detail: `v${probe.nodeVersion}` }
      : {
          name: 'Node',
          ok: false,
          detail: `v${probe.nodeVersion} is too old (need ${MIN_NODE_MAJOR} or newer)`,
          fix: 'install the current LTS from https://nodejs.org',
        },
  );

  try {
    results.push({ name: 'Browser', ok: true, detail: await probe.browser() });
  } catch {
    results.push({
      name: 'Browser',
      ok: false,
      detail: 'no Google Chrome, and Playwright can’t start its Chromium',
      fix: `install Google Chrome, or run in Take's folder: ${DOWNLOAD_CHROMIUM}`,
    });
  }

  const ffmpeg = await probe.run('ffmpeg', ['-hide_banner', '-version']);
  if (ffmpeg === null) {
    results.push({ name: 'ffmpeg', ok: false, detail: 'not found', fix: missingFix });
  } else {
    results.push({ name: 'ffmpeg', ok: true, detail: version(probe, 'ffmpeg', /ffmpeg version (\S+)/.exec(ffmpeg)?.[1] ?? 'unknown version') });

    const encoders = (await probe.run('ffmpeg', ['-hide_banner', '-encoders'])) ?? '';
    results.push(
      /\blibx264\b/.test(encoders)
        ? { name: 'H.264 encoder', ok: true, detail: 'libx264' }
        : {
            name: 'H.264 encoder',
            ok: false,
            detail: 'this ffmpeg was built without libx264',
            fix: probe.platform === 'darwin' ? 'brew reinstall ffmpeg' : 'install an ffmpeg build that includes libx264',
          },
    );
  }

  const ffprobe = await probe.run('ffprobe', ['-hide_banner', '-version']);
  results.push(
    ffprobe === null
      ? { name: 'ffprobe', ok: false, detail: 'not found', fix: missingFix }
      : { name: 'ffprobe', ok: true, detail: version(probe, 'ffprobe', /ffprobe version (\S+)/.exec(ffprobe)?.[1] ?? 'unknown version') },
  );

  return results;
}

export function formatReport(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => {
    const line = `${r.ok ? '✓' : '✗'} ${r.name.padEnd(width)}  ${r.detail}`;
    return r.fix ? `${line}\n  ${' '.repeat(width)}  fix: ${r.fix}` : line;
  });
  const failed = results.filter((r) => !r.ok).length;
  lines.push('', failed === 0 ? 'All good. Take is ready to record.' : `${failed} problem${failed > 1 ? 's' : ''} to fix.`);
  return lines.join('\n') + '\n';
}

export async function doctor(): Promise<number> {
  const results = await runChecks();
  process.stdout.write(formatReport(results));
  return results.every((r) => r.ok) ? 0 : 1;
}
