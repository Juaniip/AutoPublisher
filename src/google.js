import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import { getSetting, Accounts } from './db.js';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube', // playlists, miniaturas y datos del canal
];

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file', // solo los archivos que crea AutoPublisher
  'https://www.googleapis.com/auth/userinfo.email',
];

const pendingStates = new Map(); // state -> 'youtube' | 'drive'

export const redirectUri = () => `${(process.env.BASE_URL || getSetting('base_url')).replace(/\/$/, '')}/oauth2callback`;

function credentials() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || getSetting('google_client_id'),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || getSetting('google_client_secret'),
  };
}

export const credsConfigured = () => {
  const c = credentials();
  return !!(c.clientId && c.clientSecret);
};

export const makeOAuthClient = () => makeClient();

function makeClient() {
  const { clientId, clientSecret } = credentials();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri());
}

export function authUrl(type = 'youtube') {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, type);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);
  return makeClient().generateAuthUrl({
    access_type: 'offline',
    // select_account permite elegir otra cuenta de Google / canal de marca cada vez que se conecta
    prompt: 'consent select_account',
    scope: type === 'drive' ? DRIVE_SCOPES : SCOPES,
    state,
  });
}

export const authType = (state) => pendingStates.get(state) || null;

export async function handleCallback(code, state) {
  const type = pendingStates.get(state);
  if (!pendingStates.delete(state)) throw new Error('Estado OAuth inválido o expirado. Volvé a intentar.');
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  if (type === 'drive') {
    if (!String(tokens.scope || '').includes('drive.file')) throw new Error('No se dio el permiso de Google Drive. Volvé a intentar y marcá la casilla de Drive.');
    const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    return { type: 'drive', tokens, email: data.email };
  }
  const yt = google.youtube({ version: 'v3', auth: client });
  const { data } = await yt.channels.list({ part: ['snippet'], mine: true });
  const ch = data.items?.[0];
  if (!ch) throw new Error('Esta cuenta de Google no tiene un canal de YouTube.');
  return Accounts.upsert({
    channel_id: ch.id,
    channel_title: ch.snippet.title,
    channel_thumb: ch.snippet.thumbnails?.default?.url || '',
    tokens,
  });
}

function clientForAccount(account) {
  const client = makeClient();
  client.setCredentials(account.tokens);
  client.on('tokens', (t) => Accounts.saveTokens(account.id, t));
  return client;
}

const youtubeFor = (account) => google.youtube({ version: 'v3', auth: clientForAccount(account) });

export async function uploadVideo(video, account, onProgress) {
  const yt = youtubeFor(account);
  const size = fs.statSync(video.file_path).size;

  const status = {
    privacyStatus: video.privacy || 'public',
    selfDeclaredMadeForKids: !!video.made_for_kids,
    containsSyntheticMedia: !!video.synthetic_media,
  };
  // Programación nativa de YouTube: el video sube como privado y YouTube lo hace público a la hora indicada.
  if (video.publish_at && new Date(video.publish_at).getTime() > Date.now() + 60_000) {
    status.privacyStatus = 'private';
    status.publishAt = new Date(video.publish_at).toISOString();
  }

  // El idioma del audio puede ser "zxx" (sin diálogo), pero el título y la descripción siempre están en un idioma real
  const audioLang = video.default_language || 'es-419';
  const settingLang = getSetting('default_language');
  const textLang = audioLang !== 'zxx' ? audioLang : settingLang && settingLang !== 'zxx' ? settingLang : 'es-419';
  // Traducciones oficiales: YouTube muestra el título/descripción según el idioma del espectador
  const localizations = Object.fromEntries(
    Object.entries(video.localizations || {}).filter(([code, l]) => l?.title && code.split('-')[0] !== textLang.split('-')[0]),
  );
  const hasLoc = Object.keys(localizations).length > 0;

  const res = await yt.videos.insert(
    {
      part: ['snippet', 'status', ...(hasLoc ? ['localizations'] : [])],
      notifySubscribers: !!video.notify_subscribers,
      requestBody: {
        snippet: {
          title: video.title,
          description: video.description || '',
          tags: video.tags || [],
          categoryId: video.category_id || '22',
          defaultLanguage: textLang,
          ...(audioLang !== 'zxx' ? { defaultAudioLanguage: audioLang } : {}),
        },
        status,
        ...(hasLoc ? { localizations } : {}),
      },
      media: { body: fs.createReadStream(video.file_path) },
    },
    { onUploadProgress: (e) => onProgress(Math.min(99, Math.round((e.bytesRead / size) * 100))) },
  );
  return res.data;
}

