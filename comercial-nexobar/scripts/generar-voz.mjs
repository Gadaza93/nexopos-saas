// Genera la locución del comercial con la API de Gemini (texto a voz) usando una clave de Google AI Studio.
//
// Cada escena del guion (scripts/guion.json) se sintetiza por separado en public/voz/<id>.mp3: se recortan los
// silencios de los extremos, se acelera con atempo (sin cambiar el tono) si no cabe en su escena y se normaliza a
// -14 LUFS (TikTok/Reels). Remotion coloca cada archivo en el frame `desde` + `inicio` de su escena (src/Comercial.tsx).
// public/voz/voz.json guarda los tiempos finales.
//
// Credencial: GEMINI_API_KEY (o GOOGLE_API_KEY), la clave de Google AI Studio. Viaja en la cabecera x-goog-api-key.
// La capa gratuita limita las peticiones por minuto: el script las espacia y, ante un 429, espera lo que pida Google.
//
// Uso:  npm run voz                       → public/voz/<escena>.mp3 y public/voz/voz.json
//       npm run voz -- --voz Fenrir             (otra voz de Gemini)
//       npm run voz -- --solo-guion             (muestra el plan sin llamar a la API)
//       npm run voz -- --forzar                 (regenera todo; por defecto reutiliza las escenas ya generadas)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 30, DURACION_TOTAL = 30; // segundos; igual que src/theme.ts
const MARGEN_FINAL = 0.25; // segundos libres al final de cada escena antes del fundido
const TEMPO_MAX = 1.3; // por encima suena atropellado
const ESPACIO_ENTRE_PETICIONES = 21000; // ms: la capa gratuita admite pocas peticiones por minuto
const ESPERA_MAX = 120; // s: un 429 que pide esperar más que esto (p. ej. cuota diaria) detiene el script
const TIEMPO_LIMITE = 120000; // ms por petición
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export class CuotaAgotada extends Error {}

// ffmpeg y ffprobe vienen con Remotion (`remotion ffmpeg` / `remotion ffprobe`): no hay que instalar nada más
const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('@remotion/cli/package.json')), 'remotion-cli.js');
function remotion(herramienta, args) {
  const r = spawnSync(process.execPath, [cli, herramienta, ...args], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${herramienta} falló (${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}
export function duracionDe(archivo) {
  const s = Number(remotion('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', archivo]).trim());
  if (!Number.isFinite(s) || s <= 0) throw new Error(`No se pudo medir la duración de ${archivo}`);
  return s;
}
const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

// Gemini devuelve WAV («audio/wav») o PCM crudo de 16 bits («audio/L16;codec=pcm;rate=24000»), según el modelo
export function aPcm(buffer, mime) {
  if (/wav/i.test(mime) || buffer.subarray(0, 4).toString() === 'RIFF') {
    const canales = buffer.readUInt16LE(22), frecuencia = buffer.readUInt32LE(24);
    let i = 12;
    while (i + 8 <= buffer.length && buffer.subarray(i, i + 4).toString() !== 'data') i += 8 + buffer.readUInt32LE(i + 4);
    const datos = buffer.subarray(i + 8, Math.min(buffer.length, i + 8 + buffer.readUInt32LE(i + 4)));
    return { muestras: new Int16Array(datos.buffer.slice(datos.byteOffset, datos.byteOffset + (datos.length & ~1))), frecuencia, canales };
  }
  const frecuencia = Number(/rate=(\d+)/.exec(mime)?.[1] || 24000);
  return { muestras: new Int16Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + (buffer.length & ~1))), frecuencia, canales: 1 };
}

