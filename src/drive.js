// Respaldo en Google Drive: cuando un video sube bien a YouTube, se copia a Drive (con un .md de metadatos)
// en AutoPublisher/<canal>/<playlist>/ y recién después se permite borrar el archivo local.
// Usa el permiso drive.file: la app solo ve los archivos y carpetas que ella misma crea.
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { getSetting, setSettings, Accounts } from './db.js';
import { makeOAuthClient, listPlaylists } from './google.js';

export const driveConnected = () => !!getSetting('drive_tokens');
export const driveEnabled = () => driveConnected() && getSetting('drive_backup') !== 'false';

export function saveDriveConnection(tokens, email) {
  setSettings({ drive_tokens: JSON.stringify(tokens), drive_email: email || '' });
}

export function disconnectDrive() {
  setSettings({ drive_tokens: '', drive_email: '', drive_folder_id: '', drive_folder_name: '' });
  folderCache.clear();
}

// Token de acceso de corta duración para abrir Google Picker en el panel
export async function driveAccessToken() {
  const { token } = await oauthClient().getAccessToken();
  return token;
}

// Guarda la carpeta elegida en Picker, verificando que la app realmente tenga acceso
export async function setDriveFolder(id, name) {
  const { data } = await driveApi().files.get({ fileId: id, fields: 'id, name, mimeType' });
  if (data.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Lo elegido no es una carpeta.');
  setSettings({ drive_folder_id: data.id, drive_folder_name: data.name || name || '' });
  folderCache.clear();
  return data;
}

function oauthClient() {
  const tokens = JSON.parse(getSetting('drive_tokens'));
  const client = makeOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (t) => {
    const prev = JSON.parse(getSetting('drive_tokens') || '{}');
    setSettings({ drive_tokens: JSON.stringify({ ...prev, ...t, refresh_token: t.refresh_token || prev.refresh_token }) });
  });
  return client;
}

const driveApi = () => google.drive({ version: 'v3', auth: oauthClient() });

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Sin nombre';
const folderCache = new Map();

async function ensureFolder(drive, name, parentId) {
  const key = `${parentId}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed = false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, spaces: 'drive' });
  const id = data.files?.[0]?.id || (await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id',
  })).data.id;
  folderCache.set(key, id);
  return id;
}

// Nombres de playlists por cuenta (10 min de caché, 1 unidad de cuota de YouTube por lectura)
const plCache = new Map();
async function playlistName(account, playlistId) {
  if (!playlistId) return null;
  const c = plCache.get(account.id);
  let list = c && Date.now() - c.at < 10 * 60_000 ? c.list : null;
  if (!list) { list = await listPlaylists(account); plCache.set(account.id, { at: Date.now(), list }); }
  return list.find((p) => p.id === playlistId)?.title || null;
}

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };

export async function backupVideo(v) {
  const drive = driveApi();
  const account = v.account_id && Accounts.get(v.account_id);
  const channel = account?.channel_title || 'Sin canal';
  const playlist = account ? await playlistName(account, v.playlist_id).catch(() => null) : null;

  const root = getSetting('drive_folder_id') || await ensureFolder(drive, safeName(getSetting('drive_folder') || 'AutoPublisher'), 'root');
  const chFolder = await ensureFolder(drive, safeName(channel), root);
  const folder = await ensureFolder(drive, safeName(playlist || 'Sin playlist'), chFolder);

  // El archivo en Drive se llama igual que el título del video (sin caracteres que Drive/Windows no aceptan)
  const base = safeName(v.title || path.parse(v.file_name).name);
  const ext = path.extname(v.file_path).toLowerCase() || '.mp4';
  const yt = v.youtube_id ? `https://youtu.be/${v.youtube_id}` : '';

  const { data } = await drive.files.create({
    requestBody: { name: base + ext, parents: [folder], description: yt ? `YouTube: ${yt}` : undefined },
    media: { mimeType: MIME[ext] || 'application/octet-stream', body: fs.createReadStream(v.file_path) },
    fields: 'id, webViewLink',
  });

  // Ficha con los metadatos, en el mismo formato .md que entiende AutoPublisher
  const md = [
    '# Título', v.title, '',
    '# Descripción', v.description || '', '',
    '# Etiquetas', (v.tags || []).join(', '), '',
    '# Idioma', v.default_language || '', '',
    '# YouTube', yt, '',
    '# Fecha de publicación', v.publish_at || '', '',
    '# Canal', channel, '',
    '# Playlist', playlist || '', '',
  ].join('\n');
  await drive.files.create({
    requestBody: { name: `${base}.md`, parents: [folder] },
    media: { mimeType: 'text/markdown', body: md },
    fields: 'id',
  });
  return { id: data.id, link: data.webViewLink };
}
