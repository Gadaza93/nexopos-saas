/* NexoPos · Panel SuperAdmin SaaS (admin.html)
   Página independiente: no carga el POS ni toca sus datos locales (IndexedDB, archivo espejo).
   - Login con Supabase Auth; solo entra una cuenta con app_metadata.role === 'superadmin'.
   - Datos desde las RPC admin_get_all_negocios y admin_update_negocio_status.
   La verificación de rol aquí es solo de interfaz: las RPC deben comprobar el rol en el servidor. */

// Mismo proyecto que sync.js (no se carga sync.js aquí: arrancaría el ciclo de sincronización del POS).
const ADMIN_SUPABASE_URL = globalThis.NEXO_SUPABASE_URL || 'https://voesyutyotonbktndrum.supabase.co';
const ADMIN_SUPABASE_ANON_KEY = globalThis.NEXO_SUPABASE_ANON_KEY || 'sb_publishable_FCYyjpjy8SOBzQkEcYAfjA_N6hzP3bh';
// Clave propia y sessionStorage: no se mezcla con la sesión de la terminal y se cierra con la pestaña
const ADMIN_AUTH_KEY = 'nexopos-superadmin-auth';
const EXTEND_DAYS = 30;
const NOT_SUPERADMIN = 'Acceso no autorizado: esta cuenta no tiene permisos de SuperAdmin';

let adminClient = null, negocios = [], loadingNegocios = false;
const busyIds = new Set();

const fmtInt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const fmtDate = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });

function getAdminClient() {
  if (adminClient) return adminClient;
  if (!ADMIN_SUPABASE_URL || !ADMIN_SUPABASE_ANON_KEY) return null;
  const factory = typeof window !== 'undefined' ? window.supabase : globalThis.supabase;
  if (!factory || typeof factory.createClient !== 'function') return null;
  let storage;
  try { storage = sessionStorage; } catch { storage = undefined; } // sin sessionStorage: sesión en memoria
  adminClient = factory.createClient(ADMIN_SUPABASE_URL, ADMIN_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: ADMIN_AUTH_KEY, ...(storage ? { storage } : {}) }
  });
  return adminClient;
}

