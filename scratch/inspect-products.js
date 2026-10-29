const SUPABASE_URL = process.env.SUPABASE_URL || ""; // proyecto de Supabase propio (aún no configurado)
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const DEFAULT_BUSINESS_ID = "nexopos_default";

async function inspect() {
  const url = `${SUPABASE_URL}/rest/v1/productos?business_id=eq.${DEFAULT_BUSINESS_ID}&select=*`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    const data = await res.json();
    console.log("Respuesta:", Array.isArray(data) ? `Array de ${data.length}` : data);
    if (Array.isArray(data) && data.length > 0) {
      console.log("Ejemplo producto 0:", JSON.stringify(data[0], null, 2));
      const categories = [...new Set(data.map(p => p.categoria))];
      console.log("Categorías en Supabase:", categories);
      const withStock = data.filter(p => Number(p.stock) > 0);
      console.log("Productos con stock > 0:", withStock.length);
      const activos = data.filter(p => p.activo !== false);
      console.log("Productos con activo !== false:", activos.length);
    }
  } catch (e) {
    console.error("Error en fetch:", e);
  }
}

inspect().catch(console.error);
