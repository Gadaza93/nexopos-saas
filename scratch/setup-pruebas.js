// Se carga antes de cada prueba (npm test usa --require). La app no trae proyecto de Supabase configurado,
// así que las pruebas definen uno ficticio: los clientes son siempre simulados y nunca salen a la red.
globalThis.NEXO_SUPABASE_URL = globalThis.NEXO_SUPABASE_URL || 'https://proyecto-de-prueba.supabase.co';
globalThis.NEXO_SUPABASE_ANON_KEY = globalThis.NEXO_SUPABASE_ANON_KEY || 'sb_publishable_clave_de_prueba';
