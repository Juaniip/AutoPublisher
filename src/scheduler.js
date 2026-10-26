import fs from 'node:fs';
import path from 'node:path';
import { getSetting, Videos, Accounts } from './db.js';
import { uploadVideo, setThumbnail, addToPlaylist, errorReason, errorMessage, credsConfigured } from './google.js';
import { broadcast, toast } from './events.js';
import { markGuionUsed } from './guiones.js';
import { driveEnabled, backupVideo } from './drive.js';

const QUOTA_REASONS = new Set(['quotaExceeded', 'uploadLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']);

let active = 0;
let pausedUntil = 0;
let pauseReason = '';

export const schedulerStatus = () => ({
  active,
  paused: Date.now() < pausedUntil,
  pausedUntil: pausedUntil ? new Date(pausedUntil).toISOString() : null,
  pauseReason,
});

export function resumeScheduler() {
  pausedUntil = 0;
  pauseReason = '';
  tick();
}

function moveToDone(filePath) {
  const doneDir = getSetting('done_dir');
  fs.mkdirSync(doneDir, { recursive: true });
  const { name, ext } = path.parse(filePath);
  let dest = path.join(doneDir, name + ext);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(doneDir, `${name} (${i})${ext}`);
  try {
    fs.renameSync(filePath, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // distinto disco: copiar y borrar
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
  }
  return dest;
}

async function processVideo(v) {
  const fail = (error) => {
    Videos.update(v.id, { status: 'error', error, progress: 0 });
    broadcast('videos');
    toast(`Error en "${v.title}": ${error}`, 'error');
  };

  const account = v.account_id && Accounts.get(v.account_id);
  if (!account) return fail('No hay una cuenta de YouTube asignada.');
  if (!fs.existsSync(v.file_path)) return fail('No se encontró el archivo de video.');

  broadcast('videos');
  let last = -1;
  try {
    const data = await uploadVideo(v, account, (pct) => {
      if (pct === last) return;
      last = pct;
      Videos.update(v.id, { progress: pct });
      broadcast('progress', { id: v.id, progress: pct });
    });

    const patch = {
      status: data.status?.publishAt ? 'scheduled' : 'published',
      youtube_id: data.id,
      progress: 100,
      error: null,
      uploaded_at: new Date().toISOString(),
    };
    const warnings = [];
    if (v.thumbnail_path && fs.existsSync(v.thumbnail_path)) {
      try { await setThumbnail(account, data.id, v.thumbnail_path); }
      catch (e) { warnings.push(`Miniatura no aplicada (${e.message}). El canal debe estar verificado.`); }
    }
    if (v.playlist_id) {
      try { await addToPlaylist(account, data.id, v.playlist_id); }
      catch (e) { warnings.push(`No se pudo agregar a la playlist (${e.message}).`); }
    }
    // Si está activado el borrado automático, el archivo se borra más tarde (cleanupFiles); si no, se mueve a publicados
    if (!(Number(getSetting('delete_after_upload_min')) > 0)) {
      try { patch.file_path = moveToDone(v.file_path); }
      catch (e) { warnings.push(`No se pudo mover el archivo a la carpeta de publicados (${e.message}).`); }
    }
    if (warnings.length) patch.error = warnings.join(' ');

    Videos.update(v.id, patch);
    if (v.guion_file && markGuionUsed(v.guion_file, v.id)) broadcast('guiones');
    broadcast('videos');
    toast(patch.status === 'scheduled' ? `"${v.title}" subido y programado ✔` : `"${v.title}" publicado ✔`, 'success');
  } catch (err) {
    const reason = errorReason(err);
    console.error('[upload]', v.id, reason, errorMessage(err));
    if (QUOTA_REASONS.has(reason)) {
      // Cuota diaria de la API agotada: se reintenta más tarde sin perder el video
      Videos.update(v.id, { status: 'queued', progress: 0, error: `Cuota de YouTube agotada (${reason}). Se reintentará automáticamente.` });
      pausedUntil = Date.now() + 60 * 60 * 1000;
      pauseReason = 'Cuota de la API de YouTube agotada. Reintento automático en 1 hora.';
      broadcast('videos');
      toast(pauseReason, 'warning');
    } else if (reason === 'invalid_grant') {
      fail('El acceso a la cuenta expiró o fue revocado. Reconectá la cuenta en "Cuentas".');
    } else if (reason === 'INVALID_REQUEST_METADATA' || reason === 'invalidMetadata') {
      fail(`YouTube rechazó los datos del video: ${errorMessage(err)}. Revisá título, descripción, etiquetas e idioma.`);
    } else {
      fail(errorMessage(err));
    }
  }
}

// Borra de la PC/Pi los videos que ya están en YouTube hace más de N minutos
function cleanupFiles() {
  const minutes = Number(getSetting('delete_after_upload_min'));
  if (!(minutes > 0)) return;
  let n = 0;
  for (const v of Videos.pendingFileCleanup(minutes, driveEnabled())) {
    try {
      fs.rmSync(v.file_path, { force: true });
      // En Windows, si alguien está viendo la vista previa, el archivo queda "pendiente de borrar": se reintenta en la próxima vuelta
      if (fs.existsSync(v.file_path)) continue;
      if (v.thumbnail_path) fs.rmSync(v.thumbnail_path, { force: true });
      Videos.update(v.id, { file_deleted: true });
      n++;
    } catch (e) {
      console.error('[cleanup]', v.id, e.message);
    }
  }
  if (n) broadcast('videos');
}

// Respaldo en Drive: de a un video por vez, sin frenar las subidas a YouTube
let backingUp = false;
async function driveBackupStep() {
  if (backingUp || !driveEnabled()) return;
  const v = Videos.nextDriveBackup();
  if (!v) return;
  if (!fs.existsSync(v.file_path)) { Videos.update(v.id, { drive_error: 'El archivo local ya no existe.', drive_tried_at: new Date().toISOString() }); return; }
  backingUp = true;
  try {
    const r = await backupVideo(v);
    Videos.update(v.id, { drive_file_id: r.id, drive_error: null, drive_tried_at: new Date().toISOString() });
    broadcast('videos');
  } catch (e) {
    console.error('[drive]', v.id, errorMessage(e));
    Videos.update(v.id, { drive_error: errorMessage(e), drive_tried_at: new Date().toISOString() });
    broadcast('videos');
    toast(`No se pudo respaldar "${v.title}" en Drive: ${errorMessage(e)}. Se reintenta en 15 minutos.`, 'warning');
  } finally {
    backingUp = false;
  }
}

function tick() {
  if (Videos.markDuePublished()) broadcast('videos');
  driveBackupStep();
  cleanupFiles();
  if (Date.now() < pausedUntil || !credsConfigured()) return;

  const max = Math.max(1, Number(getSetting('max_concurrent')) || 1);
  const onlyDue = getSetting('upload_mode') === 'at_time';
  while (active < max) {
    const v = Videos.nextQueued(onlyDue);
    if (!v) break;
    Videos.update(v.id, { status: 'uploading', progress: 0, error: null }); // reservar antes del await
    active++;
    processVideo(v).finally(() => { active--; tick(); });
  }
}

export function startScheduler() {
  Videos.resetStuckUploads();
  setInterval(tick, 15_000);
  tick();
}

export const kickScheduler = () => setImmediate(tick);
