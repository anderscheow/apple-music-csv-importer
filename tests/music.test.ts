import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLiveRecording, parseCsv, rankCandidates, songIdentity, type CatalogSong } from '../src/music.ts';

const song = (id: string, name: string, artistName: string, albumName = 'Album'): CatalogSong => ({
  id, type: 'songs', attributes: { name, artistName, albumName },
});

test('CSV parser handles BOM, quoted commas, escaped quotes, and newlines', () => {
  const rows = parseCsv('\uFEFFTitle,Artist,Album\r\n"A, B","The ""Band""","One\nTwo"\r\n');
  assert.deepEqual(rows, [{ title: 'A, B', artist: 'The "Band"', album: 'One\nTwo', isrc: undefined, row: 2 }]);
});

test('accepts the supplied four-column format and a 3,040-song file', () => {
  const header = 'title,artist,album,isrc\n';
  const lines = ['情感的禁區,劉德華,情感的禁區,HKB128701018', ...Array.from({ length: 3039 }, (_, i) => `Song ${i},Artist ${i},,`)];
  const rows = parseCsv(header + lines.join('\n'));
  assert.equal(rows.length, 3040);
  assert.deepEqual(rows[0], { title: '情感的禁區', artist: '劉德華', album: '情感的禁區', isrc: 'HKB128701018', row: 2 });
  assert.equal(rows[1].isrc, undefined);
});

test('CSV parser rejects missing required columns and incomplete rows', () => {
  assert.throws(() => parseCsv('Title,Album\nDreams,Rumours'), /Title and Artist/);
  assert.throws(() => parseCsv('Title,Artist\nDreams,'), /Row 2/);
});

test('matching prefers a remaster while excluding live recordings and wrong artists', () => {
  const ranked = rankCandidates(
    { title: 'Dreams', artist: 'Fleetwood Mac', row: 2 },
    [song('1', 'Dreams', 'Fleetwood Mac'), song('2', 'Dreams (2018 Remaster)', 'Fleetwood Mac'), song('3', 'Dreams (Live at Wembley)', 'Fleetwood Mac'), song('4', 'Dreams', 'Other Artist')],
    { excludeLive: true, preferRemastered: true },
  );
  assert.deepEqual(ranked.map((item) => item.id), ['2', '1']);
});

test('an exact ISRC match outranks a text-only remaster', () => {
  const original = song('1', 'Different Display Name', 'Different Artist');
  original.attributes.isrc = 'HKB128701018';
  const ranked = rankCandidates(
    { title: '情感的禁區', artist: '劉德華', isrc: 'HKB128701018', row: 2 },
    [song('2', '情感的禁區 (Remastered)', '劉德華'), original],
    { excludeLive: true, preferRemastered: true },
  );
  assert.equal(ranked[0].id, '1');
});

test('live album detection does not exclude an unrelated studio title', () => {
  assert.equal(isLiveRecording('Live Forever', 'Definitely Maybe'), false);
  assert.equal(isLiveRecording('Song', 'Live'), true);
});

test('duplicate identity recognizes another remaster of the same song and artist', () => {
  assert.equal(songIdentity('Dreams (2018 Remaster)', 'Fleetwood Mac'), songIdentity('Dreams', 'Fleetwood Mac'));
  assert.notEqual(songIdentity('Dreams', 'Fleetwood Mac'), songIdentity('Dreams', 'Other Artist'));
});