// Quita el silencio de los extremos (ventanas de 10 ms por debajo de -45 dB) dejando 60 ms de aire
export function recortarSilencio({ muestras, frecuencia, canales }) {
  const ventana = Math.round(frecuencia * 0.01) * canales, umbral = 10 ** (-45 / 20);
  const conVoz = i => { let s = 0; const fin = Math.min(muestras.length, i + ventana); for (let k = i; k < fin; k++) s += (muestras[k] / 32768) ** 2; return Math.sqrt(s / Math.max(1, fin - i)) > umbral; };
  let ini = 0, fin = muestras.length;
  while (ini < fin && !conVoz(ini)) ini += ventana;
  while (fin > ini && !conVoz(Math.max(ini, fin - ventana))) fin -= ventana;
  const aire = Math.round(frecuencia * 0.06) * canales;
  return { muestras: muestras.subarray(Math.max(0, ini - aire), Math.min(muestras.length, fin + aire)), frecuencia, canales };
}
function aWav({ muestras, frecuencia, canales }) {
  const datos = Buffer.from(muestras.buffer, muestras.byteOffset, muestras.byteLength), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + datos.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(canales, 22); h.writeUInt32LE(frecuencia, 24); h.writeUInt32LE(frecuencia * canales * 2, 28); h.writeUInt16LE(canales * 2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(datos.length, 40);
  return Buffer.concat([h, datos]);
}

export async function sintetizar({ texto, voz, clave, fetchImpl = fetch, log = console.log, intentos = 4 }) {
  const cuerpo = {
    contents: [{ parts: [{ text: voz.estilo ? `${voz.estilo} ${texto}` : texto }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voz.nombre } } } }
  };
  for (let intento = 1; ; intento++) {
    const res = await fetchImpl(`${API}/${voz.modelo}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave }, body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIEMPO_LIMITE)
    });
    const datos = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const detalles = datos?.error?.details || [];
      const pausa = Number(/^(\d+(?:\.\d+)?)s$/.exec(detalles.find(d => d.retryDelay)?.retryDelay || '')?.[1] || 30) + 2;
      const diaria = detalles.some(d => (d.violations || []).some(v => /per ?day/i.test(`${v.description} ${v.quotaId}`)));
      // Cuota diaria agotada (o espera larga): no tiene sentido esperar horas; se avisa y se conserva lo ya generado
      if (diaria || pausa > ESPERA_MAX || intento >= intentos) {
        const horas = pausa / 3600;
        throw new CuotaAgotada(`Se agotó la cuota ${diaria ? 'diaria gratuita' : 'de peticiones'} de ${voz.modelo}. Google pide esperar ${horas >= 1 ? `~${horas.toFixed(1)} h` : `${Math.round(pausa)} s`}.`);
      }
      // Límite por minuto: Google indica cuánto esperar (RetryInfo.retryDelay, p. ej. «32s»)
      log(`  … límite de peticiones por minuto, reintento en ${Math.round(pausa)} s`);
      await esperar(pausa * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini respondió ${res.status}: ${datos?.error?.message || res.statusText}`);
    const audio = datos?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)?.inlineData;
    if (!audio) throw new Error(`Gemini no devolvió audio (motivo: ${datos?.candidates?.[0]?.finishReason || 'desconocido'}).`);
    return { buffer: Buffer.from(audio.data, 'base64'), mime: audio.mimeType || '' };
  }
}

