// Agente 1 — Director: coordina el flujo completo.
//   brief.md (formato + ideas) → Guionista (Gemini texto) → guion.md → Productor (Gemini Omni, 9:16 + foto del personaje)
//   un video por idea → guarda todo en generados/<fecha_brief>/ y, opcionalmente, lo deja en publicar/ para AutoPublisher.
//
// Uso:  npm run generar -- [ruta/al/brief.md] [--solo-guion] [--sin-autopublisher]
//       (sin ruta usa agentes/brief.md)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escribirGuiones, guionesAMarkdown } from './guionista.js';
import { leerBrief } from './brief.js';
import { generarVideo } from './productor.js';

const AGENTES_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(AGENTES_DIR, '..');
const CONFIG_PATH = path.join(AGENTES_DIR, 'config.json');
const PERSONAJE_DIR = path.join(AGENTES_DIR, 'personaje');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const DEFAULT_CONFIG = {
  apiKey: '',
  modeloTexto: 'gemini-3.8-flash',
  modeloVideo: 'gemini-omni-1.1-flash',
  aspectRatio: '9:16',
  resolucion: '720p',
  enviarAAutoPublisher: true,
  carpetaPublicar: path.join(ROOT, 'publicar'),
  carpetaGenerados: path.join(ROOT, 'generados'),
};

const log = (agente, msg) => console.log(`\x1b[90m${new Date().toLocaleTimeString('es-AR')}\x1b[0m \x1b[1m[${agente}]\x1b[0m ${msg}`);
const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
const pad = (n) => String(n).padStart(2, '0');

function parseArgs(argv) {
  const args = { brief: path.join(AGENTES_DIR, 'brief.md'), soloGuion: false, sinAutoPublisher: false };
  for (const a of argv) {
    if (a === '--solo-guion') args.soloGuion = true;
    else if (a === '--sin-autopublisher') args.sinAutoPublisher = true;
    else args.brief = path.resolve(a);
  }
  return args;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log(`Se creó ${CONFIG_PATH}. Completá tu apiKey de Gemini (o usá la variable GEMINI_API_KEY).`);
  }
  const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  cfg.apiKey = process.env.GEMINI_API_KEY || cfg.apiKey;
  return cfg;
}

function loadPersonaje() {
  fs.mkdirSync(PERSONAJE_DIR, { recursive: true });
  return fs.readdirSync(PERSONAJE_DIR)
    .filter((f) => MIME[path.extname(f).toLowerCase()])
    .sort()
    .slice(0, 3)
    .map((f) => ({
      name: f,
      mime: MIME[path.extname(f).toLowerCase()],
      base64: fs.readFileSync(path.join(PERSONAJE_DIR, f)).toString('base64'),
    }));
}

