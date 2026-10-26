import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { getSetting, Videos, Accounts } from './db.js';
import { prettifyFileName } from './templates.js';
import { broadcast, toast } from './events.js';
import { translateVideo, geminiKey } from './translate.js';
import { nextProducing, assignGuion, metadataToPatch } from './guiones.js';
import { parseMetadataMd } from '../public/metadata-md.js';

export const VIDEO_RE = /\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv|3gp|mpe?g)$/i;

let watcher = null;

function defaultsForNewVideo() {
  const accounts = Accounts.list();
  const defaultAcc = getSetting('default_account_id');
  return {
    privacy: getSetting('default_privacy') || 'public',
    category_id: getSetting('default_category') || '22',
    default_language: getSetting('default_language') || 'es-419',
    account_id: defaultAcc ? Number(defaultAcc) : accounts.length === 1 ? accounts[0].id : null,
  };
}

// Metadatos opcionales en "<video>.json" junto al archivo (los escriben los agentes de IA).
// Se importan una vez y se borra el .json para no dejar basura en la carpeta.
function readSidecar(videoPath) {
  const { dir, name } = path.parse(videoPath);
  const jsonPath = path.join(dir, `${name}.json`);
  if (!fs.existsSync(jsonPath)) return {};
  try {
    const m = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const out = {};
    if (typeof m.title === 'string') out.title = m.title.replace(/[<>]/g, '').slice(0, 100);
    if (typeof m.description === 'string') out.description = m.description.replace(/[<>]/g, '').slice(0, 5000);
    if (Array.isArray(m.tags)) out.tags = m.tags.map(String).filter(Boolean);
    if (typeof m.synthetic_media === 'boolean') out.synthetic_media = m.synthetic_media;
    if (m.localizations && typeof m.localizations === 'object') out.localizations = m.localizations;
    if (typeof m.default_language === 'string') out.default_language = m.default_language;
    fs.rmSync(jsonPath, { force: true });
    return out;
  } catch (e) {
    console.error('[watcher] JSON de metadatos inválido:', jsonPath, e.message);
    return {};
  }
}

function onAdd(p) {
  const abs = path.resolve(p);
  if (!VIDEO_RE.test(abs) || Videos.byPath(abs)) return;
  let size = 0;
  try { size = fs.statSync(abs).size; } catch { return; }

  const video = {
    file_path: abs,
    file_name: path.basename(abs),
    size,
    status: 'draft',
    title: prettifyFileName(path.basename(abs)).slice(0, 100),
    ...defaultsForNewVideo(),
  };
  const sidecar = readSidecar(abs);
  Object.assign(video, sidecar);

  const id = Videos.insert(video);
  broadcast('videos');
  toast(`Nuevo video detectado: ${video.file_name}`);

  // Guion para este video: primero un .md con el mismo nombre; si no, el guion "en producción" más antiguo
  if (!Object.keys(sidecar).length) {
    const mdPath = path.join(path.dirname(abs), `${path.parse(abs).name}.md`);
    try {
      if (fs.existsSync(mdPath)) {
        const patch = metadataToPatch(parseMetadataMd(fs.readFileSync(mdPath, 'utf8')));
        Object.assign(video, patch);
        Videos.update(id, patch);
        toast(`Se cargaron los datos de ${path.basename(mdPath)}`, 'success');
      } else if (getSetting('auto_assign_guion') !== 'false') {
        const guion = nextProducing();
        if (guion) {
          const patch = assignGuion(guion, id);
          Object.assign(video, patch);
          toast(`Guion sugerido: "${patch.title}" → ${video.file_name}. Si no es ese, cambialo en el editor; pasa a "Usado" recién cuando el video se sube.`, 'success');
          broadcast('guiones');
        }
      }
      broadcast('videos');
    } catch (e) {
      toast(`No se pudo cargar el guion: ${e.message}`, 'warning');
    }
  }

  // Traducción automática al inglés (si está activada y el video no trae una ya hecha)
  if (getSetting('auto_translate_en') === 'true' && geminiKey() && !video.localizations?.en && !String(video.default_language).startsWith('en')) {
    translateVideo(id)
      .then(() => broadcast('videos'))
      .catch((e) => toast(`No se pudo traducir "${video.title}": ${e.message}`, 'warning'));
  }
}

function onUnlink(p) {
  const v = Videos.byPath(path.resolve(p));
  if (!v) return;
  if (v.status === 'draft' || v.status === 'ignored') Videos.remove(v.id);
  else if (v.status === 'queued' || v.status === 'error') Videos.update(v.id, { status: 'error', error: 'El archivo fue movido o eliminado de la carpeta.' });
  else return; // subiendo / publicado: el propio sistema lo movió
  broadcast('videos');
}

export async function startWatcher() {
  if (watcher) await watcher.close();
  const dir = getSetting('watch_dir');
  fs.mkdirSync(dir, { recursive: true });
  watcher = chokidar.watch(dir, {
    ignoreInitial: false,
    depth: 3,
    // espera a que el archivo termine de copiarse antes de tomarlo
    awaitWriteFinish: { stabilityThreshold: 4000, pollInterval: 500 },
    ignored: (p, stats) => !!stats?.isFile() && !VIDEO_RE.test(p),
  });
  watcher.on('add', onAdd).on('unlink', onUnlink).on('error', (e) => console.error('[watcher]', e));
  console.log(`[watcher] Vigilando ${dir}`);
}

export function rescan() {
  const dir = getSetting('watch_dir');
  const walk = (d, depth) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (ent.isFile()) onAdd(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir, 0);
}
