import { isLiveRecording, type CatalogSong, type CsvSong } from './music.ts';
import { runQueue } from './queue.ts';
import type { SongMatchResult } from './matching.ts';

export type SearchPhase = 'standard' | 'deep';
export type Match = {
  source: CsvSong;
  candidates: CatalogSong[];
  selectedId: string;
  status: 'pending' | 'matched' | 'skipped' | 'unmatched' | 'review' | 'error';
  phase?: SearchPhase;
  deepSearched?: boolean;
};

export async function runMatchingPasses(options: {
  results: Match[];
  matcher: (source: CsvSong, phase: SearchPhase) => Promise<SongMatchResult>;
  deepSearch: boolean;
  excludeLive: boolean;
  shouldStop: () => boolean;
  onProgress: (phase: SearchPhase, done: number, total: number) => void;
  onUpdate: (results: Match[]) => void;
}): Promise<void> {
  const { results, matcher, deepSearch, excludeLive, shouldStop, onProgress, onUpdate } = options;
  for (const phase of ['standard', 'deep'] as const) {
    if (shouldStop()) break;
    const indices = results.flatMap((item, index) => item.status === 'pending' && (item.phase || 'standard') === phase ? [index] : []);
    if (!indices.length) continue;
    let done = 0;
    onProgress(phase, 0, indices.length);
    await runQueue(indices, 3, shouldStop, async (index) => {
      const previous = results[index];
      const source = previous.source;
      if (excludeLive && isLiveRecording(source.title, source.album)) {
        results[index] = { source, candidates: [], selectedId: '', status: 'skipped' };
      } else {
        try {
          const { matches, suggestions } = await matcher(source, phase);
          if (matches.length) results[index] = { source, candidates: matches, selectedId: matches[0].id, status: 'matched', deepSearched: phase === 'deep' };
          else if (phase === 'standard' && deepSearch) results[index] = { ...previous, status: 'pending', phase: 'deep' };
          else {
            const candidates = suggestions.length ? suggestions : previous.candidates;
            results[index] = { source, candidates, selectedId: '', status: candidates.length ? 'review' : 'unmatched', deepSearched: phase === 'deep' };
          }
        } catch {
          results[index] = { ...previous, status: 'error', phase, deepSearched: phase === 'deep' };
        }
      }
      done++;
      if (done % 10 === 0 || done === indices.length) onProgress(phase, done, indices.length);
      if (done % 25 === 0 || done === indices.length) onUpdate([...results]);
    });
    onUpdate([...results]);
  }
}
