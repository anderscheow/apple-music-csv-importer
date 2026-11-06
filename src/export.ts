import type { CsvSong } from './music.ts';

type MatchForExport = { source: CsvSong; status: string; candidates: readonly unknown[] };

export function missingMatches(matches: readonly MatchForExport[]): MatchForExport[] {
  return matches.filter((match) => match.status === 'error' || match.status === 'review' || (match.status === 'unmatched' && match.candidates.length === 0));
}

export function missingMatchesCsv(matches: readonly MatchForExport[]): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = missingMatches(matches).map(({ source, status }) => [
    source.title, source.artist, source.album || '', source.isrc || '', status === 'error' ? 'Search failed' : status === 'review' ? 'Needs review' : 'No match',
  ].map(quote).join(','));
  return '\uFEFFtitle,artist,album,isrc,reason\r\n' + rows.join('\r\n') + (rows.length ? '\r\n' : '');
}
