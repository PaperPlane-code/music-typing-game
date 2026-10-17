import { randomInt } from 'node:crypto';

export const providerNames = { netease: '网易云音乐', qq: 'QQ 音乐' };
const endpoints = {
  netease: { referer: 'https://music.163.com/' },
  qq: { referer: 'https://y.qq.com/' },
};
export class MusicError extends Error {
  constructor(message, code = 'unavailable', status = 422) { super(message); this.code = code; this.status = status; }
}
export async function upstreamJson(provider, url, options = {}) {
  try {
    const response = await fetch(url, { ...options, headers: { Referer: endpoints[provider].referer, ...options.headers }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new MusicError(`${providerNames[provider]}暂时无法响应（${response.status}）。`, 'upstream', 502);
    const body = await response.text();
    if (body.length > 3_000_000) throw new MusicError('平台返回的数据过大。', 'upstream', 502);
    try { return JSON.parse(body); } catch { throw new MusicError(`${providerNames[provider]}返回了无法识别的数据。`, 'upstream', 502); }
  } catch (error) {
    if (error instanceof MusicError) throw error;
    throw new MusicError(`${providerNames[provider]}连接失败或超时，请稍后再试。`, 'network', 502);
  }
}
function stripTags(text = '') { return String(text).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function normalizeNetease(song) {
  return { provider: 'netease', id: String(song.id), title: stripTags(song.name), artists: (song.artists || song.ar || []).map(a => stripTags(a.name)), album: stripTags((song.album || song.al)?.name), duration: Number(song.duration ?? song.dt ?? 0) / 1000 };
}
function normalizeQQ(song) {
  return { provider: 'qq', id: String(song.mid || song.songmid || ''), title: stripTags(song.title || song.name || song.songname), artists: (song.singer || []).map(a => stripTags(a.name)), album: stripTags(song.album?.name || song.albumname), duration: Number(song.interval || 0), mediaId: song.file?.media_mid || song.file?.strMediaMid || song.mid, songType: Number(song.type || 0), numericId: Number(song.id || song.songid || 0) };
}
export async function searchProvider(provider, keyword) {
  if (provider === 'netease') {
    const data = await upstreamJson(provider, 'https://music.163.com/api/search/get/web', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ s: keyword, type: '1', limit: '16', offset: '0' }) });
    if (data.code !== 200) throw new MusicError('网易云搜索暂时不可用。', 'upstream', 502);
    return (data.result?.songs || []).map(normalizeNetease).filter(s => /^\d+$/.test(s.id) && s.title);
  }
  if (provider === 'qq') {
    const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' + new URLSearchParams({ w: keyword, format: 'json', p: '1', n: '16', new_json: '1' });
    const data = await upstreamJson(provider, url);
    if (data.code !== 0) throw new MusicError('QQ 音乐搜索暂时不可用。', 'upstream', 502);
    return (data.data?.song?.list || []).map(normalizeQQ).filter(s => /^[a-zA-Z0-9]+$/.test(s.id) && s.title);
  }
  throw new MusicError('不支持的音乐平台。', 'invalid', 400);
}
function decodeEntities(text = '') {
  return text.replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16))).replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number))).replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
