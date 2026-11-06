import { Converter } from 'opencc-js/t2cn';

const toSimplifiedChinese = Converter({ from: 't', to: 'cn' });

export type CsvSong = { title: string; artist: string; album?: string; isrc?: string; row: number };
export type CatalogSong = {
  id: string;
  type: string;
  attributes: { name: string; artistName: string; albumName?: string; isrc?: string; artwork?: { url: string }; url?: string };
};
export type Playlist = { id: string; attributes: { name: string; canEdit?: boolean } };
export type PlaylistTrack = {
  id: string;
  type: 'library-songs' | 'library-music-videos';
  attributes: { name: string; artistName: string; albumName?: string; playParams?: { catalogId?: string } };
};

export function songIdentity(name: string, artist: string): string {
  return `${core(name.normalize('NFKC'))}|${core(artist.normalize('NFKC'))}`;
}

export function parseCsv(text: string): CsvSong[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; }
      else if (!field || quoted) quoted = !quoted;
      else field += char;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error('The CSV has an unclosed quote.');
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  if (!rows.length) throw new Error('The CSV is empty.');
  const headers = rows.shift()!.map((item) => item.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  const titleIndex = headers.findIndex((item) => ['title', 'song', 'songtitle', 'track', 'trackname', 'name'].includes(item));
  const artistIndex = headers.findIndex((item) => ['artist', 'artistname', 'performer'].includes(item));
  const albumIndex = headers.findIndex((item) => ['album', 'albumname'].includes(item));
  const isrcIndex = headers.findIndex((item) => item === 'isrc');
  if (titleIndex < 0 || artistIndex < 0) throw new Error('The CSV needs Title and Artist columns. Album is optional.');
  const songs = rows.map((cells, index) => ({
    title: cells[titleIndex]?.trim() || '', artist: cells[artistIndex]?.trim() || '',
    album: albumIndex < 0 ? undefined : cells[albumIndex]?.trim() || undefined,
    isrc: isrcIndex < 0 ? undefined : cells[isrcIndex]?.trim().toUpperCase() || undefined,
    row: index + 2,
  }));
  const incomplete = songs.find((song) => !song.title || !song.artist);
  if (incomplete) throw new Error(`Row ${incomplete.row} needs both a title and artist.`);
  const invalidIsrc = songs.find((song) => song.isrc && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(song.isrc));
  if (invalidIsrc) throw new Error(`Row ${invalidIsrc.row} has an invalid ISRC.`);
  if (songs.length > 5000) throw new Error('Import up to 5,000 songs at a time.');
  return songs;
}

export function isLive(value: string): boolean {
  return /(?:\b(?:live\s+(?:at|from|in|on)|live\s+version|live\s+recording|recorded\s+live)\b|[\[(][^\])]*\blive\b[^\])]*[\])]|\s[-–—]\s*live\b|\S\s+live\s*$)/i.test(value);
}

export function isLiveRecording(title: string, album?: string): boolean {
  return isLive(title) || isLive(album || '') || /^live(?:\s+album)?$/i.test(album?.trim() || '');
}

export function isRemastered(value: string): boolean {
  return /\bremaster(?:ed)?\b/i.test(value);
}

function core(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\[(][^\])]*(?:live|remaster|remastered)[^\])]*[\])]/gi, ' ')
    .replace(/\s[-–—]\s(?:live|\d{4}\s*remaster(?:ed)?|remaster(?:ed)?).*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function exactTitle(a: string, b: string): boolean {
  const left = core(a), right = core(b);
  return !!left && left === right;
}

// A small spelling or Chinese script change is a suggestion, not proof of a match.
export function similarTitleForReview(a: string, b: string): boolean {
  const left = core(a).replace(/\s/g, ''), right = core(b).replace(/\s/g, '');
  if (!left || !right || !/\p{Script=Han}/u.test(left) || !/\p{Script=Han}/u.test(right)) return false;
  if (toSimplifiedChinese(left) === toSimplifiedChinese(right)) return true;
  const x = Array.from(left), y = Array.from(right);
  return (Math.min(x.length, y.length) >= 3 && (left.includes(right) || right.includes(left))) ||
    (x.length >= 3 && x.length === y.length && x.filter((character, i) => character !== y[i]).length === 1);
}

export function trustedArtistAlias(source: string, alias?: string): string | undefined {
  if (!alias) return undefined;
  if (/\p{Script=Han}/u.test(source)) return alias;
  const short = core(source).replace(/\s/g, '');
  const words = core(alias).split(' ').filter((word) => word && !['the', 'of', 'in', 'and', 'a'].includes(word));
  const initials = words.map((word) => word[0]).join('');
  return short.length >= 2 && short.length <= 6 && initials === short ? alias : undefined;
}

export function exactArtist(source: string, candidate: string, alias?: string): boolean {
  const value = core(candidate);
  return !!value && (value === core(source) || (!!alias && value === core(alias)));
}

export function artistInCredit(source: string, candidate: string, alias?: string): boolean {
  return candidate.split(/\s*(?:,|，|、|&)\s*|\s+(?:and|feat\.?|featuring|ft\.?)\s+/i)
    .some((part) => exactArtist(source, part, alias) ||
      (/\p{Script=Han}/u.test(source) && /\p{Script=Han}/u.test(part) && toSimplifiedChinese(core(source)) === toSimplifiedChinese(core(part))));
}

function sameEnough(a: string, b: string): number {
  const left = core(a), right = core(b);
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return 0.75;
  const aWords = new Set(left.split(' '));
  const bWords = new Set(right.split(' '));
  const wordScore = [...aWords].filter((word) => bWords.has(word)).length / Math.max(aWords.size, bWords.size);
  const aText = left.replace(/\s/g, ''), bText = right.replace(/\s/g, '');
  if (!/\p{Script=Han}/u.test(aText) || !/\p{Script=Han}/u.test(bText) || Math.min(aText.length, bText.length) < 4) return wordScore;
  const bigrams = (value: string) => new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
  const aPairs = bigrams(aText), bPairs = bigrams(bText);
  return Math.max(wordScore, 2 * [...aPairs].filter((pair) => bPairs.has(pair)).length / (aPairs.size + bPairs.size));
}

export function rankCandidates(source: CsvSong, candidates: CatalogSong[], options: { excludeLive: boolean; preferRemastered: boolean; artistAlias?: string }): CatalogSong[] {
  return candidates
    .filter((song) => song.type === 'songs' && (!options.excludeLive || !isLiveRecording(song.attributes.name, song.attributes.albumName)))
    .map((song) => ({ song, title: sameEnough(source.title, song.attributes.name), artist: Math.max(sameEnough(source.artist, song.attributes.artistName), options.artistAlias && core(options.artistAlias) === core(song.attributes.artistName) ? 1 : 0) }))
    .filter(({ song, title, artist }) => (title >= 0.65 && artist >= 0.65) || !!(source.isrc && song.attributes.isrc?.toUpperCase() === source.isrc))
    .sort((a, b) => {
      const score = (item: typeof a) => item.title * 60 + item.artist * 40
        + (source.isrc && item.song.attributes.isrc?.toUpperCase() === source.isrc ? 200 : 0)
        + (source.album ? sameEnough(source.album, item.song.attributes.albumName || '') * 5 : 0)
        + (options.preferRemastered && isRemastered(`${item.song.attributes.name} ${item.song.attributes.albumName || ''}`) ? 12 : 0);
      return score(b) - score(a);
    })
    .map(({ song }) => song);
}

export function artworkUrl(song: CatalogSong): string | undefined {
  return song.attributes.artwork?.url.replace('{w}', '96').replace('{h}', '96');
}
