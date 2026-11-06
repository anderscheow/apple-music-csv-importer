import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSongMatcher } from '../src/matching.ts';
import { isLiveRecording, type CatalogSong } from '../src/music.ts';

const item = (id: string, name: string, artistName: string): CatalogSong => ({ id, type: 'songs', attributes: { name, artistName } });
const opts = { excludeLive: true, preferRemastered: false };

test('matches Chinese names to Apple artist names and shares artist lookups', async () => {
  let artistCalls = 0;
  const matcher = createSongMatcher({
    songs: async (term) => term.startsWith('歲月如歌') ? [item('1', '歲月如歌', 'Eason Chan')] : [item('2', '浮誇', 'Eason Chan')],
    artist: async () => { artistCalls++; return 'Eason Chan'; },
    isrc: async () => [],
  }, opts);
  const result = await Promise.all([
    matcher({ title: '歲月如歌', artist: '陳奕迅', row: 2 }),
    matcher({ title: '浮誇', artist: '陳奕迅', row: 3 }),
  ]);
  assert.deepEqual(result.map((result) => result.matches[0]?.id), ['1', '2']);
  assert.equal(artistCalls, 1);
});

test('falls back to title search and matches close Chinese title variants', async () => {
  const matcher = createSongMatcher({
    songs: async (term) => term === '沒有你我什麼都不是' ? [item('1', '沒有你, 我甚麼都不是', 'Jason Chan')] : [],
    artist: async () => 'Jason Chan', isrc: async () => [],
  }, opts);
  assert.equal((await matcher({ title: '沒有你我什麼都不是', artist: '陳柏宇', row: 1 })).matches[0]?.id, '1');
});

test('keeps a valid match if the remaster search fails', async () => {
  const matcher = createSongMatcher({
    songs: async (term) => { if (term.endsWith('remastered')) throw Error('rate limited'); return [item('1', 'Dreams', 'Fleetwood Mac')]; },
    artist: async () => undefined, isrc: async () => [],
  }, { ...opts, preferRemastered: true, extraRemasterSearch: true });
  assert.equal((await matcher({ title: 'Dreams', artist: 'Fleetwood Mac', row: 1 })).matches[0]?.id, '1');
});

test('fast matching prefers an existing remaster without running another search', async () => {
  let calls = 0;
  const matcher = createSongMatcher({
    songs: async () => { calls++; return [item('1', 'Dreams', 'Fleetwood Mac'), item('2', 'Dreams (2018 Remaster)', 'Fleetwood Mac')]; },
    artist: async () => undefined, isrc: async () => [],
  }, { ...opts, preferRemastered: true, extraRemasterSearch: false });
  assert.equal((await matcher({ title: 'Dreams', artist: 'Fleetwood Mac', row: 1 })).matches[0]?.id, '2');
  assert.equal(calls, 1);
});

test('reports failed searches and excludes live labels without excluding Live Forever', async () => {
  const matcher = createSongMatcher({ songs: async () => { throw Error('offline'); }, artist: async () => undefined, isrc: async () => [] }, opts);
  await assert.rejects(matcher({ title: 'Dreams', artist: 'Fleetwood Mac', row: 1 }), /offline/);
  assert.equal(isLiveRecording('Baby Boy (Homecoming Live)'), true);
  assert.equal(isLiveRecording('王子 Live'), true);
  assert.equal(isLiveRecording('Live Forever'), false);
});

test('resolves an abbreviated artist name without trusting an unrelated search result', async () => {
  const track = item('1', 'Enola Gay', 'Orchestral Manoeuvres In the Dark');
  const matcher = createSongMatcher({ songs: async () => [track], artist: async () => 'Orchestral Manoeuvres In the Dark', isrc: async () => [] }, opts);
  assert.equal((await matcher({ title: 'Enola Gay', artist: 'OMD', row: 1 })).matches[0]?.id, '1');
  const unrelated = await matcher({ title: 'Enola Gay', artist: 'XYZ', row: 2 });
  assert.equal(unrelated.matches.length, 0);
});

test('maps a verified Chinese catalog recording into the user storefront by equivalent ID and ISRC', async () => {
  const local = item('101', '晴天', '周杰倫'); local.attributes.isrc = 'TWK970300503';
  const destination = item('202', 'Sunny Day', 'Jay Chou'); destination.attributes.isrc = 'TWK970300503';
  const matcher = createSongMatcher({
    songs: async () => [], artist: async () => 'Jay Chou', isrc: async () => [],
    localizedSongs: async () => [local], equivalents: async (ids) => { assert.deepEqual(ids, ['101']); return { '101': [destination] }; },
  }, opts);
  const result = await matcher({ title: '晴天', artist: '周杰倫', row: 1 });
  assert.equal(result.matches[0]?.id, '202');
  assert.equal(result.suggestions.length, 0);
});

