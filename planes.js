/* NexoPos · Planes y funciones por plan (feature gating)
   El plan sale de negocios.plan ('basico' | 'pro'), que solo cambia el superadmin (admin_update_negocio_status; las cajas
   no tienen permiso sobre esa columna). sync.js lo guarda en state.subscription.plan al descargar y en tiempo real, así
   las restricciones siguen igual sin internet. Sin plan conocido (caja que nunca sincronizó) o en el modo demo rige el
   Pro: ningún negocio existente pierde funciones antes de saber su plan.
   Validación en la nube: el trigger negocios_limite_mesas no deja crecer el plano de un negocio Básico por encima de
   PLAN_MAX_MESAS (ver CLAUDE.md). Los reportes, la valoración y las exportaciones se calculan en el equipo con datos del
   propio negocio: su restricción es de la app. */

const PLAN_MAX_MESAS = 10; // mismo valor que el trigger de Supabase
const PLAN_MAX_USUARIOS = 2; // Plan Básico: el administrador y un usuario más (cajero o mesero)
// Línea de soporte y ventas de Netxpremium (wa.me, con indicativo y sin «+»). También la usa el modal del modo demo (app.js).
globalThis.NETXPREMIUM_WHATSAPP = globalThis.NETXPREMIUM_WHATSAPP || '573052484278';
const PLAN_FEATURES = {
  floorMap: { label: 'Mapa interactivo de mesas', detail: 'Ver el salón como plano y mover las mesas arrastrándolas.' },
  inventoryValue: { label: 'Valoración de inventario', detail: 'Capital invertido, valor comercial y ganancia proyectada en bodega.' },
  exports: { label: 'Exportación de reportes', detail: 'Descargar reportes en Excel e imprimirlos o guardarlos en PDF.' },
  netProfit: { label: 'Utilidad neta y rentabilidad', detail: 'Ganancia después de costos y gastos, con margen neto por período.' },
  expenses: { label: 'Seguimiento de gastos', detail: 'Registrar arriendo, servicios, nómina y caja menor.' },
  multiRole: { label: 'Usuarios ilimitados', detail: `El Plan Básico incluye ${PLAN_MAX_USUARIOS} usuarios: el administrador y un cajero o mesero.` },
  tables: { label: 'Mesas ilimitadas', detail: `El Plan Básico incluye hasta ${PLAN_MAX_MESAS} mesas o barras.` },
};
const PLANS = {
  basico: { label: 'Básico', maxTables: PLAN_MAX_MESAS, maxUsers: PLAN_MAX_USUARIOS, features: [] },
  pro: { label: 'Pro', maxTables: Infinity, maxUsers: Infinity, features: Object.keys(PLAN_FEATURES) },
};

