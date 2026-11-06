import 'dotenv/config';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

let cachedToken: { value: string; expiresAt: number } | undefined;

async function developerToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_MUSIC_KEY_ID;
  const keyText = process.env.APPLE_MUSIC_PRIVATE_KEY_PATH
    ? await readFile(process.env.APPLE_MUSIC_PRIVATE_KEY_PATH, 'utf8')
    : process.env.APPLE_MUSIC_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!teamId || !keyId || !keyText) throw new Error('Apple Music credentials are missing. See .env.example.');
  const privateKey = createPrivateKey(keyText);
  const now = Math.floor(Date.now() / 1000);
  const value = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60)
    .sign(privateKey);
  cachedToken = { value, expiresAt: (now + 60 * 60) * 1000 };
  return value;
}

type AppleResponse = { data?: unknown[]; next?: string; errors?: { detail?: string; title?: string }[] };

async function appleRequest(req: express.Request, method: 'GET' | 'POST', path: string, body?: unknown): Promise<AppleResponse> {
  const userToken = req.header('Music-User-Token');
  if (!userToken) throw new Error('Connect to Apple Music first.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://api.music.apple.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await developerToken()}`,
        'Music-User-Token': userToken,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (method === 'GET' && (response.status === 429 || response.status === 503) && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    const payload = response.status === 204 ? {} : await response.json() as AppleResponse;
    if (!response.ok) throw new Error(payload.errors?.map((item) => item.detail || item.title).filter(Boolean).join('; ') || `Apple Music returned ${response.status}.`);
    return payload;
  }
  throw new Error('Apple Music is temporarily unavailable.');
}

function handler(fn: (req: express.Request) => Promise<unknown>) {
  return async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Request failed.' }); }
  };
}

app.get('/api/config', handler(async () => ({ developerToken: await developerToken() })));

app.get('/api/storefront', handler(async (req) => {
  const payload = await appleRequest(req, 'GET', '/v1/me/storefront');
  return { storefront: (payload.data?.[0] as { id?: string } | undefined)?.id };
}));

app.get('/api/playlists', handler(async (req) => {
  const playlists: unknown[] = [];
  let path: string | undefined = '/v1/me/library/playlists?limit=100';
  while (path) {
    const page = await appleRequest(req, 'GET', path);
    playlists.push(...(page.data || []));
    if (playlists.length > 5000) throw new Error('Playlist limit exceeded.');
    path = page.next && page.next.startsWith('/v1/me/library/playlists') ? page.next : undefined;
  }
  return { data: playlists };
}));

app.get('/api/search', handler(async (req) => {
  const storefront = String(req.query.storefront || '');
  const term = String(req.query.term || '');
  const language = String(req.query.language || '');
  if (!/^[a-z]{2}$/.test(storefront) || !term.trim() || term.length > 200 || (language && (storefront !== 'hk' || language !== 'zh-Hant-HK'))) throw new Error('Invalid search.');
  const params = new URLSearchParams({ term, types: 'songs', limit: '25' });
  if (language) params.set('l', language);
  const payload = await appleRequest(req, 'GET', `/v1/catalog/${storefront}/search?${params}`);
  return { data: (payload as { results?: { songs?: { data?: unknown[] } } }).results?.songs?.data || [] };
}));

app.get('/api/equivalent-songs', handler(async (req) => {
  const storefront = String(req.query.storefront || '');
  const ids = String(req.query.ids || '').split(',');
  if (!/^[a-z]{2}$/.test(storefront) || ids.length < 1 || ids.length > 25 || ids.some((id) => !/^\d+$/.test(id))) throw new Error('Invalid equivalent song lookup.');
  const params = new URLSearchParams({ 'filter[equivalents]': ids.join(',') });
  const payload = await appleRequest(req, 'GET', `/v1/catalog/${storefront}/songs?${params}`);
  const equivalents = (payload as { meta?: { filters?: { equivalents?: Record<string, { id: string }[]> } } }).meta?.filters?.equivalents || {};
  const data = new Map((payload.data || []).map((item) => [(item as { id: string }).id, item]));
  return { data: Object.fromEntries(ids.map((id) => [id, (equivalents[id] || []).map((item) => data.get(item.id)).filter(Boolean)])) };
}));

app.get('/api/search-artists', handler(async (req) => {
  const storefront = String(req.query.storefront || '');
  const term = String(req.query.term || '');
  if (!/^[a-z]{2}$/.test(storefront) || !term.trim() || term.length > 200) throw new Error('Invalid artist search.');
  const params = new URLSearchParams({ term, types: 'artists', limit: '1' });
  const payload = await appleRequest(req, 'GET', `/v1/catalog/${storefront}/search?${params}`);
  return { data: (payload as { results?: { artists?: { data?: unknown[] } } }).results?.artists?.data || [] };
}));

app.get('/api/songs-by-isrc', handler(async (req) => {
  const storefront = String(req.query.storefront || '');
  const isrc = String(req.query.isrc || '').toUpperCase();
  if (!/^[a-z]{2}$/.test(storefront) || !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) throw new Error('Invalid storefront or ISRC.');
  const params = new URLSearchParams({ 'filter[isrc]': isrc });
  const payload = await appleRequest(req, 'GET', `/v1/catalog/${storefront}/songs?${params}`);
  return { data: payload.data || [] };
}));

app.post('/api/playlists', handler(async (req) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 100) throw new Error('Enter a playlist name of 100 characters or fewer.');
  const payload = await appleRequest(req, 'POST', '/v1/me/library/playlists', { attributes: { name } });
  return { data: payload.data?.[0] };
}));

app.get('/api/playlists/:id/tracks', handler(async (req) => {
  const id = String(req.params.id);
  if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid playlist ID.');
  const tracks: unknown[] = [];
  const prefix = `/v1/me/library/playlists/${encodeURIComponent(id)}/tracks`;
  let next: string | undefined = `${prefix}?limit=100`;
  while (next) {
    const page = await appleRequest(req, 'GET', next);
    tracks.push(...(page.data || []));
    if (tracks.length > 10000) throw new Error('This playlist has more than 10,000 tracks and cannot be checked safely.');
    next = page.next && page.next.startsWith(prefix + '?') ? page.next : undefined;
  }
  return { data: tracks };
}));

app.post('/api/playlists/:id/tracks', handler(async (req) => {
  const id = String(req.params.id);
  const tracks: unknown = req.body?.tracks;
  if (!/^[\w.-]+$/.test(id) || !Array.isArray(tracks) || tracks.length < 1 || tracks.length > 100 || tracks.some((item) =>
    !item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[\w.-]+$/.test(item.id) ||
    !['songs', 'music-videos', 'library-songs', 'library-music-videos'].includes(item.type))) {
    throw new Error('Invalid playlist or track IDs.');
  }
  await appleRequest(req, 'POST', `/v1/me/library/playlists/${encodeURIComponent(id)}/tracks`, { data: tracks });
  return { added: tracks.length };
}));

const distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.use(express.static(distPath));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));

const port = Number(process.env.PORT || 3001);
app.listen(port, '127.0.0.1', () => console.log(`Apple Music importer API on http://127.0.0.1:${port}`));
