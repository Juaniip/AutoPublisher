import express from 'express';
import { securityHeaders, sameOrigin } from './src/security.js';
import {
  authMiddleware, hasUsers, createFirstUser, checkLogin, changePassword, startSession, endSession,
  sessionUser, sessionId, clientIp, loginBlocked, registerFailure, clearFailures,
} from './src/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { ROOT, DATA_DIR, THUMBS_DIR, getSettings, setSettings, getSetting, Videos, Accounts, Templates } from './src/db.js';
import { disconnectDrive, saveDriveConnection, driveConnected, driveAccessToken, setDriveFolder } from './src/drive.js';
import { authUrl, authType, handleCallback, listPlaylists, credsConfigured, redirectUri, listChannelVideos, createPlaylist, errorMessage } from './src/google.js';
import { startWatcher, rescan, VIDEO_RE } from './src/watcher.js';
import { startScheduler, schedulerStatus, resumeScheduler, kickScheduler } from './src/scheduler.js';
import { templatePatch } from './src/templates.js';
import { translateVideo, geminiKey } from './src/translate.js';
import {
  listGuiones, readGuion, setStatus, assignGuion, discardGuion, guionesDir,
  listCategories, createCategory, deleteCategory, setCategory,
} from './src/guiones.js';
import { generarGuiones, leerBriefGuiones } from './agentes/fabrica.js';
import { toast } from './src/events.js';
import { addClient, broadcast } from './src/events.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // en Docker se usa 0.0.0.0 y el puerto se publica solo en 127.0.0.1
const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '2mb' }));
app.use(sameOrigin);
app.use(authMiddleware);

// ---------- Login (usuario y contraseña locales) ----------
const loginHtml = (setup) => fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8').replace('__SETUP__', setup ? 'true' : 'false');
app.get('/login', (req, res) => {
  if (hasUsers() && sessionUser(req)) return res.redirect('/');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(loginHtml(!hasUsers()));
});
app.get('/login.js', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(ROOT, 'public', 'login.js')); });