export async function setThumbnail(account, videoId, thumbPath) {
  const ext = path.extname(thumbPath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  await youtubeFor(account).thumbnails.set({ videoId, media: { mimeType, body: fs.createReadStream(thumbPath) } });
}

export async function addToPlaylist(account, videoId, playlistId) {
  await youtubeFor(account).playlistItems.insert({
    part: ['snippet'],
    requestBody: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
  });
}

export async function listPlaylists(account) {
  const yt = youtubeFor(account);
  const items = [];
  let pageToken;
  do {
    const { data } = await yt.playlists.list({ part: ['snippet'], mine: true, maxResults: 50, pageToken });
    items.push(...data.items.map((p) => ({ id: p.id, title: p.snippet.title })));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

// Videos del canal leídos de YouTube (incluye privados y programados: se piden con el token del dueño).
// Cuesta ~1 unidad de cuota cada 50 videos (playlistItems.list + videos.list).
// La búsqueda "mis videos" (search.list forMine) cuesta 100 unidades por página: se guarda 15 min por canal
const searchCache = new Map();

async function searchMyVideoIds(yt, accountId, max) {
  const c = searchCache.get(accountId);
  if (c && Date.now() - c.at < 15 * 60_000) return c.ids;
  const ids = [];
  let pageToken;
  do {
    const { data } = await yt.search.list({ part: ['id'], forMine: true, type: ['video'], maxResults: 50, pageToken });
    ids.push(...data.items.map((i) => i.id.videoId).filter(Boolean));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < max);
  searchCache.set(accountId, { at: Date.now(), ids });
  return ids;
}

// knownIds: videos que AutoPublisher sabe que subió (se suman siempre, cuestan 1 unidad cada 50)
export async function listChannelVideos(account, max = 300, knownIds = []) {
  const yt = youtubeFor(account);
  const { data: ch } = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const read = [];
  let pageToken;
  let total = 0;
  do {
    const { data } = await yt.playlistItems.list({ part: ['contentDetails'], playlistId: uploads, maxResults: 50, pageToken });
    total = data.pageInfo?.totalResults || total;
    read.push(...data.items.map((i) => i.contentDetails.videoId));
    pageToken = data.nextPageToken;
  } while (pageToken && read.length < max);

  const set = new Set(read);
  // Bug conocido de YouTube: al paginar la lista de subidos a veces repite videos y se saltea otros
  // (sobre todo programados). Si pasa, se completa con la búsqueda de "mis videos".
  if (set.size < read.length || set.size < Math.min(total, max)) {
    try { for (const id of await searchMyVideoIds(yt, account.id, max)) set.add(id); }
    catch (e) { console.error('[youtube] search forMine:', errorMessage(e)); }
  }
  for (const id of knownIds) set.add(id);
  const ids = [...set];

  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await yt.videos.list({ part: ['snippet', 'status', 'contentDetails'], id: ids.slice(i, i + 50), maxResults: 50 });
    for (const v of data.items) {
      const scheduled = v.status.privacyStatus === 'private' && v.status.publishAt && new Date(v.status.publishAt) > new Date();
      out.push({
        id: v.id,
        title: v.snippet.title,
        thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        privacy: v.status.privacyStatus,
        state: scheduled ? 'scheduled' : v.status.privacyStatus === 'public' ? 'published' : v.status.privacyStatus, // private | unlisted
        date: scheduled ? v.status.publishAt : v.snippet.publishedAt,
        duration: v.contentDetails.duration,
      });
    }
  }
  return out;
}

// Crea una playlist en el canal. translations: [{ lang, title, description }]
export async function createPlaylist(account, { title, description = '', privacy = 'public', language, translations = [] }) {
  const localizations = {};
  for (const t of translations) if (t?.lang && t?.title && t.lang !== language) localizations[t.lang] = { title: t.title, description: t.description || '' };
  const hasLoc = Object.keys(localizations).length > 0;
  const { data } = await youtubeFor(account).playlists.insert({
    part: ['snippet', 'status', ...(hasLoc ? ['localizations'] : [])],
    requestBody: {
      snippet: { title, description, ...(language ? { defaultLanguage: language } : {}) },
      status: { privacyStatus: privacy },
      ...(hasLoc ? { localizations } : {}),
    },
  });
  return { id: data.id, title: data.snippet.title };
}

// Extrae el "reason" de un error de la API de Google (quotaExceeded, uploadLimitExceeded, invalid_grant, ...)
export function errorReason(err) {
  return (
    err?.errors?.[0]?.reason ||
    err?.response?.data?.error?.errors?.[0]?.reason ||
    (typeof err?.response?.data?.error === 'string' ? err.response.data.error : null) ||
    null
  );
}

// Mensaje legible del error de Google (el genérico a veces es solo "Error")
export function errorMessage(err) {
  const detail = err?.errors?.[0]?.message || err?.response?.data?.error?.errors?.[0]?.message || err?.response?.data?.error?.message;
  const reason = errorReason(err);
  const msg = detail && detail !== 'Error' ? detail : err?.message && err.message !== 'Error' ? err.message : 'YouTube rechazó la solicitud';
  return reason ? `${msg} (${reason})` : msg;
}
