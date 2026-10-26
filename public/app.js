import { MD_TEMPLATE, parseMetadataMd, appendHashtags } from './metadata-md.js';

// ================= Utilidades =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = '/login'; throw new Error('Sesión vencida'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), level === 'error' ? 8000 : 4500);
}

const STATUS = {
  draft: 'Borradores', queued: 'En cola', uploading: 'Subiendo', scheduled: 'Programados',
  published: 'Publicados', error: 'Errores', ignored: 'Descartados', all: 'Todos',
};
const STATUS_ONE = {
  draft: 'Borrador', queued: 'En cola', uploading: 'Subiendo', scheduled: 'Programado',
  published: 'Publicado', error: 'Error', ignored: 'Descartado',
};
const LOCKED = new Set(['uploading', 'scheduled', 'published']);
const PRIVACY = { public: 'Público', unlisted: 'No listado', private: 'Privado' };
const CATEGORIES = {
  1: 'Cine y animación', 2: 'Autos y vehículos', 10: 'Música', 15: 'Mascotas y animales', 17: 'Deportes',
  19: 'Viajes y eventos', 20: 'Videojuegos', 22: 'Personas y blogs', 23: 'Comedia', 24: 'Entretenimiento',
  25: 'Noticias y política', 26: 'Consejos y estilo', 27: 'Educación', 28: 'Ciencia y tecnología', 29: 'ONG y activismo',
};

const LANGUAGES = {
  'es-419': 'Español (Latinoamérica)', es: 'Español (España)', en: 'Inglés', pt: 'Portugués', it: 'Italiano', fr: 'Francés', zxx: 'Sin diálogo / sin idioma',
};

const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const fmtDate = (iso) => new Date(iso).toLocaleString('es-AR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const options = (obj, selected, empty) =>
  (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
  Object.entries(obj).map(([k, v]) => `<option value="${esc(k)}" ${String(selected) === String(k) ? 'selected' : ''}>${esc(v)}</option>`).join('');

// ================= Estado =================
const state = {
  view: 'videos',
  filter: 'draft',
  search: '',
  videos: [],
  accounts: [],
  info: null,
  selected: new Set(),
  playlists: {},
};
const accountsMap = () => Object.fromEntries(state.accounts.map((a) => [a.id, a.channel_title]));

async function loadVideos() {
  state.videos = await api('GET', `/api/videos?status=${state.filter}`);
  const ids = new Set(state.videos.map((v) => v.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
}
async function loadInfo() { state.info = await api('GET', '/api/state'); renderSchedulerStatus(); }
async function loadAccounts() { state.accounts = await api('GET', '/api/accounts'); }

// ================= Router =================
function route() {
  const [view, query] = (location.hash.slice(1) || 'inicio').split('?');
  state.view = ['inicio', 'videos', 'calendario', 'guiones', 'cuentas', 'ajustes'].includes(view) ? view : 'inicio';
  closeDrawer();
  closeModal();
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== `view-${state.view}`));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  const params = new URLSearchParams(query || '');
  if (params.get('ok')) toast(params.get('ok') === 'drive' ? 'Google Drive conectado ✔' : 'Canal conectado correctamente ✔', 'success');
  if (params.get('error')) toast(`No se pudo conectar: ${params.get('error')}`, 'error');
  if (query) history.replaceState(null, '', `#${state.view}`);
  ({ inicio: renderHome, videos: renderVideosView, guiones: renderGuiones, cuentas: renderAccounts, calendario: renderYtCalendar, ajustes: renderSettings })[state.view]();
}

// ================= Vista: Videos =================
function renderVideosView() {
  const counts = state.info?.counts || {};
  const total = Object.entries(counts).filter(([k]) => k !== 'ignored').reduce((a, [, n]) => a + n, 0);
  $('#status-tabs').innerHTML = ['draft', 'queued', 'uploading', 'scheduled', 'published', 'error', 'all', 'ignored']
    .map((s) => {
      const n = s === 'all' ? total : counts[s] || 0;
      if ((s === 'ignored' || s === 'error' || s === 'uploading') && !n && state.filter !== s) return '';
      return `<button class="tab ${state.filter === s ? 'active' : ''}" data-status="${s}">${STATUS[s]}<span class="n">${n}</span></button>`;
    }).join('');
  $('#watch-dir-label').innerHTML = state.info ? `Carpeta vigilada: <code>${esc(state.info.watchDir)}</code>` : '';

  const banner = [];
  if (state.info && !state.info.credsConfigured)
    banner.push(`<div class="banner"><span>⚠️ Falta configurar las credenciales de Google (Client ID y Secret) para poder publicar.</span><a class="btn sm" href="#ajustes">Configurar</a></div>`);
  else if (!state.accounts.length)
    banner.push(`<div class="banner"><span>Conectá al menos un canal de YouTube para poder publicar.</span><a class="btn sm primary" href="/auth/google">Conectar canal</a></div>`);
  if (state.info?.scheduler.paused)
    banner.push(`<div class="banner"><span>⏸ ${esc(state.info.scheduler.pauseReason)}</span><button class="btn sm" data-action="resume">Reintentar ahora</button></div>`);
  $('#setup-banner').innerHTML = banner.join('');

  renderGrid();
}

function cardHtml(v) {
  const accs = accountsMap();
  const acc = state.accounts.find((a) => a.id === v.account_id);
  const media = v.file_deleted
    ? `<div class="no-file">✔ En YouTube<br><span>archivo local borrado</span></div>`
    : v.thumbnail_path
      ? `<img src="/api/videos/${v.id}/thumbnail?${encodeURIComponent(v.updated_at)}" loading="lazy" />`
      : `<video src="/api/videos/${v.id}/stream#t=1" preload="metadata" muted></video>`;
  const when = v.publish_at ? `📅 ${fmtDate(v.publish_at)}` : v.status === 'published' ? '' : '⚡ Inmediato';
  const isWarn = ['scheduled', 'published', 'queued'].includes(v.status);
  return `
    <div class="thumb">
      ${media}
      ${LOCKED.has(v.status) ? '' : `<label class="sel"><input type="checkbox" data-select="${v.id}" ${state.selected.has(v.id) ? 'checked' : ''}/></label>`}
      <span class="badge ${v.status}">${STATUS_ONE[v.status]}</span>
      <span class="size">${fmtSize(v.size)}</span>
    </div>
    <div class="card-body">
      <div class="card-title">${esc(v.title || v.file_name)}</div>
      <div class="muted small" title="${esc(v.file_name)}">${esc(v.file_name)}${v.localizations?.en?.title ? ' · <span class="badge" title="Tiene traducción al inglés">EN</span>' : ''}${v.drive_file_id ? ' · <span class="badge" title="Respaldado en Google Drive">☁ Drive</span>' : v.drive_error ? ' · <span class="badge error" title="' + esc(v.drive_error) + '">☁ error</span>' : ''}</div>
      ${v.status === 'uploading' ? `<div class="progress" data-progress="${v.id}"><div style="width:${v.progress}%"></div></div><div class="small muted" data-progress-label="${v.id}">${v.progress}% subido</div>` : ''}
      ${v.error ? `<div class="card-error ${isWarn ? 'warn' : ''}">${esc(v.error)}</div>` : ''}
      <div class="card-meta">
        <span class="acc">${acc ? `<img class="avatar" src="${esc(acc.channel_thumb)}" referrerpolicy="no-referrer" alt=""/>${esc(accs[v.account_id])}` : '<span style="color:var(--yellow)">Sin canal</span>'}</span>
        <span>${when}</span>
      </div>
      ${v.youtube_id ? `<a class="btn sm" href="https://youtu.be/${esc(v.youtube_id)}" target="_blank" rel="noopener">Ver en YouTube ↗</a>` : ''}
    </div>`;
}

const cardCache = new Map();
function renderGrid() {
  const grid = $('#video-grid');
  const q = state.search.toLowerCase();
  const list = state.videos.filter((v) => !q || v.title.toLowerCase().includes(q) || v.file_name.toLowerCase().includes(q));

  if (!list.length) {
    cardCache.clear();
    grid.innerHTML = state.filter === 'draft'
      ? `<div class="empty"><div class="big">📂</div><h3>Arrastrá tus videos a la carpeta</h3><p>Copiá o mové archivos de video a<br><code>${esc(state.info?.watchDir || '')}</code><br>y aparecerán acá automáticamente.</p></div>`
      : `<div class="empty"><div class="big">🗂</div><p>No hay videos en "${STATUS[state.filter]}".</p></div>`;
  } else {
    // Reutiliza las tarjetas que no cambiaron para no recargar los previews de video
    const nodes = list.map((v) => {
      const html = cardHtml(v);
      let entry = cardCache.get(v.id);
      if (!entry || entry.html !== html) {
        const el = document.createElement('div');
        el.className = 'card';
        el.dataset.id = v.id;
        el.innerHTML = html;
        entry = { html, el };
        cardCache.set(v.id, entry);
      }
      entry.el.classList.toggle('selected', state.selected.has(v.id));
      return entry.el;
    });
    const keep = new Set(list.map((v) => v.id));
    for (const id of cardCache.keys()) if (!keep.has(id)) cardCache.delete(id);
    grid.replaceChildren(...nodes);
  }
  const selectable = list.filter((v) => !LOCKED.has(v.status));
  $('#select-all').checked = selectable.length > 0 && selectable.every((v) => state.selected.has(v.id));
  renderBulkbar();
}

function renderBulkbar() {
  const n = state.selected.size;
  $('#bulkbar').classList.toggle('hidden', n === 0);
  if (!n) return;
  const sel = state.videos.filter((v) => state.selected.has(v.id));
  const has = (...st) => sel.some((v) => st.includes(v.status));
  $('#bulk-count').textContent = `${n} seleccionado${n > 1 ? 's' : ''}`;
  $('#bulk-actions').innerHTML = [
    `<button class="btn sm" data-bulk="edit">✏️ Editar en lote</button>`,
    `<button class="btn sm" data-bulk="translate">🌐 Traducir al inglés</button>`,
    `<button class="btn sm" data-bulk="schedule">📅 Programar</button>`,
    has('draft', 'error') ? `<button class="btn sm primary" data-bulk="queue">🚀 Poner en cola</button>` : '',
    has('queued', 'error', 'ignored') ? `<button class="btn sm" data-bulk="unqueue">↩ Volver a borrador</button>` : '',
    has('draft', 'queued', 'error') ? `<button class="btn sm danger" data-bulk="ignore">Descartar</button>` : '',
    `<button class="btn sm ghost" data-bulk="clear-sel">✕</button>`,
  ].join('');
}

async function refreshVideos() {
  await Promise.all([loadVideos(), loadInfo()]);
  if (state.view === 'videos') renderVideosView();
  if (state.view === 'inicio') renderHome();
}

// ================= Componente: etiquetas =================
function tagsInput(container, initial = []) {
  let tags = [...initial];
  const render = () => {
    container.innerHTML = tags.map((t, i) => `<span class="chip">${esc(t)}<button type="button" data-i="${i}">×</button></span>`).join('') +
      `<input placeholder="${tags.length ? '' : 'Escribí y presioná Enter (o pegá separado por comas)'}" />`;
    const input = $('input', container);
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); add(input.value); }
      else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); render(); focus(); }
    });
    input.addEventListener('blur', () => input.value.trim() && add(input.value, false));
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData.getData('text');
      if (text.includes(',')) { e.preventDefault(); add(text); }
    });
    container.dispatchEvent(new Event('tagschange'));
  };
  const focus = () => $('input', container).focus();
  const add = (text, refocus = true) => {
    for (const t of text.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean)) if (!tags.includes(t)) tags.push(t);
    render();
    if (refocus) focus();
  };
  container.addEventListener('click', (e) => {
    if (e.target.dataset.i !== undefined) { tags.splice(Number(e.target.dataset.i), 1); render(); }
    else focus();
  });
  render();
  return {
    get: () => { const pending = $('input', container).value.trim(); if (pending) add(pending, false); return tags; },
    set: (list) => { tags = [...new Set(list.map((t) => t.trim()).filter(Boolean))]; render(); },
  };
}

