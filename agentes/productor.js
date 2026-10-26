// Agente 3 — Productor: genera el video vertical con Gemini Omni usando la foto del personaje como referencia.
import { createInteraction, waitInteraction, outputContents, outputText, downloadFile } from './gemini.js';

export async function generarVideo({ apiKey, model, prompt, imagenes, aspectRatio, resolution, onTick }) {
  const input = [
    ...imagenes.map((img) => ({ type: 'image', data: img.base64, mime_type: img.mime })),
    { type: 'text', text: prompt },
  ];
  const responseFormat = { type: 'video', aspect_ratio: aspectRatio, resolution };

  let it;
  try {
    // En segundo plano: la API responde al instante y se consulta el estado hasta que termina
    it = await createInteraction(apiKey, { model, input, response_format: responseFormat, background: true });
  } catch (e) {
    if (e.status !== 400 || !/background/i.test(e.message)) throw e;
    // Si el modelo no admite background, se espera la respuesta directa y se pide el video por URI
    it = await createInteraction(apiKey, { model, input, response_format: { ...responseFormat, delivery: 'uri' } });
  }
  it = await waitInteraction(apiKey, it, { intervalMs: 10_000, timeoutMs: 30 * 60_000, onTick });

  if (it.status && it.status !== 'completed') {
    throw new Error(`La generación terminó con estado "${it.status}". ${it.error?.message || ''}`.trim());
  }
  const video = outputContents(it).find((c) => c.type === 'video');
  if (!video) {
    const motivo = outputText(it);
    throw new Error(`Gemini no devolvió un video (puede haber sido bloqueado por los filtros de seguridad).${motivo ? ` Respuesta: ${motivo.slice(0, 300)}` : ''}`);
  }
  if (video.data) return Buffer.from(video.data, 'base64');
  return downloadFile(apiKey, video.uri);
}