app.post('/api/auth/setup', (req, res) => {
  try {
    const id = createFirstUser(String(req.body.username || '').trim(), req.body.password);
    startSession(req, res, id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
  const ip = clientIp(req);
  const wait = loginBlocked(ip);
  if (wait) return res.status(429).json({ error: `Demasiados intentos fallidos. Probá de nuevo en ${wait} min.` });
  if (!hasUsers()) return res.status(400).json({ error: 'Todavía no hay usuario: recargá la página para crearlo.' });
  const user = checkLogin(String(req.body.username || '').trim(), req.body.password);
  if (!user) { registerFailure(ip); return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); }
  clearFailures(ip);
  startSession(req, res, user.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ username: req.user?.username || null }));
app.post('/api/auth/password', (req, res) => {
  if (!req.user) return res.status(400).json({ error: 'Solo se puede cambiar desde el panel, con la sesión iniciada.' });
  try { changePassword(req.user.id, req.body.current, req.body.next, sessionId(req)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Panel: nunca cachear (ni el navegador ni Cloudflare), y versionar los archivos para que
// después de una actualización siempre se cargue el código nuevo
const BUILD = Date.now().toString(36);
const noStore = (res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
};
const indexHtml = () => fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace(/(href|src)="(styles\.css|app\.js)"/g, `$1="$2?v=${BUILD}"`);
app.get(['/', '/index.html'], (req, res) => { noStore(res); res.type('html').send(indexHtml()); });
app.get('/app.js', (req, res) => {
  noStore(res);
  res.type('js').send(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8').replace("'./metadata-md.js'", `'./metadata-md.js?v=${BUILD}'`));
});
app.use(express.static(path.join(ROOT, 'public'), { index: false, setHeaders: noStore }));

const upload = multer({
  storage: multer.diskStorage({
    destination: THUMBS_DIR,
    filename: (req, file, cb) => cb(null, `${req.params.id}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // límite de YouTube para miniaturas
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png)$/.test(file.mimetype)),
});

// Subida de videos desde el panel: se escribe en una carpeta temporal y recién al terminar se mueve
// a la carpeta vigilada (así el watcher nunca ve un archivo a medio subir)
const UPLOAD_TMP = path.join(DATA_DIR, 'uploads-tmp');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });
const videoUpload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_TMP, filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`) }),
  limits: { fileSize: 8 * 1024 ** 3 },
  fileFilter: (req, file, cb) => cb(null, VIDEO_RE.test(file.originalname)),
});

const EDITABLE = ['title', 'description', 'tags', 'category_id', 'privacy', 'made_for_kids', 'notify_subscribers',
  'synthetic_media', 'account_id', 'playlist_id', 'publish_at', 'default_language', 'localizations', 'guion_file'];
const LOCKED = new Set(['uploading', 'scheduled', 'published']);

const pick = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));
const ids = (req) => (Array.isArray(req.body.ids) ? req.body.ids.map(Number) : []);
const safeAccount = ({ tokens, ...a }) => a;

function validate(v) {
  const errs = [];
  if (!v.title?.trim()) errs.push('falta el título');
  if (v.title?.length > 100) errs.push('el título supera 100 caracteres');
  if (/[<>]/.test(v.title + v.description)) errs.push('título/descripción no pueden contener < o >');
  if ((v.description || '').length > 5000) errs.push('la descripción supera 5000 caracteres');
  if ((v.tags || []).join(',').length > 500) errs.push('las etiquetas superan 500 caracteres');
  for (const [code, l] of Object.entries(v.localizations || {})) {
    if (!l?.title) continue;
    if (l.title.length > 100) errs.push(`el título en ${code} supera 100 caracteres`);
    if (/[<>]/.test(l.title + (l.description || ''))) errs.push(`la traducción ${code} no puede contener < o >`);
  }
  if (!v.account_id || !Accounts.get(v.account_id)) errs.push('no tiene cuenta asignada');
  return errs;
}

// ---------- Estado general ----------

app.get('/api/state', (req, res) => {
  res.json({
    counts: Videos.counts(),
    scheduler: schedulerStatus(),
    credsConfigured: credsConfigured(),
    redirectUri: redirectUri(),
    watchDir: getSetting('watch_dir'),
    timeSlots: getSetting('time_slots'),
    drive: { connected: driveConnected(), enabled: driveConnected() && getSetting('drive_backup') !== 'false', folder: getSetting('drive_folder_name') || getSetting('drive_folder') },
  });
});

// ---------- Calendario de YouTube (lee los canales en tiempo real; caché de 5 min) ----------
let ytCache = { at: 0, data: null, pending: null };

// YouTube manda: si una fecha se cambió en YouTube Studio o el video ya salió, se actualiza en AutoPublisher
function syncFromYoutube(channels) {
  const byId = new Map(channels.filter((c) => !c.error).flatMap((c) => c.videos.map((v) => [v.id, v])));
  // Canales leídos completos (sin error y por debajo del tope de 300): ahí un video ausente significa que se borró
  const complete = new Set(channels.filter((c) => !c.error && c.videos.length < 300).map((c) => c.account_id));
  let changed = 0;
  for (const v of Videos.list('all')) {
    if (!v.youtube_id || !['scheduled', 'published'].includes(v.status)) continue;
    const yt = byId.get(v.youtube_id);
    if (!yt) {
      if (complete.has(v.account_id)) {
        Videos.update(v.id, { status: 'ignored', error: 'Ya no está en YouTube (se eliminó del canal).' });
        changed++;
      }
      continue;
    }
    const patch = {};
    if (yt.state === 'published' && v.status === 'scheduled') patch.status = 'published';
    if (yt.state === 'scheduled' && v.status === 'published') patch.status = 'scheduled';
    if (yt.date && (!v.publish_at || new Date(v.publish_at).getTime() !== new Date(yt.date).getTime())) patch.publish_at = yt.date;
    if (Object.keys(patch).length) { Videos.update(v.id, patch); changed++; }
  }
  if (changed) broadcast('videos');
}

function youtubeCalendar(force = false) {
  if (!force && ytCache.data && Date.now() - ytCache.at < 5 * 60_000) return Promise.resolve(ytCache.data);
  if (ytCache.pending) return ytCache.pending;
  ytCache.pending = Promise.all(Accounts.list().map(async (a) => {
    const known = Videos.list('all').filter((v) => v.account_id === a.id && v.youtube_id && ['scheduled', 'published'].includes(v.status)).map((v) => v.youtube_id);
    try { return { account_id: a.id, channel: a.channel_title, videos: await listChannelVideos(a, 300, known) }; }
    catch (e) { return { account_id: a.id, channel: a.channel_title, videos: [], error: errorMessage(e) }; }
  })).then((data) => { syncFromYoutube(data); ytCache = { at: Date.now(), data, pending: null }; return data; })
    .catch((e) => { ytCache.pending = null; throw e; });
  return ytCache.pending;
}

app.get('/api/youtube/calendar', async (req, res) => {
  try { res.json({ channels: await youtubeCalendar(req.query.refresh === '1'), fetchedAt: new Date(ytCache.at).toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Fechas para el calendario del editor: lo de AutoPublisher + lo que ya está en YouTube (sin duplicar)
app.get('/api/calendar', async (req, res) => {
  const local = Videos.list('all').filter((v) => v.publish_at).map((v) => ({
    id: v.id, title: v.title || v.file_name, publish_at: v.publish_at, status: v.status, account_id: v.account_id, youtube_id: v.youtube_id,
  }));
  const known = new Set(local.map((v) => v.youtube_id).filter(Boolean));
  let yt = [];
  try {
    const channels = await Promise.race([youtubeCalendar(false), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    yt = channels.flatMap((c) => c.videos
      .filter((v) => !known.has(v.id) && (v.state === 'scheduled' || v.state === 'published') && v.date)
      .map((v) => ({ id: `yt:${v.id}`, title: v.title, publish_at: v.date, status: v.state, account_id: c.account_id })));
  } catch { /* sin conexión con YouTube: solo lo local */ }
  res.json([...local, ...yt]);
});

app.get('/api/events', addClient);

// ---------- Videos ----------

app.get('/api/videos', (req, res) => res.json(Videos.list(req.query.status)));

app.patch('/api/videos/:id', (req, res) => {
  const v = Videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'No existe' });
  if (LOCKED.has(v.status)) return res.status(409).json({ error: 'El video ya fue subido; no se puede editar.' });
  Videos.update(v.id, pick(req.body, EDITABLE));
  broadcast('videos');
  res.json(Videos.get(v.id));
});

// Actualización masiva: { updates: [{ id, ...campos }] }  ó  { ids, patch }
app.post('/api/videos/bulk-update', (req, res) => {
  const updates = req.body.updates || ids(req).map((id) => ({ id, ...req.body.patch }));
  let n = 0;
  for (const u of updates) {
    const v = Videos.get(u.id);
    if (!v || LOCKED.has(v.status)) continue;
    const patch = pick(u, EDITABLE);
    if (u.add_tags) patch.tags = [...new Set([...v.tags, ...u.add_tags])];
    if (u.append_description) patch.description = (v.description ? v.description + '\n\n' : '') + u.append_description;
    Videos.update(v.id, patch);
    n++;
  }
  broadcast('videos');
  res.json({ updated: n });
});

app.post('/api/videos/apply-template', (req, res) => {
  const tpl = Templates.get(req.body.template_id);
  if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada' });
  let n = 0;
  ids(req).forEach((id, i) => {
    const v = Videos.get(id);
    if (!v || LOCKED.has(v.status)) return;
    Videos.update(id, templatePatch(tpl, v, (Number(req.body.start_index) || 1) + i));
    n++;
  });
  broadcast('videos');
  res.json({ updated: n });
});

app.post('/api/videos/queue', (req, res) => {
  const errors = [];
  let queued = 0;
  for (const id of ids(req)) {
    const v = Videos.get(id);
    if (!v || !['draft', 'error'].includes(v.status)) continue;
    const errs = validate(v);
    if (errs.length) { errors.push({ id, title: v.title || v.file_name, errors: errs }); continue; }
    Videos.update(id, { status: 'queued', error: null, progress: 0 });
    queued++;
  }
  broadcast('videos');
  kickScheduler();
  res.json({ queued, errors });
});

app.post('/api/videos/unqueue', (req, res) => {
  for (const id of ids(req)) {
    const v = Videos.get(id);
    if (v && ['queued', 'error', 'ignored'].includes(v.status)) Videos.update(id, { status: 'draft', error: null, progress: 0 });
  }
  broadcast('videos');
  res.json({ ok: true });
});

app.post('/api/videos/ignore', (req, res) => {
  for (const id of ids(req)) {
    const v = Videos.get(id);
    if (v && ['draft', 'queued', 'error'].includes(v.status)) Videos.update(id, { status: 'ignored' });
  }
  broadcast('videos');
  res.json({ ok: true });
});

// Quita del historial los ya publicados (no toca YouTube ni el archivo)
app.post('/api/videos/clear', (req, res) => {
  for (const id of ids(req)) {
    const v = Videos.get(id);
    if (v && ['published', 'scheduled'].includes(v.status)) Videos.remove(id);
  }
  broadcast('videos');
  res.json({ ok: true });
});

app.get('/api/videos/:id/stream', (req, res) => {
  const v = Videos.get(req.params.id);
  if (!v || !fs.existsSync(v.file_path)) return res.sendStatus(404);
  res.sendFile(v.file_path); // soporta Range => se puede adelantar el video
});

app.post('/api/videos/:id/thumbnail', upload.single('thumbnail'), (req, res) => {
  const v = Videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'No existe' });
  if (!req.file) return res.status(400).json({ error: 'La miniatura debe ser JPG o PNG de hasta 2 MB.' });
  if (v.thumbnail_path) fs.rm(v.thumbnail_path, { force: true }, () => {});
  Videos.update(v.id, { thumbnail_path: req.file.path });
  broadcast('videos');
  res.json(Videos.get(v.id));
});

app.delete('/api/videos/:id/thumbnail', (req, res) => {
  const v = Videos.get(req.params.id);
  if (v?.thumbnail_path) fs.rm(v.thumbnail_path, { force: true }, () => {});
  if (v) Videos.update(v.id, { thumbnail_path: null });
  broadcast('videos');
  res.json({ ok: true });
});

app.get('/api/videos/:id/thumbnail', (req, res) => {
  const v = Videos.get(req.params.id);
  if (!v?.thumbnail_path || !fs.existsSync(v.thumbnail_path)) return res.sendStatus(404);
  res.sendFile(v.thumbnail_path);
});

app.post('/api/videos/:id/translate', async (req, res) => {
  const v = Videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'No existe' });
  if (LOCKED.has(v.status)) return res.status(409).json({ error: 'El video ya fue subido.' });
  try { res.json({ en: await translateVideo(v.id) }); broadcast('videos'); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Traducción en lote, de a uno para no chocar con los límites de Gemini
app.post('/api/videos/translate', async (req, res) => {
  let ok = 0;
  const errors = [];
  for (const id of ids(req)) {
    const v = Videos.get(id);
    if (!v || LOCKED.has(v.status)) continue;
    try { await translateVideo(id); ok++; }
    catch (e) { errors.push({ id, title: v.title || v.file_name, error: e.message }); if (/API key/i.test(e.message)) break; }
  }
  broadcast('videos');
  res.json({ translated: ok, errors });
});

app.post('/api/upload', videoUpload.array('videos', 50), (req, res) => {
  const dir = getSetting('watch_dir');
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of req.files || []) {
    // multer entrega el nombre en latin1: se corrige para que funcionen tildes y emojis
    const fixed = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const original = fixed.includes('�') ? f.originalname : fixed;
    const { name, ext } = path.parse(path.basename(original).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'));
    let dest = path.join(dir, name + ext);
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(dir, `${name} (${i})${ext}`);
    try { fs.renameSync(f.path, dest); }
    catch { fs.copyFileSync(f.path, dest); fs.rmSync(f.path, { force: true }); }
    saved.push(path.basename(dest));
  }
  res.json({ saved });
});

app.post('/api/rescan', (req, res) => { rescan(); res.json({ ok: true }); });

app.post('/api/scheduler/resume', (req, res) => { resumeScheduler(); res.json(schedulerStatus()); });

// ---------- Guiones ----------

const BRIEF_GUIONES = path.join(ROOT, 'agentes', 'brief-guiones.md');
let generating = null; // { cantidad, progress } mientras corre la fábrica

app.get('/api/guiones', (req, res) => {
  try { res.json({ guiones: listGuiones(), categories: listCategories(), generating, dir: guionesDir() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/guiones/brief', (req, res) => res.json({ text: fs.readFileSync(BRIEF_GUIONES, 'utf8'), path: BRIEF_GUIONES }));

app.put('/api/guiones/brief', (req, res) => {
  const text = String(req.body.text || '');
  if (!text.includes('{{HISTORIA}}')) return res.status(400).json({ error: 'La plantilla del prompt tiene que incluir {{HISTORIA}}.' });
  const backup = fs.readFileSync(BRIEF_GUIONES, 'utf8');
  fs.writeFileSync(BRIEF_GUIONES, text);
  try { leerBriefGuiones(BRIEF_GUIONES); res.json({ ok: true }); }
  catch (e) { fs.writeFileSync(BRIEF_GUIONES, backup); res.status(400).json({ error: e.message }); }
});

app.post('/api/guiones/generate', (req, res) => {
  if (generating) return res.status(409).json({ error: 'Ya se están generando guiones.' });
  const apiKey = geminiKey();
  if (!apiKey) return res.status(400).json({ error: 'Falta la API key de Gemini (Ajustes → Gemini).' });
  const cantidad = Math.max(1, Math.min(200, Number(req.body.cantidad) || 10));
  const ideas = Array.isArray(req.body.ideas) ? req.body.ideas.map(String).map((s) => s.trim()).filter(Boolean) : [];
  let category = null;
  try { category = req.body.category ? createCategory(req.body.category) : null; }
  catch (e) { return res.status(400).json({ error: e.message }); }
  generating = { cantidad, category, progress: 'Empezando…' };
  res.json({ started: true });
  broadcast('guiones');
  const yaUsadas = listGuiones().map((g) => (g.idea ? `${g.title} — ${g.idea}` : g.title));
  generarGuiones({
    apiKey, briefPath: BRIEF_GUIONES, outDir: guionesDir(), cantidad, ideasExtra: ideas, yaUsadas,
    onProgress: (p) => { generating.progress = p; broadcast('guiones'); },
  })
    .then((files) => {
      if (category) for (const f of files) setCategory(f, category);
      toast(`${files.length} guiones nuevos listos${category ? ` en "${category}"` : ''} 🎬`, 'success');
    })
    .catch((e) => toast(`Error al generar guiones: ${e.message}`, 'error'))
    .finally(() => { generating = null; broadcast('guiones'); });
});

app.post('/api/guion-categories', (req, res) => {
  try { res.json({ name: createCategory(req.body.name) }); broadcast('guiones'); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/guion-categories/:name', (req, res) => {
  deleteCategory(req.params.name);
  broadcast('guiones');
  res.json({ ok: true });
});

app.post('/api/guiones/:file/category', (req, res) => {
  try { setCategory(req.params.file, req.body.category || null); broadcast('guiones'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/guiones/:file', (req, res) => {
  try { res.json({ text: readGuion(req.params.file) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

// Mover varios guiones de estado a la vez (Pendientes / En producción / Usados)
app.post('/api/guiones/bulk-status', (req, res) => {
  const { status } = req.body;
  if (!['pending', 'producing', 'used'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  let moved = 0;
  for (const f of files) { try { setStatus(String(f), status); moved++; } catch { /* archivo inexistente */ } }
  broadcast('guiones');
  res.json({ moved });
});

app.post('/api/guiones/:file/status', (req, res) => {
  const { status } = req.body;
  if (!['pending', 'producing', 'used'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  try { setStatus(req.params.file, status, req.body.video_id ? Number(req.body.video_id) : null); broadcast('guiones'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/guiones/:file/assign', (req, res) => {
  const v = Videos.get(req.body.video_id);
  if (!v) return res.status(404).json({ error: 'Video no encontrado' });
  if (LOCKED.has(v.status)) return res.status(409).json({ error: 'El video ya fue subido.' });
  try { assignGuion(req.params.file, v.id); broadcast('videos'); broadcast('guiones'); res.json(Videos.get(v.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/guiones/:file', (req, res) => {
  try { discardGuion(req.params.file); broadcast('guiones'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Cuentas ----------

app.get('/api/accounts', (req, res) => res.json(Accounts.list().map(safeAccount)));

app.delete('/api/accounts/:id', (req, res) => {
  Accounts.remove(Number(req.params.id));
  broadcast('videos');
  res.json({ ok: true });
});

app.post('/api/accounts/:id/playlists', async (req, res) => {
  const acc = Accounts.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' });
  const title = String(req.body.title || '').replace(/[<>]/g, '').trim().slice(0, 150);
  if (!title) return res.status(400).json({ error: 'Falta el título de la playlist' });
  try {
    const pl = await createPlaylist(acc, {
      title,
      description: String(req.body.description || '').replace(/[<>]/g, '').slice(0, 5000),
      privacy: ['public', 'unlisted', 'private'].includes(req.body.privacy) ? req.body.privacy : 'public',
      language: req.body.language || undefined,
      translations: Array.isArray(req.body.translations) ? req.body.translations : [],
    });
    res.json(pl);
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.get('/api/accounts/:id/playlists', async (req, res) => {
  const acc = Accounts.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' });
  try { res.json(await listPlaylists(acc)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/auth/google', (req, res) => {
  if (!credsConfigured()) return res.redirect('/#ajustes');
  res.redirect(authUrl());
});

app.get('/auth/drive', (req, res) => {
  if (!credsConfigured()) return res.redirect('/#ajustes');
  res.redirect(authUrl('drive'));
});

app.post('/api/drive/disconnect', (req, res) => { disconnectDrive(); res.json({ ok: true }); });

// Datos para abrir Google Picker (ventana de Google para elegir la carpeta de destino)
app.get('/api/drive/picker', async (req, res) => {
  if (!driveConnected()) return res.status(400).json({ error: 'Primero conectá Google Drive.' });
  const apiKey = getSetting('google_picker_key');
  if (!apiKey) return res.status(400).json({ error: 'Falta la API key de Google Picker (Ajustes → Google Drive).' });
  try {
    const appId = String(getSetting('google_client_id')).split('-')[0]; // número de proyecto de Google Cloud
    res.json({ token: await driveAccessToken(), apiKey, appId });
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.post('/api/drive/folder', async (req, res) => {
  if (!req.body.id) {
    setSettings({ drive_folder_id: '', drive_folder_name: '' });
    return res.json({ ok: true });
  }
  try { const f = await setDriveFolder(String(req.body.id), String(req.body.name || '')); res.json({ id: f.id, name: f.name }); }
  catch (e) { res.status(400).json({ error: `No se pudo usar esa carpeta: ${errorMessage(e)}` }); }
});

app.get('/oauth2callback', async (req, res) => {
  const view = authType(req.query.state) === 'drive' ? 'ajustes' : 'cuentas';
  if (req.query.error) return res.redirect(`/#${view}?error=${encodeURIComponent(req.query.error)}`);
  try {
    const r = await handleCallback(req.query.code, req.query.state);
    if (r?.type === 'drive') {
      saveDriveConnection(r.tokens, r.email);
      return res.redirect('/#ajustes?ok=drive');
    }
    broadcast('accounts');
    res.redirect('/#cuentas?ok=1');
  } catch (e) {
    console.error('[oauth]', e);
    res.redirect(`/#${view}?error=${encodeURIComponent(e.message)}`);
  }
});

// ---------- Plantillas ----------

const TPL_FIELDS = ['name', 'title_pattern', 'description', 'tags', 'category_id', 'privacy', 'made_for_kids'];
app.get('/api/templates', (req, res) => res.json(Templates.list()));
app.post('/api/templates', (req, res) => res.json(Templates.get(Templates.create(pick(req.body, TPL_FIELDS)))));
app.put('/api/templates/:id', (req, res) => {
  Templates.update(Number(req.params.id), pick(req.body, TPL_FIELDS));
  res.json(Templates.get(req.params.id));
});
app.delete('/api/templates/:id', (req, res) => { Templates.remove(Number(req.params.id)); res.json({ ok: true }); });

// ---------- Ajustes ----------

app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.json({
    ...s,
    google_client_secret: s.google_client_secret ? '••••••••' : '',
    gemini_api_key: s.gemini_api_key ? '••••••••' : '',
    drive_tokens: undefined, // nunca se mandan al navegador
    google_picker_key: s.google_picker_key ? '••••••••' : '',
    drive_connected: driveConnected(),
    redirect_uri: redirectUri(),
  });
});

app.put('/api/settings', async (req, res) => {
  const body = { ...req.body };
  if (body.google_client_secret === '••••••••') delete body.google_client_secret;
  if (body.gemini_api_key === '••••••••') delete body.gemini_api_key;
  delete body.drive_tokens; // la conexión con Drive solo se cambia con el login de Google
  delete body.drive_email;
  delete body.drive_folder_id;
  delete body.drive_folder_name;
  if (body.google_picker_key === '••••••••') delete body.google_picker_key;
  const prevWatch = getSetting('watch_dir');
  setSettings(body);
  if (getSetting('watch_dir') !== prevWatch) await startWatcher();
  kickScheduler();
  res.json({ ok: true });
});

// ---------- Arranque ----------

app.listen(PORT, HOST, async () => {
  await startWatcher();
  startScheduler();
  console.log(`\n  AutoPublisher listo en http://localhost:${PORT}\n`);
});