// ================= Calendario de programación =================
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseSlots = (s) => [...new Set(String(s || '').split(/[,;\s]+/).filter((t) => /^\d{1,2}:\d{2}$/.test(t))
  .map((t) => t.split(':').map(Number)).filter(([h, m]) => h < 24 && m < 60).map(([h, m]) => `${pad(h)}:${pad(m)}`))].sort();

// value: 'YYYY-MM-DDTHH:MM' (hora local) o ''. events: [{id, title, publish_at, status, account_id}]
function scheduleCalendar(root, { value, events, accountId, slots, disabled, onChange }) {
  let sel = value ? value.slice(0, 10) : '';
  let time = value ? value.slice(11, 16) : '';
  let acc = accountId || null;
  let showAll = !acc;
  const view = sel ? new Date(`${sel}T00:00`) : new Date();
  view.setDate(1);
  const accs = accountsMap();

  const visible = () => events.filter((e) => showAll || e.account_id === acc);
  const eventsOn = (key) => visible().filter((e) => dayKey(new Date(e.publish_at)) === key)
    .sort((a, b) => new Date(a.publish_at) - new Date(b.publish_at));
  const emit = () => onChange(sel && time ? `${sel}T${time}` : '');

  function render() {
    const todayKey = dayKey(new Date());
    const offset = (view.getDay() + 6) % 7;
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const counts = new Map();
    for (const e of visible()) { const k = dayKey(new Date(e.publish_at)); counts.set(k, (counts.get(k) || 0) + 1); }

    let cells = WEEKDAYS.map((w) => `<div class="cal-wd">${w}</div>`).join('') + '<div></div>'.repeat(offset);
    for (let d = 1; d <= days; d++) {
      const key = `${view.getFullYear()}-${pad(view.getMonth() + 1)}-${pad(d)}`;
      const n = counts.get(key) || 0;
      const tip = eventsOn(key).map((e) => `${hhmm(new Date(e.publish_at))} · ${e.title}`).join('\n');
      cells += `<button type="button" class="cal-day ${n ? `lvl-${Math.min(n, 3)}` : ''} ${key === sel ? 'sel' : ''} ${key === todayKey ? 'today' : ''}"
        data-day="${key}" ${disabled || key < todayKey ? 'disabled' : ''} title="${esc(tip || 'Sin videos programados')}">
        <span class="d">${d}</span>${n ? `<span class="cal-n">${n}</span>` : ''}</button>`;
    }

    // Horarios: los predefinidos + el que ya tenga el video (si no está en la lista)
    let foot = '';
    if (sel) {
      const dayEvents = eventsOn(sel);
      const now = new Date();
      const options = [...new Set([...slots, ...(time ? [time] : [])])].sort().map((t) => {
        const taken = dayEvents.filter((e) => hhmm(new Date(e.publish_at)) === t);
        const past = new Date(`${sel}T${t}`) <= now;
        const label = past ? `${t} · ya pasó` : taken.length ? `${t} · ocupado: ${taken.map((e) => e.title).join(', ')}` : `${t} · libre`;
        return `<option value="${t}" ${t === time ? 'selected' : ''} ${past ? 'disabled' : ''}>${esc(label.length > 70 ? label.slice(0, 68) + '…' : label)}</option>`;
      }).join('');
      foot = `
        <div class="cal-foot">
          <label class="cal-time-label">Hora</label>
          <select class="input cal-time" ${disabled ? 'disabled' : ''}>${options || '<option value="">Configurá horarios en Ajustes</option>'}</select>
          ${disabled ? '' : '<button type="button" class="btn sm ghost" data-cal-clear>Quitar fecha</button>'}
        </div>
        ${dayEvents.length ? `<div class="cal-daylist">${dayEvents.map((e) => `<div><b>${hhmm(new Date(e.publish_at))}</b> ${esc(e.title)}
          <span class="muted">· ${esc(accs[e.account_id] || 'sin canal')} · ${STATUS_ONE[e.status] || e.status}</span></div>`).join('')}</div>` : ''}`;
    }

    root.innerHTML = `
      <div class="cal">
        <div class="cal-head">
          <button type="button" class="btn sm ghost" data-cal-nav="-1">‹</button>
          <div class="m">${MONTHS[view.getMonth()]} ${view.getFullYear()}</div>
          <button type="button" class="btn sm ghost" data-cal-nav="1">›</button>
          ${acc ? `<label class="check small cal-all"><input type="checkbox" data-cal-all ${showAll ? 'checked' : ''}/> Todos los canales</label>` : ''}
        </div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend">
          <span><i style="background:var(--blue)"></i>1 video</span><span><i style="background:var(--yellow)"></i>2</span><span><i style="background:var(--red)"></i>3 o más</span>
          <span>· ${showAll ? 'todos los canales' : `solo ${esc(accs[acc] || 'este canal')}`}</span>
        </div>
        ${sel ? '' : `<div class="hint" style="margin-top:8px">${disabled ? 'Sin fecha.' : 'Elegí un día. Sin fecha, el video se publica apenas termine de subir.'}</div>`}
        ${foot}
      </div>`;
  }

  root.addEventListener('click', (e) => {
    const day = e.target.closest('[data-day]');
    if (day && !day.disabled) {
      sel = day.dataset.day;
      // Si no hay hora elegida (o ya pasó), toma el primer horario libre de ese día
      const now = new Date();
      const busy = new Set(eventsOn(sel).map((x) => hhmm(new Date(x.publish_at))));
      const valid = (t) => new Date(`${sel}T${t}`) > now;
      if (!time || !valid(time)) time = slots.find((t) => valid(t) && !busy.has(t)) || slots.find(valid) || '';
      render(); emit(); return;
    }
    const nav = e.target.closest('[data-cal-nav]');
    if (nav) { view.setMonth(view.getMonth() + Number(nav.dataset.calNav)); render(); return; }
    if (e.target.closest('[data-cal-clear]')) { sel = ''; time = ''; render(); emit(); }
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('.cal-time')) { time = e.target.value; render(); emit(); }
    if (e.target.matches('[data-cal-all]')) { showAll = e.target.checked; render(); }
  });
  render();
  return { setAccount(id) { acc = id || null; showAll = !acc; render(); } };
}

// ================= Editor de un video =================
async function getPlaylists(accountId) {
  if (!accountId) return [];
  if (!state.playlists[accountId]) {
    try { state.playlists[accountId] = await api('GET', `/api/accounts/${accountId}/playlists`); }
    catch { state.playlists[accountId] = []; }
  }
  return state.playlists[accountId];
}