test('offers Chinese spelling variations for review instead of auto-selecting', async () => {
  const local = item('101', '囍帖街', '謝安琪'); local.attributes.isrc = 'HKUM70801425';
  const destination = item('202', '囍帖街', 'Kay Tse'); destination.attributes.isrc = 'HKUM70801425';
  const matcher = createSongMatcher({ songs: async () => [], artist: async () => 'Kay Tse', isrc: async () => [], localizedSongs: async () => [local], equivalents: async () => ({ '101': [destination] }) }, opts);
  const result = await matcher({ title: '喜帖街', artist: '謝安琪', row: 1 });
  assert.deepEqual(result.matches, []);
  assert.equal(result.suggestions[0]?.id, '202');
});

test('does not automatically choose a different recording or an excluded live version', async () => {
  const source = { title: '晴天', artist: '周杰倫', row: 1 };
  const local = item('101', '晴天', '周杰倫'); local.attributes.isrc = 'TWK970300503';
  const alternate = item('202', 'Sunny Day', 'Jay Chou'); alternate.attributes.isrc = 'TWK970400804';
  const live = item('303', 'Sunny Day (Live)', 'Jay Chou'); live.attributes.isrc = local.attributes.isrc;
  const matcher = createSongMatcher({ songs: async () => [], artist: async () => 'Jay Chou', isrc: async () => [], localizedSongs: async () => [local], equivalents: async () => ({ '101': [alternate, live] }) }, opts);
  const result = await matcher(source);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.suggestions.map((song) => song.id), ['202']);
});

test('keeps unrelated translated titles as suggestions without selecting them', async () => {
  const matcher = createSongMatcher({ songs: async () => [item('1', 'A Different Song', 'Jay Chou')], artist: async () => 'Jay Chou', isrc: async () => [] }, opts);
  const result = await matcher({ title: '晴天', artist: '周杰倫', row: 1 });
  assert.deepEqual(result.matches, []);
  assert.equal(result.suggestions[0]?.id, '1');
});

test('offers collaborations with the intended artist for review', async () => {
  const song = item('1', '拈花惹草 (關心妍合唱)', 'Priscilla Chan & Jade Kwan');
  const matcher = createSongMatcher({ songs: async () => [song], artist: async () => 'Jade Kwan', isrc: async () => [] }, opts);
  const result = await matcher({ title: '拈花惹草', artist: '關心妍', row: 1 });
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.suggestions.map((candidate) => candidate.id), ['1']);
});

test('keeps known storefront results when equivalent lookup for another release fails', async () => {
  const known = item('10', 'Sunny Day', 'Jay Chou'); known.attributes.isrc = 'TWK970300503';
  const localized = item('11', '晴天', '周杰倫'); localized.attributes.isrc = known.attributes.isrc;
  const other = item('12', '晴天', '周杰倫'); other.attributes.isrc = 'TWK970300504';
  const matcher = createSongMatcher({ songs: async () => [known], artist: async () => 'Jay Chou', isrc: async () => [], localizedSongs: async () => [localized, other], equivalents: async () => { throw Error('offline'); } }, opts);
  const result = await matcher({ title: '晴天', artist: '周杰倫', row: 1 });
  assert.equal(result.matches[0]?.id, '10');
});

test('offers traditional and simplified Chinese variations for review', async () => {
  const local = item('101', '下一站茶山刘', '房东的猫'); local.attributes.isrc = 'ABC123456789';
  const destination = item('202', '下一站茶山刘', "The Landlord's Cat"); destination.attributes.isrc = local.attributes.isrc;
  const matcher = createSongMatcher({ songs: async () => [], artist: async () => "The Landlord's Cat", isrc: async () => [], localizedSongs: async () => [local], equivalents: async () => ({ '101': [destination] }) }, opts);
  const result = await matcher({ title: '下一站茶山劉', artist: '房東的貓', row: 1 });
  assert.deepEqual(result.matches, []);
  assert.equal(result.suggestions[0]?.id, '202');
});

test('deep pass reuses the first search and only performs additional checks when requested', async () => {
  const calls: string[] = [];
  const localized = item('101', '晴天', '周杰倫'); localized.attributes.isrc = 'TWK970300503';
  const target = item('202', 'Sunny Day', 'Jay Chou'); target.attributes.isrc = localized.attributes.isrc;
  const matcher = createSongMatcher({
    songs: async (term) => { calls.push(`songs:${term}`); return []; },
    artist: async () => { calls.push('artist'); return 'Jay Chou'; }, isrc: async () => [],
    localizedSongs: async () => { calls.push('localized'); return [localized]; },
    equivalents: async () => ({ '101': [target] }),
  }, opts);
  const source = { title: '晴天', artist: '周杰倫', row: 1 };
  assert.deepEqual((await matcher(source, 'standard')).matches, []);
  assert.deepEqual(calls, ['songs:晴天 周杰倫']);
  assert.equal((await matcher(source, 'deep')).matches[0]?.id, '202');
  assert.equal(calls.filter((call) => call === 'songs:晴天 周杰倫').length, 1);
  assert.ok(calls.includes('localized'));
});
