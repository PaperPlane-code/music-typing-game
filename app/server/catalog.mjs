import { createHash } from 'node:crypto';
export { parseLrc, isInformationLine } from '../shared/lrc.mjs';

function normalizeKey(value) { return value.normalize('NFKC').toLocaleLowerCase().replace(/\s/g, ''); }
export function groupTracks(tracks) {
  const groups = [];
  for (const track of tracks) {
    const key = normalizeKey(track.title) + '|' + track.artists.map(normalizeKey).sort().join('/');
    const existing = groups.find(group => group.key === key && Math.abs(group.duration - track.duration) <= 4);
    if (existing) {
      if (!existing.candidates.some(item => item.provider === track.provider && item.id === track.id)) existing.candidates.push(track);
    } else groups.push({ key, id: createHash('sha256').update(key + ':' + track.duration).digest('hex').slice(0, 16), title: track.title, artists: track.artists, album: track.album, duration: track.duration, candidates: [track] });
  }
  return groups.map(({ key, ...group }) => group);
}

export async function searchAll(keyword, search) {
  const providers = ['netease', 'qq'];
  const settled = await Promise.allSettled(providers.map(provider => search(provider, keyword)));
  const tracks = []; const statuses = [];
  settled.forEach((result, index) => {
    const provider = providers[index];
    if (result.status === 'fulfilled') { tracks.push(...result.value); statuses.push({ provider, status: 'ok', count: result.value.length }); }
    else statuses.push({ provider, status: 'error', count: 0, message: result.reason instanceof Error ? result.reason.message : '搜索失败。' });
  });
  // Interleave sources; neither platform gets permanent first position in the combined list.
  const interleaved = []; const lists = providers.map(provider => tracks.filter(item => item.provider === provider));
  for (let i = 0; i < Math.max(...lists.map(list => list.length)); i++) lists.forEach(list => { if (list[i]) interleaved.push(list[i]); });
  return { groups: groupTracks(interleaved), providers: statuses, tracks };
}