function closeDrawer() {
  const video = $('#drawer video');
  if (video) video.pause();
  $('#drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
}

async function openEditor(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  const locked = LOCKED.has(v.status);
  const dis = locked ? 'disabled' : '';
  const accOpts = Object.fromEntries(state.accounts.map((a) => [a.id, a.channel_title]));
  const drawer = $('#drawer');
  drawer.innerHTML = `
    <div class="drawer-head">
      <h2>${esc(v.file_name)}</h2>
      <button class="x" data-close>×</button>
    </div>
    <div class="drawer-body">
      ${v.file_deleted ? '' : `<video src="/api/videos/${v.id}/stream" controls preload="metadata"></video>`}
      ${locked ? `<div class="banner"><span>Este video ya fue subido (${STATUS_ONE[v.status]}). Para cambios usá YouTube Studio.</span>${v.youtube_id ? `<a class="btn sm" target="_blank" href="https://studio.youtube.com/video/${esc(v.youtube_id)}/edit">Abrir Studio ↗</a>` : ''}</div>` : ''}
      ${v.error ? `<div class="card-error" style="margin-bottom:14px">${esc(v.error)}</div>` : ''}
      ${locked ? '' : `<div class="md-loader">
        <div class="md-top">
          <button type="button" class="btn sm" id="btn-md-toggle">📄 Cargar desde .md</button>
          <select class="input sm-select" id="md-guion"><option value="">📚 Elegir guion de la biblioteca…</option></select>
        </div>
        <div class="md-panel hidden" id="md-panel">
          <textarea class="input mono" id="md-text" rows="9" placeholder="Pegá acá el texto con el formato (# Título, # Descripción, # Etiquetas, # Hashtags…)"></textarea>
          <div class="md-actions">
            <button type="button" class="btn sm" id="btn-md-template">📋 Copiar plantilla</button>
            <label class="btn sm">📂 Abrir archivo .md<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" id="md-file" hidden/></label>
            <label class="check small"><input type="checkbox" id="md-append-hashtags" checked/> Agregar los hashtags al final de la descripción</label>
            <button type="button" class="btn sm primary" id="btn-md-apply">Aplicar</button>
          </div>
        </div>
      </div>`}
      <div class="field">
        <label>Título <span class="counter" id="c-title"></span></label>
        <input class="input" id="f-title" maxlength="100" value="${esc(v.title)}" ${dis}/>
      </div>
      <div class="field">
        <label>Descripción <span class="counter" id="c-desc"></span></label>
        <textarea class="input" id="f-desc" rows="7" ${dis}>${esc(v.description)}</textarea>
      </div>
      <div class="field">
        <label>Etiquetas <span class="counter" id="c-tags"></span></label>
        <div class="tags-input" id="f-tags"></div>
      </div>
      <div class="translate-box">
        <div class="row">
          <div class="field"><label>Idioma del video (audio)</label><select class="input" id="f-lang" ${dis}>${options(LANGUAGES, v.default_language || 'es-419')}</select></div>
          <div class="field" style="justify-content:flex-end">${locked ? '' : '<button type="button" class="btn" id="btn-translate">✨ Traducir al inglés con IA</button>'}</div>
        </div>
        <div class="field">
          <label>🇺🇸 Título en inglés <span class="counter" id="c-title-en"></span></label>
          <input class="input" id="f-title-en" maxlength="100" value="${esc(v.localizations?.en?.title || '')}" placeholder="Opcional: lo ven quienes usan YouTube en inglés" ${dis}/>
        </div>
        <div class="field">
          <label>🇺🇸 Descripción en inglés</label>
          <textarea class="input" id="f-desc-en" rows="4" ${dis}>${esc(v.localizations?.en?.description || '')}</textarea>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>Canal</label><select class="input" id="f-account" ${dis}>${options(accOpts, v.account_id, '— Elegir canal —')}</select></div>
        <div class="field"><label>Playlist</label><div class="pl-row"><select class="input" id="f-playlist" ${dis}><option value="">Ninguna</option></select>${locked ? '' : '<button type="button" class="btn sm" id="btn-new-pl" title="Crear una playlist nueva en este canal">＋ Nueva</button>'}</div></div>
      </div>
      <div class="row">
        <div class="field"><label>Visibilidad</label><select class="input" id="f-privacy" ${dis}>${options(PRIVACY, v.privacy)}</select></div>
        <div class="field"><label>Categoría</label><select class="input" id="f-category" ${dis}>${options(CATEGORIES, v.category_id)}</select></div>
      </div>
      <div class="field">
        <label>Fecha de publicación</label>
        <input type="hidden" id="f-date" value="${toLocalInput(v.publish_at)}"/>
        <div id="f-cal"><div class="hint">Cargando calendario…</div></div>
        <span class="hint" id="date-hint"></span>
      </div>
      <div class="toggles">
        <label class="check"><input type="checkbox" id="f-kids" ${v.made_for_kids ? 'checked' : ''} ${dis}/> Contenido creado para niños</label>
        <label class="check"><input type="checkbox" id="f-notify" ${v.notify_subscribers ? 'checked' : ''} ${dis}/> Notificar a los suscriptores</label>
        <label class="check"><input type="checkbox" id="f-synthetic" ${v.synthetic_media ? 'checked' : ''} ${dis}/> Contiene contenido alterado o sintético (IA realista)</label>
      </div>
      <div class="field">
        <label>Miniatura personalizada</label>
        <div class="thumb-picker">
          ${v.thumbnail_path ? `<img src="/api/videos/${v.id}/thumbnail?${Date.now()}" />` : '<span class="muted small">Sin miniatura (YouTube genera una automática)</span>'}
          ${locked ? '' : `<label class="btn sm">Subir JPG/PNG<input type="file" accept="image/jpeg,image/png" id="f-thumb" hidden/></label>
          ${v.thumbnail_path ? '<button class="btn sm danger" id="rm-thumb">Quitar</button>' : ''}`}
        </div>
        <span class="hint">Máx. 2 MB, ideal 1280×720. Requiere canal verificado.</span>
      </div>
    </div>
    ${locked ? '' : `<div class="drawer-foot">
      <button class="btn" data-close>Cancelar</button>
      <button class="btn" id="btn-save">Guardar</button>
      <button class="btn primary" id="btn-save-queue">Guardar y poner en cola 🚀</button>
    </div>`}`;
  drawer.classList.remove('hidden');
  $('#drawer-backdrop').classList.remove('hidden');

  const tags = tagsInput($('#f-tags'), v.tags);
  if (locked) $$('#f-tags input').forEach((i) => (i.disabled = true));

  const counters = () => {
    const te = $('#f-title-en').value.length;
    $('#c-title-en').textContent = te ? `${te}/100` : ''; $('#c-title-en').classList.toggle('over', te > 100);
    const t = $('#f-title').value.length, d = $('#f-desc').value.length, g = tags.get().join(',').length;
    $('#c-title').textContent = `${t}/100`; $('#c-title').classList.toggle('over', t > 100);
    $('#c-desc').textContent = `${d}/5000`; $('#c-desc').classList.toggle('over', d > 5000);
    $('#c-tags').textContent = `${g}/500`; $('#c-tags').classList.toggle('over', g > 500);
    const date = $('#f-date').value ? new Date($('#f-date').value) : null;
    $('#date-hint').textContent = date
      ? `📅 Se publica el ${date.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })} a las ${hhmm(date)}. Se sube como privado y YouTube lo hace público a esa hora.`
      : '';
  };
  ['#f-title', '#f-desc', '#f-date', '#f-title-en'].forEach((s) => $(s).addEventListener('input', counters));
  $('#f-tags').addEventListener('tagschange', counters);
  counters();

  // Calendario: muestra cuántos videos hay cada día y deja elegir la hora entre los horarios predefinidos
  let cal = null;
  api('GET', '/api/calendar').then((events) => {
    cal = scheduleCalendar($('#f-cal'), {
      value: $('#f-date').value,
      events: events.filter((e) => e.id !== v.id),
      accountId: Number($('#f-account').value) || null,
      slots: parseSlots(state.info?.timeSlots),
      disabled: locked,
      onChange: (val) => { $('#f-date').value = val; counters(); },
    });
  }).catch(() => { $('#f-cal').innerHTML = '<div class="hint">No se pudo cargar el calendario.</div>'; });
  $('#f-account').addEventListener('change', () => cal?.setAccount(Number($('#f-account').value) || null));

  const fillPlaylists = async () => {
    const accId = $('#f-account').value;
    const list = await getPlaylists(accId);
    $('#f-playlist').innerHTML = `<option value="">Ninguna</option>` +
      list.map((p) => `<option value="${esc(p.id)}" ${p.id === v.playlist_id ? 'selected' : ''}>${esc(p.title)}</option>`).join('');
  };
  $('#f-account').addEventListener('change', fillPlaylists);
  fillPlaylists();
  $('#btn-new-pl')?.addEventListener('click', () => {
    const accId = Number($('#f-account').value);
    if (!accId) return toast('Primero elegí el canal del video.', 'warning');
    newPlaylistModal(accId, async (pl) => { v.playlist_id = pl.id; await fillPlaylists(); });
  });

  const collect = () => ({
    title: $('#f-title').value.trim(),
    description: $('#f-desc').value,
    tags: tags.get(),
    account_id: $('#f-account').value ? Number($('#f-account').value) : null,
    playlist_id: $('#f-playlist').value || null,
    privacy: $('#f-privacy').value,
    category_id: $('#f-category').value,
    publish_at: $('#f-date').value ? new Date($('#f-date').value).toISOString() : null,
    made_for_kids: $('#f-kids').checked,
    notify_subscribers: $('#f-notify').checked,
    synthetic_media: $('#f-synthetic').checked,
    default_language: $('#f-lang').value,
    guion_file: chosenGuion ?? v.guion_file ?? null,
    localizations: (() => {
      const loc = { ...(v.localizations || {}) };
      const title = $('#f-title-en').value.trim();
      if (title) loc.en = { title, description: $('#f-desc-en').value };
      else delete loc.en;
      return loc;
    })(),
  });

  const save = async (queue) => {
    const data = collect();
    if (data.publish_at && new Date(data.publish_at) < new Date()) return toast('La fecha de publicación ya pasó.', 'error');
    try {
      await api('PATCH', `/api/videos/${v.id}`, data);
      if (queue) {
        const r = await api('POST', '/api/videos/queue', { ids: [v.id] });
        if (r.errors.length) return toast(`No se puede poner en cola: ${r.errors[0].errors.join(', ')}`, 'error');
        toast('Video en cola de publicación 🚀', 'success');
      } else toast('Cambios guardados', 'success');
      closeDrawer();
      refreshVideos();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#btn-translate')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Traduciendo…';
    try {
      await api('PATCH', `/api/videos/${v.id}`, collect()); // traduce lo que está escrito ahora
      const { en } = await api('POST', `/api/videos/${v.id}/translate`);
      $('#f-title-en').value = en.title;
      $('#f-desc-en').value = en.description;
      counters();
      toast('Traducción lista. Revisala y guardá.', 'success');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
    btn.textContent = '✨ Traducir al inglés con IA';
  });
  $('#btn-md-toggle')?.addEventListener('click', () => { $('#md-panel').classList.toggle('hidden'); $('#md-text').focus(); });
  let chosenGuion; // undefined = sin cambios; string = guion elegido en esta edición
  if ($('#md-guion')) {
    api('GET', '/api/guiones').then(({ guiones }) => {
      const label = (g) => {
        const name = g.category ? `[${g.category}] ${g.title}` : g.title;
        if (g.file === v.guion_file) return `✔ ${name} (vinculado a este video)`;
        if (g.linked) return `${name} · ya sugerido para ${g.linked.file_name}`;
        return name;
      };
      const group = (status, title) => {
        const list = guiones.filter((g) => g.status === status)
          .sort((a, b) => (a.category || '~').localeCompare(b.category || '~') || a.file.localeCompare(b.file));
        return list.length ? `<optgroup label="${title} (${list.length})">${list.map((g) =>
          `<option value="${esc(g.file)}" ${g.file === v.guion_file ? 'selected' : ''}>${esc(label(g))}</option>`).join('')}</optgroup>` : '';
      };
      $('#md-guion').insertAdjacentHTML('beforeend', group('producing', '🎬 En producción') + group('pending', '📝 Pendientes'));
    }).catch(() => {});
    $('#md-guion').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      const { text } = await api('GET', `/api/guiones/${encodeURIComponent(e.target.value)}`);
      chosenGuion = e.target.value;
      const loaded = applyMetadata(parseMetadataMd(text));
      toast(`Guion cargado (${loaded.join(', ')}). Revisá y tocá Guardar.`, 'success');
    });
  }
  $('#btn-md-template')?.addEventListener('click', () => {
    navigator.clipboard.writeText(MD_TEMPLATE);
    if (!$('#md-text').value.trim()) $('#md-text').value = MD_TEMPLATE;
    toast('Plantilla copiada');
  });
  $('#md-file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) $('#md-text').value = await f.text();
    e.target.value = '';
  });
  const applyMetadata = (m) => {
    const loaded = [];
    const withHashtags = (desc) => (m.hashtags?.length && $('#md-append-hashtags').checked ? appendHashtags(desc, m.hashtags) : desc);
    if (m.title) { $('#f-title').value = m.title; loaded.push('título'); }
    if (m.description || m.hashtags) { $('#f-desc').value = withHashtags(m.description ?? $('#f-desc').value); loaded.push('descripción'); }
    if (m.tags) { tags.set(m.tags); loaded.push(`${m.tags.length} etiquetas`); }
    if (m.language) { $('#f-lang').value = m.language; loaded.push(`idioma ${m.language}`); }
    // Si el "inglés" es igual al original (todo ya está en inglés) no hace falta traducción
    if (m.title_en && m.title_en !== m.title) { $('#f-title-en').value = m.title_en; loaded.push('título en inglés'); }
    if (m.description_en && m.description_en !== m.description) { $('#f-desc-en').value = withHashtags(m.description_en); loaded.push('descripción en inglés'); }
    counters();
    return loaded;
  };
  $('#btn-md-apply')?.addEventListener('click', () => {
    const loaded = applyMetadata(parseMetadataMd($('#md-text').value));
    if (!loaded.length) return toast('No encontré secciones válidas. Usá encabezados como "# Título", "# Descripción", "# Etiquetas".', 'error');
    $('#md-panel').classList.add('hidden');
    toast(`Cargado: ${loaded.join(', ')}. Revisá y tocá Guardar.`, 'success');
  });
  $('#btn-save')?.addEventListener('click', () => save(false));
  $('#btn-save-queue')?.addEventListener('click', () => save(true));

  $('#f-thumb')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('thumbnail', file);
    try {
      await api('PATCH', `/api/videos/${v.id}`, collect()); // no perder lo editado
      await api('POST', `/api/videos/${v.id}/thumbnail`, fd);
      await loadVideos();
      openEditor(v.id);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#rm-thumb')?.addEventListener('click', async () => {
    await api('PATCH', `/api/videos/${v.id}`, collect());
    await api('DELETE', `/api/videos/${v.id}/thumbnail`);
    await loadVideos();
    openEditor(v.id);
  });
}