/* ---------- Lógica pura (probada en scratch/test-admin-panel.js) ---------- */
function isSuperadmin(user) { return user?.app_metadata?.role === 'superadmin'; }
function computeMetrics(list) {
  const rows = Array.isArray(list) ? list : [];
  const active = rows.filter(n => n.activo !== false).length;
  return { total: rows.length, active, suspended: rows.length - active, sales: rows.reduce((sum, n) => sum + (Number(n.total_ventas) || 0), 0) };
}
function expiryInfo(fecha, now = Date.now()) {
  if (!fecha) return { label: 'Sin fecha', tone: 'muted' };
  const date = new Date(fecha); if (Number.isNaN(date.getTime())) return { label: 'Sin fecha', tone: 'muted' };
  const days = Math.ceil((date.getTime() - now) / 86400000);
  const label = fmtDate.format(date);
  if (days < 0) return { label, tone: 'danger', note: 'Vencida' };
  if (days <= 7) return { label, tone: 'warn', note: days === 0 ? 'Vence hoy' : `Vence en ${days} d` };
  return { label, tone: 'ok', note: `${days} días` };
}
// Parámetros de admin_update_negocio_status(p_negocio_id, p_activo, p_plan, p_extender_dias)
function statusPayload(negocio, { activo = negocio.activo !== false, extenderDias = 0, plan = negocio.plan } = {}) {
  return { p_negocio_id: String(negocio.id), p_activo: Boolean(activo), p_plan: plan || null, p_extender_dias: Number(extenderDias) || 0 };
}
function escapeAdminHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------- Alta de negocio ---------- */
const PLAN_LABELS = { pro: 'PRO', basico: 'BÁSICO' };
const planLabel = plan => PLAN_LABELS[String(plan || '').toLowerCase()] || String(plan || '—').toUpperCase();
const otherPlan = plan => String(plan || '').toLowerCase() === 'basico' ? 'pro' : 'basico'; // botón de cambio de plan de cada fila
const NEGOCIO_ID_RE = /^[a-z0-9_]{3,40}$/;
// Palabras genéricas del tipo de local que no aportan al ID: «Gastrobar La Estación» → bar_la_estacion
const GENERIC_VENUE_WORDS = /^(?:(?:gastro)?bar|restobar|restaurante|cafeteria|cafe|panaderia|pub|taberna|cantina|discoteca|licorera|estadero)_+/;
function slugifyNegocioId(nombre) {
  const base = String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) return '';
  const core = base.replace(GENERIC_VENUE_WORDS, '') || base;
  return `bar_${core}`.slice(0, 40).replace(/_+$/, '');
}
// Sin caracteres ambiguos (0/O, 1/l/I) para dictarla o copiarla sin errores; siempre con mayúscula, minúscula y número
const PASSWORD_SETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789'];
function randomIndex(max, rng) {
  if (rng) return Math.floor(rng() * max);
  const limit = 256 - (256 % max), buf = new Uint8Array(1);
  do { globalThis.crypto.getRandomValues(buf); } while (buf[0] >= limit); // sin sesgo de módulo
  return buf[0] % max;
}
function generatePassword(length = 8, rng) {
  const all = PASSWORD_SETS.join('');
  const chars = PASSWORD_SETS.map(set => set[randomIndex(set.length, rng)]);
  while (chars.length < length) chars.push(all[randomIndex(all.length, rng)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomIndex(i + 1, rng); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
// Valida el formulario y arma los parámetros de admin_create_negocio
function buildCreatePayload({ nombre, negocioId, email, password, plan, dias }) {
  const p_nombre = String(nombre || '').trim(), p_id = String(negocioId || '').trim().toLowerCase();
  const p_email = String(email || '').trim().toLowerCase(), p_password = String(password || '');
  const p_plan = String(plan || '').toLowerCase(), p_dias_vigencia = Number(dias);
  if (p_nombre.length < 2) return { ok: false, field: 'nombre', error: 'Escribe el nombre del negocio.' };
  if (!NEGOCIO_ID_RE.test(p_id)) return { ok: false, field: 'id', error: 'El ID debe tener entre 3 y 40 caracteres: minúsculas, números o guion bajo.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p_email)) return { ok: false, field: 'email', error: 'Escribe un correo electrónico válido.' };
  if (p_password.length < 8 || /\s/.test(p_password)) return { ok: false, field: 'password', error: 'La contraseña debe tener al menos 8 caracteres y sin espacios.' };
  if (!PLAN_LABELS[p_plan]) return { ok: false, field: 'plan', error: 'Elige un plan válido.' };
  if (!Number.isInteger(p_dias_vigencia) || p_dias_vigencia < 1 || p_dias_vigencia > 3650) return { ok: false, field: 'dias', error: 'Los días de vigencia deben ser un número entero entre 1 y 3650.' };
  return { ok: true, payload: { p_id, p_nombre, p_email, p_password, p_plan, p_dias_vigencia } };
}
// Mensaje claro para los errores típicos de la RPC (correo duplicado, ID ocupado)
function describeCreateError(error) {
  const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  const duplicate = /duplicate|already|ya existe|ya está|registrad|en uso|unique|23505/.test(text) || error?.code === '23505';
  if (/already registered|users_email/.test(text) || (duplicate && /correo|email/.test(text))) return 'Ya existe una cuenta con ese correo. Usa otro correo para la terminal.';
  if (duplicate) return 'Ese ID de negocio ya está en uso. Elige otro.';
  if (error?.code === '42501' || /permission denied|no autorizado|not authorized/.test(text)) return 'Tu sesión no tiene permisos de SuperAdmin para crear negocios.';
  return `No se pudo crear el negocio: ${error?.message || 'error desconocido'}`;
}
// Texto listo para pegar en WhatsApp
function credentialsText({ p_nombre, p_id, p_email, p_password, p_plan, p_dias_vigencia }) {
  return [
    `¡Bienvenido a NexoPos, ${p_nombre}!`,
    '',
    'Datos para vincular tu caja (pantalla «Vincular Terminal»):',
    `• Correo: ${p_email}`,
    `• Contraseña: ${p_password}`,
    '',
    `Plan ${planLabel(p_plan)} · Vigencia inicial: ${p_dias_vigencia} ${p_dias_vigencia === 1 ? 'día' : 'días'}`,
    `ID de negocio: ${p_id}`
  ].join('\n');
}

/* ---------- Supabase ---------- */
async function adminSignIn(email, password) {
  const sb = getAdminClient();
  if (!sb) return { ok: false, error: 'No se pudo cargar Supabase. Revisa tu conexión a internet y recarga.' };
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: /invalid|credentials/i.test(error.message || '') ? 'Correo o contraseña incorrectos.' : `No se pudo ingresar: ${error.message}` };
    if (!isSuperadmin(data?.user)) { await sb.auth.signOut({ scope: 'local' }); return { ok: false, error: NOT_SUPERADMIN }; }
    return { ok: true, user: data.user };
  } catch (err) {
    return { ok: false, error: 'No se pudo conectar con el servidor. Intenta de nuevo.' };
  }
}
async function fetchNegocios() {
  const { data, error } = await getAdminClient().rpc('admin_get_all_negocios');
  if (error) throw new Error(error.message || 'Error al consultar los negocios');
  return Array.isArray(data) ? data : [];
}
async function updateNegocio(negocio, options) {
  const { error } = await getAdminClient().rpc('admin_update_negocio_status', statusPayload(negocio, options));
  if (error) throw new Error(error.message || 'Error al actualizar el negocio');
}
// Borrado definitivo con admin_delete_negocio(p_negocio_id, p_confirmacion): el servidor exige que la confirmación sea el ID
const deleteConfirmMatches = (typed, id) => String(typed ?? '').trim() === String(id ?? '');
function describeDeleteError(error) {
  const text = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  if (error?.code === '42501' || /permission denied|no autorizado|not authorized/.test(text)) return 'Tu sesión no tiene permisos de SuperAdmin para eliminar negocios.';
  if (error?.code === '22023' || /confirmaci/.test(text)) return 'El ID escrito no coincide con el del negocio.';
  if (error?.code === 'P0002' || /no existe/.test(text)) return 'Ese negocio ya no existe. Actualiza la lista.';
  if (error?.code === 'PGRST202' || /could not find the function/.test(text)) return 'Falta instalar la función admin_delete_negocio en Supabase (SQL de supabase/sql).';
  return `No se pudo eliminar el negocio: ${error?.message || 'error desconocido'}`;
}
async function deleteNegocio(id, confirmacion) {
  const { data, error } = await getAdminClient().rpc('admin_delete_negocio', { p_negocio_id: String(id), p_confirmacion: String(confirmacion ?? '').trim() });
  if (error) throw new Error(describeDeleteError(error));
  return data || {};
}
async function createNegocio(payload) {
  try {
    const { data, error } = await getAdminClient().rpc('admin_create_negocio', payload);
    if (error) return { ok: false, error: describeCreateError(error) };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: 'No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.' };
  }
}

/* ---------- Interfaz ---------- */
const $ = selector => document.querySelector(selector);
let toastTimer = null;
function adminToast(message) {
  const el = $('#toast'); if (!el) return;
  el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
}
function showView(view) {
  $('#adminBooting').hidden = true;
  $('#adminLogin').hidden = view !== 'login';
  $('#adminApp').hidden = view !== 'app';
}
function showLoginView(message = '') {
  negocios = []; showView('login');
  $('#adminLoginError').textContent = message;
  $('#adminPassword').value = '';
  $('#adminEmail').focus();
}
function showDashboard(user) {
  showView('app');
  $('#adminWho').textContent = user?.email || '';
  loadNegocios();
}

function renderMetrics() {
  const m = computeMetrics(negocios);
  $('#metricTotal').textContent = fmtInt.format(m.total);
  $('#metricActive').textContent = fmtInt.format(m.active);
  $('#metricSuspended').textContent = fmtInt.format(m.suspended);
  $('#metricSales').textContent = fmtInt.format(m.sales);
}
function renderTableMessage(text, withRetry = false) {
  $('#negociosBody').innerHTML = `<tr><td colspan="8" class="admin-empty">${escapeAdminHtml(text)}${withRetry ? ' <button type="button" class="outline-button admin-small" data-action="reload">Reintentar</button>' : ''}</td></tr>`;
}
function renderNegocios() {
  renderMetrics();
  if (!negocios.length) return renderTableMessage('Aún no hay negocios registrados.');
  $('#negociosBody').innerHTML = negocios.map(n => {
    const active = n.activo !== false, busy = busyIds.has(String(n.id)), exp = expiryInfo(n.fecha_vencimiento);
    const id = escapeAdminHtml(n.id);
    return `<tr class="${active ? '' : 'is-suspended-row'}">
      <td><code class="admin-id">${id}</code></td>
      <td><strong>${escapeAdminHtml(n.nombre || 'Sin nombre')}</strong></td>
      <td><span class="admin-plan">${escapeAdminHtml(planLabel(n.plan))}</span></td>
      <td class="num">${fmtInt.format(Number(n.total_productos) || 0)}</td>
      <td class="num">${fmtInt.format(Number(n.total_ventas) || 0)}</td>
      <td><span class="admin-expiry is-${exp.tone}">${escapeAdminHtml(exp.label)}${exp.note ? `<small>${escapeAdminHtml(exp.note)}</small>` : ''}</span></td>
      <td><span class="admin-badge ${active ? 'is-active' : 'is-suspended'}">${active ? 'Activo' : 'Suspendido'}</span></td>
      <td class="actions"><div class="admin-actions">
        <button type="button" class="admin-switch" role="switch" aria-checked="${active}" data-action="toggle" data-id="${id}" ${busy ? 'disabled' : ''} title="${active ? 'Suspender' : 'Activar'} ${escapeAdminHtml(n.nombre || n.id)}"><span class="admin-switch-track"><span class="admin-switch-thumb"></span></span><span class="admin-switch-label">${active ? 'Activo' : 'Suspendido'}</span></button>
        <button type="button" class="outline-button admin-small" data-action="plan" data-id="${id}" ${busy ? 'disabled' : ''} title="Cambiar a ${escapeAdminHtml(planLabel(otherPlan(n.plan)))}">→ ${escapeAdminHtml(planLabel(otherPlan(n.plan)))}</button>
        <button type="button" class="outline-button admin-small" data-action="extend" data-id="${id}" ${busy ? 'disabled' : ''}>+${EXTEND_DAYS} días</button>
        <button type="button" class="outline-button admin-small admin-delete-action" data-action="delete" data-id="${id}" ${busy ? 'disabled' : ''} title="Eliminar ${escapeAdminHtml(n.nombre || n.id)} y todos sus datos">Eliminar</button>
      </div></td>
    </tr>`;
  }).join('');
}
async function loadNegocios({ quiet = false } = {}) {
  if (loadingNegocios) return; loadingNegocios = true;
  if (!quiet && !negocios.length) renderTableMessage('Cargando negocios…');
  $('#adminRefresh').disabled = true;
  try {
    negocios = await fetchNegocios();
    renderNegocios();
    $('#adminLastUpdate').textContent = `Actualizado ${new Date().toLocaleTimeString('es-CO')}`;
  } catch (err) {
    renderMetrics(); renderTableMessage(`No se pudieron cargar los negocios: ${err.message}`, true);
  } finally {
    loadingNegocios = false; $('#adminRefresh').disabled = false;
  }
}
// Cambia estado o extiende la licencia y vuelve a consultar la lista completa
async function applyNegocioChange(id, kind) {
  const negocio = negocios.find(n => String(n.id) === id); if (!negocio || busyIds.has(id)) return;
  if (kind === 'delete') return openDeleteDialog(negocio);
  const active = negocio.activo !== false, name = negocio.nombre || negocio.id;
  if (kind === 'toggle' && active && !confirm(`¿Suspender «${name}»? Su POS quedará bloqueado hasta reactivarlo.`)) return;
  const nextPlan = otherPlan(negocio.plan);
  if (kind === 'plan' && !confirm(`¿Cambiar «${name}» al plan ${planLabel(nextPlan)}?${nextPlan === 'basico' ? ' Quedará con 10 mesas, un solo usuario y sin reportes avanzados.' : ''}`)) return;
  // Extender un negocio suspendido lo reactiva (la tarea nexopos-suspender-vencidos suspende a los vencidos)
  if (kind === 'extend' && !active && !confirm(`«${name}» está suspendido. ¿Extender ${EXTEND_DAYS} días y reactivarlo?`)) return;
  const options = kind === 'toggle' ? { activo: !active } : kind === 'plan' ? { plan: nextPlan } : { extenderDias: EXTEND_DAYS, activo: true };
  busyIds.add(id); renderNegocios();
  try {
    await updateNegocio(negocio, options);
    adminToast(kind === 'extend' ? `Licencia de «${name}» extendida ${EXTEND_DAYS} días.` : kind === 'plan' ? `«${name}» ahora tiene el plan ${planLabel(nextPlan)}.` : `«${name}» ${active ? 'suspendido' : 'activado'}.`);
  } catch (err) {
    adminToast(`⚠ No se pudo actualizar «${name}»: ${err.message}`);
  } finally {
    busyIds.delete(id);
    await loadNegocios({ quiet: true });
  }
}

/* ---------- Modal de eliminación ---------- */
let deleting = null; // negocio que se está por eliminar
function openDeleteDialog(negocio) {
  deleting = negocio;
  const nombre = negocio.nombre || 'Sin nombre', fmt = n => fmtInt.format(Number(n) || 0);
  $('#deleteNegocioName').textContent = `«${nombre}»`;
  $('#deleteNegocioIdHint').textContent = negocio.id;
  $('#deleteNegocioSummary').innerHTML = [
    `${fmt(negocio.total_productos)} productos y ${fmt(negocio.total_ventas)} ventas`,
    'Gastos, mermas, proveedores, turnos de caja y pedidos abiertos',
    'Las cuentas de acceso (correo y contraseña) del negocio',
  ].map(t => `<li>${escapeAdminHtml(t)}</li>`).join('');
  $('#deleteNegocioConfirm').value = ''; $('#deleteNegocioError').textContent = '';
  $('#deleteNegocioSubmit').disabled = true; $('#deleteNegocioSubmit').textContent = 'Eliminar definitivamente';
  $('#deleteNegocioDialog').showModal(); $('#deleteNegocioConfirm').focus();
}
function closeDeleteDialog() { const dialog = $('#deleteNegocioDialog'); if (dialog.open) dialog.close(); deleting = null; }
async function handleDeleteSubmit(event) {
  event.preventDefault();
  const negocio = deleting, typed = $('#deleteNegocioConfirm').value;
  if (!negocio || !deleteConfirmMatches(typed, negocio.id)) { $('#deleteNegocioError').textContent = 'Escribe el ID exacto del negocio para confirmar.'; return; }
  const id = String(negocio.id), name = negocio.nombre || negocio.id, submit = $('#deleteNegocioSubmit');
  submit.disabled = true; submit.textContent = 'Eliminando…'; busyIds.add(id); renderNegocios();
  try {
    const res = await deleteNegocio(id, typed);
    closeDeleteDialog();
    adminToast(`«${name}» eliminado: ${fmtInt.format(Number(res.ventas) || 0)} ventas, ${fmtInt.format(Number(res.productos) || 0)} productos y ${fmtInt.format(Number(res.cuentas) || 0)} ${Number(res.cuentas) === 1 ? 'cuenta' : 'cuentas'} de acceso.`);
  } catch (err) {
    $('#deleteNegocioError').textContent = err.message; submit.textContent = 'Eliminar definitivamente';
    submit.disabled = !deleteConfirmMatches($('#deleteNegocioConfirm').value, id);
  } finally {
    busyIds.delete(id);
    await loadNegocios({ quiet: true });
  }
}

/* ---------- Modal de alta ---------- */
let lastCreated = null; // credenciales del último alta, solo mientras está abierta la confirmación
function openNegocioDialog() {
  const form = $('#negocioForm'); form.reset();
  $('#negocioId').dataset.touched = ''; $('#negocioDias').value = '30';
  $('#negocioPassword').value = generatePassword();
  $('#negocioFormError').textContent = '';
  $('#negocioDialog').showModal(); $('#negocioNombre').focus();
}
function closeNegocioDialog() { const dialog = $('#negocioDialog'); if (dialog.open) dialog.close(); $('#negocioPassword').value = ''; }
async function handleNegocioSubmit(event) {
  event.preventDefault();
  const errorEl = $('#negocioFormError'), submit = $('#negocioSubmit');
  const check = buildCreatePayload({ nombre: $('#negocioNombre').value, negocioId: $('#negocioId').value, email: $('#negocioEmail').value, password: $('#negocioPassword').value, plan: $('#negocioPlan').value, dias: $('#negocioDias').value });
  const fieldInputs = { nombre: '#negocioNombre', id: '#negocioId', email: '#negocioEmail', password: '#negocioPassword', plan: '#negocioPlan', dias: '#negocioDias' };
  if (!check.ok) { errorEl.textContent = check.error; $(fieldInputs[check.field])?.focus(); return; }
  submit.disabled = true; submit.textContent = 'Creando…'; errorEl.textContent = '';
  const result = await createNegocio(check.payload);
  submit.disabled = false; submit.textContent = 'Crear y Activar Negocio';
  if (!result.ok) { errorEl.textContent = result.error; return; } // el modal sigue abierto para corregir
  closeNegocioDialog();
  showCreatedDialog(check.payload);
  adminToast(`«${check.payload.p_nombre}» creado y activo.`);
  loadNegocios({ quiet: true });
}
function showCreatedDialog(payload) {
  lastCreated = payload;
  const rows = [['Negocio', payload.p_nombre], ['ID de negocio', payload.p_id], ['Correo', payload.p_email], ['Contraseña', payload.p_password, true], ['Plan', planLabel(payload.p_plan)], ['Vigencia', `${payload.p_dias_vigencia} días`]];
  $('#negocioCreatedSummary').innerHTML = rows.map(([label, value, secret]) => `<dt>${escapeAdminHtml(label)}</dt><dd${secret ? ' class="is-secret"' : ''}>${escapeAdminHtml(value)}</dd>`).join('');
  $('#negocioCopyStatus').textContent = '';
  $('#negocioCreatedDialog').showModal(); $('#negocioCopyCredentials').focus();
}
function closeCreatedDialog() {
  const dialog = $('#negocioCreatedDialog'); if (dialog.open) dialog.close();
  lastCreated = null; $('#negocioCreatedSummary').innerHTML = ''; // la contraseña no queda en la página
}
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* sin permiso: método clásico */ }
  const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  $('#negocioCreatedDialog').appendChild(area); area.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove(); return ok;
}
async function handleCopyCredentials() {
  if (!lastCreated) return;
  const ok = await copyToClipboard(credentialsText(lastCreated));
  $('#negocioCopyStatus').textContent = ok ? '✅ Credenciales copiadas. Pégalas en WhatsApp para enviarlas al cliente.' : '⚠ No se pudo copiar automáticamente. Selecciona y copia los datos manualmente.';
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const email = $('#adminEmail').value.trim().toLowerCase(), password = $('#adminPassword').value;
  const errorEl = $('#adminLoginError'), submit = $('#adminLoginSubmit');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errorEl.textContent = 'Escribe un correo electrónico válido.'; return; }
  if (!password) { errorEl.textContent = 'Escribe la contraseña.'; return; }
  submit.disabled = true; submit.textContent = 'Verificando…'; errorEl.textContent = '';
  const result = await adminSignIn(email, password);
  submit.disabled = false; submit.textContent = 'Ingresar al panel';
  if (!result.ok) { errorEl.textContent = result.error; $('#adminPassword').value = ''; return $('#adminPassword').focus(); }
  $('#adminPassword').value = '';
  showDashboard(result.user);
}
async function handleLogout() {
  try { await getAdminClient()?.auth.signOut({ scope: 'local' }); } catch { /* sin conexión: se descarta la sesión local */ }
  showLoginView();
}

