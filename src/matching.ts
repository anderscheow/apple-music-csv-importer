import { artistInCredit, exactArtist, exactTitle, isLiveRecording, isRemastered, rankCandidates, similarTitleForReview, trustedArtistAlias, type CatalogSong, type CsvSong } from './music.ts';

type SearchApi = {
  songs(term: string): Promise<CatalogSong[]>;
  isrc(value: string): Promise<CatalogSong[]>;
  artist(term: string): Promise<string | undefined>;
  localizedSongs?(term: string): Promise<CatalogSong[]>;
  equivalents?(ids: string[]): Promise<Record<string, CatalogSong[]>>;
};
type Options = { excludeLive: boolean; preferRemastered: boolean; extraRemasterSearch?: boolean };
export type SongMatchResult = { matches: CatalogSong[]; suggestions: CatalogSong[] };

// Artist searches are shared by rows from the same artist, including concurrent rows.
export function createSongMatcher(api: SearchApi, options: Options) {
  const artists = new Map<string, Promise<string | undefined>>();
  const firstPass = new WeakMap<CsvSong, { candidates: CatalogSong[]; combined: CatalogSong[] }>();
  function artistAlias(artist: string): Promise<string | undefined> {
    let pending = artists.get(artist);
    if (!pending) {
      pending = api.artist(artist).catch((error: unknown) => { artists.delete(artist); throw error; });
      artists.set(artist, pending);
    }
    return pending;
  }

  return async (source: CsvSong, phase: 'standard' | 'deep' = 'deep'): Promise<SongMatchResult> => {
    const empty = (): SongMatchResult => ({ matches: [], suggestions: [] });
    if (options.excludeLive && isLiveRecording(source.title, source.album)) return empty();
    let candidates: CatalogSong[] = [];
    let combined: CatalogSong[] = [];
    let successfulSearch = false;
    let lastError: unknown;
    let aliasError: unknown;
    let localizedError: unknown;
    let alias: string | undefined;
    const eligible = (song: CatalogSong) => song.type === 'songs' && (!options.excludeLive || !isLiveRecording(song.attributes.name, song.attributes.albumName));
    const unique = (items: CatalogSong[]) => [...new Map(items.map((item) => [item.id, item])).values()];
    const add = (items: CatalogSong[]) => { candidates = unique([...candidates, ...items]); };
    const rank = () => rankCandidates(source, candidates, { ...options, artistAlias: alias });
    const search = async (term: string): Promise<CatalogSong[]> => {
      try { const found = await api.songs(term); add(found); successfulSearch = true; return found; }
      catch (error) { lastError = error; return []; }
    };

    const term = `${source.title} ${source.artist}`;
    const cached = firstPass.get(source);
    if (cached) {
      candidates = [...cached.candidates]; combined = cached.combined; successfulSearch = true;
    } else {
      if (source.isrc) {
        try { add(await api.isrc(source.isrc)); }
        catch (error) { lastError = error; }
        if (rank().length) return { matches: rank(), suggestions: [] };
      }
      combined = await search(term);
      let initial = rank();
      if (options.preferRemastered && options.extraRemasterSearch && initial.length && !initial.some((song) => isRemastered(`${song.attributes.name} ${song.attributes.albumName || ''}`))) {
        await search(`${term} remastered`);
        initial = rank();
      }
      if (initial.length) return { matches: initial, suggestions: [] };
      if (!successfulSearch && lastError) throw lastError;
      firstPass.set(source, { candidates: [...candidates], combined });
    }
    if (phase === 'standard') return empty();
    if (!rank().length) {
      try { alias = trustedArtistAlias(source.artist, await artistAlias(source.artist)); } catch (error) { aliasError = error; }
    }
    if (!rank().length) {
      await search(source.title);
      const shortTitle = source.title.replace(/[（(][^）)]*(?:電影|电影|電視|电视|主題曲|主题曲)[^）)]*[）)]/g, '').trim();
      if (!rank().length && shortTitle && shortTitle !== source.title) await search(`${shortTitle} ${source.artist}`);
    }
    let initial = rank();
    if (options.preferRemastered && options.extraRemasterSearch && initial.length && !initial.some((song) => isRemastered(`${song.attributes.name} ${song.attributes.albumName || ''}`))) {
      await search(`${term} remastered`);
      initial = rank();
    }
    if (initial.length) return { matches: initial, suggestions: [] };

    const suggestions: CatalogSong[] = [];
    // A Chinese-language storefront supplies original names; equivalents are then
    // checked in the user's own storefront before anything can be imported.
    if (api.localizedSongs && api.equivalents && /\p{Script=Han}/u.test(`${source.title}${source.artist}`)) {
      try {
        const localized = (await api.localizedSongs(term)).filter((song) => eligible(song) && artistInCredit(source.artist, song.attributes.artistName, alias));
        const relevant = localized.filter((song) => exactTitle(source.title, song.attributes.name) || similarTitleForReview(source.title, song.attributes.name)).slice(0, 25);
        const bySource = new Map<string, CatalogSong[]>();
        for (const song of relevant) {
          const known = candidates.filter((item) => item.id === song.id || (!!song.attributes.isrc && item.attributes.isrc?.toUpperCase() === song.attributes.isrc.toUpperCase()));
          if (known.length) bySource.set(song.id, known);
        }
        const unresolved = relevant.filter((song) => !bySource.has(song.id)).map((song) => song.id);
        if (unresolved.length) {
          try {
            const resolved = await api.equivalents(unresolved);
            for (const id of unresolved) bySource.set(id, resolved[id] || []);
          } catch (error) { localizedError = error; }
        }
        const verified: CatalogSong[] = [];
        for (const song of relevant) for (const target of bySource.get(song.id) || []) {
          if (!eligible(target)) continue;
          const sameRecording = song.id === target.id || (!!song.attributes.isrc && song.attributes.isrc.toUpperCase() === target.attributes.isrc?.toUpperCase());
          if (exactTitle(source.title, song.attributes.name) && exactArtist(source.artist, song.attributes.artistName, alias) && sameRecording) verified.push(target);
          else suggestions.push(target);
        }
        if (verified.length) {
          const matches = unique(verified).sort((a, b) => options.preferRemastered
            ? Number(isRemastered(`${b.attributes.name} ${b.attributes.albumName || ''}`)) - Number(isRemastered(`${a.attributes.name} ${a.attributes.albumName || ''}`)) : 0);
          return { matches, suggestions: [] };
        }
      } catch (error) { localizedError = error; }
    }

    // Cross-language titles may be entirely different; offer the artist's results
    // for manual review, without making any automatic selection.
    suggestions.push(...combined.filter((song) => eligible(song) && artistInCredit(source.artist, song.attributes.artistName, alias) &&
      (exactTitle(source.title, song.attributes.name) || similarTitleForReview(source.title, song.attributes.name) || (/\p{Script=Han}/u.test(source.title) && !/\p{Script=Han}/u.test(song.attributes.name)))).slice(0, 5));
    const distinct = unique(suggestions);
    if (distinct.length) return { matches: [], suggestions: distinct };
    if (!successfulSearch && lastError) throw lastError;
    if (localizedError) throw localizedError;
    if (aliasError) throw aliasError;
    return empty();
  };
}
