import { randomUUID } from 'node:crypto';
import { searchProvider, resolveProvider, fetchMedia, downloadMedia, MusicError, providerNames } from './providers.mjs';
import { parseLrc, searchAll } from './catalog.mjs';

const TEN_MINUTES = 10 * 60 * 1000;
async function mapConcurrent(items, limit, task) {
  const results = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await task(items[index]); }
  }));
  return results;
}
export function createMusicService(dependencies = {}) {
  const search = dependencies.search || searchProvider;
  const resolve = dependencies.resolve || resolveProvider;
  const probe = dependencies.probe || (async (url, provider) => { const response = await fetchMedia(url, provider, true); await response.body.cancel(); });
  const download = dependencies.download || downloadMedia;
  const tracks = new Map(); const audio = new Map(); const searchCache = new Map();
  let preparing = 0;
  function clean() {
    const now = Date.now();
    for (const store of [tracks, audio, searchCache]) for (const [key, item] of store) if (item.expires <= now) store.delete(key);
  }
  return {
    async search(keyword) {
      clean();
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 80) throw new MusicError('请输入 1～80 个字的歌名或歌手。', 'invalid', 400);
      keyword = keyword.trim();
      const existing = searchCache.get(keyword); if (existing) return existing.value;
      const result = await searchAll(keyword, search);
      for (const track of result.tracks) tracks.set(`${track.provider}:${track.id}`, { value: track, expires: Date.now() + TEN_MINUTES });
      while (tracks.size > 1200) tracks.delete(tracks.keys().next().value);
      const value = { groups: result.groups, providers: result.providers };
      if (result.providers.every(item => item.status === 'ok')) searchCache.set(keyword, { value, expires: Date.now() + 60_000 });
      while (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value);
      return value;
    },
    async prepare(candidates, skip = []) {
      clean();
      if (preparing >= 2) throw new MusicError('正在准备另一首歌，请稍后再试。', 'busy', 429);
      if (!Array.isArray(candidates) || !candidates.length || candidates.length > 32 || !Array.isArray(skip) || skip.length > 32) throw new MusicError('歌曲选择无效，请重新搜索。', 'invalid', 400);
      const selected = [];
      for (const candidate of candidates) {
        if (!candidate || !['netease', 'qq'].includes(candidate.provider) || typeof candidate.id !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(candidate.id)) throw new MusicError('歌曲编号无效。', 'invalid', 400);
        const key = `${candidate.provider}:${candidate.id}`;
        if (skip.includes(key) || selected.some(track => `${track.provider}:${track.id}` === key)) continue;
        const track = tracks.get(key)?.value;
        if (!track) throw new MusicError('搜索结果已过期，请重新搜索这首歌。', 'expired', 410);
        selected.push(track);
      }
      if (!selected.length) throw new MusicError('这些音源都未通过浏览器播放检查，请尝试其他版本。', 'unavailable');
      preparing++;
      try {
        const attempts = [];
        const checked = await mapConcurrent(selected, 4, async track => {
          const started = Date.now();
          try {
            const media = await resolve(track);
            const segments = parseLrc(media.lyric, media.duration, track);
            await probe(media.url, track.provider);
            return { track, media, segments, elapsed: Date.now() - started };
          } catch (error) { attempts.push({ provider: track.provider, id: track.id, title: track.title, status: 'unavailable', message: error.message || '该音源暂时不可用。' }); return null; }
        });
        const ready = checked.filter(Boolean).sort((a, b) => a.elapsed - b.elapsed);
        for (const candidate of ready) {
          const { track, media, segments } = candidate;
          try {
            const file = await download(media.url, track.provider);
            const token = randomUUID();
            while (audio.size >= 2) audio.delete(audio.keys().next().value);
            audio.set(token, { ...file, expires: Date.now() + TEN_MINUTES });
            attempts.push({ provider: track.provider, id: track.id, title: track.title, status: 'selected', message: '音频和时间戳歌词已取得，接下来检查浏览器解码。' });
            return {
              song: { schemaVersion: 1, id: `${track.provider}-${track.id}`, title: track.title, subtitle: track.artists.join(' / '), credit: `${providerNames[track.provider]} · ${track.artists.join(' / ')}`, audioFile: `/api/music/audio/${token}`, bpm: 0, segments, source: track.provider, sourceTrackId: track.id, expectedDuration: media.duration, album: track.album },
              attempts,
              notice: '按此音源的歌词时间轴生成关卡；平台分句可能包含间奏或尾音，请先试听。',
            };
          } catch (error) { attempts.push({ provider: track.provider, id: track.id, title: track.title, status: 'unavailable', message: error.message || '音频下载失败。' }); }
        }
        const error = new MusicError('这首歌目前没有同时具备音频和时间戳歌词的可用音源。', 'unavailable'); error.attempts = attempts; throw error;
      } finally { preparing--; }
    },
    getAudio(token) { clean(); return audio.get(token); },
  };
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end };
}
export function musicMiddleware(service = createMusicService()) {
  return async (request, response, next) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/music/')) return next();
    response.setHeader('Cache-Control', 'no-store');
    // The API is only for this local game, not an open proxy for other sites.
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) return json(response, 403, { message: '只接受当前游戏页面发起的请求。' });
    try {
      if (url.pathname === '/api/music/search' && request.method === 'GET') return json(response, 200, await service.search(url.searchParams.get('q')));
      if (url.pathname === '/api/music/prepare' && request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new MusicError('请求格式不正确。', 'invalid', 415);
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8000) throw new MusicError('请求内容过大。', 'invalid', 413); }
        let data; try { data = JSON.parse(body); } catch { throw new MusicError('请求数据格式不正确。', 'invalid', 400); }
        return json(response, 200, await service.prepare(data.candidates, data.skip));
      }
      const audioMatch = /^\/api\/music\/audio\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (audioMatch && ['GET', 'HEAD'].includes(request.method)) {
        const audio = service.getAudio(audioMatch[1]);
        if (!audio) throw new MusicError('音源准备结果已过期，请重新选择歌曲。', 'expired', 410);
        const range = parseRange(request.headers.range, audio.bytes.length);
        response.setHeader('Content-Type', audio.type); response.setHeader('Accept-Ranges', 'bytes');
        if (range === false) { response.writeHead(416, { 'Content-Range': `bytes */${audio.bytes.length}` }); return response.end(); }
        const start = range ? range.start : 0; const end = range ? range.end : audio.bytes.length - 1;
        response.setHeader('Content-Length', end - start + 1);
        if (range) { response.setHeader('Content-Range', `bytes ${start}-${end}/${audio.bytes.length}`); response.statusCode = 206; }
        return response.end(request.method === 'HEAD' ? undefined : audio.bytes.subarray(start, end + 1));
      }
      return json(response, 404, { message: '没有这个音乐接口。' });
    } catch (error) { return json(response, error.status || 500, { message: error instanceof MusicError ? error.message : '准备音乐时发生异常，请重试。', code: error.code || 'internal', attempts: error.attempts || [] }); }
  };
}
function json(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
export function onlineMusicPlugin() {
  const middleware = musicMiddleware();
  return { name: 'zijian-local-music', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