function normalizePlanId(plan) {
  const id = String(plan || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return PLANS[id] ? id : null;
}
// Estado de la app: la variable global state de app.js (se reasigna al cargar o restaurar; globalThis.state puede quedar atrás)
function planState() { return typeof state !== 'undefined' ? state : globalThis.state; }
function planDemoActivo() { return typeof isDemoMode === 'function' && isDemoMode(); }
function currentPlan() {
  if (planDemoActivo()) return 'pro';
  return normalizePlanId(planState()?.subscription?.plan) || 'pro';
}
function planAllows(feature) { return PLANS[currentPlan()].features.includes(feature); }
function planTableLimit() { return PLANS[currentPlan()].maxTables; }
// ¿Cabe una mesa más? Un negocio que bajó de plan con más mesas las conserva, pero no puede agregar otras.
function canAddTable(count) { return Number(count) < planTableLimit(); }
// Usuarios activos que admite el plan (Básico: PLAN_MAX_USUARIOS, con cualquier rol)
function planUserLimit() { return PLANS[currentPlan()].maxUsers; }
const PLAN_USERS_MESSAGE = `El Plan Básico incluye ${PLAN_MAX_USUARIOS} usuarios: el administrador y un cajero o mesero. Mejora a Pro para sumar más personal con su propio PIN.`;
// ¿Este usuario puede iniciar sesión con el plan actual? Los administradores siempre; del resto, solo los primeros
// que quepan en el límite (un negocio que bajó de plan conserva a todos, pero los demás quedan con candado).
function planAllowsUser(user) {
  if (!user || planAllows('multiRole') || user.role === 'admin') return true;
  const active = (planState()?.users || []).filter(u => u.active !== false);
  const admins = active.filter(u => u.role === 'admin').length;
  const cupo = Math.max(0, planUserLimit() - Math.max(1, admins));
  return active.filter(u => u.role !== 'admin').slice(0, cupo).some(u => u.id === user.id);
}

/* ---------- Modal «Mejora tu plan a PRO» ---------- */
function planUpgradeUrl(feature) {
  const phone = (globalThis.NETXPREMIUM_WHATSAPP || '').replace(/\D/g, '');
  const negocio = planState()?.profile?.name || '';
  const text = encodeURIComponent(`Hola Netxpremium, quiero pasar mi NexoPos${negocio ? ` (${negocio})` : ''} al Plan Pro${PLAN_FEATURES[feature] ? ` para usar: ${PLAN_FEATURES[feature].label}` : ''}.`);
  return phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
}
function showUpgradeDialog(feature, message) {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const dialog = document.querySelector('#planUpgradeDialog'), info = PLAN_FEATURES[feature];
  if (!dialog) { if (typeof showToast === 'function') showToast(message || `${info?.label || 'Esta función'} es del Plan Pro.`); return; }
  dialog.querySelector('#planUpgradeFeature').textContent = info?.label || 'Función del Plan Pro';
  dialog.querySelector('#planUpgradeMessage').textContent = message || info?.detail || '';
  dialog.querySelector('#planUpgradeWhatsapp').href = planUpgradeUrl(feature);
  if (!dialog.open) dialog.showModal();
}
// Para usar dentro de una acción: true si el plan la permite; si no, abre el modal y devuelve false
function requirePlan(feature, message) {
  if (planAllows(feature)) return true;
  showUpgradeDialog(feature, message);
  return false;
}

/* ---------- Indicadores en la interfaz ----------
   Los elementos con data-plan-feature="…" llevan la etiqueta PRO y, si el plan no la incluye, quedan con candado: el
   clic abre el modal en vez de la acción (escucha en captura, antes que los manejadores de app.js y modules.js). */
function applyPlanGates() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const plan = currentPlan();
  if (document.documentElement?.dataset) document.documentElement.dataset.plan = plan;
  document.querySelectorAll('[data-plan-feature]').forEach(el => {
    const locked = !planAllows(el.dataset.planFeature);
    el.classList.toggle('plan-locked', locked);
    if (locked) el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled');
    let tag = el.querySelector(':scope > .pro-tag');
    if (locked && !tag) { tag = document.createElement('span'); tag.className = 'pro-tag'; tag.textContent = 'PRO'; tag.setAttribute('aria-label', 'Función del Plan Pro'); el.appendChild(tag); }
    if (!locked && tag) tag.remove();
  });
  document.querySelectorAll('[data-plan-table-count]').forEach(el => {
    const tables = typeof floorTables === 'function' ? floorTables() : planState()?.tables; // con el borrador del diseñador, si lo hay
    const limit = planTableLimit(), n = Array.isArray(tables) ? tables.length : 0;
    el.hidden = !Number.isFinite(limit);
    el.textContent = Number.isFinite(limit) ? `Plan Básico: ${n} de ${limit} mesas o barras${n >= limit ? ' · límite alcanzado' : ''}. Las mesas se ubican solas; moverlas en el plano es del Plan Pro.` : '';
  });
  document.querySelectorAll('[data-plan-upgrade]').forEach(el => { el.hidden = plan !== 'basico'; });
}
function handlePlanGateClick(event) {
  if (event.target?.closest?.('[data-plan-upgrade]')) { event.preventDefault(); return showUpgradeDialog(null, 'Desbloquea todas las funciones de NexoPos para tu negocio.'); }
  const el = event.target?.closest?.('[data-plan-feature]');
  if (!el || planAllows(el.dataset.planFeature)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  showUpgradeDialog(el.dataset.planFeature);
}
// Si el plan cambió con un usuario que ya no cabe en sesión (el negocio pasó a Básico), se vuelve al inicio de sesión
function enforcePlanSession() {
  applyPlanGates();
  const user = typeof me === 'function' ? me() : null;
  if (user && !planAllowsUser(user) && typeof showLogin === 'function') {
    showLogin();
    if (typeof showToast === 'function') showToast(`Tu plan Básico incluye ${PLAN_MAX_USUARIOS} usuarios. Inicia sesión con el administrador.`);
  }
  if (globalThis.tableViewMode && typeof renderTables === 'function') { try { renderTables(); } catch { /* sin interfaz */ } }
  if (typeof applyReportTab === 'function') { try { applyReportTab(); } catch { /* sin interfaz */ } }
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('click', handlePlanGateClick, true);

Object.assign(globalThis, { PLAN_MAX_MESAS, PLAN_FEATURES, PLANS, normalizePlanId, currentPlan, planAllows, planTableLimit, canAddTable, planUserLimit, planAllowsUser, PLAN_MAX_USUARIOS, PLAN_USERS_MESSAGE, planUpgradeUrl, showUpgradeDialog, requirePlan, applyPlanGates, enforcePlanSession });
if (typeof module !== 'undefined' && module.exports) module.exports = { PLAN_MAX_MESAS, PLANS, normalizePlanId, currentPlan, planAllows, planTableLimit, canAddTable, planUserLimit, planAllowsUser, PLAN_MAX_USUARIOS, planUpgradeUrl };
