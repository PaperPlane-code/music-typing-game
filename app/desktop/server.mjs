import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { musicMiddleware, parseRange } from '../server/music-api.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.flac': 'audio/flac', '.lrc': 'text/plain; charset=utf-8' };
export async function startDesktopServer({ root, port = 0, music = musicMiddleware() }) {
  root = resolve(root);
  let origin;
  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host) { response.writeHead(403); response.end(); return; }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' blob:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    void music(request, response, () => { void serve(request, response); }).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  async function serve(request, response) {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); return response.end(); }
      const path = decodeURIComponent(new URL(request.url || '/', origin).pathname);
      if (path.includes('\\') || path.includes('\0')) { response.writeHead(400); return response.end(); }
      const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
      const child = relative(root, file);
      if (child.startsWith('..') || isAbsolute(child)) { response.writeHead(403); return response.end(); }
      const info = await stat(file);
      if (!info.isFile()) { response.writeHead(404); return response.end(); }
      const range = parseRange(request.headers.range, info.size);
      if (range === false) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return response.end(); }
      const start = range?.start ?? 0; const end = range?.end ?? info.size - 1;
      response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Length', info.size ? end - start + 1 : 0);
      if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      response.writeHead(range ? 206 : 200);
      if (request.method === 'HEAD' || !info.size) return response.end();
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error instanceof URIError ? 400 : error.code === 'ENOENT' ? 404 : 500);
      response.end();
    }
  }
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close() { server.closeAllConnections(); return new Promise(resolveClose => server.close(resolveClose)); } };
}
