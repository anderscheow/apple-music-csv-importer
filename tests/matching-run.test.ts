import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMatchingPasses, type Match } from '../src/matching-run.ts';
import type { CatalogSong } from '../src/music.ts';

const song = (title: string, row: number): Match => ({ source: { title, artist: 'Artist', row }, candidates: [], selectedId: '', status: 'pending', phase: 'standard' });
const catalog: CatalogSong = { id: '1', type: 'songs', attributes: { name: 'Found', artistName: 'Artist' } };
const quiet = { excludeLive: true, onProgress: () => {}, onUpdate: () => {} };

test('deep search runs after the first pass only for songs without a match', async () => {
  const results = [song('Found', 1), song('Missing', 2), song('Live (Live)', 3)];
  const calls: string[] = [];
  await runMatchingPasses({ ...quiet, results, deepSearch: true, shouldStop: () => false, matcher: async (source, phase) => {
    calls.push(`${source.title}:${phase}`);
    return source.title === 'Found' ? { matches: [catalog], suggestions: [] } : phase === 'deep' ? { matches: [], suggestions: [catalog] } : { matches: [], suggestions: [] };
  } });
  assert.deepEqual(calls, ['Found:standard', 'Missing:standard', 'Missing:deep']);
  assert.deepEqual(results.map((result) => result.status), ['matched', 'review', 'skipped']);
  assert.equal(results[1].selectedId, '');
});

test('with deep search off, unmatched songs do not run a second pass', async () => {
  const results = [song('Missing', 1)];
  const phases: string[] = [];
  await runMatchingPasses({ ...quiet, results, deepSearch: false, shouldStop: () => false, matcher: async (_source, phase) => { phases.push(phase); return { matches: [], suggestions: [] }; } });
  assert.deepEqual(phases, ['standard']);
  assert.equal(results[0].status, 'unmatched');
});

test('pausing the first pass preserves both phases and resumes without redoing completed work', async () => {
  const results = Array.from({ length: 5 }, (_, i) => song(`Song ${i}`, i));
  let paused = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const matcher = async (source: Match['source'], phase: 'standard' | 'deep') => {
    calls.push(`${source.title}:${phase}`);
    if (phase === 'standard') await gate;
    return { matches: [], suggestions: [] };
  };
  const running = runMatchingPasses({ ...quiet, results, deepSearch: true, shouldStop: () => paused, matcher });
  paused = true; release(); await running;
  assert.equal(calls.filter((call) => call.endsWith(':standard')).length, 3);
  assert.equal(calls.filter((call) => call.endsWith(':deep')).length, 0);
  assert.equal(results.filter((result) => result.phase === 'standard').length, 2);
  assert.equal(results.filter((result) => result.phase === 'deep').length, 3);
  paused = false;
  await runMatchingPasses({ ...quiet, results, deepSearch: true, shouldStop: () => paused, matcher });
  assert.equal(calls.filter((call) => call.endsWith(':standard')).length, 5);
  assert.equal(calls.filter((call) => call.endsWith(':deep')).length, 5);
  assert.ok(results.every((result) => result.status === 'unmatched' && result.deepSearched));
});

test('records which pass failed and preserves earlier suggestions', async () => {
  const results: Match[] = [{ ...song('Missing', 1), candidates: [catalog], phase: 'deep' }];
  await runMatchingPasses({ ...quiet, results, deepSearch: true, shouldStop: () => false, matcher: async () => { throw Error('offline'); } });
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].phase, 'deep');
  assert.deepEqual(results[0].candidates, [catalog]);
});

test('retrying a failed deep search keeps prior suggestions when no better result is found', async () => {
  const results: Match[] = [{ ...song('Missing', 1), candidates: [catalog], status: 'pending', phase: 'deep' }];
  await runMatchingPasses({ ...quiet, results, deepSearch: false, shouldStop: () => false, matcher: async (_source, phase) => {
    assert.equal(phase, 'deep');
    return { matches: [], suggestions: [] };
  } });
  assert.equal(results[0].status, 'review');
  assert.deepEqual(results[0].candidates, [catalog]);
  assert.equal(results[0].deepSearched, true);
});