function videoMarkdown(g, i) {
  return [
    `# Video ${i}: ${g.title}`, '',
    `> Idea: ${g.idea}`, '',
    '## Título', g.title, '',
    '## Descripción', g.description, '', g.hashtags.join(' '), '',
    '## Hashtags', g.hashtags.join(' '), '',
    '## 🇺🇸 Título en inglés', g.title_en, '',
    '## 🇺🇸 Descripción en inglés', g.description_en, '',
    '## Prompt usado', '```', g.video_prompt, '```', '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    console.error('\n✖ Falta la API key de Gemini. Conseguila en https://aistudio.google.com/apikey y pegala en agentes/config.json ("apiKey").\n');
    process.exit(1);
  }

  if (!fs.existsSync(args.brief)) {
    console.error(`
✖ No encontré el brief: ${args.brief}
  Usá agentes/brief.md como plantilla.
`);
    process.exit(1);
  }
  const brief = leerBrief(args.brief);
  const briefName = path.parse(args.brief).name;

  const imagenes = loadPersonaje();
  if (!args.soloGuion && !imagenes.length) {
    console.error(`\n✖ No hay foto del personaje. Poné 1 a 3 imágenes (JPG/PNG) en:\n  ${PERSONAJE_DIR}\n`);
    process.exit(1);
  }

  const d = new Date();
  const runName = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_${slugify(briefName)}`;
  const outDir = path.join(cfg.carpetaGenerados, runName);
  fs.mkdirSync(outDir, { recursive: true });

  // ---- Paso 1: Guionista ----
  fs.copyFileSync(args.brief, path.join(outDir, 'brief.md'));
  log('Director', `Brief: ${args.brief} · ${brief.ideas.length} ideas · salida: ${outDir}`);
  log('Director', `Le paso el formato y las ideas al Guionista (${cfg.modeloTexto})…`);
  const guiones = await escribirGuiones({ apiKey: cfg.apiKey, model: cfg.modeloTexto, brief });
  fs.writeFileSync(path.join(outDir, 'guion.md'), guionesAMarkdown(briefName, guiones));
  fs.writeFileSync(path.join(outDir, 'guion.json'), JSON.stringify(guiones, null, 2));
  guiones.forEach((g, i) => log('Guionista', `${i + 1}. ${g.title}`));
  log('Director', `Guiones guardados en guion.md`);
  if (args.soloGuion) return;

  // ---- Paso 2: Productor (uno por uno, para no chocar con los límites de la API) ----
  log('Director', `Foto(s) del personaje: ${imagenes.map((i) => i.name).join(', ')}`);
  const resultados = [];
  for (const [idx, g] of guiones.entries()) {
    const n = idx + 1;
    const base = `video_${n}`;
    log('Productor', `Generando video ${n}/${guiones.length} (${cfg.aspectRatio}, ${cfg.resolucion})…`);
    try {
      const buffer = await generarVideo({
        apiKey: cfg.apiKey,
        model: cfg.modeloVideo,
        prompt: g.video_prompt,
        imagenes,
        aspectRatio: cfg.aspectRatio,
        resolution: cfg.resolucion,
        onTick: (it, ms) => process.stdout.write(`\r   …${it.status} (${Math.round(ms / 1000)} s)   `),
      });
      process.stdout.write('\n');
      fs.writeFileSync(path.join(outDir, `${base}.mp4`), buffer);
      fs.writeFileSync(path.join(outDir, `${base}.md`), videoMarkdown(g, n));
      log('Productor', `✔ ${base}.mp4 (${(buffer.length / 1e6).toFixed(1)} MB)`);

      if (cfg.enviarAAutoPublisher && !args.sinAutoPublisher) {
        // El .json va primero: AutoPublisher lo lee al detectar el video y precarga título, descripción y etiquetas
        fs.mkdirSync(cfg.carpetaPublicar, { recursive: true });
        const pubName = `${runName}_${n}`;
        fs.writeFileSync(path.join(cfg.carpetaPublicar, `${pubName}.json`), JSON.stringify({
          title: g.title,
          description: `${g.description}\n\n${g.hashtags.join(' ')}`,
          tags: g.hashtags.map((h) => h.slice(1)),
          synthetic_media: true,
          ...(g.title_en ? { localizations: { en: { title: g.title_en, description: `${g.description_en}\n\n${g.hashtags.join(' ')}` } } } : {}),
        }, null, 2));
        fs.copyFileSync(path.join(outDir, `${base}.mp4`), path.join(cfg.carpetaPublicar, `${pubName}.mp4`));
        log('Director', `→ enviado a AutoPublisher como borrador (${pubName}.mp4)`);
      }
      resultados.push({ n, ok: true });
    } catch (e) {
      process.stdout.write('\n');
      log('Productor', `\x1b[31m✖ Video ${n} falló: ${e.message}\x1b[0m`);
      fs.writeFileSync(path.join(outDir, `${base}_ERROR.txt`), `${e.message}\n\nPrompt:\n${g.video_prompt}\n`);
      resultados.push({ n, ok: false });
    }
  }

  const ok = resultados.filter((r) => r.ok).length;
  log('Director', `Listo: ${ok}/${resultados.length} videos generados. Carpeta: ${outDir}`);
  if (ok < resultados.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
});
