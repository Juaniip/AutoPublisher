// Traduce título y descripción al inglés con Gemini y los guarda como localización "en" del video.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getSetting, Videos } from './db.js';
import { createWithFallback, waitInteraction, outputText, TEXT_FALLBACKS } from '../agentes/gemini.js';

const MODEL = 'gemini-3.8-flash';

// La key puede venir de la variable de entorno, de Ajustes o de la config de los agentes
export function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (getSetting('gemini_api_key')) return getSetting('gemini_api_key');
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'agentes', 'config.json'), 'utf8')).apiKey || '';
  } catch {
    return '';
  }
}

export async function translateToEnglish({ title, description }) {
  const apiKey = geminiKey();
  if (!apiKey) throw new Error('Falta la API key de Gemini (Ajustes → Gemini).');

  let it = await createWithFallback(apiKey, {
    system_instruction: [
      'You translate YouTube titles and descriptions into natural, engaging English for a US/global audience.',
      'Keep the same tone and hook. Keep emojis, @mentions, URLs and hashtags exactly as they are (do not translate hashtags).',
      'The title must be at most 100 characters. Never use the characters < or >.',
    ].join(' '),
    input: JSON.stringify({ title, description }),
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, description: { type: 'string' } },
        required: ['title', 'description'],
      },
    },
  }, [MODEL, ...TEXT_FALLBACKS]);
  it = await waitInteraction(apiKey, it, { intervalMs: 1500, timeoutMs: 2 * 60_000 });
  const data = JSON.parse(outputText(it));
  return {
    title: String(data.title).replace(/[<>]/g, '').trim().slice(0, 100),
    description: String(data.description).replace(/[<>]/g, '').trim().slice(0, 5000),
  };
}

export async function translateVideo(id) {
  const v = Videos.get(id);
  if (!v) throw new Error('Video no encontrado');
  if (!v.title?.trim()) throw new Error('El video no tiene título para traducir');
  const en = await translateToEnglish({ title: v.title, description: v.description || '' });
  Videos.update(id, { localizations: { ...v.localizations, en } });
  return en;
}
