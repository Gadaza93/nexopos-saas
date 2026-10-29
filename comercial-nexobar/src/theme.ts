// Paleta y medidas compartidas por todas las escenas
export const FPS = 30;

// Escenas en frames: [inicio, duración]
export const ESCENAS = {
  caos: { desde: 0, duracion: 240 }, // 0–8 s
  fortalezas: { desde: 240, duracion: 300 }, // 8–18 s
  interfaz: { desde: 540, duracion: 210 }, // 18–25 s
  cierre: { desde: 750, duracion: 150 } // 25–30 s
} as const;
export const DURACION_TOTAL = 900;

export const COLOR = {
  fondo: '#0a0a0c',
  superficie: '#16181F',
  superficie2: '#20232B',
  linea: 'rgba(255,255,255,0.08)',
  texto: '#F3F4F6',
  apagado: '#9CA3AF',
  rojo: '#EF4444',
  rojoSuave: 'rgba(239,68,68,0.16)',
  esmeralda: '#10B981',
  cian: '#06B6D4',
  ambar: '#F59E0B',
  naranja: '#FF8C32',
  grafito: '#12141A'
} as const;

export const FUENTE = {
  ui: '"Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif',
  display: 'Bahnschrift, "Segoe UI", Inter, system-ui, sans-serif'
} as const;

// Zona segura de TikTok/Reels: arriba ~220 px (pestañas) y abajo ~420 px (descripción y botones)
export const ZONA_SEGURA = { arriba: 220, abajo: 420, lados: 72 } as const;

export const pesos = (n: number) => '$' + Math.round(n).toLocaleString('es-CO');
