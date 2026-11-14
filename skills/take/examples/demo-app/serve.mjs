// Zero-dependency static server for the demo app. Usage: node examples/demo-app/serve.mjs [port]   (default 4300)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/** Starts the server and resolves with its URL. Port 0 picks a free port. */
export function serve(port = 4300) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost').pathname;
    const file = path.join(ROOT, url === '/' ? 'index.html' : path.normalize(url));
    if (!file.startsWith(ROOT) || !TYPES[path.extname(file)] || !fs.existsSync(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${actual}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(Number(process.argv[2] ?? 4300));
  console.log(`Boards demo app: ${url}`);
}
