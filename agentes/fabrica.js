// Fábrica de guiones: genera N archivos .md (prompt para Gemini + título, descripción, etiquetas y hashtags)
// a partir de agentes/brief-guiones.md. La plantilla del prompt se copia tal cual; la IA solo escribe la historia.
import fs from 'node:fs';
import path from 'node:path';
import { createWithFallback, waitInteraction, outputText, TEXT_FALLBACKS } from './gemini.js';

const LOTE = 10; // guiones por llamada: lotes chicos dan mejor calidad
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const slugify = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'guion';
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function leerBriefGuiones(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n');
  const sections = {};
  let current = null;
  let inFence = false;
  for (const line of raw.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h2 = !inFence && line.match(/^##\s+(.+?)\s*$/);
    if (h2) { current = norm(h2[1]); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const get = (k) => (sections[k] || []).join('\n').trim();
  const plantilla = get('plantilla del prompt').replace(/^```[^\n]*\n/, '').replace(/\n```$/, '').trim();
  if (!plantilla.includes('{{HISTORIA}}')) throw new Error('La "Plantilla del prompt" del brief tiene que incluir {{HISTORIA}}.');
  return {
    plantilla,
    reglas: get('reglas de la historia'),
    formato: get('formato de metadatos'),
    idioma: get('idioma').split('\n')[0].trim() || 'en',
    ideas: get('ideas').split('\n').map((l) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1]?.trim()).filter(Boolean),
  };
}

function schema(n) {
  return {
    type: 'object',
    properties: {
      guiones: {
        type: 'array',
        minItems: n,
        maxItems: n,
        items: {
          type: 'object',
          properties: {
            idea: { type: 'string', description: 'La idea en una frase corta (en español).' },
            historia: { type: 'string', description: 'La historia segundo a segundo según las reglas, lista para insertar en el prompt.' },
            title: { type: 'string' },
            description: { type: 'string', description: 'Sin hashtags (van aparte).' },
            tags: { type: 'array', items: { type: 'string' } },
            hashtags: { type: 'array', items: { type: 'string' } },
          },
          required: ['idea', 'historia', 'title', 'description', 'tags', 'hashtags'],
        },
      },
    },
    required: ['guiones'],
  };
}

async function generarLote({ apiKey, brief, ideasLote, cantidad, yaUsadas }) {
  const system = [
    'Sos un guionista experto en YouTube Shorts infantiles virales y en escribir historias para modelos de generación de video.',
    `Escribí exactamente ${cantidad} guiones. Seguí ESTRICTAMENTE las reglas de la historia y el formato de metadatos.`,
    `Título, descripción, etiquetas y hashtags en el idioma "${brief.idioma}". La historia siempre en inglés.`,
    'No escribas el resto del prompt (personaje, estilo, audio): solo la historia, que se inserta en una plantilla fija.',
    'Nunca uses los caracteres < ni >.',
  ].join('\n');
  const input = [
    `## Reglas de la historia\n${brief.reglas}`,
    `## Formato de metadatos\n${brief.formato}`,
    ideasLote.length
      ? `## Ideas a desarrollar (una por guion, en este orden${ideasLote.length < cantidad ? `; inventá ${cantidad - ideasLote.length} más` : ''})\n${ideasLote.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
      : `## Ideas\nInventá ${cantidad} ideas nuevas y variadas.`,
    yaUsadas.length ? `## Ideas y títulos que YA existen (no repetir ni hacer variaciones parecidas)\n${yaUsadas.slice(-150).map((t) => `- ${t}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  let it = await createWithFallback(apiKey, {
    system_instruction: system,
    input,
    response_format: { type: 'text', mime_type: 'application/json', schema: schema(cantidad) },
  }, ['gemini-3.8-flash', ...TEXT_FALLBACKS]);
  it = await waitInteraction(apiKey, it, { intervalMs: 2000, timeoutMs: 5 * 60_000 });
  const data = JSON.parse(outputText(it));
  return (data.guiones || []).slice(0, cantidad);
}

function guionMarkdown(brief, g) {
  const clean = (s) => String(s).replace(/[<>]/g, '').trim();
  const hashtags = [...new Set(g.hashtags.map((h) => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')).filter((h) => h.length > 1))].slice(0, 15);
  return [
    '# Idea', clean(g.idea), '',
    '# Prompt', '```text', brief.plantilla.replace('{{HISTORIA}}', clean(g.historia)), '```', '',
    '# Título', clean(g.title).slice(0, 100), '',
    '# Descripción', clean(g.description), '',
    '# Etiquetas', g.tags.map((t) => clean(t).replace(/^#/, '')).filter(Boolean).join(', '), '',
    '# Hashtags', hashtags.join(' '), '',
    '# Idioma', brief.idioma, '',
  ].join('\n');
}

// yaUsadas: títulos/ideas existentes para no repetir. Devuelve la lista de archivos creados.
export async function generarGuiones({ apiKey, briefPath, outDir, cantidad, ideasExtra = [], yaUsadas = [], onProgress = () => {} }) {
  const brief = leerBriefGuiones(briefPath);
  const ideas = [...ideasExtra, ...brief.ideas];
  fs.mkdirSync(outDir, { recursive: true });
  const existentes = fs.readdirSync(outDir).filter((f) => f.endsWith('.md')).length;
  const d = new Date();
  const fecha = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const usadas = [...yaUsadas];
  const creados = [];

  for (let hecho = 0; hecho < cantidad; ) {
    const n = Math.min(LOTE, cantidad - hecho);
    onProgress(`Escribiendo guiones ${hecho + 1}–${hecho + n} de ${cantidad}…`);
    const lote = await generarLote({ apiKey, brief, ideasLote: ideas.slice(hecho, hecho + n), cantidad: n, yaUsadas: usadas });
    for (const g of lote) {
      const num = existentes + creados.length + 1;
      const file = `${fecha}_${pad(num, 3)}_${slugify(g.title)}.md`;
      fs.writeFileSync(path.join(outDir, file), guionMarkdown(brief, g));
      creados.push(file);
      usadas.push(`${g.title} — ${g.idea}`);
    }
    hecho += lote.length || n; // si el modelo devolviera menos, no se queda en bucle
  }
  return creados;
}