export async function generarVoz({
  guion = JSON.parse(readFileSync(path.join(RAIZ, 'scripts', 'guion.json'), 'utf8')),
  vozNombre, clave, fetchImpl, carpeta = path.join(RAIZ, 'public', 'voz'), log = console.log, espacio = ESPACIO_ENTRE_PETICIONES, forzar = false
} = {}) {
  const voz = { ...guion.voz, ...(vozNombre ? { nombre: vozNombre } : {}) };
  const temporal = path.join(carpeta, '.tmp'), indice = path.join(carpeta, 'voz.json');
  if (forzar) rmSync(carpeta, { recursive: true, force: true });
  mkdirSync(temporal, { recursive: true });

  // Reanudación: una escena ya generada con el mismo texto, modelo y voz no se vuelve a pedir (ahorra cuota)
  let previos = [];
  try { previos = JSON.parse(readFileSync(indice, 'utf8')).tramos || []; } catch { /* primera vez */ }
  const tramos = [];
  const guardarIndice = () => writeFileSync(indice, JSON.stringify({ generado: new Date().toISOString(), tramos }, null, 2) + '\n');
  let pedidas = 0;
  try {
    for (const escena of guion.escenas) {
      // Una escena puede usar otro modelo o estilo («modelo»/«estilo» en guion.json), p. ej. si se agotó la cuota diaria del principal
      const vozEscena = { ...voz, ...(escena.modelo ? { modelo: escena.modelo } : {}), ...(escena.estilo !== undefined ? { estilo: escena.estilo } : {}) };
      const previo = previos.find(t => t.id === escena.id && t.texto === escena.texto && t.modelo === vozEscena.modelo && t.voz === vozEscena.nombre && t.estilo === (vozEscena.estilo || ''));
      if (previo && existsSync(path.join(carpeta, `${escena.id}.mp3`))) {
        tramos.push({ ...previo, frame: escena.desde + Math.round(escena.inicio * FPS), inicio: escena.desde / FPS + escena.inicio });
        log(`  = ${escena.id}: ya generada, se reutiliza`);
        continue;
      }
      if (pedidas++ > 0) await esperar(espacio);
      const inicio = escena.desde / FPS + escena.inicio;
      const disponible = escena.duracion / FPS - escena.inicio - MARGEN_FINAL;
      const { buffer, mime } = await sintetizar({ texto: escena.texto, voz: vozEscena, clave, fetchImpl, log });
      const audio = recortarSilencio(aPcm(buffer, mime));
      const crudo = audio.muestras.length / audio.canales / audio.frecuencia;
      const tempo = crudo > disponible ? crudo / disponible * 1.02 : 1;
      if (tempo > TEMPO_MAX) throw new Error(`La escena «${escena.id}» dura ${crudo.toFixed(2)} s y solo caben ${disponible.toFixed(2)} s. Acorta el texto en scripts/guion.json.`);

      const wav = path.join(temporal, `${escena.id}.wav`), final = path.join(carpeta, `${escena.id}.mp3`);
      writeFileSync(wav, aWav(audio));
      const filtros = [...(tempo > 1 ? [`atempo=${tempo.toFixed(4)}`] : []), 'loudnorm=I=-14:TP=-1.5:LRA=11'].join(',');
      remotion('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-af', filtros, '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', final]);
      const duracion = duracionDe(final);
      tramos.push({
        id: escena.id, archivo: `voz/${escena.id}.mp3`, frame: escena.desde + Math.round(escena.inicio * FPS), inicio, duracion, tempo: Number(tempo.toFixed(3)),
        texto: escena.texto, modelo: vozEscena.modelo, voz: vozEscena.nombre, estilo: vozEscena.estilo || ''
      });
      guardarIndice(); // se guarda tras cada escena: si se corta la cuota, lo generado no se pierde
      log(`  ✓ ${escena.id}: ${duracion.toFixed(2)} s desde el segundo ${inicio.toFixed(2)}${tempo > 1 ? ` (acelerada ×${tempo.toFixed(2)})` : ''}`);
    }
  } finally {
    rmSync(temporal, { recursive: true, force: true });
  }

  const ultimo = tramos[tramos.length - 1];
  if (ultimo && ultimo.inicio + ultimo.duracion > DURACION_TOTAL) throw new Error('La locución termina después de los 30 s del video.');
  guardarIndice();
  return { modelo: voz.modelo, voz: voz.nombre, tramos };
}

// Ejecución directa: `node scripts/generar-voz.mjs`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const vozNombre = args.includes('--voz') ? args[args.indexOf('--voz') + 1] : undefined;
  const guion = JSON.parse(readFileSync(path.join(RAIZ, 'scripts', 'guion.json'), 'utf8'));
  if (args.includes('--solo-guion')) {
    console.log(`Modelo: ${guion.voz.modelo} · voz ${vozNombre || guion.voz.nombre} · estilo ${guion.voz.estilo || '(ninguno)'}`);
    for (const e of guion.escenas) console.log(`  ${(e.desde / FPS + e.inicio).toFixed(1).padStart(5)} s  ${e.id.padEnd(11)} ${e.texto}${e.modelo ? `  [${e.modelo}]` : ""}`);
    process.exit(0);
  }
  const clave = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!clave) {
    console.error('Falta la clave. Define GEMINI_API_KEY con tu clave de Google AI Studio.');
    process.exit(1);
  }
  console.log(`Sintetizando la locución con Gemini (${guion.voz.modelo}, voz ${vozNombre || guion.voz.nombre}); entre escenas se espera ~${ESPACIO_ENTRE_PETICIONES / 1000} s por el límite por minuto…`);
  generarVoz({ vozNombre, clave, forzar: args.includes('--forzar') })
    .then(r => console.log(`\n✅ ${r.tramos.length} audios en public/voz/ (voz ${r.voz}). Renderiza con: npm run render:final`))
    .catch(err => {
      console.error(`\n❌ ${err.message}`);
      if (err instanceof CuotaAgotada) console.error('Las escenas ya generadas quedaron en public/voz/: al volver a ejecutar `npm run voz` solo se piden las que faltan.');
      process.exit(1);
    });
}
