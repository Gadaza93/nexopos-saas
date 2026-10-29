/* NexoPos · Modo Demo vs Producción (única definición de isDemoMode)
   El modo demo SOLO se activa si la URL trae explícitamente ?demo=true.
   Cualquier otra URL (Netlify, localhost, app de escritorio) abre el POS en producción.
   No se guarda en localStorage ni IndexedDB: se decide en cada carga a partir de la URL,
   así que quitar el parámetro siempre devuelve la app a producción.
   Se carga ANTES que storage.js, modules.js, sync.js y app.js. */
function isDemoMode() {
  if (typeof globalThis.__FORCE_DEMO_MODE__ === 'boolean') return globalThis.__FORCE_DEMO_MODE__; // solo pruebas
  try {
    const search = (typeof window !== 'undefined' && window.location && window.location.search) || '';
    return new URLSearchParams(search).get('demo') === 'true';
  } catch {
    return false;
  }
}
globalThis.isDemoMode = isDemoMode;
