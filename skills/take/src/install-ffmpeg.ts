import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { bundledPath, onPath } from './media-tools.ts';

const require = createRequire(import.meta.url);

const ffprobe = bundledPath('ffprobe');
if (ffprobe) fs.chmodSync(ffprobe, 0o755);

if (onPath('ffmpeg') && onPath('ffprobe')) {
  console.log('Take will use your ffmpeg: nothing to download.');
} else {
  if (!bundledPath('ffmpeg')) {
    console.log('ffmpeg not found: downloading a copy for Take (once, about 45 MB).');
    const folder = path.dirname(require.resolve('ffmpeg-static/package.json'));
    spawnSync(process.execPath, ['install.js'], { cwd: folder, stdio: 'inherit' });
  }
  if (!bundledPath('ffmpeg') || !ffprobe) console.log("Take couldn't get its own ffmpeg. Run take doctor to see what to do.");
}
