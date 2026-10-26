// Lector del formato .md de metadatos. Lo usan el panel (navegador) y el servidor (Node).

export const MD_TEMPLATE = `# Título
Escribí acá el título (máx. 100 caracteres)

# Descripción
Escribí acá la descripción.
Puede tener varias líneas.

# Etiquetas
etiqueta uno, etiqueta dos, etiqueta tres

# Hashtags
#shorts #ejemplo

# Título en inglés
Optional English title

# Descripción en inglés
Optional English description.
`;

export const LANGUAGE_CODES = ['es-419', 'es', 'en', 'pt', 'it', 'fr', 'zxx'];

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const KEYS = [
  ['title_en', /^(titulo en ingles|titulo ingles|title|english title)$/],
  ['description_en', /^(descripcion en ingles|descripcion ingles|description|english description)$/],
  ['title', /^titulo$/],
  ['description', /^descripcion$/],
  ['tags', /^(etiquetas|tags)$/],
  ['hashtags', /^hashtags?$/],
  ['prompt', /^prompt( usado| de video| de ia)?$/],
  ['language', /^(idioma|language)$/],
  ['idea', /^idea$/],
];

// Acepta encabezados # / ## / ### con o sin emojis. Las secciones desconocidas se ignoran,
// y lo que está dentro de bloques ``` nunca se toma como encabezado.
export function parseMetadataMd(text) {
  const sections = {};
  let current = null;
  let inFence = false;
  for (const line of String(text).replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (h) {
      const key = KEYS.find(([, re]) => re.test(norm(h[1])))?.[0];
      current = key || null; // encabezado desconocido: se ignora su contenido
      if (key) sections[key] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  const get = (k) => (sections[k] || []).join('\n').trim().replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();

  const out = {};
  if (get('title')) out.title = get('title').split('\n')[0].replace(/[<>]/g, '').slice(0, 100);
  if (get('description')) out.description = get('description').replace(/[<>]/g, '');
  const tags = get('tags').split(/[,\n]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
  const hashtags = get('hashtags').match(/#[^\s#,]+/g) || [];
  if (tags.length || hashtags.length) out.tags = [...new Set([...tags, ...hashtags.map((h) => h.slice(1))])];
  if (hashtags.length) out.hashtags = hashtags;
  if (get('title_en')) out.title_en = get('title_en').split('\n')[0].replace(/[<>]/g, '').slice(0, 100);
  if (get('description_en')) out.description_en = get('description_en').replace(/[<>]/g, '');
  if (get('prompt')) out.prompt = get('prompt');
  if (get('idea')) out.idea = get('idea');
  const lang = get('language').split('\n')[0].trim();
  if (LANGUAGE_CODES.includes(lang)) out.language = lang;
  return out;
}

// Agrega al final de la descripción los hashtags que todavía no estén
export function appendHashtags(desc, hashtags) {
  const missing = (hashtags || []).filter((h) => !desc.includes(h));
  return missing.length ? `${desc.trimEnd()}\n\n${missing.join(' ')}` : desc;
}
