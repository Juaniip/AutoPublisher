import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Todo lo que crea la app (base de datos, videos, miniaturas) nace legible solo por su dueño
process.umask(0o077);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const THUMBS_DIR = path.join(DATA_DIR, 'thumbnails');
fs.mkdirSync(THUMBS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT UNIQUE NOT NULL,
  channel_title TEXT,
  channel_thumb TEXT,
  tokens TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT UNIQUE NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  category_id TEXT DEFAULT '22',
  privacy TEXT DEFAULT 'public',
  made_for_kids INTEGER DEFAULT 0,
  notify_subscribers INTEGER DEFAULT 1,
  synthetic_media INTEGER DEFAULT 0,
  account_id INTEGER,
  playlist_id TEXT,
  publish_at TEXT,
  thumbnail_path TEXT,
  youtube_id TEXT,
  progress INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title_pattern TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  category_id TEXT,
  privacy TEXT,
  made_for_kids INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Migraciones simples: columnas agregadas después de la primera versión
const videoCols = new Set(db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name));
if (!videoCols.has('default_language')) db.exec("ALTER TABLE videos ADD COLUMN default_language TEXT DEFAULT 'es-419'");
if (!videoCols.has('localizations')) db.exec("ALTER TABLE videos ADD COLUMN localizations TEXT DEFAULT '{}'");
if (!videoCols.has('uploaded_at')) db.exec('ALTER TABLE videos ADD COLUMN uploaded_at TEXT');
if (!videoCols.has('file_deleted')) db.exec('ALTER TABLE videos ADD COLUMN file_deleted INTEGER DEFAULT 0');
if (!videoCols.has('guion_file')) db.exec('ALTER TABLE videos ADD COLUMN guion_file TEXT');
if (!videoCols.has('drive_file_id')) db.exec('ALTER TABLE videos ADD COLUMN drive_file_id TEXT');
if (!videoCols.has('drive_error')) db.exec('ALTER TABLE videos ADD COLUMN drive_error TEXT');
if (!videoCols.has('drive_tried_at')) db.exec('ALTER TABLE videos ADD COLUMN drive_tried_at TEXT');

// ---------- Settings ----------

const DEFAULT_SETTINGS = {
  base_url: 'http://localhost:3000',
  google_client_id: '',
  google_client_secret: '',
  watch_dir: path.join(ROOT, 'publicar'),
  done_dir: path.join(ROOT, 'publicados'),
  upload_mode: 'asap', // 'asap' = sube ya y YouTube publica a la hora; 'at_time' = sube cuando llega la hora
  max_concurrent: '1',
  default_account_id: '',
  default_privacy: 'public',
  default_category: '22',
  default_template_id: '',
  default_language: 'es-419',
  gemini_api_key: '',
  auto_translate_en: 'false',
  guiones_dir: path.join(ROOT, 'guiones'),
  auto_assign_guion: 'true',
  time_slots: '07:00, 16:00', // horarios de publicación que aparecen en el desplegable
  delete_after_upload_min: '10',
  drive_tokens: '',      // conexión con Google Drive (nunca se manda al panel)
  drive_email: '',
  drive_backup: 'true',  // respaldar en Drive cada video que se sube a YouTube
  drive_folder: 'AutoPublisher',   // se usa solo si no se eligió una carpeta propia
  drive_folder_id: '',             // carpeta elegida con Google Picker
  drive_folder_name: '',
  google_picker_key: '',           // API key (solo Picker) para la ventana de elegir carpeta // minutos después de subir a YouTube para borrar el archivo local (0 = mover a publicados)
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key] ?? '';
}

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

export function setSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, v == null ? '' : String(v));
  }
}

// ---------- Helpers ----------

