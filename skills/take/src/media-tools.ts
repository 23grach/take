import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export type MediaTool = 'ffmpeg' | 'ffprobe';

const require = createRequire(import.meta.url);
const found = new Map<MediaTool, string>();

export function onPath(tool: MediaTool): boolean {
  return !spawnSync(tool, ['-hide_banner', '-version'], { stdio: 'ignore' }).error;
}

export function bundledPath(tool: MediaTool): string | undefined {
  try {
    const file: string | null = tool === 'ffmpeg' ? require('ffmpeg-static') : require('@ffprobe-installer/ffprobe').path;
    return file && fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

export function mediaTool(tool: MediaTool): string {
  let file = found.get(tool);
  if (!file) {
    file = onPath(tool) ? tool : (bundledPath(tool) ?? tool);
    found.set(tool, file);
  }
  return file;
}

export const isBundled = (tool: MediaTool) => mediaTool(tool) !== tool;
