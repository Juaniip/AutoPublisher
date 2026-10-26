// Biblioteca de guiones (.md): cada guion tiene el prompt para Gemini y los metadatos de YouTube.
// Estados: pending (sin usar) → producing (se copió el prompt, esperando el video) → used (asignado a un video).
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, Videos } from './db.js';
import { parseMetadataMd, appendHashtags } from '../public/metadata-md.js';

db.exec(`
CREATE TABLE IF NOT EXISTS guiones (
  file TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  video_id INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS guion_categories (
  name TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);`);
if (!db.prepare('PRAGMA table_info(guiones)').all().some((c) => c.name === 'category')) {
  db.exec('ALTER TABLE guiones ADD COLUMN category TEXT');
}

export const guionesDir = () => {
  const dir = getSetting('guiones_dir');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Solo nombres de archivo simples: nunca rutas que salgan de la carpeta
export function safeFile(file) {
  const f = String(file || '');
  if (path.basename(f) !== f || !f.toLowerCase().endsWith('.md')) throw new Error('Nombre de guion inválido');
  const full = path.join(guionesDir(), f);
  if (!fs.existsSync(full)) throw new Error('El guion no existe');
  return full;
}

export const readGuion = (file) => fs.readFileSync(safeFile(file), 'utf8');

// Videos todavía sin subir: el guion vinculado a uno de estos está "reservado", pero no usado
const PENDING_VIDEO = "status IN ('draft', 'queued', 'uploading', 'error')";

function linkedVideos() {
  return new Map(db.prepare(`SELECT id, file_name, status, guion_file FROM videos WHERE guion_file IS NOT NULL AND ${PENDING_VIDEO} ORDER BY id`)
    .all().map((v) => [v.guion_file, { id: v.id, file_name: v.file_name, status: v.status }]));
}

export function listGuiones() {
  const dir = guionesDir();
  const linked = linkedVideos();
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  const rows = new Map(db.prepare('SELECT * FROM guiones').all().map((r) => [r.file, r]));
  const insert = db.prepare('INSERT OR IGNORE INTO guiones (file) VALUES (?)');
  const out = files.map((file) => {
    if (!rows.has(file)) insert.run(file);
    const row = rows.get(file) || { status: 'pending', video_id: null };
    const m = parseMetadataMd(fs.readFileSync(path.join(dir, file), 'utf8'));
    return {
      file, status: row.status, video_id: row.video_id, category: row.category || null, title: m.title || file, idea: m.idea || '', prompt: m.prompt || '', hashtags: m.hashtags || [],
      linked: linked.get(file) || null, // video pendiente al que está vinculado (todavía no subido)
    };
  });
  // Limpia registros de archivos que ya no están en la carpeta
  const present = new Set(files);
  for (const file of rows.keys()) if (!present.has(file)) db.prepare('DELETE FROM guiones WHERE file = ?').run(file);
  return out;
}

export function setStatus(file, status, videoId = null) {
  safeFile(file);
  // (no toca la categoría)
  db.prepare("INSERT INTO guiones (file, status, video_id, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(file) DO UPDATE SET status = excluded.status, video_id = excluded.video_id, updated_at = excluded.updated_at")
    .run(file, status, videoId);
}

// ---------- Categorías ----------

const cleanCategory = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);

export const listCategories = () => db.prepare('SELECT name FROM guion_categories ORDER BY name COLLATE NOCASE').all().map((r) => r.name);

export function createCategory(name) {
  const n = cleanCategory(name);
  if (!n) throw new Error('Poné un nombre para la categoría');
  db.prepare('INSERT OR IGNORE INTO guion_categories (name) VALUES (?)').run(n);
  return n;
}

export function deleteCategory(name) {
  db.prepare('UPDATE guiones SET category = NULL WHERE category = ?').run(name);
  db.prepare('DELETE FROM guion_categories WHERE name = ?').run(name);
}

export function setCategory(file, category) {
  safeFile(file);
  const cat = category ? createCategory(category) : null;
  db.prepare('INSERT OR IGNORE INTO guiones (file) VALUES (?)').run(file);
  db.prepare('UPDATE guiones SET category = ? WHERE file = ?').run(cat, file);
}

// Convierte los metadatos de un .md en cambios para el video
export function metadataToPatch(m) {
  const patch = {};
  if (m.title) patch.title = m.title;
  if (m.description != null || m.hashtags) patch.description = appendHashtags(m.description || '', m.hashtags);
  if (m.tags) patch.tags = m.tags;
  if (m.language) patch.default_language = m.language;
  if (m.title_en && m.title_en !== m.title) {
    patch.localizations = { en: { title: m.title_en, description: appendHashtags(m.description_en || '', m.hashtags) } };
  }
  return patch;
}

export function assignGuion(file, videoId) {
  const v = Videos.get(videoId);
  if (!v) throw new Error('Video no encontrado');
  const patch = metadataToPatch(parseMetadataMd(readGuion(file)));
  if (patch.localizations) patch.localizations = { ...v.localizations, ...patch.localizations };
  patch.guion_file = file; // vínculo provisorio: pasa a "Usado" cuando el video se sube a YouTube
  Videos.update(videoId, patch);
  return patch;
}

// Se llama cuando el video se subió bien a YouTube
export function markGuionUsed(file, videoId) {
  try { setStatus(file, 'used', videoId); return true; }
  catch { return false; } // el .md pudo haberse borrado o descartado
}

// El guion "en producción" más antiguo sin video: es el que corresponde al próximo video que llegue
// (se saltean los que ya están vinculados a otro video que todavía no se subió)
export function nextProducing() {
  listGuiones(); // sincroniza con la carpeta
  return db.prepare(`SELECT file FROM guiones WHERE status = 'producing'
    AND file NOT IN (SELECT guion_file FROM videos WHERE guion_file IS NOT NULL AND ${PENDING_VIDEO})
    ORDER BY updated_at, file LIMIT 1`).get()?.file || null;
}


export function discardGuion(file) {
  const full = safeFile(file);
  const dest = path.join(guionesDir(), 'descartados');
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(full, path.join(dest, file));
  db.prepare('DELETE FROM guiones WHERE file = ?').run(file);
}
