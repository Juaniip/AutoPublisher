import path from 'node:path';

export function prettifyFileName(fileName) {
  const base = path.parse(fileName).name;
  const clean = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function fill(pattern, video, index) {
  const now = new Date();
  const fecha = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  return pattern
    .replaceAll('{nombre}', prettifyFileName(video.file_name))
    .replaceAll('{archivo}', path.parse(video.file_name).name)
    .replaceAll('{n}', String(index))
    .replaceAll('{fecha}', fecha);
}

// Devuelve los cambios que la plantilla aplica sobre un video. `index` es 1-based (para {n}).
export function templatePatch(tpl, video, index = 1) {
  const patch = {};
  if (tpl.title_pattern) patch.title = fill(tpl.title_pattern, video, index).slice(0, 100);
  if (tpl.description) patch.description = fill(tpl.description, video, index);
  if (tpl.tags?.length) patch.tags = tpl.tags;
  if (tpl.category_id) patch.category_id = tpl.category_id;
  if (tpl.privacy) patch.privacy = tpl.privacy;
  if (tpl.made_for_kids != null) patch.made_for_kids = tpl.made_for_kids;
  return patch;
}