// ================= Modales =================
function openModal(title, body, footer) {
  $('#modal').innerHTML = `
    <div class="modal-head"><h2>${title}</h2><button class="x" data-close-modal>×</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${footer}</div>`;
  $('#modal').classList.remove('wide');
  $('#modal-backdrop').classList.remove('hidden');
}
const closeModal = () => $('#modal-backdrop').classList.add('hidden');
const selectedIds = () => state.videos.filter((v) => state.selected.has(v.id)).map((v) => v.id);

function bulkEditModal() {
  const accOpts = Object.fromEntries(state.accounts.map((a) => [a.id, a.channel_title]));
  const keep = '— No cambiar —';
  openModal(`Editar ${state.selected.size} videos`, `
    <div class="row">
      <div class="field"><label>Canal</label><select class="input" id="b-account">${options(accOpts, '', keep)}</select></div>
      <div class="field"><label>Visibilidad</label><select class="input" id="b-privacy">${options(PRIVACY, '', keep)}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Categoría</label><select class="input" id="b-category">${options(CATEGORIES, '', keep)}</select></div>
      <div class="field"><label>Para niños</label><select class="input" id="b-kids">${options({ 1: 'Sí', 0: 'No' }, '', keep)}</select></div>
    </div>
    <div class="field">
      <label>Etiquetas</label>
      <div class="tags-input" id="b-tags"></div>
      <label class="check small"><input type="checkbox" id="b-tags-replace"/> Reemplazar las existentes (si no, se agregan)</label>
    </div>
    <div class="field">
      <label>Descripción</label>
      <textarea class="input" id="b-desc" rows="4" placeholder="Dejar vacío para no cambiar"></textarea>
      <select class="input" id="b-desc-mode"><option value="append">Agregar al final de la descripción actual</option><option value="replace">Reemplazar la descripción</option></select>
    </div>
    <label class="check"><input type="checkbox" id="b-clear-date"/> Quitar fecha programada (publicar al subir)</label>`,
    `<button class="btn" data-close-modal>Cancelar</button><button class="btn primary" id="b-apply">Aplicar</button>`);
  const tags = tagsInput($('#b-tags'));
  $('#b-apply').onclick = async () => {
    const patch = {};
    if ($('#b-account').value) patch.account_id = Number($('#b-account').value);
    if ($('#b-privacy').value) patch.privacy = $('#b-privacy').value;
    if ($('#b-category').value) patch.category_id = $('#b-category').value;
    if ($('#b-kids').value) patch.made_for_kids = $('#b-kids').value === '1';
    const t = tags.get();
    if (t.length) $('#b-tags-replace').checked ? (patch.tags = t) : (patch.add_tags = t);
    const d = $('#b-desc').value.trim();
    if (d) $('#b-desc-mode').value === 'replace' ? (patch.description = d) : (patch.append_description = d);
    if ($('#b-clear-date').checked) patch.publish_at = null;
    if (patch.account_id) patch.playlist_id = null;
    const r = await api('POST', '/api/videos/bulk-update', { updates: selectedIds().map((id) => ({ id, ...patch })) });
    toast(`${r.updated} videos actualizados`, 'success');
    closeModal();
    refreshVideos();
  };
}

function computeSlots(count, startDate, times, everyDays) {
  const parsed = times.split(/[,\s]+/).map((t) => t.trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => t.split(':').map(Number)).sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
  if (!parsed.length || !startDate) return [];
  const [y, m, d] = startDate.split('-').map(Number);
  const slots = [];
  const now = Date.now() + 5 * 60 * 1000;
  for (let day = 0; slots.length < count && day < 3650; day += Math.max(1, everyDays)) {
    for (const [h, min] of parsed) {
      const dt = new Date(y, m - 1, d + day, h, min);
      if (dt.getTime() > now && slots.length < count) slots.push(dt);
    }
  }
  return slots;
}

function scheduleModal() {
  const tomorrow = new Date(Date.now() + 86400000);
  const def = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  const sel = state.videos.filter((v) => state.selected.has(v.id) && !LOCKED.has(v.status));
  openModal(`Programar ${sel.length} videos`, `
    <div class="row3">
      <div class="field"><label>Desde el día</label><input type="date" class="input" id="s-start" value="${def}"/></div>
      <div class="field"><label>Cada cuántos días</label><input type="number" class="input" id="s-every" value="1" min="1"/></div>
      <div class="field"><label>Orden</label><select class="input" id="s-order"><option value="view">Como se ven</option><option value="name">Por nombre de archivo</option></select></div>
    </div>
    <div class="field">
      <label>Horarios de publicación por día</label>
      <input class="input" id="s-times" value="${esc(parseSlots(state.info?.timeSlots).join(', ') || '12:00, 18:00')}"/>
      <span class="hint">Separados por coma, formato 24 h. Ej: 09:00, 13:30, 20:00</span>
    </div>
    <div class="field"><label>Vista previa</label><div class="preview-list" id="s-preview"></div></div>
    <label class="check"><input type="checkbox" id="s-queue" checked/> Poner en cola de publicación al aplicar</label>`,
    `<button class="btn" data-close-modal>Cancelar</button><button class="btn primary" id="s-apply">Programar</button>`);

  const ordered = () => ($('#s-order').value === 'name' ? [...sel].sort((a, b) => a.file_name.localeCompare(b.file_name, 'es', { numeric: true })) : sel);
  const compute = () => {
    const list = ordered();
    const slots = computeSlots(list.length, $('#s-start').value, $('#s-times').value, Number($('#s-every').value));
    $('#s-preview').innerHTML = slots.length
      ? list.map((v, i) => `<div><span>${esc(v.title || v.file_name)}</span><span class="muted">${slots[i] ? fmtDate(slots[i].toISOString()) : '—'}</span></div>`).join('')
      : '<div><span class="muted">Revisá la fecha y los horarios.</span></div>';
    return { list, slots };
  };
  ['#s-start', '#s-every', '#s-times', '#s-order'].forEach((s) => $(s).addEventListener('input', compute));
  compute();

  $('#s-apply').onclick = async () => {
    const { list, slots } = compute();
    if (slots.length < list.length) return toast('Horarios inválidos.', 'error');
    await api('POST', '/api/videos/bulk-update', { updates: list.map((v, i) => ({ id: v.id, publish_at: slots[i].toISOString() })) });
    let msg = `${list.length} videos programados`;
    if ($('#s-queue').checked) {
      const r = await api('POST', '/api/videos/queue', { ids: list.map((v) => v.id) });
      msg += ` · ${r.queued} en cola`;
      if (r.errors.length) toast(`${r.errors.length} no se pudieron encolar: ${r.errors.map((e) => `"${e.title}" (${e.errors.join(', ')})`).join('; ')}`, 'error');
    }
    toast(msg, 'success');
    closeModal();
    refreshVideos();
  };
}

async function bulkAction(action) {
  const ids = selectedIds();
  if (action === 'clear-sel') { state.selected.clear(); return renderGrid(); }
  if (action === 'edit') return bulkEditModal();
  if (action === 'translate') {
    toast(`Traduciendo ${ids.length} videos…`);
    const r = await api('POST', '/api/videos/translate', { ids });
    if (r.translated) toast(`${r.translated} videos traducidos al inglés 🌐`, 'success');
    if (r.errors.length) toast(`No se pudieron traducir ${r.errors.length}: ${r.errors[0].error}`, 'error');
    return refreshVideos();
  }
  if (action === 'schedule') return scheduleModal();
  if (action === 'queue') {
    const r = await api('POST', '/api/videos/queue', { ids });
    if (r.queued) toast(`${r.queued} videos en cola 🚀`, 'success');
    if (r.errors.length) toast(`${r.errors.length} no se pudieron encolar: ${r.errors.map((e) => `"${e.title}" (${e.errors.join(', ')})`).join('; ')}`, 'error');
  }
  if (action === 'unqueue') await api('POST', '/api/videos/unqueue', { ids });
  if (action === 'ignore') {
    if (!confirm(`¿Descartar ${ids.length} videos? (los archivos no se borran)`)) return;
    await api('POST', '/api/videos/ignore', { ids });
  }
  state.selected.clear();
  refreshVideos();
}

// ================= Vista: Guiones =================
const GUION_STATUS = { pending: 'Pendientes', producing: 'En producción', used: 'Usados' };
const GUION_ONE = { pending: 'Pendiente', producing: 'En producción', used: 'Usado' };
state.guionFilter = 'pending';
state.gSel = new Set(); // guiones seleccionados para mover en lote
state.guionCat = (() => { try { return localStorage.getItem('guionCat') || 'all'; } catch { return 'all'; } })();
const NO_CAT = '__none__';
const setGuionCat = (c) => { state.guionCat = c; try { localStorage.setItem('guionCat', c); } catch {} };
const inCat = (g) => state.guionCat === 'all' || (state.guionCat === NO_CAT ? !g.category : g.category === state.guionCat);