export async function resolveProvider(track) {
  if (track.provider === 'netease') {
    const [audio, words] = await Promise.all([
      upstreamJson('netease', 'https://music.163.com/api/song/enhance/player/url?' + new URLSearchParams({ ids: JSON.stringify([Number(track.id)]), br: '128000' })),
      upstreamJson('netease', 'https://music.163.com/api/song/lyric?' + new URLSearchParams({ id: track.id, lv: '-1', kv: '-1', tv: '-1' })),
    ]);
    const file = audio.data?.find(item => String(item.id) === track.id);
    if (!file?.url) throw new MusicError('此版本暂未提供匿名可播放音源，可能需要登录、会员或存在地区限制。', 'restricted');
    if (file.freeTrialInfo) throw new MusicError('平台仅提供试听片段，不能用于完整歌词关卡。', 'trial');
    if (!words.lrc?.lyric) throw new MusicError('此版本没有可用的时间戳歌词。', 'no_lyrics');
    return { url: file.url, lyric: words.lrc.lyric, duration: Number(file.time || 0) / 1000 || track.duration };
  }
  const guid = String(randomInt(1_000_000_000, 9_999_999_999));
  const data = {
    comm: { uin: 0, format: 'json', ct: 19, cv: 1859 },
    req: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid, songmid: [track.id], songtype: [track.songType || 0], uin: '0', loginflag: 1, platform: '20' } },
  };
  const [audio, words] = await Promise.all([
    upstreamJson('qq', 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(JSON.stringify(data))),
    upstreamJson('qq', 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' + new URLSearchParams({ songmid: track.id, format: 'json', nobase64: '1', g_tk: '5381' })),
  ]);
  const response = audio.req?.data;
  const file = response?.midurlinfo?.find(item => item.songmid === track.id) || response?.midurlinfo?.[0];
  if (!file?.purl) throw new MusicError('此版本暂未提供匿名可播放音源，可能需要登录、会员或存在地区限制。', 'restricted');
  if (/^(RS|TS|R000|C200)/i.test(file.filename || '') || /(?:^|\/)RS\d|(?:^|\/)C200/.test(file.purl)) throw new MusicError('平台仅提供试听片段，不能用于完整歌词关卡。', 'trial');
  let lyric = words.lyric || '';
  if (lyric && !lyric.includes('[')) { try { lyric = Buffer.from(lyric, 'base64').toString('utf8'); } catch { lyric = ''; } }
  if (!lyric) throw new MusicError('此版本没有可用的时间戳歌词。', 'no_lyrics');
  return { url: new URL(file.purl, response.sip?.find(url => url.startsWith('https:')) || response.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/').href, lyric: decodeEntities(lyric), duration: track.duration };
}

export function isAllowedMediaUrl(value, provider) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return false;
    if (provider === 'netease') return url.hostname.endsWith('.music.126.net') || url.hostname.endsWith('.music.163.com');
    return url.hostname === 'aqqmusic.tc.qq.com' || url.hostname === 'stream.qqmusic.qq.com' || url.hostname.endsWith('.stream.qqmusic.qq.com');
  } catch { return false; }
}
export async function fetchMedia(url, provider, range = false) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!isAllowedMediaUrl(url, provider)) throw new MusicError('平台返回了不支持的音频地址。', 'media');
    const secure = new URL(url); secure.protocol = 'https:'; secure.port = '';
    let response;
    try { response = await fetch(secure, { redirect: 'manual', headers: { Referer: endpoints[provider].referer, ...(range ? { Range: 'bytes=0-2047' } : {}) }, signal: AbortSignal.timeout(range ? 10000 : 30000) }); }
    catch { throw new MusicError('音频服务器连接失败或超时。', 'network'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new MusicError('音频服务器没有提供有效跳转地址。', 'media');
      url = new URL(location, secure).href; continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new MusicError('音频链接已失效，或当前不可播放。', 'media'); }
    const type = response.headers.get('content-type') || '';
    if (/text\/|application\/(json|xml)/i.test(type)) { await response.body.cancel(); throw new MusicError('平台没有返回音频文件。', 'media'); }
    return response;
  }
  throw new MusicError('音频跳转次数过多。', 'media');
}
export async function downloadMedia(url, provider) {
  const response = await fetchMedia(url, provider);
  const limit = 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new MusicError('音频超过本地试玩的 20 MB 限制。', 'too_large'); }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > limit) throw new MusicError('音频超过本地试玩的 20 MB 限制。', 'too_large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (size < 1024) throw new MusicError('平台返回的音频内容不完整。', 'media');
  return { bytes: Buffer.concat(chunks), type: response.headers.get('content-type') || 'application/octet-stream' };
}
