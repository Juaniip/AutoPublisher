// Lee el brief .md que escribe el usuario: secciones "## Personaje", "## Contexto", "## Formato" e "## Ideas".
import fs from 'node:fs';

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function leerBrief(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n');

  // Agrupa el contenido por secciones de nivel 2 (## ...); los ### quedan dentro de su sección
  const sections = {};
  let current = null;
  for (const line of raw.split('\n')) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2 && !line.startsWith('###')) { current = norm(h2[1]); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const get = (name) => (sections[name] || []).join('\n').trim();

  const formato = get('formato');
  const ideas = get('ideas')
    .split('\n')
    .map((l) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);

  const errores = [];
  if (!formato) errores.push('falta la sección "## Formato"');
  if (!ideas.length) errores.push('la sección "## Ideas" no tiene ideas (una por línea, con - o 1.)');
  if (errores.length) throw new Error(`El brief ${filePath} no es válido: ${errores.join('; ')}.`);

  return { formato, ideas, personaje: get('personaje'), contexto: get('contexto'), raw };
}
