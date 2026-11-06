import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Check, ChevronDown, CircleHelp, Download, FileUp, ListMusic, LoaderCircle, Music2, Plus, Search, ShieldCheck, SlidersHorizontal, UploadCloud, X } from 'lucide-react';
import { artworkUrl, isLiveRecording, isRemastered, parseCsv, songIdentity, type CatalogSong, type CsvSong, type Playlist, type PlaylistTrack } from './music';
import { createSongMatcher } from './matching';
import { runMatchingPasses, type Match } from './matching-run';
import { missingMatches, missingMatchesCsv } from './export';
import './styles.css';

type MusicKitInstance = { authorize(): Promise<string | undefined>; unauthorize(): Promise<void>; musicUserToken: string; isAuthorized: boolean };
declare global { interface Window { MusicKit?: { configure(config: { developerToken: string; app: { name: string; build: string } }): Promise<MusicKitInstance> | MusicKitInstance; getInstance(): MusicKitInstance } } }

async function loadMusicKit(): Promise<void> {
  if (window.MusicKit) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load MusicKit from Apple.'));
    document.head.append(script);
  });
  if (!window.MusicKit) throw new Error('MusicKit did not initialize.');
}

async function api<T>(path: string, userToken?: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(userToken ? { 'Music-User-Token': userToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'Something went wrong.');
  return json as T;
}

function App() {
  const [music, setMusic] = useState<MusicKitInstance | null>(null);
  const [connected, setConnected] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [storefront, setStorefront] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [playlistId, setPlaylistId] = useState('');
  const [newName, setNewName] = useState('');
  const [playlistFilter, setPlaylistFilter] = useState('');
  const [fileName, setFileName] = useState('');
  const [songs, setSongs] = useState<CsvSong[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [reviewPage, setReviewPage] = useState(0);
  const [reviewFilter, setReviewFilter] = useState('');
  const [reviewStatus, setReviewStatus] = useState<'all' | 'review' | 'selected' | 'skipped' | 'pending'>('all');
  const [excludeLive, setExcludeLive] = useState(true);
  const [preferRemastered, setPreferRemastered] = useState(true);
  const [extraRemasterSearch, setExtraRemasterSearch] = useState(false);
  const [deepSearch, setDeepSearch] = useState(false);
  const [preventDuplicates, setPreventDuplicates] = useState(true);
  const [cleanCopy, setCleanCopy] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'match' | 'import' | null>(null);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState('');
  const [complete, setComplete] = useState<{ added: number; skippedDuplicates: number; omittedLive: number; copied: number; name: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pauseRef = useRef(false);
  const [pausing, setPausing] = useState(false);
  const matcherRef = useRef<ReturnType<typeof createSongMatcher> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { developerToken } = await api<{ developerToken: string }>('/config');
        await loadMusicKit();
        const instance = await window.MusicKit!.configure({ developerToken, app: { name: 'Tracklist', build: '1.0.0' } });
        if (alive) setMusic(instance || window.MusicKit!.getInstance());
      } catch (error) { if (alive) setMessage(error instanceof Error ? error.message : 'MusicKit setup failed.'); }
    })();
    return () => { alive = false; };
  }, []);

  async function connect() {
    if (!music) return;
    setBusy('connect'); setMessage('');
    try {
      const token = await music.authorize();
      if (!token && !music.musicUserToken) throw new Error('Apple Music authorization was canceled.');
      const userToken = music.musicUserToken || token;
      const [playlistData, storeData] = await Promise.all([
        api<{ data: Playlist[] }>('/playlists', userToken),
        api<{ storefront: string }>('/storefront', userToken),
      ]);
      setPlaylists(playlistData.data);
      setPlaylistId(playlistData.data.find((playlist) => playlist.attributes.canEdit)?.id || '');
      setStorefront(storeData.storefront);
      setConnected(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Connection failed.'); }
    finally { setBusy(null); }
  }

  async function disconnect() {
    await music?.unauthorize();
    setConnected(false); setPlaylists([]); setStorefront(''); setPlaylistId(''); setMatches([]); setComplete(null);
  }

  async function readCsv(file: File) {
    if (busy !== null) return;
    setMessage(''); setComplete(null);
    try {
      const parsed = parseCsv(await file.text());
      setSongs(parsed); setFileName(file.name); setMatches([]); setReviewPage(0); setReviewFilter(''); setReviewStatus('all'); matcherRef.current = null;
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not read CSV.'); }
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void readCsv(file);
  }

  async function findMatches(action: 'all' | 'retry' | 'resume' | 'deep' = 'all') {
    if (!connected || !music || !storefront) return;
    const indices = action === 'all' ? songs.map((_, index) => index) : matches.flatMap((match, index) =>
      (action === 'retry' ? match.status === 'error' : action === 'resume' ? match.status === 'pending' :
        !match.deepSearched && (match.status === 'review' || (match.status === 'unmatched' && match.candidates.length === 0))) ? [index] : []);
    if (!indices.length) return;
    pauseRef.current = false; setPausing(false); setBusy('match'); setMessage(''); setComplete(null);
    if (action === 'all') { setReviewPage(0); setReviewFilter(''); setReviewStatus('all'); }
    const result: Match[] = action === 'all'
      ? songs.map((source) => ({ source, candidates: [], selectedId: '', status: 'pending', phase: 'standard' }))
      : matches.map((match) => action === 'retry' && match.status === 'error' ? { ...match, status: 'pending' } :
        action === 'deep' && !match.deepSearched && (match.status === 'review' || (match.status === 'unmatched' && match.candidates.length === 0)) ? { ...match, status: 'pending', phase: 'deep' } : match);
    setMatches([...result]);
    if (action === 'all' || !matcherRef.current) matcherRef.current = createSongMatcher({
      songs: async (term) => (await api<{ data: CatalogSong[] }>(`/search?${new URLSearchParams({ storefront, term })}`, music.musicUserToken)).data,
      isrc: async (isrc) => (await api<{ data: CatalogSong[] }>(`/songs-by-isrc?${new URLSearchParams({ storefront, isrc })}`, music.musicUserToken)).data,
      artist: async (term) => (await api<{ data: { attributes: { name: string } }[] }>(`/search-artists?${new URLSearchParams({ storefront, term })}`, music.musicUserToken)).data[0]?.attributes?.name,
      localizedSongs: async (term) => (await api<{ data: CatalogSong[] }>(`/search?${new URLSearchParams({ storefront: 'hk', language: 'zh-Hant-HK', term })}`, music.musicUserToken)).data,
      equivalents: async (ids) => (await api<{ data: Record<string, CatalogSong[]> }>(`/equivalent-songs?${new URLSearchParams({ storefront, ids: ids.join(',') })}`, music.musicUserToken)).data,
    }, { excludeLive, preferRemastered, extraRemasterSearch });
    const matcher = matcherRef.current;
    await runMatchingPasses({
      results: result, matcher, deepSearch, excludeLive, shouldStop: () => pauseRef.current,
      onProgress: (phase, done, total) => setProgress(`${phase === 'deep' ? 'Deep search' : 'Searching'} ${done} of ${total}`),
      onUpdate: setMatches,
    });
    setMatches([...result]); setBusy(null); setPausing(false); setProgress('');
    if (result.some((item) => item.status === 'pending')) setMessage('Matching paused. Resume when you are ready.');
    else if (result.some((item) => item.status === 'error')) setMessage('Some searches failed. Use Retry failed searches to try those rows again.');
  }

  function selectMatch(index: number, selectedId: string) {
    setComplete(null);
    setMatches((current) => current.map((match, i) => i === index ? { ...match, selectedId, status: selectedId ? 'matched' : 'unmatched' } : match));
  }

  function exportMissing() {
    if (!missingMatches(matches).length) return;
    const url = URL.createObjectURL(new Blob([missingMatchesCsv(matches)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName.replace(/\.csv$/i, '') || 'songs'}-unmatched.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importSongs() {
    if (!music || !connected) return;
    const makeCleanCopy = mode === 'existing' && cleanCopy;
    const selected = matches.flatMap((match, index) => match?.selectedId ? [{ index, song: match.candidates.find((item) => item.id === match.selectedId)! }] : []);
    if (!selected.length && !makeCleanCopy) return setMessage('Choose at least one matched song.');
    if (mode === 'new' && !newName.trim()) return setMessage('Enter a name for the new playlist.');
    if (mode === 'existing' && !playlistId) return setMessage('Choose a playlist.');
    setBusy('import'); setMessage(''); setComplete(null);
    let targetId = playlistId;
    let targetName = playlists.find((item) => item.id === playlistId)?.attributes.name || newName.trim();
    let added = 0;
    let copied = 0;
    let omittedLive = 0;
    let skippedDuplicates = 0;
    const importedIndices = new Set<number>();
    try {
      let existingTracks: PlaylistTrack[] = [];
      if (mode === 'existing' && (preventDuplicates || makeCleanCopy)) {
        setProgress('Checking destination playlist');
        existingTracks = (await api<{ data: PlaylistTrack[] }>(`/playlists/${encodeURIComponent(playlistId)}/tracks`, music.musicUserToken)).data;
      }
      const retainedTracks = makeCleanCopy
        ? existingTracks.filter((track) => {
          const live = isLiveRecording(track.attributes.name, track.attributes.albumName);
          if (live) omittedLive++;
          return !live;
        })
        : existingTracks;
      const seenIds = new Set(retainedTracks.map((track) => track.attributes.playParams?.catalogId).filter((id): id is string => !!id));
      const seenNames = new Set(retainedTracks.map((track) => songIdentity(track.attributes.name, track.attributes.artistName)));
      const toAdd = selected.filter(({ song }) => {
        if (preventDuplicates && (seenIds.has(song.id) || seenNames.has(songIdentity(song.attributes.name, song.attributes.artistName)))) {
          skippedDuplicates++;
          return false;
        }
        seenIds.add(song.id);
        seenNames.add(songIdentity(song.attributes.name, song.attributes.artistName));
        return true;
      });
      if (mode === 'new' || makeCleanCopy) {
        const name = makeCleanCopy ? `${targetName} (No Live)`.slice(0, 100) : newName.trim();
        setProgress('Creating playlist');
        const response = await api<{ data: Playlist }>('/playlists', music.musicUserToken, { name });
        targetId = response.data.id;
        targetName = response.data.attributes.name;
        setPlaylists((current) => [...current, response.data]);
      }
      if (makeCleanCopy) {
        for (let index = 0; index < retainedTracks.length; index += 100) {
          const batch = retainedTracks.slice(index, index + 100).map((track) => ({ id: track.id, type: track.type }));
          setProgress(`Copying existing songs ${copied + 1}–${copied + batch.length} of ${retainedTracks.length}`);
          await api(`/playlists/${encodeURIComponent(targetId)}/tracks`, music.musicUserToken, { tracks: batch });
          copied += batch.length;
        }
      }
      for (let index = 0; index < toAdd.length; index += 100) {
        const batch = toAdd.slice(index, index + 100);
        setProgress(`Adding songs ${added + 1}–${added + batch.length} of ${toAdd.length}`);
        await api(`/playlists/${encodeURIComponent(targetId)}/tracks`, music.musicUserToken, { tracks: batch.map(({ song }) => ({ id: song.id, type: 'songs' })) });
        added += batch.length;
        batch.forEach(({ index: matchIndex }) => importedIndices.add(matchIndex));
      }
      setPlaylistId(targetId);
      setMode('existing');
      setCleanCopy(false);
      setComplete({ added, skippedDuplicates, omittedLive, copied, name: targetName });
      setProgress('');
    } catch (error) {
      if (importedIndices.size) setMatches((current) => current.map((match, index) => importedIndices.has(index) ? { ...match, selectedId: '', status: 'skipped' } : match));
      setMessage(`${error instanceof Error ? error.message : 'Import failed.'} ${copied || added ? `${copied} existing and ${added} CSV songs were added to ${targetName} before it stopped.` : ''}`);
    } finally { setBusy(null); setProgress(''); }
  }

  const chosenPlaylist = playlists.find((item) => item.id === playlistId);
  const matchedCount = matches.filter((item) => item?.selectedId).length;
  const skippedCount = matches.filter((item) => item?.status === 'skipped').length;
  const failedCount = matches.filter((item) => item?.status === 'error').length;
  const missingCount = missingMatches(matches).length;
  const pendingCount = matches.filter((item) => item.status === 'pending').length;
  const deepCount = matches.filter((item) => !item.deepSearched && (item.status === 'review' || (item.status === 'unmatched' && item.candidates.length === 0))).length;
  const reviewRows = matches.map((match, index) => ({ match, index })).filter(({ match }) => {
    const textMatches = `${match.source.title} ${match.source.artist}`.toLocaleLowerCase().includes(reviewFilter.trim().toLocaleLowerCase());
    const statusMatches = reviewStatus === 'all' || (reviewStatus === 'review' ? match.status === 'unmatched' || match.status === 'review' || match.status === 'error' : reviewStatus === 'selected' ? !!match.selectedId : match.status === reviewStatus);
    return textMatches && statusMatches;
  });
  const reviewPages = Math.max(1, Math.ceil(reviewRows.length / 100));
  const currentPage = Math.min(reviewPage, reviewPages - 1);
  const filteredPlaylists = playlists.filter((item) => item.attributes.name.toLowerCase().includes(playlistFilter.toLowerCase()));

  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><div className="header-inner">
      <div className="brand"><div className="brand-mark"><Music2 size={21} strokeWidth={2.5} /></div><span>tracklist<span className="brand-period">.</span></span></div>
      <div className="header-right"><span className="header-caption">Made for Apple Music</span>{connected ? <button className="header-connect connected" onClick={disconnect} disabled={busy !== null}><Check size={16} /> Connected <ChevronDown size={15} /></button> : <button className="header-connect" onClick={connect} disabled={!music || busy === 'connect'}>{busy === 'connect' ? <LoaderCircle className="spin" size={16} /> : <Music2 size={16} />} Connect Apple Music <ArrowRight size={16} /></button>}</div>
    </div></header>
    <main id="main" className="page-shell">
      <section className="intro"><div className="intro-copy"><h1>From spreadsheet<br />to <span className="accent">soundtrack.</span></h1><p>Bring your CSV to Apple Music. Find the right versions, skip live recordings, and build your playlist with confidence.</p><div className="intro-points"><span><ShieldCheck size={17} /> Review every match</span><span><SlidersHorizontal size={17} /> You’re in control</span></div></div><div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-record"><div className="record-rings" /><div className="record-label"><Music2 size={35} strokeWidth={1.5} /></div></div><div className="art-card art-card-one"><span className="art-card-icon"><ListMusic size={18} /></span><span><strong>Weekend rotation</strong><small>Playlist ready</small></span><Check size={17} /></div><div className="art-card art-card-two"><span className="art-card-icon alt"><Music2 size={18} /></span><span><strong>Better versions</strong><small>Remastered when available</small></span></div></div></section>

      <section className="workspace" aria-label="Playlist importer"><div className="workspace-header"><div><h2>Let’s build your playlist</h2><p>Four simple steps from file to favorite.</p></div><div className="step-track"><span className="step-track-current">01</span> / 04</div></div>
        {message && <div className="alert" role="alert"><CircleHelp size={18} /><span>{message}</span><button onClick={() => setMessage('')} aria-label="Dismiss message"><X size={17} /></button></div>}
        {complete && <div className="success" role="status"><Check size={22} /><div><strong>{complete.added} CSV songs added to {complete.name}</strong><span>{complete.skippedDuplicates ? `${complete.skippedDuplicates} duplicates skipped. ` : ''}{complete.copied ? `${complete.copied} existing tracks copied. ` : ''}{complete.omittedLive ? `${complete.omittedLive} live tracks left out of the new copy. ` : ''}Your playlist is ready in Apple Music.</span></div></div>}

        <div className="work-grid"><div className="work-main">
          <div className="step-block"><div className="step-heading"><span className="step-number">01</span><div><h3>Connect your music</h3><p>Authorize access to your Apple Music library.</p></div>{connected && <span className="done-pill"><Check size={14} /> Connected</span>}</div>{!connected && <button className="button primary connect-main" onClick={connect} disabled={!music || busy === 'connect'}>{busy === 'connect' ? <LoaderCircle className="spin" size={18} /> : <Music2 size={18} />} Connect Apple Music <ArrowRight size={18} /></button>}{connected && <div className="connected-note"><span className="small-check"><Check size={15} /></span> Your library is connected. {playlists.length} playlists found.</div>}</div>

          <div className="step-block"><div className="step-heading"><span className="step-number">02</span><div><h3>Choose a destination</h3><p>Add to a playlist you have or start something new.</p></div></div><div className="choice-tabs" role="tablist" aria-label="Destination type"><button role="tab" aria-selected={mode === 'existing'} className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}><ListMusic size={17} /> Existing playlist</button><button role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}><Plus size={17} /> New playlist</button></div>{mode === 'existing' ? <div className="playlist-picker"><label htmlFor="playlist-search">Your playlists</label><div className="search-field"><Search size={17} /><input id="playlist-search" value={playlistFilter} onChange={(event) => setPlaylistFilter(event.target.value)} placeholder="Search your playlists" disabled={!connected} /></div><div className="playlist-list" role="radiogroup" aria-label="Choose playlist">{filteredPlaylists.length ? filteredPlaylists.map((item) => <label key={item.id} className={`playlist-option ${playlistId === item.id ? 'selected' : ''} ${item.attributes.canEdit ? '' : 'readonly'}`}><input type="radio" name="playlist" value={item.id} checked={playlistId === item.id} disabled={!item.attributes.canEdit} onChange={() => setPlaylistId(item.id)} /><span className="playlist-icon"><ListMusic size={18} /></span><span className="playlist-name">{item.attributes.name}</span>{!item.attributes.canEdit && <span className="readonly-label">Read only</span>}<span className="radio-visual" /></label>) : <p className="empty-list">{connected ? 'No playlists found. Create a new one.' : 'Connect Apple Music to see your playlists.'}</p>}</div></div> : <div className="new-playlist"><label htmlFor="new-name">Playlist name</label><input id="new-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="e.g. Sunday slow down" maxLength={100} /><p>A new playlist is created when you import.</p></div>}</div>

          <div className="step-block"><div className="step-heading"><span className="step-number">03</span><div><h3>Add your CSV</h3><p>Use title, artist, album, isrc. Album and ISRC can be blank.</p></div></div><input ref={inputRef} className="visually-hidden" type="file" disabled={busy !== null} accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readCsv(file); event.target.value = ''; }} /><div className="drop-zone" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}><div className="drop-icon"><UploadCloud size={26} /></div><strong>{fileName || 'Drop your CSV here'}</strong><span>{songs.length ? `${songs.length} songs ready to match` : 'or choose a file from your computer'}</span><button className="button secondary" disabled={busy !== null} onClick={() => inputRef.current?.click()}><FileUp size={16} /> {fileName ? 'Replace file' : 'Choose CSV file'}</button></div><a className="sample-link" href="/sample-playlist.csv" download>Download a sample CSV <ArrowRight size={14} /></a></div>
        </div>

        <aside className="work-sidebar"><div className="sidebar-title"><SlidersHorizontal size={18} /><h3>Make it yours</h3></div><p className="sidebar-intro">A little fine-tuning goes a long way.</p><label className="setting"><span className="setting-copy"><strong>Skip live versions</strong><small>Leave out tracks labeled live, including live albums.</small></span><input type="checkbox" checked={excludeLive} disabled={busy !== null} onChange={(event) => { setExcludeLive(event.target.checked); setMatches([]); }} /><span className="switch" /></label><label className="setting"><span className="setting-copy"><strong>Prefer remastered</strong><small>Pick remastered releases when the song and artist match.</small></span><input type="checkbox" checked={preferRemastered} disabled={busy !== null} onChange={(event) => { setPreferRemastered(event.target.checked); setMatches([]); }} /><span className="switch" /></label><label className="setting"><span className="setting-copy"><strong>Search further for remasters</strong><small>Run an extra search per song when needed. This takes longer.</small></span><input type="checkbox" checked={extraRemasterSearch} disabled={busy !== null || !preferRemastered} onChange={(event) => { setExtraRemasterSearch(event.target.checked); setMatches([]); }} /><span className="switch" /></label><label className="setting"><span className="setting-copy"><strong>Deep search for unmatched songs</strong><small>After the first search, check aliases, title variations and equivalent recordings. This takes longer.</small></span><input type="checkbox" checked={deepSearch} disabled={busy !== null || pendingCount > 0} onChange={(event) => setDeepSearch(event.target.checked)} /><span className="switch" /></label><label className="setting"><span className="setting-copy"><strong>Prevent duplicates</strong><small>Skip songs already in the destination, and repeated CSV matches.</small></span><input type="checkbox" checked={preventDuplicates} disabled={busy !== null} onChange={(event) => setPreventDuplicates(event.target.checked)} /><span className="switch" /></label><label className="setting"><span className="setting-copy"><strong>Make a copy without live songs</strong><small>For an existing playlist, copy its non-live tracks into a new playlist, then add your CSV songs. The original stays unchanged.</small></span><input type="checkbox" checked={cleanCopy} disabled={mode !== 'existing' || busy !== null} onChange={(event) => setCleanCopy(event.target.checked)} /><span className="switch" /></label><div className="sidebar-tip"><CircleHelp size={18} /><p>Apple Music does not offer track removal through its public API. This option creates a cleaned copy of your selected playlist.</p></div></aside></div>

        <div className="match-section"><div className="step-heading"><span className="step-number">04</span><div><h3>Review your matches</h3><p>Check the versions we found before they reach your playlist.</p></div></div><div className="match-toolbar"><div className="match-summary">{matches.length ? <><span><strong>{matchedCount}</strong> selected</span><span><strong>{skippedCount}</strong> skipped</span><span><strong>{matches.length - matchedCount - skippedCount - pendingCount}</strong> need review</span>{pendingCount > 0 && <span><strong>{pendingCount}</strong> waiting</span>}</> : <span>Your matches will appear here.</span>}</div><div className="match-buttons">{missingCount > 0 && <button className="button secondary" onClick={exportMissing} disabled={busy !== null} title="Includes unconfirmed suggestions, songs with no match, and failed searches"><Download size={16} />{pendingCount > 0 ? 'Export missing so far' : 'Export missing'} ({missingCount})</button>}{busy === 'match' ? <><span role="status" className="match-progress">{pausing ? 'Pausing after current searches…' : progress}</span><button className="button secondary" disabled={pausing} onClick={() => { pauseRef.current = true; setPausing(true); }}>Pause matching</button></> : <>{pendingCount > 0 && <button className="button secondary" disabled={!connected || busy !== null} onClick={() => void findMatches('resume')}>Resume matching ({pendingCount} left)</button>}{deepSearch && deepCount > 0 && pendingCount === 0 && <button className="button secondary" onClick={() => void findMatches('deep')} disabled={!connected || busy !== null}>Deep search unmatched ({deepCount})</button>}{failedCount > 0 && <button className="button secondary" onClick={() => void findMatches('retry')} disabled={busy !== null || pendingCount > 0}>Retry failed searches ({failedCount})</button>}<button className="button secondary" onClick={() => void findMatches()} disabled={!connected || !songs.length || busy !== null}><Search size={16} />{matches.length ? 'Find matches again' : 'Find matches'}</button></>}</div></div>{matches.length > 0 && <div className="review-search"><div><label htmlFor="review-filter">Find a song</label><input id="review-filter" value={reviewFilter} onChange={(event) => { setReviewFilter(event.target.value); setReviewPage(0); }} placeholder="Title or artist" /></div><div><label htmlFor="review-status">Show</label><select id="review-status" value={reviewStatus} onChange={(event) => { setReviewStatus(event.target.value as typeof reviewStatus); setReviewPage(0); }}><option value="all">All songs</option><option value="review">Need review</option><option value="selected">Selected</option><option value="skipped">Skipped</option><option value="pending">Waiting</option></select></div></div>}
          {matches.length > 0 && <div className="match-table"><div className="match-table-head"><span>Your CSV</span><span>Apple Music match</span><span>Selection</span></div>{reviewRows.slice(currentPage * 100, (currentPage + 1) * 100).map(({ match, index }) => match && <div className="match-row" key={`${match.source.row}-${index}`}><div className="source-song"><span className="source-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{match.source.title}</strong><small>{match.source.artist}{match.source.album ? ` (${match.source.album})` : ''}</small></span></div><div className="found-song">{match.selectedId ? (() => { const song = match.candidates.find((item) => item.id === match.selectedId)!; return <>{artworkUrl(song) ? <img src={artworkUrl(song)} alt="" /> : <span className="song-placeholder"><Music2 size={17} /></span>}<span><strong>{song.attributes.name}</strong><small>{song.attributes.artistName}</small></span></>; })() : <span className="not-found">{match.status === 'pending' ? 'Waiting to search' : match.status === 'skipped' ? 'Skipped: live recording' : match.status === 'error' ? 'Search failed' : match.status === 'review' ? 'Possible matches — verify before choosing' : 'No close match found'}</span>}</div><div className="match-action">{match.candidates.length > 0 ? <select aria-label={`Match for ${match.source.title}`} value={match.selectedId} disabled={busy !== null} onChange={(event) => selectMatch(index, event.target.value)}><option value="">{match.status === 'review' ? 'Choose a match to confirm' : 'Skip song'}</option>{match.candidates.map((song) => <option key={song.id} value={song.id}>{song.attributes.name}: {song.attributes.artistName}{song.attributes.albumName ? ` — ${song.attributes.albumName}` : ''}{isRemastered(`${song.attributes.name} ${song.attributes.albumName || ''}`) ? ' (remastered)' : ''}</option>)}</select> : <span className={`status-pill ${match.status}`}>{match.status === 'pending' ? 'Waiting' : match.status === 'skipped' ? 'Skipped' : 'Review needed'}</span>}</div></div>)}</div>}
          {matches.length > 0 && reviewRows.length === 0 && <p className="empty-list">No songs match this filter.</p>}
          {matches.length > 0 && <div className="review-pages"><button className="button secondary" onClick={() => setReviewPage(currentPage - 1)} disabled={currentPage === 0}>Previous</button><span>Page {currentPage + 1} of {reviewPages} · {reviewRows.length} songs</span><button className="button secondary" onClick={() => setReviewPage(currentPage + 1)} disabled={currentPage + 1 >= reviewPages}>Next</button></div>}
          {matches.length === 0 && <div className="matches-empty"><div><Music2 size={28} /></div><strong>Your soundtrack starts here</strong><p>Upload a CSV and find matches to preview every song.</p></div>}
          <div className="import-footer"><span>{pendingCount > 0 ? 'Resume matching to finish before importing.' : mode === 'existing' && cleanCopy ? `Create ${chosenPlaylist?.attributes.name || 'your playlist'} (No Live), leaving existing live tracks out.${matchedCount ? ` Add up to ${matchedCount} selected CSV songs.` : ''}` : matches.length ? `${matchedCount} songs selected for ${mode === 'new' ? (newName || 'your new playlist') : (chosenPlaylist?.attributes.name || 'your playlist')}. ${preventDuplicates ? 'Duplicates will be checked before adding.' : ''}` : 'Ready when you are.'}</span><button className="button primary" onClick={importSongs} disabled={(!matchedCount && !(mode === 'existing' && cleanCopy && !!playlistId)) || busy !== null || pendingCount > 0 || !!complete}>{busy === 'import' ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}{busy === 'import' ? progress : complete ? 'Imported' : mode === 'existing' && cleanCopy ? 'Create clean copy' : 'Import songs'}<ArrowRight size={18} /></button></div>
        </div>
      </section>
      <footer className="footer"><span className="brand footer-brand"><span className="brand-mark"><Music2 size={17} /></span>tracklist<span className="brand-period">.</span></span><span>Your playlists stay yours. CSV files are processed in your browser.</span></footer>
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
