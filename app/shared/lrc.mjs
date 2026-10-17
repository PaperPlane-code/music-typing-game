class LyricsError extends Error { constructor(message, code = 'lyrics') { super(message); this.name = 'LyricsError'; this.code = code; } }
function normalizeKey(value) { return value.normalize('NFKC').toLocaleLowerCase().replace(/\s/g, ''); }
const strongCredits = /^(?:作词人?|作曲人?|制曲人|词曲作者|编曲人?|制作人|制作统筹|制作团队|音乐制作|录音(?:师|室)?|混音(?:师|室)?|母带(?:工程师)?|和声(?:编写)?|监制|发行(?:公司)?|出品(?:人|公司)?|版权(?:所有)?|录制|配唱制作|吉他|贝斯|鼓手|键盘|弦乐|人声编辑|音频编辑|后期制作)/u;
const credits = /^(?:词曲|词|曲|制作|演唱|原唱|人声|制谱|木吉他|电吉他|乐队|vocal|copyist|orchestra|lyrics?|lyricist|composer|arrang(?:er|ement)|producer|produced\s+by|music|OP|SP)\s*(?:[:：/／|｜]|\s+by\b|\s+)/iu;
const instrumentalLabels = /^(?:前奏|间奏|尾奏|纯音乐|伴奏|instrumental|intro|outro|interlude)$/iu;
const visibleCharacters = /[\p{L}\p{N}]/u;
export function isInformationLine(text, start = 0, track = {}) {
  if (!visibleCharacters.test(text) || strongCredits.test(text) || credits.test(text)) return true;
  const label = text.replace(/^[\s(（【\[]+|[\s)）】\]]+$/g, '');
  if (instrumentalLabels.test(label)) return true;
  const title = normalizeKey(track.title || '');
  const artists = (track.artists || []).map(normalizeKey);
  const titleCredits = new Set(artists.length ? [`${title}-${artists.join('/')}`, `${title}-${artists.join('&')}`, `${title}–${artists.join('/')}`] : []);
  return start < 15 && titleCredits.has(normalizeKey(text));
}
export function parseLrc(lyric, duration, track = {}) {
  if (typeof lyric !== 'string' || !Number.isFinite(duration) || duration <= 0 || duration > 15 * 60) throw new LyricsError('歌曲时长异常，或超过 15 分钟。', 'lyrics');
  const offset = Number(lyric.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const entries = [];
  for (const raw of lyric.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{2}(?:\.\d+)?>/g, '').trim();
    for (const tag of tags) {
      const seconds = Number(tag[1]) * 60 + Number(tag[2]) + Number(`0.${tag[3] || 0}`) + offset;
      if (Number(tag[2]) >= 60 || seconds >= duration || seconds < 0) continue;
      entries.push({ start: seconds, text });
    }
  }
  entries.sort((a, b) => a.start - b.start);
  const unique = [];
  for (const entry of entries) {
    const previous = unique.at(-1);
    if (!previous || entry.start !== previous.start) unique.push(entry);
    else if (isInformationLine(previous.text, previous.start, track) && !isInformationLine(entry.text, entry.start, track)) unique[unique.length - 1] = entry;
  }
  const segments = [];
  for (let index = 0; index < unique.length; index++) {
    const entry = unique[index];
    if (isInformationLine(entry.text, entry.start, track)) continue;
    const end = unique[index + 1]?.start ?? Math.min(duration, entry.start + 8);
    if (end - entry.start < .15) continue;
    segments.push({ id: `line-${index + 1}`, displayText: entry.text, inputText: entry.text, start: Math.round(entry.start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
  }
  if (!segments.length) throw new LyricsError('没有找到可用于游戏的时间戳歌词，可能是纯音乐或歌词未收录。', 'no_lyrics');
  return segments;
}

