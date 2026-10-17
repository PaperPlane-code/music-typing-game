import { startDesktopServer } from './server.mjs';
import { musicMiddleware } from '../server/music-api.mjs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1]; };
const readyFile = option('--ready-file');
const token = option('--quit-token');
if (!readyFile || !isAbsolute(readyFile) || !/^[a-f0-9]{32}$/.test(token || '')) throw new Error('Invalid launcher arguments.');
const metadata = JSON.parse(await readFile(new URL('../../version.json', import.meta.url), 'utf8'));
const music = musicMiddleware();
let local;
let stopping = false;
let pageRequests = 0;
let clientState = 'waiting';
let clientMessage = '';
let clientStage = 'library';
async function stop() { if (stopping) return; stopping = true; await local?.close(); process.exit(0); }
const middleware = async (request, response, next) => {
  const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && (path === '/' || path === '/index.html')) { pageRequests++; console.log('Game page requested.'); }
  if (path === '/__zijian/status' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ application: 'zijian-browser', version: metadata.version, runtime: process.version, pageRequests, clientState, clientMessage, clientStage }));
  }
  if (path === '/__zijian/client-ready') {
    if (request.method !== 'POST' || request.headers.origin !== local.origin) { response.writeHead(403); return response.end(); }
    if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415); return response.end(); }
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 1024) { response.writeHead(413); return response.end(); } }
    let data;
    try { data = JSON.parse(body); } catch { response.writeHead(400); return response.end(); }
    if (!data || !['ready', 'error'].includes(data.state) || (data.message !== undefined && typeof data.message !== 'string') || (data.stage !== undefined && !['library', 'song'].includes(data.stage))) { response.writeHead(400); return response.end(); }
    clientState = data.state; clientStage = data.stage || 'song'; clientMessage = data.state === 'error' ? (data.message || '网页加载失败。').slice(0, 200) : '';
    console.log(clientState === 'ready' ? (clientStage === 'library' ? 'Import screen confirmed ready.' : 'Game code and audio confirmed ready.') : 'Game client reported a loading error.');
    response.writeHead(204); return response.end();
  }
  if (path === '/__zijian/quit') {
    const supplied = request.headers['x-zijian-token'];
    const origin = request.headers.origin;
    const valid = typeof supplied === 'string' && /^[a-f0-9]{32}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if (request.method !== 'POST' || !valid || (origin && origin !== local.origin)) { response.writeHead(403); return response.end(); }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end('{"stopping":true}', () => setTimeout(() => { void stop(); }, 30));
  }
  return music(request, response, next);
};
const settings = { root: fileURLToPath(new URL('../../web/', import.meta.url)), music: middleware };
try { local = await startDesktopServer({ ...settings, port: 52731 }); }
catch (error) { if (error.code !== 'EADDRINUSE') throw error; local = await startDesktopServer(settings); }
await writeFile(readyFile + '.tmp', JSON.stringify({ origin: local.origin, application: 'zijian-browser', version: metadata.version, pid: process.pid, runtime: process.version }));
await rename(readyFile + '.tmp', readyFile);
console.log('Zijian browser service is ready.');
if (argv.includes('--parent-stdin')) { process.stdin.resume(); process.stdin.on('end', () => { void stop(); }); }
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('uncaughtException', error => { console.error(error.stack || error); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error); process.exit(1); });