async function renderGuiones() {
  const { guiones, categories, generating, dir } = await api('GET', '/api/guiones');
  state.guiones = guiones;
  state.guionCategories = categories;
  if (state.guionCat !== 'all' && state.guionCat !== NO_CAT && !categories.includes(state.guionCat)) setGuionCat('all');
  const sinCat = guiones.filter((g) => !g.category).length;
  const chip = (value, text, n) => `<button class="tab ${state.guionCat === value ? 'active' : ''}" data-gcat="${esc(value)}">${text}<span class="n">${n}</span></button>`;
  $('#guion-cats').innerHTML = `<span class="cat-label">Categoría:</span>`
    + chip('all', 'Todas', guiones.length)
    + categories.map((c) => chip(c, `📁 ${esc(c)}`, guiones.filter((g) => g.category === c).length)).join('')
    + (sinCat && categories.length ? chip(NO_CAT, 'Sin categoría', sinCat) : '')
    + `<button class="btn sm ghost" id="btn-new-cat">＋ Categoría</button>`
    + (state.guionCat !== 'all' && state.guionCat !== NO_CAT ? `<button class="btn sm ghost danger" id="btn-del-cat" title="Los guiones quedan sin categoría">🗑 Eliminar "${esc(state.guionCat)}"</button>` : '');
  $('#guiones-sub').innerHTML = `Prompts para Gemini con su título, descripción, etiquetas y hashtags. Carpeta: <code>${esc(dir)}</code>`;
  $('#guiones-progress').innerHTML = generating
    ? `<div class="banner"><span>⏳ Generando ${generating.cantidad} guiones${generating.category ? ` para "${esc(generating.category)}"` : ''} con Gemini… ${esc(generating.progress)}</span></div>` : '';
  $('#btn-gen-guiones').disabled = !!generating;
  const counts = Object.fromEntries(Object.keys(GUION_STATUS).map((k) => [k, guiones.filter((g) => g.status === k && inCat(g)).length]));
  $('#guion-tabs').innerHTML = Object.entries(GUION_STATUS).map(([k, label]) =>
    `<button class="tab ${state.guionFilter === k ? 'active' : ''}" data-gtab="${k}">${label}<span class="n">${counts[k]}</span></button>`).join('');
  const list = guiones.filter((g) => g.status === state.guionFilter && inCat(g));
  for (const f of state.gSel) if (!list.some((g) => g.file === f)) state.gSel.delete(f);
  const others = Object.entries(GUION_STATUS).filter(([k]) => k !== state.guionFilter);
  const nSel = state.gSel.size;
  const moveBar = list.length ? `
    <div class="g-movebar">
      <label class="check"><input type="checkbox" id="g-selall" ${nSel && nSel === list.length ? 'checked' : ''}/> ${nSel ? `${nSel} seleccionado${nSel > 1 ? 's' : ''}` : 'Seleccionar todos'}</label>
      <div class="g-move-actions">${others.map(([k, label]) =>
        `<button class="btn sm ${k === 'used' ? 'primary' : ''}" data-gmove="${k}" ${nSel ? '' : 'disabled'}>Mover a ${label}</button>`).join('')}</div>
    </div>` : '';
  const catOptions = (g) => `<option value="">Sin categoría</option>` + categories.map((c) => `<option ${g.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const video = (id) => state.videos.find((x) => x.id === id);
  $('#guiones-list').innerHTML = moveBar + (list.length ? list.map((g) => `
    <div class="guion ${state.gSel.has(g.file) ? 'sel' : ''}">
      <input type="checkbox" class="g-check" data-gsel="${esc(g.file)}" ${state.gSel.has(g.file) ? 'checked' : ''} title="Seleccionar"/>
      <div class="g-main">
        <div class="g-title">${esc(g.title)}</div>
        <div class="muted small">${g.idea ? esc(g.idea) + ' · ' : ''}${esc(g.file)}</div>
        ${g.status === 'used' && g.video_id ? `<div class="small muted">🎞 Video #${g.video_id}${video(g.video_id) ? ` · ${esc(video(g.video_id).file_name)}` : ''}</div>` : ''}
        ${g.status !== 'used' && g.linked ? `<div class="small linked">🔗 Sugerido para ${esc(g.linked.file_name)} · pasa a "Usado" cuando ese video se suba</div>` : ''}
      </div>
      ${categories.length ? `<select class="input cat-select" data-gsetcat="${esc(g.file)}" title="Categoría">${catOptions(g)}</select>` : ''}
      <span class="badge ${g.status === 'producing' ? 'uploading' : g.status === 'used' ? 'published' : 'draft'}">${GUION_ONE[g.status]}</span>
      <div class="g-actions">
        ${g.status !== 'used' && g.prompt ? `<button class="btn sm primary" data-gcopy="${esc(g.file)}">📋 Copiar prompt</button>` : ''}
        <button class="btn sm" data-gview="${esc(g.file)}">👁 Ver</button>
        ${g.status === 'producing' ? `<button class="btn sm" data-gstatus="pending" data-gfile="${esc(g.file)}">↩ Pendiente</button>` : ''}
        ${g.status !== 'used' ? `<button class="btn sm" data-gstatus="used" data-gfile="${esc(g.file)}" title="Marcar como usado">✓ Usado</button>` : ''}
        ${g.status === 'used' ? `<button class="btn sm" data-gstatus="pending" data-gfile="${esc(g.file)}">↩ Reusar</button>` : ''}
        <button class="btn sm danger" data-gdel="${esc(g.file)}">Descartar</button>
      </div>
    </div>`).join('')
    : `<div class="empty"><div class="big">📝</div><p>${state.guionFilter === 'pending'
      ? 'No hay guiones pendientes. Tocá <b>✨ Generar guiones</b> para crear un lote.'
      : `No hay guiones en "${GUION_STATUS[state.guionFilter]}".`}${state.guionCat !== 'all' ? ' (en esta categoría)' : ''}</p></div>`);
}

function generarGuionesModal() {
  const cats = state.guionCategories || [];
  const current = cats.includes(state.guionCat) ? state.guionCat : '';
  openModal('Generar guiones', `
    <div class="field"><label>¿En qué categoría los guardo?</label>
      <select class="input" id="gg-cat">
        <option value="">Sin categoría</option>
        ${cats.map((c) => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        <option value="__new__">＋ Nueva categoría…</option>
      </select>
      <input class="input hidden" id="gg-cat-new" placeholder="Nombre de la nueva categoría (ej. Polo navideño)" style="margin-top:8px"/></div>
    <div class="field"><label>Cantidad</label><input type="number" class="input" id="gg-n" value="10" min="1" max="200"/>
      <span class="hint">Se generan de a 10. Con el nivel gratis de Gemini, 30 guiones tardan un par de minutos.</span></div>
    <div class="field"><label>Ideas propias (opcional, una por línea)</label>
      <textarea class="input" id="gg-ideas" rows="6" placeholder="Polo intenta atrapar un copo de nieve mágico&#10;Polo aprende a patinar con una foca"></textarea>
      <span class="hint">Si ponés menos ideas que la cantidad, la IA inventa el resto sin repetir los guiones que ya existen.</span></div>
    <p class="hint">El personaje, el estilo y el audio salen de la <b>⚙️ Plantilla</b>; la IA solo escribe la historia y los textos.</p>`,
    `<button class="btn" data-close-modal>Cancelar</button><button class="btn primary" id="gg-go">✨ Generar</button>`);
  $('#gg-cat').onchange = (e) => { $('#gg-cat-new').classList.toggle('hidden', e.target.value !== '__new__'); if (e.target.value === '__new__') $('#gg-cat-new').focus(); };
  $('#gg-go').onclick = async () => {
    const category = $('#gg-cat').value === '__new__' ? $('#gg-cat-new').value.trim() : $('#gg-cat').value;
    if ($('#gg-cat').value === '__new__' && !category) return toast('Escribí el nombre de la nueva categoría.', 'warning');
    try {
      await api('POST', '/api/guiones/generate', { cantidad: Number($('#gg-n').value), ideas: $('#gg-ideas').value.split('\n'), category });
      if (category) setGuionCat(category);
      closeModal();
      state.guionFilter = 'pending';
      renderGuiones();
    } catch (e) { toast(e.message, 'error'); }
  };
}

async function briefModal() {
  const { text, path } = await api('GET', '/api/guiones/brief');
  openModal('Plantilla de la fábrica de guiones', `
    <p class="hint">Archivo: <code>${esc(path)}</code>. <b>{{HISTORIA}}</b> se reemplaza por la historia de cada guion; el resto del prompt queda fijo.</p>
    <textarea class="input mono" id="brief-text" rows="22">${esc(text)}</textarea>`,
    `<button class="btn" data-close-modal>Cancelar</button><button class="btn primary" id="brief-save">Guardar</button>`);
  $('#modal').classList.add('wide');
  $('#brief-save').onclick = async () => {
    try { await api('PUT', '/api/guiones/brief', { text: $('#brief-text').value }); toast('Plantilla guardada', 'success'); closeModal(); }
    catch (e) { toast(e.message, 'error'); }
  };
}

async function verGuion(file) {
  const { text } = await api('GET', `/api/guiones/${encodeURIComponent(file)}`);
  openModal(esc(file), `<pre class="md-view">${esc(text)}</pre>`,
    `<button class="btn" id="gv-copy">📋 Copiar todo</button><button class="btn primary" data-close-modal>Cerrar</button>`);
  $('#modal').classList.add('wide');
  $('#gv-copy').onclick = () => { navigator.clipboard.writeText(text); toast('Copiado'); };
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-gtab],[data-gcopy],[data-gview],[data-gstatus],[data-gdel],[data-gcat],[data-gmove],#btn-gen-guiones,#btn-brief,#btn-new-cat,#btn-del-cat');
  if (!t) return;
  try {
    if (t.dataset.gcat) { setGuionCat(t.dataset.gcat); state.gSel.clear(); return renderGuiones(); }
    if (t.id === 'btn-new-cat') {
      const name = prompt('Nombre de la nueva categoría:');
      if (!name?.trim()) return;
      const r = await api('POST', '/api/guion-categories', { name });
      setGuionCat(r.name);
      return renderGuiones();
    }
    if (t.id === 'btn-del-cat') {
      if (!confirm(`¿Eliminar la categoría "${state.guionCat}"? Los guiones no se borran: quedan sin categoría.`)) return;
      await api('DELETE', `/api/guion-categories/${encodeURIComponent(state.guionCat)}`);
      setGuionCat('all');
      return renderGuiones();
    }
    if (t.id === 'btn-gen-guiones') return generarGuionesModal();
    if (t.id === 'btn-brief') return briefModal();
    if (t.dataset.gtab) { state.guionFilter = t.dataset.gtab; state.gSel.clear(); return renderGuiones(); }
    if (t.dataset.gmove) {
      const files = [...state.gSel];
      const r = await api('POST', '/api/guiones/bulk-status', { files, status: t.dataset.gmove });
      state.gSel.clear();
      toast(`${r.moved} guion${r.moved === 1 ? '' : 'es'} movido${r.moved === 1 ? '' : 's'} a ${GUION_STATUS[t.dataset.gmove]}`, 'success');
      return renderGuiones();
    }
    if (t.dataset.gview) return verGuion(t.dataset.gview);
    if (t.dataset.gcopy) {
      const g = state.guiones.find((x) => x.file === t.dataset.gcopy);
      await navigator.clipboard.writeText(g.prompt);
      if (g.status === 'pending') await api('POST', `/api/guiones/${encodeURIComponent(g.file)}/status`, { status: 'producing' });
      toast('Prompt copiado. Pegalo en Gemini con la foto de Polo. Cuando arrastres el video a "publicar", se le asigna este guion.', 'success');
      return renderGuiones();
    }
    if (t.dataset.gstatus) { await api('POST', `/api/guiones/${encodeURIComponent(t.dataset.gfile)}/status`, { status: t.dataset.gstatus }); return renderGuiones(); }
    if (t.dataset.gdel) {
      if (!confirm('¿Descartar este guion? Se mueve a la carpeta "descartados".')) return;
      await api('DELETE', `/api/guiones/${encodeURIComponent(t.dataset.gdel)}`);
      return renderGuiones();
    }
  } catch (err) { toast(err.message, 'error'); }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-gsel]')) {
    e.target.checked ? state.gSel.add(e.target.dataset.gsel) : state.gSel.delete(e.target.dataset.gsel);
    renderGuiones();
  } else if (e.target.id === 'g-selall') {
    const list = state.guiones.filter((g) => g.status === state.guionFilter && inCat(g));
    if (e.target.checked) list.forEach((g) => state.gSel.add(g.file)); else state.gSel.clear();
    renderGuiones();
  }
});

document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-gsetcat]');
  if (!sel) return;
  try { await api('POST', `/api/guiones/${encodeURIComponent(sel.dataset.gsetcat)}/category`, { category: sel.value }); renderGuiones(); }
  catch (err) { toast(err.message, 'error'); }
});

// ================= Vista: Calendario (YouTube en tiempo real) =================
const YT_STATE = { published: 'Publicado', scheduled: 'Programado', private: 'Privado', unlisted: 'No listado' };
state.ytcal = { month: (() => { const d = new Date(); d.setDate(1); return d; })(), channel: 'all', data: null };
const isShort = (iso) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ''); return m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) <= 180 : false; };

async function renderYtCalendar(refresh = true) {
  const box = $('#ytcal');
  if (refresh || !state.ytcal.data) {
    box.innerHTML = '<div class="empty"><div class="big">⏳</div><p>Leyendo tus canales de YouTube…</p></div>';
    try { state.ytcal.data = await api('GET', '/api/youtube/calendar?refresh=1'); }
    catch (e) { box.innerHTML = `<div class="banner"><span>No se pudo leer YouTube: ${esc(e.message)}</span></div>`; return; }
  }
  const { channels, fetchedAt } = state.ytcal.data;
  const sel = $('#ytcal-channel');
  sel.innerHTML = `<option value="all">Todos los canales</option>` + channels.map((c) => `<option value="${c.account_id}" ${String(state.ytcal.channel) === String(c.account_id) ? 'selected' : ''}>${esc(c.channel)}</option>`).join('');
  const errors = channels.filter((c) => c.error);
  const vids = channels.filter((c) => state.ytcal.channel === 'all' || String(c.account_id) === String(state.ytcal.channel))
    .flatMap((c) => c.videos.map((v) => ({ ...v, channel: c.channel })))
    .filter((v) => v.date).sort((a, b) => new Date(a.date) - new Date(b.date));

  const m = state.ytcal.month;
  const inMonth = vids.filter((v) => { const d = new Date(v.date); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); });
  const byDay = new Map();
  for (const v of inMonth) { const k = dayKey(new Date(v.date)); byDay.set(k, [...(byDay.get(k) || []), v]); }
  const count = (s) => inMonth.filter((v) => v.state === s).length;
  $('#ytcal-sub').innerHTML = `Leído de YouTube ${fetchedAt ? `a las ${hhmm(new Date(fetchedAt))}` : ''} · se actualiza cada vez que entrás.`;

  const offset = (m.getDay() + 6) % 7;
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const todayKey = dayKey(new Date());
  let cells = WEEKDAYS.map((w) => `<div class="cal-wd">${w}</div>`).join('') + '<div></div>'.repeat(offset);
  for (let d = 1; d <= days; d++) {
    const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(d)}`;
    const list = byDay.get(key) || [];
    cells += `<div class="ytc-day ${key === todayKey ? 'today' : ''} ${list.length ? 'has' : ''}" ${list.length ? `data-ytday="${key}"` : ''}>
      <div class="ytc-head"><span class="d">${d}</span>${list.length ? `<span class="ytc-n">${list.length}</span>` : ''}</div>
      ${list.slice(0, 3).map((v) => `<div class="ytc-item ${v.state}" title="${esc(`${hhmm(new Date(v.date))} · ${v.title} · ${YT_STATE[v.state] || v.state} · ${v.channel}`)}">
        <img src="${esc(v.thumb)}" referrerpolicy="no-referrer" alt=""/><span><b>${hhmm(new Date(v.date))}</b> ${esc(v.title)}</span></div>`).join('')}
      ${list.length > 3 ? `<div class="ytc-more">+${list.length - 3} más</div>` : ''}
    </div>`;
  }
  box.innerHTML = `
    ${errors.map((c) => `<div class="banner"><span>⚠️ ${esc(c.channel)}: ${esc(c.error)}</span><a class="btn sm" href="#cuentas">Revisar cuenta</a></div>`).join('')}
    <div class="ytc-top">
      <button class="btn sm ghost" data-ytnav="-1">‹</button>
      <div class="ytc-month">${MONTHS[m.getMonth()]} ${m.getFullYear()}</div>
      <button class="btn sm ghost" data-ytnav="1">›</button>
      <button class="btn sm ghost" data-ytnav="0">Hoy</button>
      <div class="ytc-stats">
        <span class="ytc-pill published">✔ ${count('published')} publicados</span>
        <span class="ytc-pill scheduled">⏰ ${count('scheduled')} programados</span>
        ${count('private') + count('unlisted') ? `<span class="ytc-pill private">🔒 ${count('private') + count('unlisted')} privados / no listados</span>` : ''}
      </div>
    </div>
    <div class="ytc-grid">${cells}</div>`;
}

function ytDayModal(key) {
  const vids = state.ytcal.data.channels
    .filter((c) => state.ytcal.channel === 'all' || String(c.account_id) === String(state.ytcal.channel))
    .flatMap((c) => c.videos.map((v) => ({ ...v, channel: c.channel })))
    .filter((v) => v.date && dayKey(new Date(v.date)) === key).sort((a, b) => new Date(a.date) - new Date(b.date));
  const d = new Date(`${key}T00:00`);
  openModal(d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }), `<div class="ytc-list">${vids.map((v) => `
    <div class="ytc-row ${v.state}">
      <img src="${esc(v.thumb)}" referrerpolicy="no-referrer" alt=""/>
      <div class="info"><div class="t">${esc(v.title)}</div>
        <div class="small muted">${hhmm(new Date(v.date))} · ${YT_STATE[v.state] || v.state} · ${esc(v.channel)}${isShort(v.duration) ? ' · Short' : ''}</div></div>
      <a class="btn sm" target="_blank" href="https://studio.youtube.com/video/${esc(v.id)}/edit">Studio ↗</a>
      <a class="btn sm ghost" target="_blank" href="https://youtu.be/${esc(v.id)}">Ver ↗</a>
    </div>`).join('')}</div>`, `<button class="btn primary" data-close-modal>Cerrar</button>`);
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-ytnav]');
  if (nav) {
    const step = Number(nav.dataset.ytnav);
    if (step === 0) { state.ytcal.month = new Date(); state.ytcal.month.setDate(1); } else state.ytcal.month.setMonth(state.ytcal.month.getMonth() + step);
    return renderYtCalendar(false);
  }
  const day = e.target.closest('[data-ytday]');
  if (day) return ytDayModal(day.dataset.ytday);
});
$('#ytcal-channel').addEventListener('change', (e) => { state.ytcal.channel = e.target.value; renderYtCalendar(false); });
$('#ytcal-refresh').addEventListener('click', () => renderYtCalendar(true));

