// Agente 2 — Guionista: convierte cada idea del brief en un guion con prompt de video, título, descripción y hashtags,
// respetando el formato que el usuario definió en el brief.
import { createWithFallback, waitInteraction, outputText, TEXT_FALLBACKS } from './gemini.js';

function schema(cantidad) {
  return {
    type: 'object',
    properties: {
      videos: {
        type: 'array',
        minItems: cantidad,
        maxItems: cantidad,
        description: 'Un guion por idea, en el MISMO orden que la lista de ideas.',
        items: {
          type: 'object',
          properties: {
            idea: { type: 'string', description: 'La idea original a la que corresponde este guion.' },
            video_prompt: { type: 'string', description: 'Prompt para el modelo de video, siguiendo la sección "Prompt de video" del formato.' },
            title: { type: 'string', description: 'Título según la sección "Título" del formato. Nunca más de 100 caracteres, sin < ni >.' },
            description: { type: 'string', description: 'Descripción según la sección "Descripción" del formato. Sin hashtags; van aparte.' },
            hashtags: {
              type: 'array',
              items: { type: 'string', description: 'Hashtag que empieza con #, sin espacios.' },
              description: 'Hashtags según la sección "Hashtags" del formato.',
            },
            title_en: { type: 'string', description: 'Traducción natural al inglés del título (máx. 100 caracteres), mismo gancho y emojis.' },
            description_en: { type: 'string', description: 'Traducción natural al inglés de la descripción.' },
          },
          required: ['idea', 'video_prompt', 'title', 'description', 'hashtags', 'title_en', 'description_en'],
        },
      },
    },
    required: ['videos'],
  };
}

export async function escribirGuiones({ apiKey, model, brief }) {
  const { ideas, formato, personaje, contexto } = brief;
  const system = [
    'Sos un guionista experto en YouTube Shorts y en escribir prompts para modelos de generación de video.',
    'Vas a recibir un brief con un FORMATO y una lista de IDEAS. Para cada idea escribí exactamente un guion,',
    'en el mismo orden, respetando ESTRICTAMENTE las reglas del formato para cada campo',
    '(prompt de video, título, descripción y hashtags). Si una regla del formato contradice estas instrucciones, gana el formato.',
    'Los videos son verticales 9:16. El protagonista SIEMPRE es el personaje de las imágenes de referencia:',
    'en el prompt de video referite a él como "the character from the reference image" y pedí que mantenga exactamente su apariencia.',
    'No inventes ideas nuevas: desarrollá las que te dan.',
  ].join('\n');

  const input = [
    personaje && `## Personaje\n${personaje}`,
    contexto && `## Contexto\n${contexto}`,
    `## Formato\n${formato}`,
    `## Ideas\n${ideas.map((idea, i) => `${i + 1}. ${idea}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');

  let it = await createWithFallback(apiKey, {
    system_instruction: system,
    input,
    response_format: { type: 'text', mime_type: 'application/json', schema: schema(ideas.length) },
  }, [model, ...TEXT_FALLBACKS.filter((m) => m !== model)]);
  it = await waitInteraction(apiKey, it, { intervalMs: 2000, timeoutMs: 5 * 60_000 });

  const text = outputText(it);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`El guionista no devolvió JSON válido:\n${text.slice(0, 500)}`); }
  if (!Array.isArray(data.videos) || !data.videos.length) throw new Error('El guionista no devolvió guiones.');

  // Normalización mínima para que YouTube lo acepte sin errores
  return data.videos.slice(0, ideas.length).map((v, i) => ({
    idea: ideas[i],
    video_prompt: v.video_prompt.trim(),
    title: v.title.replace(/[<>]/g, '').trim().slice(0, 100),
    description: v.description.replace(/[<>]/g, '').trim(),
    hashtags: [...new Set(v.hashtags.map((h) => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')).filter((h) => h.length > 1))].slice(0, 15),
    title_en: (v.title_en || '').replace(/[<>]/g, '').trim().slice(0, 100),
    description_en: (v.description_en || '').replace(/[<>]/g, '').trim(),
  }));
}

export function guionesAMarkdown(nombre, guiones) {
  return [
    `# Guiones — ${nombre}`,
    '',
    `Generado el ${new Date().toLocaleString('es-AR')}`,
    '',
    ...guiones.flatMap((g, i) => [
      `## Video ${i + 1}`,
      '',
      `> Idea: ${g.idea}`,
      '',
      '### Título',
      g.title,
      '',
      '### Descripción',
      g.description,
      '',
      '### Hashtags',
      g.hashtags.join(' '),
      '',
      '### 🇺🇸 Título en inglés',
      g.title_en,
      '',
      '### 🇺🇸 Descripción en inglés',
      g.description_en,
      '',
      '### Prompt de video',
      '```',
      g.video_prompt,
      '```',
      '',
    ]),
  ].join('\n');
}
