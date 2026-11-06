import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingMatches, missingMatchesCsv } from '../src/export.ts';
import { parseCsv, type CsvSong } from '../src/music.ts';

test('exports unmatched and failed songs in order, preserving CSV fields for reimport', () => {
  const source = (row: number, title: string, artist: string, album?: string, isrc?: string): CsvSong => ({ row, title, artist, album, isrc });
  const matches = [
    { source: source(2, '歌曲, "一"', '歌手', '專輯\n第二行', 'HKB128701018'), status: 'unmatched', candidates: [] },
    { source: source(3, 'Failed', 'Artist'), status: 'error', candidates: [] },
    { source: source(8, 'Needs confirmation', 'Artist'), status: 'review', candidates: [{ id: '3' }] },
    { source: source(4, 'Skipped manually', 'Artist'), status: 'unmatched', candidates: [{ id: '1' }] },
    { source: source(5, 'Waiting', 'Artist'), status: 'pending', candidates: [] },
    { source: source(6, 'Live', 'Artist'), status: 'skipped', candidates: [] },
    { source: source(7, 'Found', 'Artist'), status: 'matched', candidates: [{ id: '2' }] },
  ];
  const csv = missingMatchesCsv(matches);
  assert.equal(missingMatches(matches).length, 3);
  assert.ok(csv.startsWith('\uFEFFtitle,artist,album,isrc,reason\r\n'));
  assert.match(csv, /"No match"\r\n.*"Search failed"/s);
  assert.deepEqual(parseCsv(csv).map(({ row: _row, ...song }) => song), [
    { title: '歌曲, "一"', artist: '歌手', album: '專輯\n第二行', isrc: 'HKB128701018' },
    { title: 'Failed', artist: 'Artist', album: undefined, isrc: undefined },
    { title: 'Needs confirmation', artist: 'Artist', album: undefined, isrc: undefined },
  ]);
});
