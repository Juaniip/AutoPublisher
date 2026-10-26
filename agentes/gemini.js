// Cliente mínimo de la Interactions API de Gemini (texto y video).
// Usa node:https en lugar de fetch para que no haya timeouts en generaciones largas.
import https from 'node:https';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const API_HOST = new URL(BASE).host;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpRequest(method, url, headers, body, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        // la API key solo viaja al host de la API, nunca a URLs de redirección externas
        const nextHeaders = next.host === API_HOST ? headers : {};
        return resolve(httpRequest('GET', next.toString(), nextHeaders, null, redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiJson(method, path, apiKey, payload) {
  const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
  const headers = { 'x-goog-api-key': apiKey };
  if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  const res = await httpRequest(method, `${BASE}${path}`, headers, body);
  let data;
  try { data = JSON.parse(res.body.toString('utf8')); } catch { data = { raw: res.body.toString('utf8').slice(0, 500) }; }
  if (res.status >= 400) {
    const e = Array.isArray(data) ? data[0]?.error : data?.error; // a veces el error viene dentro de un array
    const err = new Error(e?.message ? `${e.message} (HTTP ${res.status})` : data.raw || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Reintenta cuando Google está saturado (503) o limita la velocidad (429): espera 2, 4, 8 y 16 s
export async function createInteraction(apiKey, payload, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await apiJson('POST', '/interactions', apiKey, payload);
    } catch (e) {
      if (!RETRYABLE.has(e.status) || attempt >= retries) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// Si un modelo sigue saturado después de los reintentos, prueba con el siguiente de la lista
export async function createWithFallback(apiKey, payload, models) {
  let lastErr;
  for (const model of models) {
    try {
      return await createInteraction(apiKey, { ...payload, model });
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.has(e.status)) throw e;
      console.warn(`[gemini] ${model} no disponible (${e.status}), probando el siguiente modelo…`);
    }
  }
  throw lastErr;
}

export const TEXT_FALLBACKS = ['gemini-3.7-flash', 'gemini-3.6-flash'];
export const getInteraction = (apiKey, id) => apiJson('GET', `/interactions/${encodeURIComponent(id)}`, apiKey);

const PENDING = new Set(['in_progress', 'queued', 'pending', 'running']);

export async function waitInteraction(apiKey, interaction, { intervalMs = 10_000, timeoutMs = 30 * 60_000, onTick } = {}) {
  const start = Date.now();
  let it = interaction;
  while (PENDING.has(it.status)) {
    if (Date.now() - start > timeoutMs) throw new Error(`Tiempo de espera agotado (${Math.round(timeoutMs / 60000)} min).`);
    await sleep(intervalMs);
    it = await getInteraction(apiKey, it.id);
    onTick?.(it, Date.now() - start);
  }
  return it;
}

// Devuelve los bloques de contenido que generó el modelo (texto, video, ...)
export function outputContents(interaction) {
  const fromSteps = (interaction.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || []);
  return fromSteps.length ? fromSteps : interaction.outputs || [];
}

export const outputText = (interaction) =>
  outputContents(interaction).filter((c) => c.type === 'text').map((c) => c.text).join('');

export async function downloadFile(apiKey, uri) {
  const id = uri.match(/files\/([^/:?]+)/)?.[1];
  if (id) {
    // esperar a que el archivo esté listo
    for (let i = 0; i < 120; i++) {
      const f = await apiJson('GET', `/files/${id}`, apiKey);
      if (f.state === 'ACTIVE' || !f.state) break;
      if (f.state === 'FAILED') throw new Error('Gemini marcó el archivo de video como FAILED.');
      await sleep(5000);
    }
  }
  const url = uri.includes('alt=media') ? uri : `${BASE}/files/${id}:download?alt=media`;
  const res = await httpRequest('GET', url, { 'x-goog-api-key': apiKey });
  if (res.status >= 400) throw new Error(`No se pudo descargar el video (HTTP ${res.status}).`);
  return res.body;
}