async function initAdmin() {
  $('#adminLoginForm').addEventListener('submit', handleLoginSubmit);
  $('#adminLogout').addEventListener('click', handleLogout);
  $('#adminRefresh').addEventListener('click', () => loadNegocios());
  $('#adminNewNegocio').addEventListener('click', openNegocioDialog);
  $('#negocioForm').addEventListener('submit', handleNegocioSubmit);
  $('#negocioNombre').addEventListener('input', () => { if (!$('#negocioId').dataset.touched) $('#negocioId').value = slugifyNegocioId($('#negocioNombre').value); });
  $('#negocioId').addEventListener('input', event => { event.target.dataset.touched = event.target.value ? '1' : ''; }); // vacío: vuelve a sugerir
  $('#negocioGeneratePassword').addEventListener('click', () => { $('#negocioPassword').value = generatePassword(); $('#negocioPassword').focus(); });
  $('#negocioCopyCredentials').addEventListener('click', handleCopyCredentials);
  document.querySelectorAll('[data-close-negocio]').forEach(btn => btn.addEventListener('click', closeNegocioDialog));
  document.querySelectorAll('[data-close-created]').forEach(btn => btn.addEventListener('click', closeCreatedDialog));
  $('#negocioDialog').addEventListener('cancel', () => { $('#negocioPassword').value = ''; });
  $('#negocioCreatedDialog').addEventListener('close', closeCreatedDialog);
  $('#deleteNegocioForm').addEventListener('submit', handleDeleteSubmit);
  $('#deleteNegocioConfirm').addEventListener('input', event => { $('#deleteNegocioSubmit').disabled = !deleting || !deleteConfirmMatches(event.target.value, deleting.id); $('#deleteNegocioError').textContent = ''; });
  document.querySelectorAll('[data-close-delete]').forEach(btn => btn.addEventListener('click', closeDeleteDialog));
  $('#deleteNegocioDialog').addEventListener('close', () => { deleting = null; });
  $('#negociosBody').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    if (button.dataset.action === 'reload') return loadNegocios();
    applyNegocioChange(button.dataset.id, button.dataset.action);
  });

  const sb = getAdminClient();
  if (!sb) return showLoginView('No se pudo cargar Supabase. Revisa tu conexión a internet y recarga.');
  sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' && !$('#adminApp').hidden) showLoginView('La sesión se cerró. Ingresa de nuevo.'); });
  try {
    const { data } = await sb.auth.getSession();
    const user = data?.session?.user;
    if (user && isSuperadmin(user)) return showDashboard(user);
    if (user) await sb.auth.signOut({ scope: 'local' }); // sesión válida pero sin rol: no se reutiliza
    showLoginView(user ? NOT_SUPERADMIN : '');
  } catch {
    showLoginView();
  }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && !globalThis.__IS_NODE_TEST__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAdmin); else initAdmin();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isSuperadmin, computeMetrics, expiryInfo, statusPayload, escapeAdminHtml, adminSignIn, fetchNegocios, updateNegocio, NOT_SUPERADMIN, EXTEND_DAYS, slugifyNegocioId, generatePassword, buildCreatePayload, describeCreateError, credentialsText, createNegocio, planLabel, otherPlan, deleteNegocio, deleteConfirmMatches, describeDeleteError };
}