// ================= Crear playlist desde el editor =================
function newPlaylistModal(accountId, onCreated) {
  const langs = Object.fromEntries(Object.entries(LANGUAGES).filter(([k]) => k !== 'zxx'));
  openModal('Nueva playlist', `
    <p class="hint">Se crea en: <b>${esc(accountsMap()[accountId] || 'canal')}</b></p>
    <div class="field"><label>Título</label><input class="input" id="np-title" maxlength="150" placeholder="Polo's Adventures"/></div>
    <div class="field"><label>Descripción</label><textarea class="input" id="np-desc" rows="4" placeholder="Join Polo on fun adventures…"></textarea></div>
    <div class="row">
      <div class="field"><label>Idioma principal</label><select class="input" id="np-lang">${options(langs, 'en')}</select></div>
      <div class="field"><label>Visibilidad</label><select class="input" id="np-privacy">${options(PRIVACY, 'public')}</select></div>
    </div>
    <div class="translate-box">
      <div class="field"><label>Traducción (opcional)</label><select class="input" id="np-tlang">${options(langs, 'es-419', '— Sin traducción —')}</select></div>
      <div class="field"><label>Título traducido</label><input class="input" id="np-ttitle" maxlength="150" placeholder="Las aventuras de Polo"/></div>
      <div class="field"><label>Descripción traducida</label><textarea class="input" id="np-tdesc" rows="3"></textarea></div>
    </div>`,
    `<button class="btn" data-close-modal>Cancelar</button><button class="btn primary" id="np-create">Crear playlist</button>`);
  $('#np-create').onclick = async () => {
    const title = $('#np-title').value.trim();
    if (!title) return toast('Poné un título para la playlist.', 'warning');
    const btn = $('#np-create'); btn.disabled = true; btn.textContent = 'Creando…';
    try {
      const tl = $('#np-tlang').value;
      const pl = await api('POST', `/api/accounts/${accountId}/playlists`, {
        title, description: $('#np-desc').value, language: $('#np-lang').value, privacy: $('#np-privacy').value,
        translations: tl && $('#np-ttitle').value.trim() ? [{ lang: tl, title: $('#np-ttitle').value.trim(), description: $('#np-tdesc').value }] : [],
      });
      (state.playlists[accountId] ||= []).push(pl);
      toast(`Playlist "${pl.title}" creada ✔`, 'success');
      closeModal();
      onCreated(pl);
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Crear playlist'; }
  };
}

// ================= Vista: Inicio =================
async function renderHome() {
  const h = new Date().getHours();
  $('#home-greeting').textContent = `${h < 6 ? '¡Buenas noches' : h < 13 ? '¡Buen día' : h < 20 ? '¡Buenas tardes' : '¡Buenas noches'}! 👋`;
  const [, , guionesRes, calendar] = await Promise.all([
    loadInfo(), loadAccounts(),
    api('GET', '/api/guiones').catch(() => ({ guiones: [] })),
    api('GET', '/api/calendar').catch(() => []),
  ]);
  const c = state.info?.counts || {};
  const g = guionesRes.guiones || [];
  const gCount = (s) => g.filter((x) => x.status === s).length;
  const now = Date.now();
  const upcoming = calendar.filter((e) => ['scheduled', 'queued'].includes(e.status) && new Date(e.publish_at).getTime() > now)
    .sort((a, b) => new Date(a.publish_at) - new Date(b.publish_at));
  const drive = state.info?.drive || {};
  const accs = accountsMap();

  // Avisos
  const alerts = [];
  if (state.info && !state.info.credsConfigured) alerts.push(['warn', 'Faltan las credenciales de Google para publicar.', '#ajustes', 'Configurar']);
  else if (!state.accounts.length) alerts.push(['warn', 'No hay canales de YouTube conectados.', '#cuentas', 'Conectar canal']);
  if (state.info?.scheduler.paused) alerts.push(['warn', state.info.scheduler.pauseReason, '#videos', 'Ver']);
  if (c.error) alerts.push(['error', `${c.error} video${c.error > 1 ? 's' : ''} con error.`, '#videos', 'Revisar']);
  $('#home-alerts').innerHTML = alerts.map(([lvl, msg, href, btn]) =>
    `<div class="banner ${lvl === 'error' ? 'banner-error' : ''}"><span>${lvl === 'error' ? '⛔' : '⚠️'} ${esc(msg)}</span><a class="btn sm" href="${href}">${btn}</a></div>`).join('');

  const stat = (n, label, cls, href) => `<a class="home-stat ${cls}" href="${href}"><div class="n">${n}</div><div class="l">${label}</div></a>`;
  $('#home-stats').innerHTML = [
    stat(c.draft || 0, 'Borradores', 'draft', '#videos'),
    stat((c.queued || 0) + (c.uploading || 0), 'En cola', 'queued', '#videos'),
    stat(c.scheduled || 0, 'Programados', 'scheduled', '#calendario'),
    stat(c.published || 0, 'Publicados', 'published', '#calendario'),
    stat(state.accounts.length, state.accounts.length === 1 ? 'Canal' : 'Canales', 'channels', '#cuentas'),
  ].join('');

  const card = (href, icon, title, desc, meta) => `
    <a class="home-card" href="${href}">
      <div class="home-card-icon">${icon}</div>
      <div class="home-card-body"><div class="home-card-title">${title}</div><div class="muted small">${desc}</div></div>
      ${meta ? `<div class="home-card-meta">${meta}</div>` : ''}
      <div class="home-card-arrow">→</div>
    </a>`;
  $('#home-cards').innerHTML = [
    card('#videos', '🎬', 'Videos', 'Editá, programá y publicá', c.draft ? `${c.draft} borrador${c.draft > 1 ? 'es' : ''}` : 'Todo al día'),
    card('#calendario', '📅', 'Calendario', 'Lo que está en tus canales de YouTube', upcoming.length ? `${upcoming.length} por salir` : ''),
    card('#guiones', '📝', 'Guiones', 'Prompts para Gemini con título y hashtags', `${gCount('pending')} pendientes · ${gCount('producing')} en producción`),
    card('#cuentas', '👤', 'Cuentas', 'Canales de YouTube conectados', state.accounts.map((a) => esc(a.channel_title)).join(' · ') || 'Ninguno'),
    card('#ajustes', '⚙️', 'Ajustes', 'Drive, horarios, Gemini y más', drive.connected ? `☁ Drive${drive.enabled ? '' : ' (pausado)'} · ${esc(drive.folder || '')}` : 'Drive sin conectar'),
  ].join('');

  $('#home-next').innerHTML = `
    <div class="home-next-head"><h3>⏰ Próximas publicaciones</h3><a class="btn sm ghost" href="#calendario">Ver calendario →</a></div>
    ${upcoming.length ? upcoming.slice(0, 5).map((e) => {
      const d = new Date(e.publish_at);
      return `<div class="home-next-row">
        <div class="when"><b>${d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })}</b><span>${hhmm(d)}</span></div>
        <div class="what">${esc(e.title)}</div>
        <div class="muted small">${esc(accs[e.account_id] || '')}</div>
      </div>`;
    }).join('') : '<p class="muted">No hay publicaciones programadas. ¡Subí tus próximos videos!</p>'}`;
}