const JSON_FIELDS = { tags: () => [], localizations: () => ({}) };
const toDb = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function updateRow(table, allowed, id, patch) {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const values = keys.map((k) => (JSON_FIELDS[k] ? JSON.stringify(patch[k] || JSON_FIELDS[k]()) : toDb(patch[k])));
  const extra = table === 'videos' ? ", updated_at = datetime('now')" : '';
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}${extra} WHERE id = ?`).run(...values, id);
}

// ---------- Videos ----------

const VIDEO_FIELDS = [
  'file_path', 'file_name', 'size', 'status', 'title', 'description', 'tags', 'category_id', 'privacy',
  'made_for_kids', 'notify_subscribers', 'synthetic_media', 'account_id', 'playlist_id', 'publish_at',
  'thumbnail_path', 'youtube_id', 'progress', 'error', 'default_language', 'localizations',
  'uploaded_at', 'file_deleted', 'guion_file', 'drive_file_id', 'drive_error', 'drive_tried_at',
];

function rowToVideo(r) {
  if (!r) return null;
  return {
    ...r,
    tags: JSON.parse(r.tags || '[]'),
    localizations: JSON.parse(r.localizations || '{}'),
    made_for_kids: !!r.made_for_kids,
    notify_subscribers: !!r.notify_subscribers,
    synthetic_media: !!r.synthetic_media,
    file_deleted: !!r.file_deleted,
  };
}

export const Videos = {
  list(status) {
    const rows = status && status !== 'all'
      ? db.prepare("SELECT * FROM videos WHERE status = ? ORDER BY COALESCE(publish_at, created_at), id").all(status)
      : db.prepare("SELECT * FROM videos WHERE status != 'ignored' ORDER BY COALESCE(publish_at, created_at), id").all();
    return rows.map(rowToVideo);
  },
  counts() {
    const out = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM videos GROUP BY status').all()) out[r.status] = r.n;
    return out;
  },
  get: (id) => rowToVideo(db.prepare('SELECT * FROM videos WHERE id = ?').get(id)),
  byPath: (p) => rowToVideo(db.prepare('SELECT * FROM videos WHERE file_path = ?').get(p)),
  insert(v) {
    const keys = Object.keys(v).filter((k) => VIDEO_FIELDS.includes(k));
    const values = keys.map((k) => (JSON_FIELDS[k] ? JSON.stringify(v[k] || JSON_FIELDS[k]()) : toDb(v[k])));
    const res = db.prepare(`INSERT INTO videos (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...values);
    return Number(res.lastInsertRowid);
  },
  update: (id, patch) => updateRow('videos', VIDEO_FIELDS, id, patch),
  remove: (id) => db.prepare('DELETE FROM videos WHERE id = ?').run(id),
  nextQueued(onlyDue) {
    const sql = onlyDue
      ? "SELECT * FROM videos WHERE status = 'queued' AND (publish_at IS NULL OR publish_at <= ?) ORDER BY COALESCE(publish_at, created_at), id LIMIT 1"
      : "SELECT * FROM videos WHERE status = 'queued' ORDER BY COALESCE(publish_at, created_at), id LIMIT 1";
    return rowToVideo(onlyDue ? db.prepare(sql).get(new Date().toISOString()) : db.prepare(sql).get());
  },
  markDuePublished() {
    return db.prepare("UPDATE videos SET status = 'published', updated_at = datetime('now') WHERE status = 'scheduled' AND publish_at <= ?")
      .run(new Date().toISOString()).changes;
  },
  // Videos ya subidos cuyo archivo local se puede borrar
  // (si el respaldo en Drive está activo, solo los que ya se copiaron a Drive)
  pendingFileCleanup(minutes, requireDrive = false) {
    const limit = new Date(Date.now() - minutes * 60_000).toISOString();
    return db.prepare(`SELECT * FROM videos WHERE status IN ('scheduled', 'published') AND file_deleted = 0 AND uploaded_at IS NOT NULL AND uploaded_at <= ?
      ${requireDrive ? 'AND drive_file_id IS NOT NULL' : ''}`).all(limit).map(rowToVideo);
  },
  // Próximo video subido a YouTube que todavía no está respaldado en Drive (reintenta errores cada 15 min)
  nextDriveBackup() {
    const retry = new Date(Date.now() - 15 * 60_000).toISOString();
    return rowToVideo(db.prepare(`SELECT * FROM videos WHERE status IN ('scheduled', 'published') AND file_deleted = 0 AND uploaded_at IS NOT NULL
      AND drive_file_id IS NULL AND (drive_tried_at IS NULL OR drive_tried_at <= ?) ORDER BY uploaded_at LIMIT 1`).get(retry));
  },
  resetStuckUploads() {
    db.prepare("UPDATE videos SET status = 'queued', progress = 0 WHERE status = 'uploading'").run();
  },
};

// ---------- Accounts ----------

function rowToAccount(r) {
  return r ? { ...r, tokens: JSON.parse(r.tokens) } : null;
}

export const Accounts = {
  list: () => db.prepare('SELECT * FROM accounts ORDER BY id').all().map(rowToAccount),
  get: (id) => rowToAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)),
  upsert({ channel_id, channel_title, channel_thumb, tokens }) {
    const existing = db.prepare('SELECT * FROM accounts WHERE channel_id = ?').get(channel_id);
    if (existing) {
      const old = JSON.parse(existing.tokens);
      const merged = { ...old, ...tokens, refresh_token: tokens.refresh_token || old.refresh_token };
      db.prepare('UPDATE accounts SET channel_title = ?, channel_thumb = ?, tokens = ? WHERE id = ?')
        .run(channel_title, channel_thumb, JSON.stringify(merged), existing.id);
      return existing.id;
    }
    const res = db.prepare('INSERT INTO accounts (channel_id, channel_title, channel_thumb, tokens) VALUES (?, ?, ?, ?)')
      .run(channel_id, channel_title, channel_thumb, JSON.stringify(tokens));
    return Number(res.lastInsertRowid);
  },
  saveTokens(id, tokens) {
    const acc = Accounts.get(id);
    if (!acc) return;
    const merged = { ...acc.tokens, ...tokens, refresh_token: tokens.refresh_token || acc.tokens.refresh_token };
    db.prepare('UPDATE accounts SET tokens = ? WHERE id = ?').run(JSON.stringify(merged), id);
  },
  remove(id) {
    db.prepare('UPDATE videos SET account_id = NULL WHERE account_id = ? AND status IN (\'draft\', \'queued\', \'error\')').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },
};

// ---------- Templates ----------

const TEMPLATE_FIELDS = ['name', 'title_pattern', 'description', 'tags', 'category_id', 'privacy', 'made_for_kids'];

function rowToTemplate(r) {
  return r ? { ...r, tags: JSON.parse(r.tags || '[]'), made_for_kids: r.made_for_kids == null ? null : !!r.made_for_kids } : null;
}

export const Templates = {
  list: () => db.prepare('SELECT * FROM templates ORDER BY name').all().map(rowToTemplate),
  get: (id) => rowToTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id)),
  create(t) {
    const res = db.prepare('INSERT INTO templates (name) VALUES (?)').run(t.name || 'Plantilla');
    const id = Number(res.lastInsertRowid);
    updateRow('templates', TEMPLATE_FIELDS, id, t);
    return id;
  },
  update: (id, t) => updateRow('templates', TEMPLATE_FIELDS, id, t),
  remove: (id) => db.prepare('DELETE FROM templates WHERE id = ?').run(id),
};