$('#home-upload').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });

// ================= Vista: Cuentas =================
async function renderAccounts() {
  await Promise.all([loadAccounts(), loadInfo()]);
  const el = $('#accounts-list');
  if (!state.info.credsConfigured) {
    $('#btn-connect').classList.add('hidden');
    el.innerHTML = `<div class="banner" style="grid-column:1/-1"><span>Antes de conectar canales, cargá el Client ID y Client Secret de Google en Ajustes.</span><a class="btn sm" href="#ajustes">Ir a Ajustes</a></div>`;
    return;
  }
  $('#btn-connect').classList.remove('hidden');
  el.innerHTML = state.accounts.length
    ? state.accounts.map((a) => `
      <div class="acc-card">
        <img src="${esc(a.channel_thumb)}" referrerpolicy="no-referrer" alt=""/>
        <div class="info">
          <div class="name">${esc(a.channel_title)}</div>
          <div class="muted small">Conectado ${esc(new Date(a.created_at + 'Z').toLocaleDateString('es-AR'))}</div>
        </div>
        <div class="acc-actions">
          <a class="btn sm" href="https://studio.youtube.com/channel/${esc(a.channel_id)}" target="_blank">Studio ↗</a>
          <button class="btn sm danger" data-disconnect="${a.id}">Desconectar</button>
        </div>
      </div>`).join('')
    : `<div class="empty"><div class="big">📺</div><p>Todavía no conectaste ningún canal.</p><a class="btn primary" href="/auth/google">Conectar canal de YouTube</a>
       <p class="hint">Podés repetir el proceso para conectar varias cuentas de Google o varios canales de marca.</p></div>`;
}

// ================= Google Picker: elegir la carpeta de Drive =================
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar la ventana de Google Drive.'));
    document.head.append(s);
  });
}

async function pickDriveFolder() {
  const { token, apiKey, appId } = await api('GET', '/api/drive/picker');
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise((resolve) => window.gapi.load('picker', resolve));
  const gp = window.google.picker;
  const view = new gp.DocsView(gp.ViewId.FOLDERS)
    .setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder').setParent('root');
  new gp.PickerBuilder()
    .setTitle('Elegí la carpeta donde se guardan los videos')
    .setLocale('es')
    .addView(view)
    .setOAuthToken(token)
    .setDeveloperKey(apiKey)
    .setAppId(appId)
    .setCallback(async (data) => {
      if (data.action !== gp.Action.PICKED) return;
      const f = data.docs[0];
      try {
        const r = await api('POST', '/api/drive/folder', { id: f.id, name: f.name });
        toast(`Los videos se van a guardar en "${r.name}" ✔`, 'success');
        renderSettings();
      } catch (e) { toast(e.message, 'error'); }
    })
    .build()
    .setVisible(true);
}

// ================= Vista: Ajustes =================
async function renderSettings() {
  const [s] = await Promise.all([api('GET', '/api/settings'), loadAccounts()]);
  const accOpts = Object.fromEntries(state.accounts.map((a) => [a.id, a.channel_title]));
  $('#settings-form').innerHTML = `
    <h3>🔒 Seguridad · Cambiar contraseña</h3>
    <div class="row3">
      <div class="field"><label>Contraseña actual</label><input class="input" type="password" id="pw-current" autocomplete="current-password"/></div>
      <div class="field"><label>Nueva (mín. 10)</label><input class="input" type="password" id="pw-next" autocomplete="new-password"/></div>
      <div class="field"><label>Repetir nueva</label><input class="input" type="password" id="pw-next2" autocomplete="new-password"/></div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:-4px"><button type="button" class="btn" id="pw-change">Cambiar contraseña</button></div>
    <p class="hint">Al cambiarla se cierran las sesiones abiertas en otros dispositivos.</p>

    <h3>1 · Credenciales de Google (YouTube Data API v3)</h3>
    <p class="hint">Creá un proyecto en <a href="https://console.cloud.google.com/" target="_blank">Google Cloud Console</a>, habilitá <b>YouTube Data API v3</b>, configurá la pantalla de consentimiento OAuth y creá un <b>ID de cliente OAuth</b> de tipo <b>Aplicación web</b>. Mirá el README para el paso a paso.</p>
    <div class="field"><label>URI de redirección autorizada (copiala en Google Cloud)</label>
      <div class="copy"><input class="input" readonly value="${esc(s.redirect_uri)}" id="redir"/><button type="button" class="btn" id="copy-redir">Copiar</button></div></div>
    <div class="field"><label>Client ID</label><input class="input" name="google_client_id" value="${esc(s.google_client_id)}" placeholder="xxxxxxxx.apps.googleusercontent.com"/></div>
    <div class="field"><label>Client Secret</label><input class="input" name="google_client_secret" type="password" value="${esc(s.google_client_secret)}" placeholder="GOCSPX-…"/></div>
    <div class="field"><label>O importar el archivo JSON descargado de Google Cloud</label>
      <label class="btn" style="align-self:flex-start">📄 Elegir client_secret_….json<input type="file" accept=".json,application/json" id="import-creds" hidden/></label>
      <span class="hint">Completa el Client ID y el Secret automáticamente. Después tocá "Guardar ajustes".</span></div>

    <h3>2 · Carpetas</h3>
    <div class="field"><label>Carpeta "Publicar" (se vigila automáticamente)</label><input class="input" name="watch_dir" value="${esc(s.watch_dir)}"/></div>
    <div class="field"><label>Carpeta de publicados (los videos se mueven acá al terminar)</label><input class="input" name="done_dir" value="${esc(s.done_dir)}"/></div>

    <h3>3 · Subida</h3>
    <div class="row">
      <div class="field"><label>Modo de programación</label>
        <select class="input" name="upload_mode">${options({ asap: 'Subir ya y que YouTube publique a la hora (recomendado)', at_time: 'Subir recién a la hora programada (PC encendida)' }, s.upload_mode)}</select></div>
      <div class="field"><label>Subidas simultáneas</label><input class="input" type="number" min="1" max="5" name="max_concurrent" value="${esc(s.max_concurrent)}"/></div>
    </div>

    <h3>4 · Valores por defecto para videos nuevos</h3>
    <div class="row">
      <div class="field"><label>Canal</label><select class="input" name="default_account_id">${options(accOpts, s.default_account_id, '— Ninguno —')}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Visibilidad</label><select class="input" name="default_privacy">${options(PRIVACY, s.default_privacy)}</select></div>
      <div class="field"><label>Categoría</label><select class="input" name="default_category">${options(CATEGORIES, s.default_category)}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Idioma de los videos</label><select class="input" name="default_language">${options(LANGUAGES, s.default_language)}</select></div>
      <div class="field"><label>Traducir al inglés automáticamente</label><select class="input" name="auto_translate_en">${options({ false: 'No, lo hago a mano', true: 'Sí, al detectar cada video nuevo' }, s.auto_translate_en)}</select></div>
    </div>
    <div class="field"><label>Horarios de publicación</label>
      <input class="input" name="time_slots" value="${esc(s.time_slots)}" placeholder="07:00, 16:00"/>
      <span class="hint">Separados por coma, formato 24 h. Son las opciones del desplegable de hora en el editor y en la programación en lote.</span></div>
    <div class="field"><label>Borrar el archivo local después de subirlo a YouTube</label>
      <select class="input" name="delete_after_upload_min">${options({ 0: 'No, moverlo a la carpeta de publicados', 10: 'Sí, a los 10 minutos', 60: 'Sí, a la hora', 1440: 'Sí, al día siguiente' }, s.delete_after_upload_min)}</select>
      <span class="hint">El video sigue en YouTube y en el historial del panel; solo se libera el espacio.</span></div>
    <div class="row">
      <div class="field"><label>Asignar guiones automáticamente</label><select class="input" name="auto_assign_guion">${options({ true: 'Sí: al llegar un video, usar el guion "en producción" más antiguo', false: 'No, lo elijo a mano en el editor' }, s.auto_assign_guion)}</select></div>
      <div class="field"><label>Carpeta de guiones</label><input class="input" name="guiones_dir" value="${esc(s.guiones_dir)}"/></div>
    </div>

    <h3>5 · Google Drive (respaldo de los videos)</h3>
    ${s.drive_connected
      ? `<div class="banner" style="border-color:rgba(47,191,113,.4);background:rgba(47,191,113,.08)"><span>☁ Conectado como <b>${esc(s.drive_email || 'tu cuenta')}</b>. Cada video que sube bien a YouTube se copia a Drive antes de borrarse de la Pi.</span>
         <button type="button" class="btn sm danger" id="drive-disconnect">Desconectar</button></div>`
      : `<div class="banner"><span>Conectá Google Drive para guardar una copia de cada video (y una ficha .md con sus datos) antes de que se borre de la Pi.</span>
         <a class="btn sm primary" href="/auth/drive">Conectar Google Drive</a></div>`}
    ${s.drive_connected ? `
    <div class="field"><label>Carpeta de destino</label>
      <div class="pl-row">
        <div class="input drive-folder">${s.drive_folder_id ? `📁 ${esc(s.drive_folder_name || 'Carpeta elegida')}` : `📁 Mi unidad / ${esc(s.drive_folder || 'AutoPublisher')} <span class="muted">(se crea sola)</span>`}</div>
        <button type="button" class="btn" id="drive-pick">Elegir carpeta</button>
        ${s.drive_folder_id ? '<button type="button" class="btn ghost" id="drive-unpick" title="Volver a la carpeta automática">✕</button>' : ''}
      </div>
      <span class="hint">Adentro se ordena por canal y playlist. Se abre una ventana de Google para que elijas una carpeta de tu unidad.</span></div>` : ''}
    <div class="row">
      <div class="field"><label>Respaldar en Drive</label><select class="input" name="drive_backup">${options({ true: 'Sí, cada video que se sube a YouTube', false: 'No (pausado)' }, s.drive_backup)}</select></div>
      <div class="field"><label>API key de Google Picker</label><input class="input" name="google_picker_key" type="password" value="${esc(s.google_picker_key)}" placeholder="AIza…"/>
        <span class="hint">Solo para la ventana de elegir carpeta. Ver README.</span></div>
    </div>
    <input type="hidden" name="drive_folder" value="${esc(s.drive_folder)}"/>

    <h3>6 · Gemini (traducciones)</h3>
    <div class="field"><label>API key de Gemini</label><input class="input" name="gemini_api_key" type="password" value="${esc(s.gemini_api_key)}" placeholder="AIza…"/>
      <span class="hint">Se consigue gratis en <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>. Se usa para traducir título y descripción. Si ya la pusiste en agentes/config.json no hace falta repetirla.</span></div>
    <div class="field"><label>URL base del servidor</label><input class="input" name="base_url" value="${esc(s.base_url)}"/>
      <span class="hint">Cambiala solo si accedés desde otra dirección; la URI de redirección se actualiza sola.</span></div>
    <div style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit">Guardar ajustes</button></div>`;
  $('#copy-redir').onclick = () => { navigator.clipboard.writeText($('#redir').value); toast('Copiado'); };
  $('#pw-change').addEventListener('click', async () => {
    if ($('#pw-next').value !== $('#pw-next2').value) return toast('Las contraseñas nuevas no coinciden.', 'error');
    try {
      await api('POST', '/api/auth/password', { current: $('#pw-current').value, next: $('#pw-next').value });
      ['#pw-current', '#pw-next', '#pw-next2'].forEach((s) => ($(s).value = ''));
      toast('Contraseña cambiada ✔', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#drive-pick')?.addEventListener('click', () => pickDriveFolder().catch((e) => toast(e.message, 'error')));
  $('#drive-unpick')?.addEventListener('click', async () => {
    await api('POST', '/api/drive/folder', { id: '' });
    toast('Se vuelve a usar la carpeta automática "AutoPublisher"');
    renderSettings();
  });
  $('#drive-disconnect')?.addEventListener('click', async () => {
    if (!confirm('¿Desconectar Google Drive? Los archivos que ya están en Drive no se borran.')) return;
    await api('POST', '/api/drive/disconnect');
    toast('Google Drive desconectado');
    renderSettings();
  });
  $('#import-creds').onchange = async (e) => {
    try {
      const json = JSON.parse(await e.target.files[0].text());
      const c = json.web || json.installed;
      if (!c?.client_id || !c?.client_secret) throw new Error('El archivo no tiene client_id / client_secret.');
      if (!json.web) toast('Ojo: el cliente no es de tipo "Aplicación web".', 'warning');
      if (c.redirect_uris && !c.redirect_uris.includes(s.redirect_uri)) toast(`La URI de redirección del cliente no incluye ${s.redirect_uri}.`, 'warning');
      $('#settings-form [name=google_client_id]').value = c.client_id;
      $('#settings-form [name=google_client_secret]').value = c.client_secret;
      toast('Credenciales importadas. Tocá "Guardar ajustes".', 'success');
    } catch (err) { toast(`No se pudo importar: ${err.message}`, 'error'); }
    e.target.value = '';
  };
}

// ================= Estado del programador =================
function renderSchedulerStatus() {
  const s = state.info?.scheduler;
  if (!s) return;
  $('#scheduler-status').innerHTML = s.paused
    ? `<span class="dot paused"></span>En pausa<br><span class="small">${esc(s.pauseReason)}</span>`
    : `<span class="dot"></span>Publicador activo${s.active ? ` · ${s.active} subiendo` : ''}<br><span class="small">${state.info.counts.queued || 0} en cola · ${state.info.counts.scheduled || 0} programados</span>`;
}

// ================= Subida de videos desde el panel =================
const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv|3gp|mpe?g)$/i;

function uploadFile(file) {
  const box = $('#uploads');
  box.classList.remove('hidden');
  const row = document.createElement('div');
  row.className = 'upload-row';
  row.innerHTML = `<div class="small">${esc(file.name)}</div><div class="progress"><div style="width:0%"></div></div>`;
  box.append(row);
  return new Promise((resolve) => {
    const fd = new FormData();
    fd.append('videos', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('.progress > div', row).style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
    xhr.onload = () => {
      if (xhr.status === 401) { location.href = '/login'; return; }
      const ok = xhr.status < 400;
      if (!ok) toast(xhr.status === 413 ? `"${file.name}" es demasiado grande para subir por internet (máx. 100 MB).` : `No se pudo subir "${file.name}" (error ${xhr.status}).`, 'error');
      row.remove();
      if (!box.children.length) box.classList.add('hidden');
      resolve(ok);
    };
    xhr.onerror = () => { toast(`Se cortó la subida de "${file.name}".`, 'error'); row.remove(); resolve(false); };
    xhr.send(fd);
  });
}

async function uploadFiles(files) {
  const videos = [...files].filter((f) => VIDEO_EXT.test(f.name));
  if (!videos.length) return toast('Solo se pueden subir archivos de video.', 'warning');
  let ok = 0;
  for (const f of videos) if (await uploadFile(f)) ok++; // de a uno: más estable por el túnel
  if (ok) toast(`${ok} video${ok > 1 ? 's' : ''} subido${ok > 1 ? 's' : ''}. Aparecen como borrador en unos segundos.`, 'success');
}

$('#upload-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#drop-overlay').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.add('hidden');
  if (state.view !== 'videos' && state.view !== 'inicio') location.hash = 'videos';
  uploadFiles(e.dataTransfer.files);
});

// ================= Eventos =================
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-close]') || t.id === 'drawer-backdrop') return closeDrawer();
  if (t.closest('[data-close-modal]') || t.id === 'modal-backdrop') return closeModal();

  const tab = t.closest('[data-status]');
  if (tab) {
    state.filter = tab.dataset.status;
    state.selected.clear();
    cardCache.clear();
    return refreshVideos();
  }
  if (t.dataset.select) {
    const id = Number(t.dataset.select);
    t.checked ? state.selected.add(id) : state.selected.delete(id);
    return renderGrid();
  }
  const card = t.closest('.card');
  if (card && !t.closest('a') && !t.closest('.sel')) return openEditor(Number(card.dataset.id));

  const bulk = t.closest('[data-bulk]');
  if (bulk) return bulkAction(bulk.dataset.bulk).catch((err) => toast(err.message, 'error'));

  if (t.closest('[data-action="resume"]')) { await api('POST', '/api/scheduler/resume'); return refreshVideos(); }
  if (t.dataset.disconnect) {
    if (!confirm('¿Desconectar este canal? Los videos pendientes quedarán sin canal asignado.')) return;
    await api('DELETE', `/api/accounts/${t.dataset.disconnect}`);
    delete state.playlists[t.dataset.disconnect];
    return renderAccounts();
  }
});

$('#select-all').addEventListener('change', (e) => {
  const q = state.search.toLowerCase();
  for (const v of state.videos) {
    if (LOCKED.has(v.status) || (q && !v.title.toLowerCase().includes(q) && !v.file_name.toLowerCase().includes(q))) continue;
    e.target.checked ? state.selected.add(v.id) : state.selected.delete(v.id);
  }
  renderGrid();
});
$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderGrid(); });
$('#btn-rescan').addEventListener('click', async () => { await api('POST', '/api/rescan'); toast('Carpeta reescaneada'); refreshVideos(); });
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target)));
    toast('Ajustes guardados', 'success');
    await loadInfo();
  } catch (err) { toast(err.message, 'error'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal-backdrop').classList.contains('hidden')) closeModal();
  else closeDrawer();
});
window.addEventListener('hashchange', route);

// Tiempo real
const es = new EventSource('/api/events');
let reloadTimer;
es.addEventListener('videos', () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(refreshVideos, 250); });
es.addEventListener('guiones', () => { if (state.view === 'guiones') renderGuiones(); });
es.addEventListener('accounts', () => loadAccounts().then(() => state.view === 'cuentas' && renderAccounts()));
es.addEventListener('toast', (e) => { const d = JSON.parse(e.data); toast(d.message, d.level); });
es.addEventListener('progress', (e) => {
  const { id, progress } = JSON.parse(e.data);
  const bar = $(`[data-progress="${id}"] > div`);
  if (bar) bar.style.width = `${progress}%`;
  const label = $(`[data-progress-label="${id}"]`);
  if (label) label.textContent = `${progress}% subido`;
  const v = state.videos.find((x) => x.id === id);
  if (v) v.progress = progress;
});
setInterval(loadInfo, 30000);

// Usuario logueado y cierre de sesión
api('GET', '/api/auth/me').then(({ username }) => {
  if (!username) return; // acceso local desde la Pi
  $('#user-box').innerHTML = `<span>👤 ${esc(username)}</span><button class="btn sm ghost" id="logout">Cerrar sesión</button>`;
  $('#user-box').classList.remove('hidden');
  $('#logout').onclick = async () => { await api('POST', '/api/auth/logout'); location.href = '/login'; };
}).catch(() => {});

// Arranque
(async () => {
  await Promise.all([loadAccounts(), loadInfo(), loadVideos()]);
  route();
})();
