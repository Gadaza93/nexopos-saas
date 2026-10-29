/* Brasa POS · módulos adicionales
   Roles y PIN, auditoría, facturas editables, proveedores y costo promedio,
   mermas y conteo físico, reportes analíticos y exportación a Excel/PDF.
   Se carga ANTES de app.js: aquí solo hay declaraciones; el arranque ocurre en DOMContentLoaded. */

// Funciones por plan (planAllows, requirePlan…) viven en planes.js (cargado antes en index.html); en Node (pruebas) se carga aquí.
if (typeof module !== 'undefined' && typeof globalThis.planAllows !== 'function') require('./planes.js');

/* ============ Roles, permisos y PIN ============ */
const ROLE_LABELS = { admin: 'Administrador', cajero: 'Cajero', mesero: 'Mesero' };
// Edita esta tabla para ajustar lo que puede hacer cada rol. '*' = todo.
const ROLE_PERMS = {
  admin: '*',
  cajero: ['view.pos', 'view.invoices', 'view.inventory', 'view.purchases', 'order', 'charge', 'cancelOrder', 'shift', 'purchases', 'inventory', 'merma'],
  mesero: ['view.pos', 'order'],
};
const PIN_LENGTH = 4;
let session = null; // id del usuario con sesión iniciada
let loginTarget = null, loginPin = '', loginFails = 0, loginLockUntil = 0;
let editingUserId = null, forcedPinChange = false;

function me() { return session ? state.users.find(u => u.id === session && u.active !== false) || null : null; }
function can(perm) {
  const isDemo = typeof isDemoMode === 'function' ? isDemoMode() : !!globalThis.isDemoMode?.();
  if (isDemo) return true;
  const user = me();
  if (!user) return false;
  const perms = ROLE_PERMS[user.role];
  return perms === '*' || (Array.isArray(perms) && perms.includes(perm));
}
function actor() { const user = me(); return { userId: user?.id || null, userName: user?.name || '' }; }
globalThis.me = me;
globalThis.can = can;
globalThis.actor = actor;
function deny() { showToast('Tu rol no tiene permiso para esta acción.'); }
function guard(name, perm) { const original = globalThis[name]; if (typeof original !== 'function') return; globalThis[name] = function (...args) { if (!can(perm)) { deny(); return; } return original.apply(this, args); }; }
function planGuard(name, feature) { const original = globalThis[name]; if (typeof original !== 'function') return; globalThis[name] = function (...args) { if (!requirePlan(feature)) return; return original.apply(this, args); }; }
function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'; }
function fmtDateTime(ts) { return new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }

function cyrb53(str, seed = 0) { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); }
function hashPin(pin, salt) { return cyrb53(`${salt}:${pin}`); }
function uid(prefix = 'id') { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
globalThis.uid = globalThis.uid || uid;
function newUser(name, role, pin) { const salt = Math.random().toString(36).slice(2, 10); return { id: uid('usr'), name, role, salt, pinHash: hashPin(pin, salt), active: true, createdAt: Date.now() }; }
function setUserPin(user, pin) { user.salt = Math.random().toString(36).slice(2, 10); user.pinHash = hashPin(pin, user.salt); user.pinAt = Date.now(); } // pinAt: el PIN más reciente gana al sincronizar
globalThis.cyrb53 = cyrb53;
globalThis.hashPin = hashPin;
globalThis.setUserPin = setUserPin;

/* Completa los datos nuevos al cargar o restaurar un respaldo (se llama desde normalizeState). */
function ensureExtras(s) {
  // Se clonan para no compartir referencias con defaultState ni con el respaldo importado.
  ['users', 'suppliers', 'stockLog', 'auditLog', 'backupLog'].forEach(key => { s[key] = Array.isArray(s[key]) ? structuredClone(s[key]) : []; });
  s.backupSettings = { ...BACKUP_DEFAULTS, ...(s.backupSettings || {}) };
  s.invoiceCounter = Number(s.invoiceCounter || 0);
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    s.users = [
      {
        id: 'u_demo_guest',
        name: 'Invitado Demo',
        role: 'admin',
        active: true,
        mustChangePin: false,
        salt: 'demo_salt',
        pinHash: hashPin('1234', 'demo_salt'),
        createdAt: Date.now()
      }
    ];
  } else if (!s.users.length) {
    const existingPin = s.profile?.admin_pin || s.profile?.adminPin;
    const admin = newUser('Administrador', 'admin', existingPin || '1234');
    admin.mustChangePin = !existingPin;
    s.users.push(admin);
  }
  (s.purchases || []).forEach(purchase => {
    if (purchase.supplierId || !purchase.supplier) return;
    let supplier = s.suppliers.find(item => item.name.toLowerCase() === String(purchase.supplier).toLowerCase());
    if (!supplier) { supplier = { id: uid('sup'), name: purchase.supplier, nit: '', phone: '', notes: '' }; s.suppliers.push(supplier); }
    purchase.supplierId = supplier.id;
  });
  const numberOf = p => parseInt(String(p.invoiceNo || '').replace(/\D/g, ''), 10);
  let counter = Math.max(s.invoiceCounter, ...(s.payments || []).map(p => numberOf(p)).filter(Number.isFinite), 0);
  [...(s.payments || [])].filter(p => !p.invoiceNo).sort((a, b) => paymentTimestamp(a) - paymentTimestamp(b)).forEach(p => { counter++; p.invoiceNo = `FAC-${String(counter).padStart(5, '0')}`; });
  s.invoiceCounter = counter;
}
globalThis.ensureExtras = ensureExtras;
function nextInvoiceNo() { state.invoiceCounter = Number(state.invoiceCounter || 0) + 1; return `FAC-${String(state.invoiceCounter).padStart(5, '0')}`; }
function afterStateReplaced() { if (!me()) showLogin(); }

function logAudit(action, detail = '', extra = {}) {
  state.auditLog.push({ id: uid('aud'), at: Date.now(), userId: me()?.id || null, userName: me()?.name || 'Sistema', action, detail, ...extra });
  if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 1000);
}

function requireOpenShift() {
  const isOpen = (typeof isShiftOpen === 'function' ? isShiftOpen() : (globalThis.isShiftOpen ? globalThis.isShiftOpen() : (globalThis.state?.cashShift?.status === 'open')));
  if (isOpen) return true;
  if (typeof can === 'function' && can('shift')) {
    document.querySelector('#openShiftDialog')?.showModal?.();
    if (typeof showToast === 'function') showToast('Debes abrir un turno de caja antes de registrar movimientos.');
  } else {
    if (typeof showToast === 'function') showToast('La caja está cerrada. Pide al cajero o al administrador que abra el turno.');
  }
  return false;
}
globalThis.requireOpenShift = requireOpenShift;

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active-view', v.id === id));
  document.querySelectorAll('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  const button = document.querySelector(`.nav-link[data-view="${id}"]`);
  document.querySelector('#pageTitle').textContent = button ? button.textContent.replace(/\d+/g, '').trim() : '';
}
function applyPermissions() {
  document.querySelectorAll('[data-perm]').forEach(el => { el.hidden = !can(el.dataset.perm); });
  const active = document.querySelector('.view.active-view'), nav = active && document.querySelector(`.nav-link[data-view="${active.id}"]`);
  if (me() && nav && nav.hidden) showView('pos');
  if (typeof applyPlanGates === 'function') applyPlanGates(); // etiquetas PRO y candados del plan (planes.js)
}
function renderUserChip() { const user = me(), chip = document.querySelector('#userChip'); chip.hidden = !user; chip.textContent = user ? initials(user.name) : '?'; chip.title = user ? `${user.name} · ${ROLE_LABELS[user.role]}` : ''; }

/* ---------- Inicio de sesión con PIN ---------- */
function renderLogin() {
  document.querySelector('#loginTitle').textContent = 'NexoPos';
  const active = state.users.filter(u => u.active !== false), target = state.users.find(u => u.id === loginTarget);
  document.querySelector('#loginUsers').hidden = !!target; document.querySelector('#loginPinBox').hidden = !target;
  const roleOk = u => typeof planAllowsRole !== 'function' || planAllowsRole(u.role);
  document.querySelector('#loginUsers').innerHTML = active.map(u => `<button class="login-user${roleOk(u) ? '' : ' plan-locked'}" data-login-user="${u.id}"${roleOk(u) ? '' : ' title="Varios usuarios y roles: Plan Pro"'}><span class="mini-avatar">${escapeHtml(initials(u.name))}</span><strong>${escapeHtml(u.name)}</strong><small>${escapeHtml(ROLE_LABELS[u.role] || u.role)}</small>${roleOk(u) ? '' : '<span class="pro-tag">PRO</span>'}</button>`).join('');
  document.querySelector('#loginWho').textContent = target ? target.name : '';
  const forgotPin = document.querySelector('#forgotPinButton'); if (forgotPin) forgotPin.hidden = typeof isDemoMode === 'function' && isDemoMode();
  document.querySelectorAll('#pinDots i').forEach((dot, index) => dot.classList.toggle('filled', index < loginPin.length));
  const firstRun = state.users.find(u => u.mustChangePin && u.role === 'admin');
  document.querySelector('#loginHint').textContent = firstRun ? `Primer ingreso: usuario «${firstRun.name}», PIN 1234. Se te pedirá cambiarlo.` : '';
}
function setLoginError(message) { document.querySelector('#loginError').textContent = message || ''; }
function showLogin() {
  session = null; sessionStorage.removeItem('brasa-session'); loginTarget = null; loginPin = ''; setLoginError('');
  document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'loginDialog') d.close(); });
  renderLogin(); const dialog = document.querySelector('#loginDialog'); if (!dialog.open) dialog.showModal(); applyPermissions(); renderUserChip();
  if (typeof enforceSubscription === 'function') enforceSubscription(); // la suscripción suspendida queda por encima del login
}
function pressPin(key) {
  if (!loginTarget) return;
  if (Date.now() < loginLockUntil) return setLoginError(`Demasiados intentos. Espera ${Math.ceil((loginLockUntil - Date.now()) / 1000)} s.`);
  if (key === 'back') loginPin = loginPin.slice(0, -1); else if (/^\d$/.test(key) && loginPin.length < PIN_LENGTH) loginPin += key;
  setLoginError(''); renderLogin(); if (loginPin.length === PIN_LENGTH) attemptLogin();
}
function attemptLogin() {
  const user = state.users.find(u => u.id === loginTarget);
  if (user && typeof planAllowsRole === 'function' && !planAllowsRole(user.role)) { loginTarget = null; loginPin = ''; renderLogin(); return requirePlan('multiRole', 'El Plan Básico incluye un solo usuario administrador. Mejora a Pro para que meseros y cajeros entren con su propio PIN.'); }
  if (user && user.active !== false && hashPin(loginPin, user.salt) === user.pinHash) { loginFails = 0; return completeLogin(user); }
  loginFails++; loginPin = '';
  if (loginFails >= 5) { loginLockUntil = Date.now() + 30000; loginFails = 0; setLoginError('Demasiados intentos. Espera 30 segundos.'); } else setLoginError('PIN incorrecto.');
  renderLogin();
}
function completeLogin(user) {
  session = user.id; sessionStorage.setItem('brasa-session', user.id); user.lastLogin = Date.now(); saveState();
  loginTarget = null; loginPin = ''; document.querySelector('#loginDialog').close();
  applyPermissions(); renderAll(); showView('pos'); showToast(`Hola, ${user.name}.`);
  if (user.mustChangePin) openPinDialog(true);
  if (typeof enforceSubscription === 'function') enforceSubscription(); // licencia vencida o sin verificar (sin cuentas abiertas)
}
/* ---------- ¿Olvidaste tu PIN? ----------
   Solo el PIN de administrador se restablece aquí, y solo con la contraseña maestra del negocio (verificada en Supabase,
   con internet). Meseros y cajeros se lo piden al administrador (Equipo → Editar). El PIN nuevo llega a las demás cajas
   por syncAdminPin. Si también olvidaron la contraseña maestra, se abre la recuperación por correo (app.js). */
let pinRecoveryUserId = null;
function setPinRecoveryMessage(text, info = false) { const el = document.querySelector('#pinRecoveryMessage'); el.textContent = text || ''; el.classList.toggle('is-info', info); }
function openPinRecovery() {
  const user = state.users.find(u => u.id === loginTarget); if (!user) return;
  if (user.role !== 'admin') return setLoginError('Pide al administrador que restablezca tu PIN en Equipo → Editar.');
  if (!state.terminal?.businessId) return setLoginError('Esta caja no está vinculada a un negocio: no se puede verificar la contraseña maestra.');
  pinRecoveryUserId = user.id;
  const $ = s => document.querySelector(s);
  $('#pinRecoveryEmail').value = state.terminal.email || '';
  ['#pinRecoveryPassword', '#pinRecoveryPin', '#pinRecoveryPin2'].forEach(s => { $(s).value = ''; });
  setPinRecoveryMessage(''); $('#pinRecoverySubmit').disabled = false;
  $('#pinRecoveryDialog').showModal();
  ($('#pinRecoveryEmail').value ? $('#pinRecoveryPassword') : $('#pinRecoveryEmail')).focus();
}
async function savePinRecovery(event) {
  event.preventDefault();
  const $ = s => document.querySelector(s), user = state.users.find(u => u.id === pinRecoveryUserId); if (!user) return;
  const email = $('#pinRecoveryEmail').value.trim().toLowerCase(), password = $('#pinRecoveryPassword').value, pin = $('#pinRecoveryPin').value.trim(), confirm = $('#pinRecoveryPin2').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setPinRecoveryMessage('Escribe un correo electrónico válido.'); return $('#pinRecoveryEmail').focus(); }
  if (!password) { setPinRecoveryMessage('Escribe la contraseña maestra.'); return $('#pinRecoveryPassword').focus(); }
  if (!/^\d{4}$/.test(pin)) { setPinRecoveryMessage('El PIN debe tener exactamente 4 números.'); return $('#pinRecoveryPin').focus(); }
  if (pin !== confirm) { setPinRecoveryMessage('Los dos PIN no coinciden.'); return $('#pinRecoveryPin2').focus(); }
  $('#pinRecoverySubmit').disabled = true; setPinRecoveryMessage('Verificando la contraseña maestra…', true);
  const result = globalThis.NexoSync?.activateTerminal ? await NexoSync.activateTerminal(email, password) : { ok: false, error: 'El módulo de sincronización no cargó. Recarga la app.' };
  $('#pinRecoverySubmit').disabled = false;
  if (!result.ok) return setPinRecoveryMessage(result.error);
  if (result.businessId !== state.terminal?.businessId) {
    await NexoSync.signOutTerminal();
    return setPinRecoveryMessage(`Estas credenciales son de otro negocio. Esta caja está vinculada a «${state.terminal?.businessId}».`);
  }
  setUserPin(user, pin); user.mustChangePin = false;
  state.terminal = { ...state.terminal, email: result.email };
  logAudit('PIN restablecido', `${user.name} · con la contraseña maestra`);
  saveState();
  if (globalThis.NexoSync?.syncAdminPin) NexoSync.syncAdminPin(pin, user).catch(err => console.warn('[NexoSync] Error syncAdminPin:', err));
  $('#pinRecoveryDialog').close();
  completeLogin(user);
  showToast('PIN restablecido. Ya puedes entrar con el PIN nuevo.');
}
function openSessionDialog() { const user = me(); if (!user) return; document.querySelector('#sessionName').textContent = user.name; document.querySelector('#sessionRole').textContent = ROLE_LABELS[user.role]; document.querySelector('#sessionDialog').showModal(); }
function openPinDialog(forced = false) { forcedPinChange = forced; document.querySelector('#newPin').value = ''; document.querySelector('#confirmPin').value = ''; document.querySelector('#pinDialogClose').hidden = forced; document.querySelector('#pinForcedNote').hidden = !forced; document.querySelector('#sessionDialog').close(); document.querySelector('#pinDialog').showModal(); }
function savePin() {
  const user = me(); if (!user) return;
  const pin = document.querySelector('#newPin').value.trim(), confirm = document.querySelector('#confirmPin').value.trim();
  if (!/^\d{4}$/.test(pin)) return showToast('El PIN debe tener exactamente 4 números.');
  if (pin !== confirm) return showToast('Los dos PIN no coinciden.');
  if (hashPin(pin, user.salt) === user.pinHash) return showToast('Elige un PIN diferente al actual.');
  setUserPin(user, pin); user.mustChangePin = false; logAudit('PIN cambiado', user.name); saveState();
  forcedPinChange = false; document.querySelector('#pinDialog').close(); renderAll(); showToast('PIN actualizado.');
  if (user.role === 'admin' && globalThis.NexoSync?.syncAdminPin) {
    globalThis.NexoSync.syncAdminPin(pin, user).catch(err => console.warn('[NexoSync] Error syncAdminPin:', err));
  }
}

/* ---------- Equipo y bitácora ---------- */
function renderTeam() {
  if (!can('view.team')) return;
  document.querySelector('#teamTable').innerHTML = state.users.map(u => `<tr><td><strong>${escapeHtml(u.name)}</strong></td><td>${escapeHtml(ROLE_LABELS[u.role] || u.role)}</td><td><span class="status ${u.active === false ? 'low' : 'good'}">${u.active === false ? 'Inactivo' : 'Activo'}</span></td><td>${u.lastLogin ? fmtDateTime(u.lastLogin) : '—'}</td><td><button class="mini-action" data-edit-user="${u.id}">Editar</button></td></tr>`).join('');
  const rows = [...state.auditLog].reverse().slice(0, 40);
  document.querySelector('#auditTable').innerHTML = rows.map(e => `<tr><td>${fmtDateTime(e.at)}</td><td>${escapeHtml(e.userName || '')}</td><td><strong>${escapeHtml(e.action)}</strong></td><td>${escapeHtml(e.detail || '')}</td><td>${escapeHtml(e.reason || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aún no hay movimientos auditados.</td></tr>';
}
function openUserDialog(id = null) {
  if (!can('team')) return deny();
  if (!id && !planAllows('multiRole') && state.users.some(u => u.active !== false)) return requirePlan('multiRole');
  editingUserId = id; const user = id && state.users.find(u => u.id === id);
  document.querySelector('#userDialogTitle').textContent = user ? 'Editar usuario' : 'Nuevo usuario';
  document.querySelector('#userName').value = user?.name || ''; document.querySelector('#userRole').value = user?.role || 'mesero';
  document.querySelectorAll('#userRole option').forEach(o => { o.disabled = !planAllowsRole(o.value) && o.value !== user?.role; }); // Básico: solo administrador
  if (!user && !planAllowsRole(document.querySelector('#userRole').value)) document.querySelector('#userRole').value = 'admin';
  document.querySelector('#userPin').value = ''; document.querySelector('#userActive').checked = user ? user.active !== false : true;
  document.querySelector('#userPinLabel').textContent = user ? 'Nuevo PIN de 4 dígitos (vacío = no cambiar)' : 'PIN de 4 dígitos';
  document.querySelector('#userDialog').showModal();
}
function saveUser() {
  if (!can('team')) return deny();
  const name = document.querySelector('#userName').value.trim(), role = document.querySelector('#userRole').value, pin = document.querySelector('#userPin').value.trim(), active = document.querySelector('#userActive').checked;
  const user = editingUserId && state.users.find(u => u.id === editingUserId);
  if (!name) return showToast('Escribe el nombre del usuario.');
  if ((!user && !/^\d{4}$/.test(pin)) || (user && pin && !/^\d{4}$/.test(pin))) return showToast('El PIN debe tener exactamente 4 números.');
  if (state.users.some(u => u.id !== editingUserId && u.name.toLowerCase() === name.toLowerCase())) return showToast('Ya existe un usuario con ese nombre.');
  // Plan Básico: un solo usuario activo y solo administrador. Un negocio que bajó de plan conserva sus usuarios, pero no suma otros ni asigna roles.
  if (!planAllows('multiRole')) {
    const activeNow = state.users.filter(u => u.active !== false).length, activeAfter = state.users.filter(u => u.id !== editingUserId && u.active !== false).length + (active ? 1 : 0);
    if (activeAfter > 1 && activeAfter > activeNow) return requirePlan('multiRole');
    if (!planAllowsRole(role) && (!user || user.role !== role)) return requirePlan('multiRole');
  }
  const otherAdmins = state.users.filter(u => u.id !== editingUserId && u.role === 'admin' && u.active !== false).length;
  if (!otherAdmins && !(role === 'admin' && active)) return showToast('Debe existir al menos un administrador activo.');
  if (user) {
    const changes = [];
    if (user.name !== name) changes.push(`nombre «${user.name}» → «${name}»`); if (user.role !== role) changes.push(`rol ${ROLE_LABELS[user.role]} → ${ROLE_LABELS[role]}`); if ((user.active !== false) !== active) changes.push(active ? 'reactivado' : 'desactivado'); if (pin) changes.push('PIN restablecido');
    Object.assign(user, { name, role, active });
    if (pin) {
      setUserPin(user, pin);
      user.mustChangePin = user.id !== me()?.id;
      if (user.role === 'admin' && globalThis.NexoSync?.syncAdminPin) {
        globalThis.NexoSync.syncAdminPin(pin, user).catch(err => console.warn('[NexoSync] Error syncAdminPin:', err));
      }
    }
    logAudit('Usuario editado', `${name}${changes.length ? ': ' + changes.join(', ') : ''}`);
  } else {
    const created = newUser(name, role, pin);
    created.mustChangePin = true;
    state.users.push(created);
    if (created.role === 'admin' && globalThis.NexoSync?.syncAdminPin) {
      globalThis.NexoSync.syncAdminPin(pin, created).catch(err => console.warn('[NexoSync] Error syncAdminPin:', err));
    }
    logAudit('Usuario creado', `${name} · ${ROLE_LABELS[role]}`);
  }
  saveState(); document.querySelector('#userDialog').close(); renderAll(); if (!me()) showLogin(); showToast('Usuario guardado.');
}

/* ============ Facturas: ver, corregir y eliminar ============ */
const invoiceFilter = { date: '', method: '', q: '' }; // date: '' = hoy · 'all' = todas · 'AAAA-MM-DD'
let invoiceDraft = null, invoiceToDelete = null;

function invoiceCardMarkup(payment, { actions = false } = {}) {
  const who = [payment.waiterName && `Mesero: ${escapeHtml(payment.waiterName)}`, payment.cashierName && `Cajero: ${escapeHtml(payment.cashierName)}`].filter(Boolean).join(' · ');
  const edited = payment.editedAt ? `<span class="badge-edited" title="${escapeHtml((payment.edits || []).slice(-1)[0]?.reason || '')}">Editada · ${fmtDateTime(payment.editedAt)}</span>` : '';
  // Reimprimir: cualquiera que vea las facturas; editar/eliminar: solo con permiso invoiceEdit
  const editButtons = can('invoiceEdit') ? `<button class="mini-action" data-edit-invoice="${payment.id}">Editar</button><button class="mini-action delete-action" data-delete-invoice="${payment.id}">Eliminar</button>` : '';
  const buttons = actions ? `<div class="invoice-actions"><button class="mini-action" data-print-invoice="${payment.id}" title="Reimprimir ticket">🖨 Imprimir</button>${editButtons}</div>` : '';
  return `<article class="invoice-card"><div class="invoice-head"><div><strong>${escapeHtml(payment.invoiceNo || 'FAC')} · ${escapeHtml(payment.customer || 'Venta mostrador')}</strong><span>${new Date(paymentTimestamp(payment)).toLocaleString('es-CO')} · ${escapeHtml(payment.method)}${who ? ' · ' + who : ''}</span>${edited}</div><b>${money.format(payment.amount)}</b></div>${invoiceItemsMarkup(payment)}${buttons}</article>`;
}
function renderRecentInvoices() {
  const invoices = [...state.payments].sort((a, b) => paymentTimestamp(b) - paymentTimestamp(a)).slice(0, 5);
  document.querySelector('#recentInvoices').innerHTML = invoices.length ? invoices.map(p => invoiceCardMarkup(p, { actions: true })).join('') : '<p class="muted">Aún no hay facturas cobradas.</p>';
}
function filteredInvoices() {
  const f = invoiceFilter, day = f.date === 'all' ? null : (f.date || today()), q = f.q.trim().toLowerCase();
  return [...state.payments].filter(p => (!day || p.date === day) && (!f.method || p.method === f.method || (Array.isArray(p.payments) && p.payments.some(t => t.method === f.method))) && (!q || [p.invoiceNo, p.customer, p.waiterName, p.cashierName, ...(p.items || []).map(i => i.name)].join(' ').toLowerCase().includes(q))).sort((a, b) => paymentTimestamp(b) - paymentTimestamp(a));
}
function renderInvoices() {
  if (!can('view.invoices')) return;
  const list = filteredInvoices(), total = list.reduce((s, p) => s + p.amount, 0), edited = list.filter(p => p.editedAt).length;
  document.querySelector('#invoiceDate').value = invoiceFilter.date === 'all' ? '' : (invoiceFilter.date || today());
  document.querySelector('#invoiceSummary').innerHTML = `<div class="summary-item"><span>Facturas</span><strong>${list.length}</strong></div><div class="summary-item"><span>Total</span><strong>${money.format(total)}</strong></div><div class="summary-item ${edited ? 'warning' : ''}"><span>Editadas</span><strong>${edited}</strong></div>`;
  document.querySelector('#invoiceList').innerHTML = (list.slice(0, 100).map(p => invoiceCardMarkup(p, { actions: true })).join('') || '<p class="muted">No hay facturas con esos filtros.</p>') + (list.length > 100 ? `<p class="muted history-more">Mostrando las 100 más recientes de ${list.length}. Afina la búsqueda para ver otras.</p>` : '');
}

/* Ajusta el inventario cuando cambia lo vendido: soldDelta > 0 descuenta, < 0 devuelve. */
function adjustSoldStock(item, soldDelta) {
  if (!soldDelta) return;
  consumeModifiers(item, soldDelta); // insumos de las adiciones (adición de queso…)
  const nowIso = new Date().toISOString();
  const apply = (supply, amount) => { supply.qty = Math.max(0, Number((supply.qty - amount).toFixed(2))); };
  const prod = state.products.find(p => p.id === (item.productId || item.id) || (item.inventoryId && p.inventoryId === item.inventoryId));
  // Plato preparado: se mueven sus insumos (receta guardada en la venta; si es una venta vieja, la actual del producto)
  if (item.tipo === 'preparado' || isPrepared(prod)) return consumeRecipe(recipeLines(item).length ? item : prod, soldDelta);
  const invId = item.inventoryId || prod?.inventoryId || (prod ? `stock-${prod.id}` : null);
  const supply = invId ? state.inventory.find(i => i.id === invId) : null;

  if (prod) {
    const prevStock = Number(prod.stock != null ? prod.stock : (supply?.qty ?? 0));
    prod.stock = Number((prevStock - soldDelta).toFixed(2)); // sin tope en 0: la nube aplica la misma diferencia
    prod.updated_at = nowIso;
    prod.sync_status = 'pending';
  }
  if (supply) {
    supply.qty = prod ? prod.stock : Number((supply.qty - soldDelta).toFixed(2));
  }

  // Receta con insumos secundarios distintos al producto (omitir si es el mismo insumo)
  Object.entries(item.recipe || {}).forEach(([id, amount]) => {
    if (id === invId || id === supply?.id || id === prod?.inventoryId || id === prod?.id) return;
    const sup = state.inventory.find(i => i.id === id);
    if (sup) {
      apply(sup, amount * soldDelta);
    }
  });
}
function draftTotal() { return (invoiceDraft?.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0); }
function openInvoiceEdit(id) {
  if (!can('invoiceEdit')) return deny();
  const payment = state.payments.find(p => p.id === id); if (!payment) return;
  invoiceDraft = { id, customer: payment.customer || '', method: payment.method, items: structuredClone(payment.items || []), tenders: invoiceTendersOf(payment) };
  document.querySelector('#invoiceDialogNo').textContent = payment.invoiceNo || 'FACTURA';
  document.querySelector('#invoiceCustomer').value = invoiceDraft.customer;
  const standardMethods = ['Efectivo', 'Nequi', 'Daviplata', 'Tarjeta / Datáfono', 'Transferencia'];
  const allMethods = Array.from(new Set([...standardMethods, payment.method].filter(Boolean)));
  document.querySelector('#invoiceMethodEdit').innerHTML = allMethods.map(m => `<option ${payment.method === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  document.querySelector('#invoiceAddProduct').innerHTML = state.products.map(p => `<option value="${p.id}">${escapeHtml(p.name)} · ${money.format(p.price)}</option>`).join('');
  document.querySelector('#invoiceReason').value = '';
  const warning = document.querySelector('#invoiceWarning'), closedShift = !isShiftOpen() || payment.shiftId !== state.cashShift?.id;
  warning.hidden = !closedShift; warning.textContent = closedShift ? 'Esta factura pertenece a un turno de caja que ya cerró. El cierre guardado de ese turno no se recalcula; la corrección sí queda en reportes y bitácora.' : '';
  renderInvoiceDraft(); document.querySelector('#invoiceDialog').showModal();
}
/* Desglose de pagos de una factura. La caja (cashSalesToday / otherSalesToday), el arqueo Z y el reporte de WhatsApp
   suman payment.payments: toda corrección reescribe ese desglose junto con payment.method y payment.amount. */
function invoiceTendersOf(payment) {
  const list = Array.isArray(payment.payments) && payment.payments.length ? payment.payments : [{ method: payment.method || 'Efectivo', amount: payment.amount }];
  return list.map(t => { const venta = tenderSale(t); return { method: t.method, amount: venta, received: Math.max(venta, (Number(t.received) || Number(t.amount) || 0) - tenderTip(t)), change: Number(t.change) || 0 }; }); // sin la propina: se edita solo el consumo
}
// Un solo medio: el monto sigue al total (en efectivo se conserva lo recibido si alcanza). Pago mixto: las filas editadas.
function rebuildInvoiceTenders(original, draftTenders, method, total) {
  if (draftTenders.length <= 1) {
    const prev = original[0], keepCash = method === 'Efectivo' && prev?.method === 'Efectivo' && prev.received >= total;
    return [{ method, amount: total, received: keepCash ? prev.received : total, change: keepCash ? prev.received - total : 0 }];
  }
  return draftTenders.map((t, i) => {
    const prev = original[i];
    return prev && prev.method === t.method && prev.amount === t.amount ? { ...prev } : { method: t.method, amount: t.amount, received: t.amount, change: 0 };
  });
}
function tendersMethodLabel(tenders) { return tenders.length === 1 ? tenders[0].method : tenders.map(t => t.method).join(' + '); }
function renderInvoiceTenders() {
  const box = document.querySelector('#invoiceTendersBox'); if (!box || !invoiceDraft) return;
  const mixed = invoiceDraft.tenders.length > 1, select = document.querySelector('#invoiceMethodEdit');
  box.hidden = !mixed; if (select) select.disabled = mixed;
  if (!mixed) return;
  const methods = Array.from(new Set([...(typeof PAYMENT_METHODS !== 'undefined' ? PAYMENT_METHODS : ['Efectivo']), ...invoiceDraft.tenders.map(t => t.method)].filter(Boolean)));
  document.querySelector('#invoiceTenders').innerHTML = invoiceDraft.tenders.map((t, i) => `<div class="invoice-tender-row"><select data-inv-tender="${i}" data-inv-tender-field="method" aria-label="Medio de pago">${methods.map(m => `<option ${m === t.method ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select><input type="number" min="0" step="100" value="${t.amount}" data-inv-tender="${i}" data-inv-tender-field="amount" aria-label="Monto" /><button class="remove-line" data-remove-inv-tender="${i}" title="Quitar este medio">×</button></div>`).join('');
  renderInvoiceTendersStatus();
}
function renderInvoiceTendersStatus() {
  const el = document.querySelector('#invoiceTendersStatus'); if (!el || !invoiceDraft || invoiceDraft.tenders.length < 2) return;
  const sum = invoiceDraft.tenders.reduce((s, t) => s + (Number(t.amount) || 0), 0), total = draftTotal(), diff = total - sum;
  el.textContent = diff === 0 ? `El desglose cuadra con el total (${money.format(total)}).` : `El desglose suma ${money.format(sum)}: ${diff > 0 ? 'faltan' : 'sobran'} ${money.format(Math.abs(diff))} para el total de ${money.format(total)}.`;
  el.className = diff === 0 ? 'muted' : 'warn-text';
}
function renderInvoiceDraft() {
  if (!invoiceDraft) return; const original = state.payments.find(p => p.id === invoiceDraft.id), total = draftTotal(), diff = total - (original?.amount || 0);
  document.querySelector('#invoiceLines').innerHTML = invoiceDraft.items.map((item, index) => `<div class="invoice-line"><strong>${escapeHtml(item.name)}</strong><input type="number" min="0" step="1" value="${item.qty}" data-inv-line="${index}" data-inv-field="qty" aria-label="Cantidad" /><input type="number" min="0" step="100" value="${item.price}" data-inv-line="${index}" data-inv-field="price" aria-label="Precio unitario" /><b>${money.format((Number(item.price) || 0) * (Number(item.qty) || 0))}</b><button class="remove-line" data-remove-inv-line="${index}" aria-label="Quitar producto">×</button></div>`).join('');
  document.querySelector('#invoiceNewTotal').textContent = money.format(total);
  document.querySelector('#invoiceDiff').textContent = diff === 0 ? 'El total no cambia.' : `Total original ${money.format(original?.amount || 0)} · diferencia ${diff > 0 ? '+' : '−'}${money.format(Math.abs(diff))}`;
  renderInvoiceTenders();
}
function addInvoiceLine() {
  if (!invoiceDraft) return; const product = state.products.find(p => p.id === document.querySelector('#invoiceAddProduct').value); if (!product) return;
  const found = invoiceDraft.items.find(i => lineKey(i) === product.id); // una línea sin adiciones
  if (found) found.qty = Number(found.qty) + 1; else invoiceDraft.items.push({ productId: product.id, name: product.name, price: product.price, cost: Number(product.cost || 0), qty: 1, inventoryId: product.inventoryId, recipe: product.recipe, category: product.category, ...(isPrepared(product) ? { tipo: 'preparado', receta: structuredClone(recipeLines(product)) } : {}) });
  renderInvoiceDraft();
}
function saveInvoiceEdit() {
  if (!can('invoiceEdit')) return deny(); if (!invoiceDraft) return;
  const payment = state.payments.find(p => p.id === invoiceDraft.id); if (!payment) return;
  const reason = document.querySelector('#invoiceReason').value.trim();
  if (reason.length < 3) return showToast('Escribe el motivo de la corrección.');
  const draftItems = invoiceDraft.items.map(i => ({ ...i, qty: Number(i.qty) || 0, price: Number(i.price) || 0 }));
  const linesKey = list => JSON.stringify(list.map(i => [i.name, Number(i.qty) || 0, Number(i.price) || 0]));
  // Parte de una cuenta dividida en partes iguales: sus líneas (abono / ajuste) cuadran con las demás partes; solo se corrige el pago o el cliente
  if (payment.splitShare && linesKey(draftItems) !== linesKey(payment.items || [])) return showToast('Esta factura es una parte de una cuenta dividida: solo se puede corregir el medio de pago o el cliente. Para cambiar productos, elimínala y vuelve a cobrar.');
  const items = payment.splitShare ? structuredClone(payment.items || []) : draftItems.filter(i => i.qty > 0);
  if (!payment.splitShare) {
    if (!items.length) return showToast('La factura necesita al menos un producto. Si todo fue un error, elimínala.');
    if (items.some(i => !Number.isInteger(i.qty) || i.price < 0)) return showToast('Las cantidades deben ser enteras y los precios no pueden ser negativos.');
  }
  const newAmount = items.reduce((s, i) => s + i.price * i.qty, 0);
  const draftTenders = invoiceDraft.tenders.map(t => ({ method: String(t.method || '').trim(), amount: Math.round(Number(t.amount) || 0) }));
  if (draftTenders.length > 1) {
    if (draftTenders.some(t => !t.method || t.amount <= 0)) return showToast('Cada medio del pago mixto necesita un monto mayor a $0.');
    const sum = draftTenders.reduce((s, t) => s + t.amount, 0);
    if (sum !== newAmount) return showToast(`El desglose del pago suma ${money.format(sum)} y la factura ${money.format(newAmount)}. Ajusta los montos.`);
  }
  const tip = paymentTip(payment), shares = tipShares(draftTenders.length > 1 ? draftTenders.map(t => t.amount) : [newAmount], tip);
  // La propina no se edita aquí: se vuelve a repartir entre los medios del desglose corregido
  const tenders = rebuildInvoiceTenders(invoiceTendersOf(payment), draftTenders, document.querySelector('#invoiceMethodEdit').value, newAmount)
    .map((t, i) => { const share = shares[i] || 0; if (!share) return t; const amount = t.amount + share, received = Math.max(Number(t.received) || 0, amount); return { ...t, amount, tip: share, received, change: received - amount }; });
  const before = { customer: payment.customer, method: payment.method, amount: payment.amount, items: structuredClone(payment.items || []), payments: structuredClone(payment.payments || []) };
  if (!payment.splitShare) {
    const oldQty = {}, newQty = {}, sample = {};
    // Por línea: una adición cambia lo que se descuenta (lineKey); la nube sigue contando por producto (productId)
    before.items.forEach(i => { const k = lineKey(i); oldQty[k] = (oldQty[k] || 0) + i.qty; sample[k] = i; });
    items.forEach(i => { const k = lineKey(i); newQty[k] = (newQty[k] || 0) + i.qty; sample[k] = i; });
    new Set([...Object.keys(oldQty), ...Object.keys(newQty)]).forEach(id => {
      const soldDelta = (newQty[id] || 0) - (oldQty[id] || 0);
      adjustSoldStock(sample[id], soldDelta);
      globalThis.NexoSync?.addSaleStockDelta?.(payment, sample[id].productId, soldDelta); // la nube aplica la misma diferencia al subir la factura
    });
  }
  payment.items = items; payment.amount = newAmount;
  payment.customer = document.querySelector('#invoiceCustomer').value.trim() || payment.customer;
  payment.payments = tenders; payment.method = tendersMethodLabel(tenders); if (tip) payment.tip = tip;
  payment.sync_status = 'pending'; // la corrección también se sube a Supabase (monto, productos y desglose)
  payment.editedAt = Date.now(); payment.editedBy = actor().userName; payment.edits = [...(payment.edits || []), { at: payment.editedAt, by: payment.editedBy, reason, before }];
  globalThis.marcarHistorialModificado?.('payments', payment); // su mes se reescribe en IndexedDB aunque sea antiguo
  logAudit('Factura editada', `${payment.invoiceNo} · ${money.format(before.amount)} → ${money.format(payment.amount)}${before.method !== payment.method ? ` · ${before.method} → ${payment.method}` : ''}`, { reason, data: { before } });
  saveState(); invoiceDraft = null; document.querySelector('#invoiceDialog').close(); renderAll(); showToast(`${payment.invoiceNo} corregida.`);
}
function openInvoiceDelete(id) {
  if (!can('invoiceEdit')) return deny(); const payment = state.payments.find(p => p.id === id); if (!payment) return;
  invoiceToDelete = id;
  document.querySelector('#invoiceDeleteSummary').innerHTML = `<strong>${escapeHtml(payment.invoiceNo)} · ${escapeHtml(payment.customer || 'Venta mostrador')}</strong><span>${money.format(payment.amount)} · ${escapeHtml(payment.method)}</span>${invoiceItemsMarkup(payment)}`;
  document.querySelector('#invoiceRestoreStock').checked = true; document.querySelector('#invoiceDeleteReason').value = '';
  document.querySelector('#invoiceDeleteDialog').showModal();
}
function confirmDeleteInvoice() {
  if (!can('invoiceEdit')) return deny(); const payment = state.payments.find(p => p.id === invoiceToDelete); if (!payment) return;
  const reason = document.querySelector('#invoiceDeleteReason').value.trim(); if (reason.length < 3) return showToast('Escribe el motivo para eliminar la factura.');
  const restore = document.querySelector('#invoiceRestoreStock').checked;
  if (restore) (payment.items || []).forEach(item => adjustSoldStock(item, -item.qty));
  if (globalThis.NexoSync?.deleteSale) {
    globalThis.NexoSync.deleteSale(payment.id);
  }
  state.payments = state.payments.filter(p => p.id !== payment.id);
  const reopened = reopenSplitShare(payment);
  logAudit('Factura eliminada', `${payment.invoiceNo} · ${payment.customer || 'Venta mostrador'} · ${money.format(payment.amount)} · ${payment.method}${restore ? ' · inventario devuelto' : ''}`, { reason, data: structuredClone(payment) });
  saveState(); invoiceToDelete = null; document.querySelector('#invoiceDeleteDialog').close(); renderAll();
  if (reopened && globalThis.NexoSync?.syncOrders) globalThis.NexoSync.syncOrders().catch(() => {});
  showToast(reopened ? `${payment.invoiceNo} eliminada. ${reopened.parts.length === 1 ? `La parte ${reopened.parts[0]}` : `Las partes ${reopened.parts.join(', ')}`} de ${reopened.tableName} vuelve${reopened.parts.length === 1 ? '' : 'n'} a quedar pendiente${reopened.parts.length === 1 ? '' : 's'}: saldo ${money.format(reopened.pending)}.` : `${payment.invoiceNo} eliminada.`);
}
// Factura de una parte de un cobro en partes iguales con la mesa aún abierta: su cuota vuelve a quedar pendiente.
// (Si la mesa ya se cerró, la factura se elimina como cualquier otra y la mesa no se reabre.)
function reopenSplitShare(payment) {
  const order = payment.splitShare && typeof getOrder === 'function' ? getOrder(payment.splitShare.orderId) : null;
  if (!order?.equalSplit || typeof isOrderOpen !== 'function' || !isOrderOpen(order)) return null;
  const paid = order.equalSplit.paid || [], parts = paid.filter(p => p.paymentId === payment.id).map(p => p.part);
  if (!parts.length) return null;
  order.equalSplit.paid = paid.filter(p => p.paymentId !== payment.id);
  order.paidAmount = Math.max(0, (Number(order.paidAmount) || 0) - (Number(payment.amount) || 0));
  if (!order.equalSplit.paid.length) delete order.equalSplit; // sin partes cobradas, la cuenta se puede volver a dividir libremente
  if (typeof touchOrder === 'function') touchOrder(order);
  return { parts, tableName: order.tableName, pending: orderPending(order) };
}

/* ============ Proveedores y costo promedio ============ */
let editingSupplierId = null;
function defaultUnitCost(product, unit = product?.unit) {
  const cost = Number(product?.lastCost ?? product?.cost ?? 0);
  return product?.unit && unit && unit !== product.unit ? Math.round(cost * convertUnits(1, unit, product.unit)) : cost; // insumo: costo en la unidad de compra
}
function upsertSupplier(name) {
  const clean = name.trim(); let supplier = state.suppliers.find(s => s.name.toLowerCase() === clean.toLowerCase());
  if (!supplier) { supplier = { id: uid('sup'), name: clean, nit: '', phone: '', notes: '' }; state.suppliers.push(supplier); }
  return supplier;
}
function supplierStats(supplier) { const list = state.purchases.filter(p => p.supplierId === supplier.id); return { count: list.length, total: list.reduce((s, p) => s + p.total, 0), last: list.map(p => p.date).sort().pop() || '' }; }
function renderSuppliers() {
  document.querySelector('#supplierOptions').innerHTML = state.suppliers.map(s => `<option value="${escapeHtml(s.name)}"></option>`).join('');
  document.querySelector('#suppliersTable').innerHTML = state.suppliers.map(s => { const st = supplierStats(s); return `<tr><td><strong>${escapeHtml(s.name)}</strong>${s.notes ? `<br><small class="muted">${escapeHtml(s.notes)}</small>` : ''}</td><td>${escapeHtml(s.nit || '—')}</td><td>${escapeHtml(s.phone || '—')}</td><td>${st.count}</td><td>${money.format(st.total)}</td><td>${st.last ? formatDate(st.last) : '—'}</td><td><div class="product-actions"><button class="mini-action" data-edit-supplier="${s.id}">Editar</button><button class="mini-action delete-action" data-delete-supplier="${s.id}">Eliminar</button></div></td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">Aún no hay proveedores. Se crean solos al registrar una factura de compra.</td></tr>';
}
function openSupplierDialog(id = null) {
  if (!can('purchases')) return deny(); editingSupplierId = id; const s = id && state.suppliers.find(x => x.id === id);
  document.querySelector('#supplierDialogTitle').textContent = s ? 'Editar proveedor' : 'Nuevo proveedor';
  document.querySelector('#supplierName').value = s?.name || ''; document.querySelector('#supplierNit').value = s?.nit || ''; document.querySelector('#supplierPhone').value = s?.phone || ''; document.querySelector('#supplierNotes').value = s?.notes || '';
  document.querySelector('#supplierDialog').showModal();
}
function saveSupplier() {
  if (!can('purchases')) return deny(); const name = document.querySelector('#supplierName').value.trim(); if (!name) return showToast('Escribe el nombre del proveedor.');
  if (state.suppliers.some(s => s.id !== editingSupplierId && s.name.toLowerCase() === name.toLowerCase())) return showToast('Ya existe un proveedor con ese nombre.');
  const data = { name, nit: document.querySelector('#supplierNit').value.trim(), phone: document.querySelector('#supplierPhone').value.trim(), notes: document.querySelector('#supplierNotes').value.trim() };
  const existing = editingSupplierId && state.suppliers.find(s => s.id === editingSupplierId);
  if (existing) { Object.assign(existing, data); state.purchases.forEach(p => { if (p.supplierId === existing.id) { p.supplier = name; globalThis.marcarHistorialModificado?.('purchases', p); } }); } else state.suppliers.push({ id: uid('sup'), ...data });
  saveState(); document.querySelector('#supplierDialog').close(); renderAll(); showToast('Proveedor guardado.');
}
function deleteSupplier(id) {
  if (!can('purchases')) return deny(); const s = state.suppliers.find(x => x.id === id); if (!s) return;
  const st = supplierStats(s); if (st.count) return showToast(`${s.name} tiene ${st.count} facturas de compra y no se puede eliminar.`);
  if (!window.confirm(`¿Eliminar al proveedor ${s.name}?`)) return;
  state.suppliers = state.suppliers.filter(x => x.id !== id); saveState(); renderAll(); showToast('Proveedor eliminado.');
}

/* Productos: costo promedio ponderado (ya no solo el último costo). */
function renderProducts() {
  renderModifierGroups();
  const tbody = document.querySelector('#productsTable');
  if (!state.products || state.products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:36px 16px;font-size:14px;">No hay productos registrados. Crea uno nuevo o importa tu archivo Excel.</td></tr>';
    return;
  }
  tbody.innerHTML = state.products.map(product => {
    const prepared = isPrepared(product), stock = !prepared && state.inventory.find(item => item.id === product.inventoryId);
    const cost = prepared ? recipeCost(product) : Number(product.cost || 0), profit = Number(product.price || 0) - cost, margin = cost ? profit / cost * 100 : 0;
    const last = !prepared && product.lastCost !== undefined && Math.round(product.lastCost) !== Math.round(cost) ? `<br><small class="muted">Última compra ${money.format(product.lastCost)}</small>` : '';
    const portions = prepared ? preparedAvailable(product) : null;
    const existencias = prepared ? `<span class="recipe-tag">Receta · ${recipeLines(product).length} insumo${recipeLines(product).length === 1 ? '' : 's'}</span><br><small class="${portions === 0 ? 'text-danger' : 'muted'}">${portions === null ? 'Sin insumos' : portions === 0 ? 'Faltan insumos' : `Alcanza para ${portions}`}</small>` : stock ? `${formatQty(stock.qty)} ${escapeHtml(stock.unit)}` : '<span class="muted">Sin stock</span>';
    return `<tr><td><strong>${escapeHtml(product.name)}</strong></td><td>${escapeHtml(product.category || 'Sin categoría')}</td><td>${money.format(cost)}${prepared ? '<br><small class="muted">Según receta</small>' : ''}${last}</td><td><strong>${money.format(product.price)}</strong></td><td><strong>${money.format(profit)}</strong></td><td>${cost ? `${margin.toFixed(1)}%` : '<span class="muted">—</span>'}</td><td>${existencias}</td><td><div class="product-actions"><button class="mini-action" data-edit-product="${product.id}">Editar</button><button class="mini-action delete-action" data-delete-product="${product.id}">Eliminar</button></div></td></tr>`;
  }).join('');
}
globalThis.renderProducts = renderProducts;
function savePurchase() {
  if (!requireOpenShift()) return;
  const supplierName = document.querySelector('#purchaseSupplier').value.trim(), invoice = document.querySelector('#purchaseInvoice').value.trim(), date = document.querySelector('#purchaseDate').value, method = document.querySelector('#purchaseMethod').value;
  if (!supplierName || !invoice || !date) return showToast('Indica proveedor, número y fecha de la factura.');
  if (purchaseDraft.some(line => !line.productId || line.qty <= 0 || line.unitCost < 0)) return showToast('Revisa cantidades y costos de la factura.');
  const supplier = upsertSupplier(supplierName);
  if (purchaseDraft.some(line => !state.products.some(p => p.id === line.productId) && !insumoById(line.productId))) return showToast('Hay un producto o insumo que ya no existe en la factura.');
  const lines = purchaseDraft.map(line => { const product = state.products.find(item => item.id === line.productId), ins = !product && insumoById(line.productId); return { ...line, productName: (product || ins).name, ...(ins ? { insumoId: ins.id, unit: line.unit || ins.unit } : {}), total: line.qty * line.unitCost }; });
  lines.forEach(line => {
    if (line.insumoId) {
      // Insumo: se compra en cualquier unidad compatible (bulto en kg, caja en und…); stock y costo promedio quedan en su unidad
      const ins = insumoById(line.insumoId), qty = roundInsumoQty(convertUnits(line.qty, line.unit, ins.unit)), before = Math.max(0, Number(ins.qty) || 0), costBefore = Number(ins.cost) || 0;
      if (!(qty > 0)) return;
      const unitCost = line.total / qty;
      ins.cost = Math.round((before > 0 && costBefore > 0 ? (before * costBefore + line.total) / (before + qty) : unitCost) * 100) / 100;
      ins.lastCost = Math.round(unitCost * 100) / 100;
      ins.qty = roundInsumoQty((Number(ins.qty) || 0) + qty); ins.updatedAt = Date.now(); ins.sync_status = 'pending'; // costo nuevo
      line.avgCostAfter = ins.cost;
      return;
    }
    const product = state.products.find(item => item.id === line.productId), supply = state.inventory.find(item => item.id === product?.inventoryId);
    const stockBefore = supply ? Math.max(0, Number(supply.qty || 0)) : Math.max(0, Number(product?.stock || 0));
    const newStock = Number((stockBefore + line.qty).toFixed(2));
    if (supply) supply.qty = newStock;
    if (product) {
      product.stock = newStock;
      product.updated_at = new Date().toISOString();
      product.sync_status = 'pending';
      const costBefore = Number(product.cost || 0);
      const average = stockBefore > 0 && costBefore > 0 ? (stockBefore * costBefore + line.qty * line.unitCost) / (stockBefore + line.qty) : line.unitCost;
      line.avgCostAfter = Math.round(average * 100) / 100;
      product.cost = line.avgCostAfter;
      product.lastCost = line.unitCost;
    }
  });
  refreshPreparedCosts(); // los platos cambian de costo con el nuevo promedio de sus insumos
  const total = lines.reduce((sum, line) => sum + line.total, 0);
  state.purchases.push({
    id: uid('buy'),
    supplier: supplier.name,
    supplierId: supplier.id,
    invoice,
    date,
    method,
    lines,
    total,
    createdAt: Date.now(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    shiftId: state.cashShift.id,
    userName: actor().userName,
    sync_status: 'pending'
  });
  saveState();
  document.querySelector('#purchaseDialog').close();
  renderAll();
  showToast('Factura guardada: inventario sumado y costo promedio actualizado.');
  if (globalThis.NexoSync?.syncAll) {
    globalThis.NexoSync.syncAll().catch(() => {});
  }
}

/* ============ Insumos y recetas ============
   Insumos (state.insumos): ingredientes que no se venden solos. Cada uno tiene su unidad de manejo (kg, g, lb, L, ml, und):
   en ella se guardan stock, mínimo y costo (cost = $ por esa unidad). No van en state.inventory, porque getPOSProducts
   convierte en producto vendible todo artículo de inventario sin producto.
   Producto preparado (tipo 'preparado'): sin stock propio ni artículo de inventario. Su receta (receta: [{ insumoId, qty, unit }],
   por porción) descuenta insumos al cobrar y su costo es la suma de la receta. Se vende aunque falten insumos (stock negativo). */
const INSUMO_UNITS = {
  kg: { dim: 'masa', factor: 1000, label: 'kg' }, g: { dim: 'masa', factor: 1, label: 'g' }, lb: { dim: 'masa', factor: 500, label: 'lb (500 g)' },
  L: { dim: 'volumen', factor: 1000, label: 'L' }, ml: { dim: 'volumen', factor: 1, label: 'ml' }, und: { dim: 'unidad', factor: 1, label: 'und' }
};
function compatibleUnits(unit) { const dim = INSUMO_UNITS[unit]?.dim; return Object.keys(INSUMO_UNITS).filter(u => INSUMO_UNITS[u].dim === dim); }
function convertUnits(qty, from, to) { const a = INSUMO_UNITS[from], b = INSUMO_UNITS[to]; return a && b && a.dim === b.dim ? (Number(qty) || 0) * a.factor / b.factor : (Number(qty) || 0); }
function roundInsumoQty(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function insumoById(id) { return (state.insumos || []).find(i => i.id === id) || null; }
function isPrepared(product) { return product?.tipo === 'preparado'; }
function recipeLines(source) { return Array.isArray(source?.receta) ? source.receta.filter(l => l && l.insumoId && Number(l.qty) > 0) : []; }
function recipeLineUse(line, insumo = insumoById(line.insumoId)) { return insumo ? convertUnits(line.qty, line.unit || insumo.unit, insumo.unit) : 0; } // en la unidad del insumo
function recipeCost(source) { return Math.round(recipeLines(source).reduce((sum, line) => { const ins = insumoById(line.insumoId); return sum + (ins ? recipeLineUse(line, ins) * (Number(ins.cost) || 0) : 0); }, 0)); }
// Porciones que alcanzan con el stock actual (null = receta vacía)
function preparedAvailable(product) {
  let min = Infinity;
  recipeLines(product).forEach(line => { const ins = insumoById(line.insumoId), use = recipeLineUse(line, ins); if (ins && use > 0) min = Math.min(min, Math.floor((Number(ins.qty) || 0) / use + 1e-9)); });
  return Number.isFinite(min) ? Math.max(0, min) : null;
}
// soldQty > 0 descuenta, < 0 devuelve. Sin tope en 0: vender sin insumos deja el stock en negativo (se corrige con compras o conteo).
function consumeRecipe(source, soldQty) {
  if (!soldQty) return;
  recipeLines(source).forEach(line => { const ins = insumoById(line.insumoId); if (!ins) return; ins.qty = roundInsumoQty((Number(ins.qty) || 0) - recipeLineUse(line, ins) * soldQty); ins.updatedAt = Date.now(); });
}
// El costo de un preparado sigue al de sus insumos (cambia con cada compra)
function refreshPreparedCosts() { (state.products || []).filter(isPrepared).forEach(p => { const cost = recipeCost(p); if (cost !== Number(p.cost)) { p.cost = cost; p.sync_status = 'pending'; p.updated_at = new Date().toISOString(); } }); }
function insumoStatus(ins) { return ins.qty <= 0 ? ['status-out', 'Agotado'] : ins.qty <= ins.min ? ['status-low', 'Bajo stock'] : ['status-good', 'Disponible']; }
function insumoUsage(id) { return (state.products || []).filter(p => isPrepared(p) && recipeLines(p).some(l => l.insumoId === id)); }

let editingInsumoId = null;
let insumoForRecipe = false; // abierto con «+ Crear insumo» desde la receta del producto
function openInsumoDialog(id = null, { forRecipe = false } = {}) {
  const ins = id ? insumoById(id) : null; editingInsumoId = ins?.id || null;
  insumoForRecipe = forRecipe && !ins;
  const unitEl = document.querySelector('#insumoUnit');
  unitEl.innerHTML = (ins ? compatibleUnits(ins.unit) : Object.keys(INSUMO_UNITS)).map(u => `<option value="${u}">${INSUMO_UNITS[u].label}</option>`).join('');
  unitEl.value = ins?.unit || 'kg';
  document.querySelector('#insumoName').value = ins?.name || '';
  document.querySelector('#insumoQty').value = ins ? roundInsumoQty(ins.qty) : '';
  document.querySelector('#insumoQty').disabled = Boolean(ins); // con el insumo creado, el stock cambia por compras, ajustes, mermas o conteo
  document.querySelector('#insumoMin').value = ins ? roundInsumoQty(ins.min) : '';
  document.querySelector('#insumoCost').value = ins ? Math.round(ins.cost) : '';
  document.querySelector('#insumoDialog h2').textContent = ins ? 'Editar insumo' : 'Nuevo insumo';
  document.querySelector('#deleteInsumoButton').hidden = !ins;
  updateInsumoUnitLabels();
  document.querySelector('#insumoDialog').showModal();
}
function updateInsumoUnitLabels() { const unit = document.querySelector('#insumoUnit')?.value || 'kg'; document.querySelectorAll('[data-insumo-unit-label]').forEach(el => { el.textContent = unit; }); }
function saveInsumo() {
  const name = document.querySelector('#insumoName').value.trim(), unit = document.querySelector('#insumoUnit').value;
  const qty = Number(document.querySelector('#insumoQty').value || 0), min = Number(document.querySelector('#insumoMin').value || 0), cost = Number(document.querySelector('#insumoCost').value || 0);
  if (!name || !INSUMO_UNITS[unit]) return showToast('Escribe el nombre y la unidad del insumo.');
  if (qty < 0 || min < 0 || cost < 0) return showToast('Las cantidades y el costo no pueden ser negativos.');
  if ((state.insumos || []).some(i => i.id !== editingInsumoId && i.name.toLowerCase() === name.toLowerCase())) return showToast('Ya existe un insumo con ese nombre.');
  let ins = editingInsumoId && insumoById(editingInsumoId);
  if (ins) {
    // Cambio de unidad (misma magnitud): el stock se convierte; mínimo y costo se escriben ya en la unidad nueva
    if (unit !== ins.unit) ins.qty = roundInsumoQty(convertUnits(ins.qty, ins.unit, unit));
    Object.assign(ins, { name, unit, min, cost, updatedAt: Date.now(), sync_status: 'pending' });
  } else {
    ins = { id: uid('ins'), name, unit, qty, min, cost, createdAt: Date.now(), updatedAt: Date.now(), sync_status: 'pending' };
    state.insumos = [...(state.insumos || []), ins];
    if (qty) logStock({ type: 'ajuste', reasonCategory: 'Stock inicial', itemId: ins.id, itemName: name, unit, delta: qty, cost, value: qty * cost, reason: 'Stock inicial' });
  }
  refreshPreparedCosts(); saveState(); document.querySelector('#insumoDialog').close(); renderAll();
  if (insumoForRecipe && !editingInsumoId) { insumoForRecipe = false; return useNewInsumoInRecipe(ins); }
  showToast(editingInsumoId ? 'Insumo actualizado.' : 'Insumo creado.');
}
function deleteInsumo(id = editingInsumoId) {
  const ins = insumoById(id); if (!ins) return;
  const used = insumoUsage(id);
  if (used.length) return showToast(`${ins.name} está en la receta de ${used.map(p => p.name).slice(0, 3).join(', ')}${used.length > 3 ? '…' : ''}. Quítalo de esas recetas primero.`);
  if (!window.confirm(`¿Eliminar el insumo ${ins.name}?`)) return;
  state.insumos = state.insumos.filter(i => i.id !== id);
  if (Number.isFinite(ins.qtySynced)) state.deletedInsumoIds = [...new Set([...(state.deletedInsumoIds || []), id])]; // la nube lo marca inactivo
  logAudit('Insumo eliminado', `${ins.name} · ${formatQty(ins.qty)} ${ins.unit}`);
  saveState(); document.querySelector('#insumoDialog')?.close(); renderAll(); showToast('Insumo eliminado.');
}
function renderInsumos() {
  const tbody = document.querySelector('#insumosTable'); if (!tbody) return;
  const list = [...(state.insumos || [])].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  tbody.innerHTML = list.length ? list.map(ins => {
    const [cls, label] = insumoStatus(ins), used = insumoUsage(ins.id).length;
    return `<tr><td><strong>${escapeHtml(ins.name)}</strong><br><small class="muted">${used ? `En ${used} receta${used === 1 ? '' : 's'}` : 'Sin recetas'}</small></td><td><b>${formatQty(roundInsumoQty(ins.qty))}</b> ${escapeHtml(ins.unit)}</td><td>${formatQty(roundInsumoQty(ins.min))} ${escapeHtml(ins.unit)}</td><td>${money.format(ins.cost || 0)} / ${escapeHtml(ins.unit)}</td><td><span class="status ${cls}">${label}</span></td><td><div class="product-actions"><button class="mini-action" data-edit-insumo="${ins.id}">Editar</button><button class="mini-action" data-adjust="${ins.id}">Ajustar</button></div></td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:28px 16px;">Aún no hay insumos. Crea los ingredientes de tus platos (arroz, carne, aceite…) para armar sus recetas.</td></tr>';
}

/* Receta en el formulario de producto (recipeDraft mientras está abierto) */
let recipeDraft = [];
function fillProductRecipe(product) {
  const prepared = isPrepared(product);
  document.querySelector('#productType').value = prepared ? 'preparado' : 'reventa';
  recipeDraft = prepared ? structuredClone(recipeLines(product)) : [];
  toggleProductType();
}
function toggleProductType() {
  const prepared = document.querySelector('#productType').value === 'preparado';
  document.querySelector('#productStockFields').hidden = prepared;
  document.querySelector('#productRecipeFields').hidden = !prepared;
  const costEl = document.querySelector('#productCost'); costEl.readOnly = prepared; costEl.title = prepared ? 'Se calcula con la receta' : '';
  if (prepared && !recipeDraft.length && (state.insumos || []).length) addRecipeLine();
  else renderRecipeDraft();
}
// El insumo recién creado desde la receta queda puesto en ella (reutiliza la última línea si quedó vacía)
function useNewInsumoInRecipe(ins) {
  const last = recipeDraft[recipeDraft.length - 1], line = { insumoId: ins.id, qty: 0, unit: defaultRecipeUnit(ins.unit) };
  if (last && !(Number(last.qty) > 0)) Object.assign(last, line); else recipeDraft.push(line);
  renderRecipeDraft();
  showToast(`${ins.name} creado y agregado a la receta: indica la cantidad por porción.`);
}
function addRecipeLine() {
  const first = (state.insumos || [])[0];
  if (!first) return openInsumoDialog(null, { forRecipe: true }); // sin insumos: se crea el primero aquí mismo
  recipeDraft.push({ insumoId: first.id, qty: 0, unit: defaultRecipeUnit(first.unit) });
  renderRecipeDraft();
}
// En recetas se piensa en gramos y mililitros
function defaultRecipeUnit(unit) { return { kg: 'g', lb: 'g', L: 'ml' }[unit] || unit; }
function renderRecipeDraft() {
  const box = document.querySelector('#recipeLines'); if (!box) return;
  const insumos = [...(state.insumos || [])].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  box.innerHTML = recipeDraft.length ? recipeDraft.map((line, index) => {
    const ins = insumoById(line.insumoId), units = ins ? compatibleUnits(ins.unit) : [line.unit];
    const lineCost = ins ? recipeLineUse(line, ins) * (Number(ins.cost) || 0) : 0;
    return `<div class="recipe-line"><select data-recipe-index="${index}" data-recipe-field="insumoId" aria-label="Insumo">${insumos.map(i => `<option value="${i.id}"${i.id === line.insumoId ? ' selected' : ''}>${escapeHtml(i.name)}</option>`).join('')}</select><input data-recipe-index="${index}" data-recipe-field="qty" type="number" min="0" step="any" inputmode="decimal" value="${line.qty || ''}" placeholder="0" aria-label="Cantidad por porción" /><select data-recipe-index="${index}" data-recipe-field="unit" aria-label="Unidad">${units.map(u => `<option value="${u}"${u === line.unit ? ' selected' : ''}>${u}</option>`).join('')}</select><span class="recipe-line-cost">${money.format(Math.round(lineCost))}</span><button type="button" class="remove-line" data-remove-recipe-line="${index}" aria-label="Quitar insumo">×</button></div>`;
  }).join('') : `<p class="muted recipe-empty">${(state.insumos || []).length ? 'Agrega los insumos de una porción.' : 'Aún no hay insumos: usa «+ Crear insumo».'}</p>`;
  updateRecipeSummary();
}
function updateRecipeSummary() {
  const el = document.querySelector('#recipeSummary'); if (!el) return;
  const cost = recipeCost({ receta: recipeDraft }), price = Number(document.querySelector('#productPrice')?.value || 0), profit = price - cost;
  if (document.querySelector('#productType')?.value === 'preparado') document.querySelector('#productCost').value = cost;
  el.innerHTML = `<span>Costo por porción <b>${money.format(cost)}</b></span>${price ? `<span>Ganancia <b>${money.format(profit)}</b></span><span>Costo ${Math.round(cost / price * 100)}% del precio</span>` : ''}`;
}
function updateRecipeDraft(target) {
  const line = recipeDraft[Number(target.dataset.recipeIndex)]; if (!line) return;
  const field = target.dataset.recipeField;
  if (field === 'insumoId') { const ins = insumoById(target.value); line.insumoId = target.value; if (ins && !compatibleUnits(ins.unit).includes(line.unit)) line.unit = defaultRecipeUnit(ins.unit); return renderRecipeDraft(); }
  if (field === 'unit') { line.unit = target.value; return renderRecipeDraft(); }
  line.qty = Number(target.value || 0);
  const cost = target.closest?.('.recipe-line')?.querySelector('.recipe-line-cost'), ins = insumoById(line.insumoId);
  if (cost && ins) cost.textContent = money.format(Math.round(recipeLineUse(line, ins) * (Number(ins.cost) || 0)));
  updateRecipeSummary();
}
function removeRecipeLine(index) { recipeDraft.splice(Number(index), 1); renderRecipeDraft(); }
// Guarda un producto preparado (lo llama saveProduct cuando el tipo es «Preparado con receta»)
function savePreparedProduct({ name, category, price, editingId }) {
  const receta = recipeDraft.filter(l => insumoById(l.insumoId) && Number(l.qty) > 0).map(l => ({ insumoId: l.insumoId, qty: Number(l.qty), unit: l.unit }));
  if (!name || !(price > 0)) return showToast('Completa nombre y precio de venta.');
  if (!receta.length) return showToast('Agrega al menos un insumo con su cantidad a la receta.');
  if (!state.categories.includes(category)) state.categories.push(category);
  let product = editingId && state.products.find(p => p.id === editingId);
  if (product && product.inventoryId) {
    // Pasa de reventa a preparado: su stock propio deja de existir (si no, getPOSProducts lo volvería un producto aparte)
    const supply = state.inventory.find(i => i.id === product.inventoryId);
    if (supply && supply.qty > 0 && !window.confirm(`${product.name} tiene ${formatQty(supply.qty)} ${supply.unit} en stock propio. Un plato preparado no lleva stock propio: se descuentan sus insumos. ¿Continuar?`)) return;
    state.inventory = state.inventory.filter(i => i.id !== product.inventoryId);
    delete product.inventoryId;
  }
  const fields = { name, category, price, cost: recipeCost({ receta }), tipo: 'preparado', receta, recipe: {}, image: pendingProductImage, sync_status: 'pending' };
  if (product) Object.assign(product, fields);
  else { product = { id: uid('prod'), icon: '🍽️', ...fields }; state.products.push(product); }
  saveState(); document.querySelector('#productDialog').close(); renderAll();
  showToast(editingId ? 'Plato actualizado.' : 'Plato creado con su receta.');
  return product;
}
globalThis.isPrepared = isPrepared;
globalThis.preparedAvailable = preparedAvailable;
globalThis.consumeRecipe = consumeRecipe;
globalThis.recipeCost = recipeCost;

/* ============ Adiciones y modificadores ============
   Grupos reutilizables en state.profile.modifierGroups (viajan en negocios.configuracion con el perfil, sin migración):
   { id, name, mode: 'una' | 'una-opcional' | 'varias', options: [{ id, name, price, insumoId?, qty?, unit? }], productIds }.
   Al agregar un producto con grupos se eligen las opciones; la línea del pedido lleva lineId propio (producto + opciones),
   modifiers (copia de lo elegido), price = precio + adiciones, cost con los insumos de las adiciones y name con las
   opciones: totales, recibo, comanda, división de cuenta y reportes funcionan sin cambios. Al cobrar, las opciones con
   insumo lo descuentan (consumeModifiers, desde deductInventory y adjustSoldStock). */
const MODIFIER_MODES = { una: 'Elegir una (obligatorio)', 'una-opcional': 'Elegir una (opcional)', varias: 'Elegir varias (opcional)' };
function modifierGroups() { return Array.isArray(state.profile?.modifierGroups) ? state.profile.modifierGroups : []; }
function productModifierGroups(productId) { return modifierGroups().filter(g => (g.productIds || []).includes(productId) && (g.options || []).length); }
function modifiersLabel(mods) { return (mods || []).map(m => (Number(m.price) > 0 ? `+ ${m.name}` : m.name)).join(', '); }
function modifiersLineId(productId, mods) { return mods?.length ? `${productId}|${mods.map(m => m.optionId).sort().join(',')}` : String(productId); }
function modifiersRecipe(mods) { return { receta: (mods || []).filter(m => m.insumoId && Number(m.qty) > 0).map(m => ({ insumoId: m.insumoId, qty: Number(m.qty), unit: m.unit })) }; }
function modifiersCost(mods) { return recipeCost(modifiersRecipe(mods)); }
function consumeModifiers(item, qty) { if (item?.modifiers?.length) consumeRecipe(modifiersRecipe(item.modifiers), qty); }

/* Elegir opciones al agregar el producto al pedido */
let modifierPick = null; // { productId, selected: { groupId: [optionId] } }
function openModifierDialog(productId) {
  const product = state.products.find(p => p.id === productId); if (!product) return;
  modifierPick = { productId, selected: {} };
  document.querySelector('#modifierPickTitle').textContent = product.name;
  renderModifierPick();
  document.querySelector('#modifierPickDialog').showModal();
}
function renderModifierPick() {
  if (!modifierPick) return;
  const product = state.products.find(p => p.id === modifierPick.productId), groups = productModifierGroups(modifierPick.productId);
  document.querySelector('#modifierPickGroups').innerHTML = groups.map(g => {
    const chosen = modifierPick.selected[g.id] || [], multi = g.mode === 'varias';
    return `<fieldset class="modifier-group"><legend>${escapeHtml(g.name)} <small class="${g.mode === 'una' ? 'required' : 'muted'}">${g.mode === 'una' ? 'Obligatorio' : multi ? 'Puedes elegir varias' : 'Opcional'}</small></legend>${g.options.map(o => `<button type="button" class="modifier-option${chosen.includes(o.id) ? ' active' : ''}" data-modifier-group="${escapeHtml(g.id)}" data-modifier-option="${escapeHtml(o.id)}"><span>${escapeHtml(o.name)}</span>${Number(o.price) > 0 ? `<b>+ ${money.format(o.price)}</b>` : ''}</button>`).join('')}</fieldset>`;
  }).join('');
  const mods = pickedModifiers(), total = Number(product?.price || 0) + mods.reduce((s, m) => s + (Number(m.price) || 0), 0);
  document.querySelector('#modifierPickTotal').textContent = money.format(total);
}
function toggleModifierOption(groupId, optionId) {
  const g = modifierGroups().find(x => x.id === groupId); if (!g || !modifierPick) return;
  const chosen = modifierPick.selected[groupId] || [];
  if (g.mode === 'varias') modifierPick.selected[groupId] = chosen.includes(optionId) ? chosen.filter(id => id !== optionId) : [...chosen, optionId];
  else modifierPick.selected[groupId] = chosen.includes(optionId) && g.mode === 'una-opcional' ? [] : [optionId]; // la obligatoria no se puede dejar vacía
  renderModifierPick();
}
function pickedModifiers() {
  if (!modifierPick) return [];
  return productModifierGroups(modifierPick.productId).flatMap(g => (modifierPick.selected[g.id] || []).map(optionId => {
    const o = g.options.find(x => x.id === optionId); if (!o) return null;
    return { groupId: g.id, groupName: g.name, optionId: o.id, name: o.name, price: Number(o.price) || 0, ...(o.insumoId && Number(o.qty) > 0 ? { insumoId: o.insumoId, qty: Number(o.qty), unit: o.unit } : {}) };
  }).filter(Boolean));
}
function confirmModifierPick() {
  if (!modifierPick) return;
  const faltan = productModifierGroups(modifierPick.productId).filter(g => g.mode === 'una' && !(modifierPick.selected[g.id] || []).length);
  if (faltan.length) return showToast(`Elige: ${faltan.map(g => g.name).join(', ')}.`);
  const { productId } = modifierPick, mods = pickedModifiers();
  modifierPick = null; document.querySelector('#modifierPickDialog').close();
  addProduct(productId, mods);
}

/* Administrar grupos (Productos → Adiciones y modificadores) */
let modifierDraft = null;
function renderModifierGroups() {
  const box = document.querySelector('#modifierGroupsList'); if (!box) return;
  const groups = modifierGroups();
  box.innerHTML = groups.length ? groups.map(g => `<div class="modifier-group-row"><div><strong>${escapeHtml(g.name)}</strong><small class="muted">${MODIFIER_MODES[g.mode] || ''} · ${g.options.map(o => escapeHtml(o.name) + (Number(o.price) > 0 ? ` (+${money.format(o.price)})` : '')).join(', ') || 'sin opciones'}</small><small class="muted">${(g.productIds || []).length ? `En ${(g.productIds || []).map(id => escapeHtml(state.products.find(p => p.id === id)?.name || '')).filter(Boolean).join(', ')}` : 'Sin productos asignados'}</small></div><button class="mini-action" data-edit-modifier-group="${escapeHtml(g.id)}">Editar</button></div>`).join('') : '<p class="muted">Aún no hay grupos. Crea por ejemplo «Término de la carne» (obligatorio) o «Adiciones» (con precio) y asígnalos a tus productos.</p>';
}
function openModifierGroupDialog(id = null) {
  const g = id && modifierGroups().find(x => x.id === id);
  modifierDraft = g ? structuredClone(g) : { id: null, name: '', mode: 'una', options: [{ id: uid('opc'), name: '', price: 0 }], productIds: [] };
  document.querySelector('#modifierGroupDialog h2').textContent = g ? 'Editar grupo' : 'Nuevo grupo de opciones';
  document.querySelector('#modifierGroupName').value = modifierDraft.name;
  document.querySelector('#modifierGroupMode').value = modifierDraft.mode;
  document.querySelector('#deleteModifierGroupButton').hidden = !g;
  renderModifierDraft();
  document.querySelector('#modifierGroupDialog').showModal();
}
function renderModifierDraft() {
  if (!modifierDraft) return;
  const insumos = [...(state.insumos || [])].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  document.querySelector('#modifierOptionLines').innerHTML = modifierDraft.options.map((o, i) => {
    const ins = o.insumoId && insumoById(o.insumoId), units = ins ? compatibleUnits(ins.unit) : [];
    return `<div class="modifier-option-line"><input type="text" maxlength="40" value="${escapeHtml(o.name)}" placeholder="Opción (ej. Término medio)" data-mod-index="${i}" data-mod-field="name" aria-label="Nombre de la opción" /><input type="number" min="0" step="100" inputmode="numeric" value="${Number(o.price) || ''}" placeholder="$0" data-mod-index="${i}" data-mod-field="price" aria-label="Precio adicional" /><select data-mod-index="${i}" data-mod-field="insumoId" aria-label="Insumo que descuenta"><option value="">Sin insumo</option>${insumos.map(x => `<option value="${escapeHtml(x.id)}"${x.id === o.insumoId ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select>${ins ? `<input type="number" min="0" step="any" inputmode="decimal" value="${Number(o.qty) || ''}" placeholder="0" data-mod-index="${i}" data-mod-field="qty" aria-label="Cantidad del insumo" /><select data-mod-index="${i}" data-mod-field="unit" aria-label="Unidad">${units.map(u => `<option${u === o.unit ? ' selected' : ''}>${u}</option>`).join('')}</select>` : '<span></span><span></span>'}<button type="button" class="remove-line" data-remove-mod-option="${i}" aria-label="Quitar opción">×</button></div>`;
  }).join('');
  document.querySelector('#modifierGroupProducts').innerHTML = state.products.length ? state.products.map(p => `<label class="check-row modifier-product"><input type="checkbox" data-mod-product="${escapeHtml(p.id)}"${modifierDraft.productIds.includes(p.id) ? ' checked' : ''} /> ${escapeHtml(p.name)} <small class="muted">${escapeHtml(p.category || '')}</small></label>`).join('') : '<p class="muted">Crea productos para asignarles el grupo.</p>';
}
function updateModifierDraft(target) {
  if (!modifierDraft) return;
  if (target.dataset.modProduct !== undefined) { const id = target.dataset.modProduct; modifierDraft.productIds = target.checked ? [...new Set([...modifierDraft.productIds, id])] : modifierDraft.productIds.filter(x => x !== id); return; }
  const o = modifierDraft.options[Number(target.dataset.modIndex)]; if (!o) return;
  const field = target.dataset.modField;
  if (field === 'insumoId') { o.insumoId = target.value || undefined; const ins = o.insumoId && insumoById(o.insumoId); o.unit = ins ? defaultRecipeUnit(ins.unit) : undefined; if (!ins) delete o.qty; return renderModifierDraft(); }
  if (field === 'unit') { o.unit = target.value; return; }
  o[field] = field === 'name' ? target.value : Number(target.value) || 0;
}
function addModifierOption() { if (modifierDraft) { modifierDraft.options.push({ id: uid('opc'), name: '', price: 0 }); renderModifierDraft(); } }
function removeModifierOption(index) { if (modifierDraft) { modifierDraft.options.splice(Number(index), 1); renderModifierDraft(); } }
function saveModifierGroup() {
  if (!modifierDraft) return;
  const name = document.querySelector('#modifierGroupName').value.trim(), mode = document.querySelector('#modifierGroupMode').value;
  const options = modifierDraft.options.map(o => ({ ...o, name: String(o.name || '').trim(), price: Math.max(0, Math.round(Number(o.price) || 0)) })).filter(o => o.name);
  if (!name) return showToast('Escribe el nombre del grupo (ej. Término de la carne).');
  if (!MODIFIER_MODES[mode]) return showToast('Elige cómo se escogen las opciones.');
  if (!options.length) return showToast('Agrega al menos una opción con nombre.');
  if (options.some(o => o.insumoId && !(Number(o.qty) > 0))) return showToast('Indica la cantidad del insumo de cada opción que lo descuenta.');
  const group = { id: modifierDraft.id || uid('mod'), name, mode, options: options.map(o => (o.insumoId ? o : { id: o.id, name: o.name, price: o.price })), productIds: modifierDraft.productIds.filter(id => state.products.some(p => p.id === id)) };
  const groups = modifierGroups().filter(g => g.id !== group.id);
  const index = modifierGroups().findIndex(g => g.id === group.id);
  groups.splice(index < 0 ? groups.length : index, 0, group);
  state.profile = { ...state.profile, modifierGroups: groups, sync_status: 'pending' };
  saveState(); if (globalThis.NexoSync?.scheduleSync) globalThis.NexoSync.scheduleSync();
  modifierDraft = null; document.querySelector('#modifierGroupDialog').close(); renderAll();
  showToast(index < 0 ? 'Grupo de opciones creado.' : 'Grupo actualizado.');
}
function deleteModifierGroup() {
  if (!modifierDraft?.id) return;
  if (!window.confirm(`¿Eliminar el grupo «${modifierDraft.name}»? Los pedidos y facturas que ya lo usaron no cambian.`)) return;
  state.profile = { ...state.profile, modifierGroups: modifierGroups().filter(g => g.id !== modifierDraft.id), sync_status: 'pending' };
  saveState(); if (globalThis.NexoSync?.scheduleSync) globalThis.NexoSync.scheduleSync();
  modifierDraft = null; document.querySelector('#modifierGroupDialog').close(); renderAll(); showToast('Grupo eliminado.');
}
globalThis.productModifierGroups = productModifierGroups;
globalThis.consumeModifiers = consumeModifiers;
globalThis.renderModifierGroups = renderModifierGroups;

/* ============ Mermas, conteo físico y ajustes ============
   Trabajan sobre productos de reventa (state.inventory) e insumos (state.insumos) por igual. */
function stockItems() { return [...(state.inventory || []), ...(state.insumos || [])]; }
function findStockItem(id) { return (state.inventory || []).find(i => i.id === id) || insumoById(id); }
function stockItemOptions(label = i => `${i.name} (${formatQty(roundInsumoQty(i.qty))} ${i.unit})`) {
  const group = (title, list) => list.length ? `<optgroup label="${title}">${list.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(label(i))}</option>`).join('')}</optgroup>` : '';
  return group('Productos', state.inventory || []) + group('Insumos', state.insumos || []);
}
function supplyProduct(supplyId) {
  return state.products.find(p => p.inventoryId === supplyId || p.id === supplyId);
}
function supplyUnitCost(supplyId) {
  return Number(supplyProduct(supplyId)?.cost ?? insumoById(supplyId)?.cost ?? 0);
}
function supplyUnitPrice(supplyId) {
  return Number(supplyProduct(supplyId)?.price || 0);
}
function logStock(entry) {
  state.stockLog.push({ id: uid('stk'), at: Date.now(), date: today(), userName: actor().userName, sync_status: 'pending', ...entry });
  if (state.stockLog.length > 2000) state.stockLog.splice(0, state.stockLog.length - 2000);
  if (globalThis.NexoSync?.scheduleSync) globalThis.NexoSync.scheduleSync();
}
const STOCK_TYPES = {
  merma: 'Merma / Ajuste',
  conteo: 'Conteo físico',
  ajuste: 'Ajuste manual'
};
function renderStockLog() {
  const rows = [...state.stockLog].reverse().slice(0, 20);
  const tbody = document.querySelector('#stockLogTable');
  if (!tbody) return;
  tbody.innerHTML = rows.map(e => {
    const costVal = e.value != null ? Math.abs(e.value) : (e.cost ? Math.abs(e.delta * e.cost) : 0);
    const saleVal = e.saleValue != null ? Math.abs(e.saleValue) : (e.price ? Math.abs(e.delta * e.price) : 0);
    const reasonText = e.reasonCategory || e.reason || STOCK_TYPES[e.type] || e.type;
    return `
      <tr>
        <td>${fmtDateTime(e.at)}</td>
        <td><span class="status ${e.delta < 0 ? 'status-out' : 'status-good'}">${escapeHtml(reasonText)}</span></td>
        <td><strong>${escapeHtml(e.itemName)}</strong></td>
        <td><b>${e.delta > 0 ? '+' : ''}${formatQty(e.delta)}</b> ${escapeHtml(e.unit || '')}</td>
        <td>${costVal > 0 ? money.format(costVal) : '—'}</td>
        <td>${saleVal > 0 ? money.format(saleVal) : '—'}</td>
        <td><small class="muted">${escapeHtml(e.note || e.reason || '—')}</small></td>
        <td>${escapeHtml(e.userName || '')}</td>
      </tr>
    `;
  }).join('') || '<tr><td colspan="8" class="muted">Aún no hay ajustes, mermas ni conteos registrados.</td></tr>';
}

globalThis.renderRecentInvoices = renderRecentInvoices;
globalThis.renderInvoices = renderInvoices;
globalThis.applyPermissions = applyPermissions;
globalThis.renderUserChip = renderUserChip;
globalThis.renderTeam = renderTeam;
globalThis.renderSuppliers = renderSuppliers;
globalThis.renderStockLog = renderStockLog;
globalThis.renderReports = renderReports;
globalThis.printReport = printReport;
globalThis.reportSheets = reportSheets;
globalThis.exportReportXlsx = exportReportXlsx;
function saveInventory() {
  if (!requireOpenShift()) return;
  const item = findStockItem(document.querySelector('#inventorySelect').value), delta = Number(document.querySelector('#inventoryAmount').value), reason = document.querySelector('#inventoryReason').value.trim();
  if (!item || !delta) return showToast('Indica una cantidad válida.');
  const before = item.qty; item.qty = Math.max(0, Number((item.qty + delta).toFixed(2))); const real = Number((item.qty - before).toFixed(2));
  const p = supplyProduct(item.id);
  if (p) {
    p.stock = item.qty;
    p.updated_at = new Date().toISOString();
    p.sync_status = 'pending';
  }
  const cost = supplyUnitCost(item.id), price = supplyUnitPrice(item.id);
  logStock({ type: 'ajuste', reasonCategory: reason || 'Ajuste manual', itemId: item.id, itemName: item.name, unit: item.unit, delta: real, cost, price, value: real * cost, saleValue: real * price, reason: reason || 'Ajuste manual' });
  saveState(); document.querySelector('#inventoryDialog').close(); renderAll(); showToast('Inventario actualizado.');
}
function openWasteDialog() {
  if (!can('merma')) return deny();
  document.querySelector('#wasteItem').innerHTML = stockItemOptions(i => `${i.name} (Stock: ${formatQty(roundInsumoQty(i.qty))} ${i.unit} · Costo: ${money.format(supplyUnitCost(i.id))})`);
  document.querySelector('#wasteQty').value = '';
  document.querySelector('#wasteNote').value = '';
  document.querySelector('#wasteReason').value = 'Rotura / Merma';
  updateWasteValue();
  document.querySelector('#wasteDialog').showModal();
}
function updateWasteValue() {
  const item = findStockItem(document.querySelector('#wasteItem')?.value);
  const qty = Number(document.querySelector('#wasteQty')?.value || 0);
  const el = document.querySelector('#wasteValue');
  if (!el) return;
  if (!item || !(qty > 0)) {
    el.textContent = 'Indica la cantidad a descontar para ver la valoración contable ($0 en ventas/caja).';
    return;
  }
  const cost = supplyUnitCost(item.id);
  const price = supplyUnitPrice(item.id);
  el.innerHTML = `<strong>Valoración contable:</strong> Pérdida al costo: <b>${money.format(qty * cost)}</b> · Precio venta: <b>${money.format(qty * price)}</b> <br><small class="muted">($0 de impacto financiero en caja y ventas)</small>`;
}
function saveWaste() {
  if (!can('merma')) return deny();
  const item = findStockItem(document.querySelector('#wasteItem')?.value);
  const qty = Number(document.querySelector('#wasteQty')?.value);
  const reason = document.querySelector('#wasteReason')?.value || 'Rotura / Merma';
  const note = document.querySelector('#wasteNote')?.value.trim() || '';
  if (!item || !(qty > 0)) return showToast('Indica la cantidad a descontar.');
  if (qty > item.qty) return showToast(`En el sistema solo hay ${formatQty(item.qty)} ${item.unit}.`);

  const cost = supplyUnitCost(item.id);
  const price = supplyUnitPrice(item.id);

  // Descontar inmediatamente del inventario
  item.qty = Math.max(0, Number((item.qty - qty).toFixed(2)));
  const prod = supplyProduct(item.id);
  if (prod) {
    prod.stock = item.qty;
    prod.updated_at = new Date().toISOString();
    prod.sync_status = 'pending';
  }

  logStock({
    type: 'merma',
    reasonCategory: reason,
    itemId: item.id,
    itemName: item.name,
    unit: item.unit,
    delta: -qty,
    cost,
    price,
    value: -qty * cost,
    saleValue: -qty * price,
    reason,
    note
  });

  logAudit('Ajuste de stock registrado', `${formatQty(qty)} ${item.unit} de ${item.name} · ${reason}${note ? ' (' + note + ')' : ''}`);
  saveState();
  document.querySelector('#wasteDialog').close();
  renderAll();
  showToast(`Ajuste registrado: -${formatQty(qty)} ${item.unit} de ${item.name} (${reason}).`);
}
function openCountDialog() {
  if (!can('conteo')) return deny();
  document.querySelector('#countBody').innerHTML = stockItems().map(i => `<tr data-count-row="${i.id}"><td><strong>${escapeHtml(i.name)}</strong><br><small class="muted">${escapeHtml(i.unit)}</small></td><td>${formatQty(i.qty)}</td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-count-item="${i.id}" placeholder="—" /></td><td class="count-diff" data-count-diff="${i.id}">—</td></tr>`).join('');
  document.querySelector('#countNote').value = ''; updateCountTotals(); document.querySelector('#countDialog').showModal();
}
function countLines() {
  const lines = [];
  document.querySelectorAll('#countBody input[data-count-item]').forEach(input => {
    if (input.value === '') return; const item = findStockItem(input.dataset.countItem), counted = Number(input.value); if (!item || !Number.isFinite(counted) || counted < 0) return;
    lines.push({ item, counted, diff: Number((counted - item.qty).toFixed(2)) });
  });
  return lines;
}
function updateCountTotals() {
  const lines = countLines(); let value = 0;
  document.querySelectorAll('#countBody [data-count-diff]').forEach(cell => { cell.textContent = '—'; cell.className = 'count-diff'; });
  lines.forEach(({ item, diff }) => { value += diff * supplyUnitCost(item.id); const cell = document.querySelector(`[data-count-diff="${item.id}"]`); if (cell) { cell.textContent = diff === 0 ? 'Cuadra' : `${diff > 0 ? '+' : ''}${formatQty(diff)}`; cell.className = `count-diff ${diff === 0 ? 'ok' : diff < 0 ? 'neg' : 'pos'}`; } });
  document.querySelector('#countTotal').textContent = `${value < 0 ? '−' : value > 0 ? '+' : ''}${money.format(Math.abs(value))}`;
}
function applyCount() {
  if (!can('conteo')) return deny(); const lines = countLines(); if (!lines.length) return showToast('Escribe al menos una cantidad contada.');
  const note = document.querySelector('#countNote').value.trim() || 'Conteo físico', changed = lines.filter(l => l.diff !== 0); let value = 0;
  changed.forEach(({ item, counted, diff }) => { const v = diff * supplyUnitCost(item.id); value += v; item.qty = counted; logStock({ type: 'conteo', itemId: item.id, itemName: item.name, unit: item.unit, delta: diff, value: v, reason: note }); });
  logAudit('Conteo físico', `${lines.length} insumos contados · ${changed.length} con diferencia · ${value < 0 ? '−' : '+'}${money.format(Math.abs(value))}`, { reason: note });
  saveState(); document.querySelector('#countDialog').close(); renderAll(); showToast(changed.length ? `Conteo aplicado: ${changed.length} diferencias ajustadas.` : 'Conteo aplicado: todo cuadra.');
}

/* Anular un pedido abierto deja constancia en la bitácora. */
function deleteCurrentOrder() {
  const order = getOrder(state.currentOrderId); if (!order) return;
  if (order.items.length && !window.confirm(`¿Eliminar el pedido de ${order.tableName} por ${money.format(orderTotal(order))}?`)) return;
  logAudit('Pedido eliminado', `${order.tableName} · ${money.format(orderTotal(order))} · ${order.items.length} productos`, { data: structuredClone(order) });
  voidAllSent(order); // la cocina deja de preparar lo que ya se había enviado
  state.orders = state.orders.filter(o => o.id !== order.id); if (typeof rememberRemovedOrder === 'function') rememberRemovedOrder(order.id); saveState(); if (globalThis.NexoSync?.deleteActiveOrder) globalThis.NexoSync.deleteActiveOrder(order.id).catch(() => {}); if (globalThis.NexoSync?.syncOrders) globalThis.NexoSync.syncOrders().catch(() => {}); document.querySelector('#orderDialog').close(); state.currentOrderId = null; renderAll(); showToast('Pedido eliminado.');
}

/* ============ Comandas de cocina ============
   Cada línea del pedido guarda sentQty (lo que ya salió a su estación) y kitchenNote (nota del próximo envío).
   «Enviar a cocina» imprime solo lo nuevo, una comanda por estación (Cocina / Barra; las categorías en 'ninguna' no salen).
   Quitar algo ya enviado necesita el permiso cancelOrder y deja una anulación en order.pendingVoids, que se imprime en el
   siguiente envío, al guardar el pedido o al eliminarlo. Un cobro por productos no es anulación: solo baja sentQty. */
const KITCHEN_STATIONS = { cocina: 'Cocina', barra: 'Barra' };
const KITCHEN_STATION_OPTIONS = { ...KITCHEN_STATIONS, ninguna: 'No se envía' };
function kitchenNorm(text) { return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
// Sin configurar: bebidas y cafetería a Barra, el resto a Cocina
function defaultKitchenStation(category) { return /bebida|cafe|jugo|gaseosa|refresco|limonada|batido|malteada|licor|cerveza|coctel|vino|aromatica|\bte\b/.test(kitchenNorm(category)) ? 'barra' : 'cocina'; }
function kitchenStationsMap() { return state.profile?.kitchenStations || state.kitchenStations || {}; }
function kitchenStationFor(category) { const saved = kitchenStationsMap()[category]; return KITCHEN_STATION_OPTIONS[saved] ? saved : defaultKitchenStation(category); }
// Las estaciones son del negocio: van en el perfil, que sube a negocios.configuracion (las impresoras sí son de cada equipo)
function setKitchenStation(category, station) { if (!KITCHEN_STATION_OPTIONS[station]) return; state.profile = { ...state.profile, kitchenStations: { ...kitchenStationsMap(), [category]: station }, sync_status: 'pending' }; saveState(); if (globalThis.NexoSync?.scheduleSync) globalThis.NexoSync.scheduleSync(); }
function itemSentQty(item) { return Math.min(Math.max(0, Number(item.sentQty) || 0), Math.max(0, Number(item.qty) || 0)); }
function itemUnsentQty(item) { return Math.max(0, (Number(item.qty) || 0) - itemSentQty(item)); }
function itemGoesToKitchen(item) { return kitchenStationFor(itemCategory(item)) !== 'ninguna'; }
function kitchenPendingCount(order) {
  if (!order) return 0;
  return (order.items || []).filter(itemGoesToKitchen).reduce((sum, item) => sum + itemUnsentQty(item), 0)
    + (order.pendingVoids || []).filter(itemGoesToKitchen).reduce((sum, v) => sum + (Number(v.qty) || 0), 0);
}
// Arma las comandas pendientes de un pedido (sin modificarlo): una por estación y tipo
function pendingComandas(order, { voidsOnly = false } = {}) {
  const groups = new Map();
  const add = (type, item, qty, note = '') => {
    const station = kitchenStationFor(itemCategory(item));
    if (station === 'ninguna' || !(qty > 0)) return;
    const key = `${type}:${station}`;
    if (!groups.has(key)) groups.set(key, { type, station, stationLabel: KITCHEN_STATIONS[station], items: [] });
    groups.get(key).items.push({ productId: item.productId, name: item.name, qty, note: String(note || '').trim() });
  };
  (order?.pendingVoids || []).forEach(v => add('anulacion', v, Number(v.qty) || 0));
  if (!voidsOnly) (order?.items || []).forEach(item => add('envio', item, itemUnsentQty(item), item.kitchenNote));
  // Anulaciones primero: la cocina debe parar antes de empezar lo nuevo
  return [...groups.values()].sort((a, b) => (a.type === b.type ? 0 : a.type === 'anulacion' ? -1 : 1));
}
function kitchenPrinterFor(station) { return (typeof printSettings === 'function' ? printSettings().stationPrinters?.[station] : '') || ''; }
// Envía lo pendiente: marca las líneas como enviadas, guarda la comanda en el pedido y la imprime en la impresora de su estación
function sendOrderToKitchen(order = getOrder(state.currentOrderId), { voidsOnly = false, quiet = false } = {}) {
  if (!order) return { ok: false, comandas: [] };
  const drafts = pendingComandas(order, { voidsOnly });
  if (!voidsOnly) (order.items || []).forEach(item => { item.sentQty = Number(item.qty) || 0; delete item.kitchenNote; });
  order.pendingVoids = [];
  if (!drafts.length) { touchOrder(order); saveState(); if (!quiet) showToast('No hay productos nuevos para cocina.'); return { ok: true, comandas: [] }; }
  const at = Date.now(), by = order.userName || actor().userName || '';
  const comandas = drafts.map(d => ({ id: uid('cmd'), n: (state.comandaCounter = (Number(state.comandaCounter) || 0) + 1), at, by, tableName: order.tableName, orderNote: d.type === 'envio' ? String(order.note || '').trim() : '', ...d }));
  order.comandas = [...(order.comandas || []), ...comandas.map(c => structuredClone(c))].slice(-50);
  comandas.forEach(c => logAudit(c.type === 'anulacion' ? 'Comanda anulada' : 'Comanda enviada', `${c.stationLabel} #${c.n} · ${order.tableName} · ${c.items.map(i => `${i.qty} ${i.name}`).join(', ')}`));
  touchOrder(order); saveState();
  if (globalThis.NexoSync?.syncOrders) globalThis.NexoSync.syncOrders().catch(() => {});
  comandas.forEach(c => {
    const html = buildComandaHtml(c, { paperWidth: printSettings().paperWidth, demo: isDemoMode() });
    sendToPrinter(html, `${c.type === 'anulacion' ? 'Anulación' : 'Comanda'} ${c.stationLabel} #${c.n}`, { printerName: kitchenPrinterFor(c.station) });
  });
  if (!quiet) showToast(comandas.length === 1 ? `🔔 Comanda #${comandas[0].n} enviada a ${comandas[0].stationLabel}.` : `🔔 ${comandas.length} comandas enviadas (${[...new Set(comandas.map(c => c.stationLabel))].join(' y ')}).`);
  return { ok: true, comandas };
}
// Una línea baja de cantidad: si toca lo ya enviado, exige permiso y deja la anulación pendiente. Devuelve false si no se permite.
function registerKitchenReduction(order, item, newQty) {
  const sent = itemSentQty(item), next = Math.max(0, Number(newQty) || 0);
  if (next >= sent) return true;
  if (!can('cancelOrder')) { showToast('Ese producto ya salió a cocina: pide al cajero o al administrador que lo anule.'); return false; }
  order.pendingVoids = [...(order.pendingVoids || []), { productId: item.productId, name: item.name, category: itemCategory(item), qty: sent - next }];
  item.sentQty = next;
  return true;
}
// Un pedido que se elimina con productos ya enviados: anula todo lo enviado
function voidAllSent(order) {
  (order?.items || []).forEach(item => { const sent = itemSentQty(item); if (sent > 0) order.pendingVoids = [...(order.pendingVoids || []), { productId: item.productId, name: item.name, category: itemCategory(item), qty: sent }]; item.sentQty = 0; });
  return sendOrderToKitchen(order, { voidsOnly: true, quiet: true });
}
function renderKitchenSettings() {
  const list = document.querySelector('#kitchenStationList'); if (!list || !state) return;
  const categories = [...new Set([...(state.categories || []), ...(state.products || []).map(p => p.category)].map(c => String(c || '').trim()).filter(c => c && c !== 'Todos'))];
  list.innerHTML = categories.length ? categories.map(cat => `<label class="kitchen-station-row"><span>${escapeHtml(cat)}</span><select data-kitchen-category="${escapeHtml(cat)}">${Object.entries(KITCHEN_STATION_OPTIONS).map(([value, label]) => `<option value="${value}"${kitchenStationFor(cat) === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`).join('') : '<p class="muted">Crea categorías de productos para asignarlas.</p>';
}
globalThis.sendOrderToKitchen = sendOrderToKitchen;
globalThis.kitchenPendingCount = kitchenPendingCount;
globalThis.kitchenStationFor = kitchenStationFor;

/* ============ Reportes analíticos ============ */
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'], WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOUR_ORDER = [...Array(12).keys()].map(i => i + 12).concat([...Array(12).keys()]); // 12:00 → 11:59, así la noche queda junta
function previousBounds() {
  const { from, to } = reportBounds(), days = Math.round((parseISO(to) - parseISO(from)) / 86400000) + 1;
  const pTo = parseISO(from); pTo.setDate(pTo.getDate() - 1); const pFrom = new Date(pTo); pFrom.setDate(pFrom.getDate() - (days - 1));
  return { from: localISO(pFrom), to: localISO(pTo), days };
}
function paymentsBetween(from, to) { return state.payments.filter(p => p.date >= from && p.date <= to); }
function itemCost(item) { return Number(item.cost ?? state.products.find(p => p.id === item.productId)?.cost ?? 0); }
function itemCategory(item) { return item.category || state.products.find(p => p.id === item.productId)?.category || 'Sin categoría'; }
function paymentMetrics(payments) {
  const total = payments.reduce((s, p) => s + p.amount, 0), count = payments.length, cost = payments.reduce((s, p) => s + (p.items || []).reduce((c, i) => c + itemCost(i) * i.qty, 0), 0), profit = total - cost;
  return { total, count, avg: count ? total / count : 0, cost, profit, margin: total ? profit / total * 100 : 0 };
}
function reportDataset() {
  const { from, to } = reportBounds(), prev = previousBounds(), payments = reportPayments(), prevPayments = paymentsBetween(prev.from, prev.to);
  const data = { from, to, prev, payments, cur: paymentMetrics(payments), old: paymentMetrics(prevPayments), byMethod: {}, byProduct: {}, byCategory: {}, byWaiter: {}, hours: Array(24).fill(0), hourCount: Array(24).fill(0), weekdays: Array(7).fill(0), weekdayDays: Array(7).fill(0) };
  payments.forEach(p => {
    if (Array.isArray(p.payments) && p.payments.length > 0) {
      p.payments.forEach(tender => {
        data.byMethod[tender.method] = (data.byMethod[tender.method] || 0) + tender.amount;
      });
    } else {
      data.byMethod[p.method] = (data.byMethod[p.method] || 0) + p.amount;
    }
    const waiter = p.waiterName || 'Sin asignar'; const w = data.byWaiter[waiter] || (data.byWaiter[waiter] = { sales: 0, count: 0 }); w.sales += p.amount; w.count++;
    const hour = new Date(paymentTimestamp(p)).getHours(); data.hours[hour] += p.amount; data.hourCount[hour]++;
    data.weekdays[parseISO(p.date).getDay()] += p.amount;
    (p.items || []).filter(item => !item.splitLine).forEach(item => {
      const sales = item.price * item.qty, cost = itemCost(item) * item.qty, category = itemCategory(item);
      const prod = data.byProduct[item.name] || (data.byProduct[item.name] = { qty: 0, sales: 0, cost: 0, category }); prod.qty += item.qty; prod.sales += sales; prod.cost += cost;
      const cat = data.byCategory[category] || (data.byCategory[category] = { qty: 0, sales: 0, cost: 0 }); cat.qty += item.qty; cat.sales += sales; cat.cost += cost;
    });
  });
  for (let d = parseISO(from), n = 0; localISO(d) <= to && n < 800; d.setDate(d.getDate() + 1), n++) data.weekdayDays[d.getDay()]++;
  data.purchases = state.purchases.filter(p => p.date >= from && p.date <= to); data.expenses = state.expenses.filter(e => e.date >= from && e.date <= to);
  data.stock = state.stockLog.filter(e => e.date >= from && e.date <= to);
  const sum = (type, sign) => data.stock.filter(e => e.type === type && Math.sign(e.value) === sign).reduce((s, e) => s + Math.abs(e.value), 0);
  data.mermas = sum('merma', -1); data.faltantes = sum('conteo', -1); data.sobrantes = sum('conteo', 1);
  data.stockLoss = data.mermas + data.faltantes - data.sobrantes; data.profitAfterLoss = data.cur.profit - data.stockLoss;
  return data;
}
function deltaCell(cur, prev, { inverse = false, pts = false } = {}) {
  if (!prev && !cur) return '<span class="delta flat">—</span>'; if (!prev) return '<span class="delta up">Nuevo</span>';
  const d = pts ? cur - prev : (cur - prev) / Math.abs(prev) * 100, cls = Math.abs(d) < 0.05 ? 'flat' : ((d > 0) !== inverse ? 'up' : 'down');
  return `<span class="delta ${cls}">${d > 0.05 ? '▲' : d < -0.05 ? '▼' : '■'} ${Math.abs(d).toFixed(1)}${pts ? ' pts' : '%'}</span>`;
}
function columnChart(cols) {
  const max = Math.max(1, ...cols.map(c => c.value));
  return cols.map(c => `<div class="day-col ${c.peak ? 'peak' : ''}" title="${escapeHtml(c.title)}"><span class="day-val">${escapeHtml(c.top || '')}</span><div class="day-bar"><i style="height:${c.value ? Math.max(3, c.value / max * 100) : 0}%"></i></div><span class="day-label">${escapeHtml(String(c.label))}</span></div>`).join('');
}
function rowList(rows) { return rows.map(([label, value]) => `<div class="report-row"><span>${label}</span><b>${value}</b></div>`).join(''); }
function hourLabel(h) { return `${String(h).padStart(2, '0')}:00`; }

function renderReports() {
  if (typeof renderReportPeriod === 'function') renderReportPeriod(); else if (typeof globalThis.renderReportPeriod === 'function') globalThis.renderReportPeriod();
  const isDemo = typeof isDemoMode === 'function' ? isDemoMode() : !!globalThis.isDemoMode?.();
  const wmTop = document.querySelector('#reportWatermarkTop');
  const wmBottom = document.querySelector('#reportWatermarkBottom');
  if (wmTop) wmTop.hidden = !isDemo;
  if (wmBottom) wmBottom.hidden = !isDemo;

  const $ = s => document.querySelector(s), d = reportDataset(), { cur, old } = d, compact = new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 });
  $('#reportTotal').textContent = money.format(cur.total);
  $('#reportTicket').textContent = `${cur.count} ${cur.count === 1 ? 'ticket' : 'tickets'} · Promedio ${money.format(cur.avg)}`;
  $('#paymentReport').innerHTML = Object.keys(d.byMethod).length ? rowList(Object.entries(d.byMethod).map(([m, v]) => [escapeHtml(m), money.format(v)])) : '<p class="muted">Aún no hay pagos registrados.</p>';
  const ranking = Object.entries(d.byProduct).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);
  $('#productReport').innerHTML = ranking.length ? rowList(ranking.map(([name, v], i) => [`${i + 1}. ${escapeHtml(name)}`, `${v.qty} und`])) : '<p class="muted">Aún no hay productos vendidos.</p>';
  const top = Object.entries(d.byProduct).sort((a, b) => b[1].sales - a[1].sales).slice(0, 5), topMax = top[0]?.[1].sales || 1;
  $('#profitChart').innerHTML = top.length ? top.map(([name, v]) => `<div class="chart-row"><span title="${escapeHtml(name)}">${escapeHtml(name)}</span><div class="chart-track"><div class="chart-fill" style="width:${Math.max(4, v.sales / topMax * 100)}%"></div></div><strong>${money.format(v.sales)}</strong></div>`).join('') : '<p class="muted">Las ventas cerradas aparecerán aquí.</p>';
  $('#profitReport').innerHTML = rowList([['Ventas netas', money.format(cur.total)], ['Costo de productos vendidos', money.format(cur.cost)], ['Utilidad bruta', money.format(cur.profit)], ['Margen bruto', `${cur.margin.toFixed(1)}%`], ['Mermas y faltantes (neto)', `− ${money.format(d.stockLoss)}`], ['Utilidad tras mermas', money.format(d.profitAfterLoss)]]);
  const purchasesTotal = d.purchases.reduce((s, p) => s + p.total, 0), expensesTotal = d.expenses.reduce((s, e) => s + e.amount, 0);
  $('#operationsReport').innerHTML = rowList([['Compras de mercancía', money.format(purchasesTotal)], ['Servicios y otros gastos', money.format(expensesTotal)], ['Flujo registrado', money.format(cur.total - purchasesTotal - expensesTotal)]]);
  $('#expectedCashInClose').textContent = money.format(paymentsToday().filter(p => p.method === 'Efectivo').reduce((s, p) => s + p.amount, 0));

  // Comparativo con el período anterior
  $('#comparisonRange').textContent = `${shortDate(d.from)}${d.from === d.to ? '' : ' – ' + shortDate(d.to)} frente a ${shortDate(d.prev.from)}${d.prev.from === d.prev.to ? '' : ' – ' + shortDate(d.prev.to)}`;
  const cmp = [['Ventas', cur.total, old.total, money.format.bind(money), {}], ['Facturas', cur.count, old.count, String, {}], ['Ticket promedio', cur.avg, old.avg, money.format.bind(money), {}], ['Costo de ventas', cur.cost, old.cost, money.format.bind(money), { inverse: true }], ['Utilidad bruta', cur.profit, old.profit, money.format.bind(money), {}], ['Margen bruto', cur.margin, old.margin, v => `${v.toFixed(1)}%`, { pts: true }]];
  $('#comparisonReport').innerHTML = `<table class="compare-table"><thead><tr><th></th><th>Actual</th><th>Anterior</th><th>Variación</th></tr></thead><tbody>${cmp.map(([label, a, b, fmt, opts]) => `<tr><td>${label}</td><td><strong>${fmt(a)}</strong></td><td>${fmt(b)}</td><td>${deltaCell(a, b, opts)}</td></tr>`).join('')}</tbody></table>`;

  // Ventas por hora
  const maxHour = Math.max(...d.hours), peakHour = d.hours.indexOf(maxHour);
  $('#hourChart').innerHTML = columnChart(HOUR_ORDER.map(h => ({ label: String(h).padStart(2, '0'), value: d.hours[h], peak: maxHour > 0 && h === peakHour, top: d.hours[h] && d.hours[h] >= maxHour * .5 ? compact.format(d.hours[h]) : '', title: `${hourLabel(h)} – ${hourLabel((h + 1) % 24)}: ${money.format(d.hours[h])} · ${d.hourCount[h]} ${d.hourCount[h] === 1 ? 'factura' : 'facturas'}` })));
  const active = HOUR_ORDER.filter(h => d.hours[h] > 0);
  $('#hourSummary').innerHTML = maxHour ? rowList([['Hora pico', `${hourLabel(peakHour)} – ${hourLabel((peakHour + 1) % 24)} · ${money.format(maxHour)}`], ['Primera venta (franja)', hourLabel(active[0])], ['Última venta (franja)', hourLabel(active[active.length - 1])]]) : '<p class="muted">Sin ventas en este período.</p>';

  // Por día de la semana
  const maxDay = Math.max(...d.weekdays), peakDay = d.weekdays.indexOf(maxDay);
  $('#weekdayChart').innerHTML = columnChart(WEEKDAY_ORDER.map((n, i) => ({ label: WEEKDAYS[i], value: d.weekdays[n], peak: maxDay > 0 && n === peakDay, top: d.weekdays[n] ? compact.format(d.weekdays[n]) : '', title: `${WEEKDAYS[i]}: ${money.format(d.weekdays[n])} en ${d.weekdayDays[n]} ${d.weekdayDays[n] === 1 ? 'día' : 'días'}` })));
  $('#weekdaySummary').innerHTML = maxDay ? rowList(WEEKDAY_ORDER.filter(n => d.weekdayDays[n]).map(n => [WEEKDAYS[WEEKDAY_ORDER.indexOf(n)], `${money.format(d.weekdays[n])} · prom. ${money.format(d.weekdays[n] / d.weekdayDays[n])}`])) : '<p class="muted">Sin ventas en este período.</p>';

  // Por categoría y por vendedor
  const cats = Object.entries(d.byCategory).sort((a, b) => b[1].sales - a[1].sales), catMax = cats[0]?.[1].sales || 1, catTotal = cats.reduce((s, [, v]) => s + v.sales, 0) || 1;
  $('#categoryChart').innerHTML = cats.length ? cats.map(([name, v]) => `<div class="chart-row"><span title="${escapeHtml(name)}">${escapeHtml(name)} · ${(v.sales / catTotal * 100).toFixed(0)}%</span><div class="chart-track"><div class="chart-fill" style="width:${Math.max(4, v.sales / catMax * 100)}%"></div></div><strong>${money.format(v.sales)}</strong></div>`).join('') : '<p class="muted">Aún no hay ventas por categoría.</p>';
  $('#waiterReport').innerHTML = Object.keys(d.byWaiter).length ? rowList(Object.entries(d.byWaiter).sort((a, b) => b[1].sales - a[1].sales).map(([name, v]) => [`${escapeHtml(name)} <small class="muted">· ${v.count} fact.</small>`, money.format(v.sales)])) : '<p class="muted">Aún no hay ventas.</p>';
  const mermasBreakdown = {
    'Rotura / Merma': { qty: 0, cost: 0, sale: 0 },
    'Cortesía de la casa': { qty: 0, cost: 0, sale: 0 },
    'Consumo de personal': { qty: 0, cost: 0, sale: 0 },
    'Otro ajuste': { qty: 0, cost: 0, sale: 0 }
  };
  let totalBajasQty = 0, totalBajasCost = 0, totalBajasSale = 0;
  (d.stock || []).forEach(e => {
    if (e.delta < 0) {
      const cat = e.reasonCategory || e.reason || '';
      let k = 'Otro ajuste';
      if (cat.includes('Rotura') || cat.includes('Merma')) k = 'Rotura / Merma';
      else if (cat.includes('Cortesía') || cat.includes('Cortesia')) k = 'Cortesía de la casa';
      else if (cat.includes('Consumo') || cat.includes('personal')) k = 'Consumo de personal';

      const q = Math.abs(e.delta);
      const c = e.value != null ? Math.abs(e.value) : (e.cost ? q * e.cost : 0);
      const s = e.saleValue != null ? Math.abs(e.saleValue) : (e.price ? q * e.price : 0);

      mermasBreakdown[k].qty += q;
      mermasBreakdown[k].cost += c;
      mermasBreakdown[k].sale += s;

      totalBajasQty += q;
      totalBajasCost += c;
      totalBajasSale += s;
    }
  });

  const stockRows = [
    ['Roturas y mermas', `${formatQty(mermasBreakdown['Rotura / Merma'].qty)} und · Costo: ${money.format(mermasBreakdown['Rotura / Merma'].cost)} (Venta: ${money.format(mermasBreakdown['Rotura / Merma'].sale)})`],
    ['Cortesías de la casa', `${formatQty(mermasBreakdown['Cortesía de la casa'].qty)} und · Costo: ${money.format(mermasBreakdown['Cortesía de la casa'].cost)} (Venta: ${money.format(mermasBreakdown['Cortesía de la casa'].sale)})`],
    ['Consumo de personal', `${formatQty(mermasBreakdown['Consumo de personal'].qty)} und · Costo: ${money.format(mermasBreakdown['Consumo de personal'].cost)} (Venta: ${money.format(mermasBreakdown['Consumo de personal'].sale)})`],
    ['Otros ajustes y conteo', `${formatQty(mermasBreakdown['Otro ajuste'].qty)} und · Costo: ${money.format(mermasBreakdown['Otro ajuste'].cost)}`],
    ['TOTAL BAJAS AUDITADAS', `<strong>${formatQty(totalBajasQty)} und · ${money.format(totalBajasCost)} costo (${money.format(totalBajasSale)} venta)</strong>`]
  ];
  $('#stockReport').innerHTML = rowList(stockRows);
  applyReportTab();
}

/* ============ Utilidad neta ============
   Ventas netas − costo de ventas = utilidad bruta; − gastos (caja menor de los turnos + fijos y generales) = utilidad neta.
   Las facturas anuladas se eliminan de state.payments, así que no entran. Los abonos de una cuenta dividida en partes
   iguales no duplican la venta: cada abono suma su importe (sin costo) y la factura que salda la cuenta lleva una línea de
   ajuste negativa por esos abonos, de modo que la suma de importes es exactamente el total de la cuenta. Las compras de
   mercancía no se restan como gasto porque su costo ya entra en el costo de ventas. */
let reportTab = 'summary', netRange = 'month', netFrom = '', netTo = '';
const NET_EXPENSE_GROUPS = ['Arriendo', 'Servicios', 'Personal', 'Insumos / caja menor', 'Otros'];
function netBounds() {
  const end = today(), base = parseISO(end);
  if (netRange === 'today') return { from: end, to: end };
  if (netRange === 'week') { const start = new Date(base); start.setDate(start.getDate() - (start.getDay() + 6) % 7); return { from: localISO(start), to: end }; } // semana de lunes a hoy
  if (netRange === 'month') return { from: localISO(new Date(base.getFullYear(), base.getMonth(), 1)), to: end };
  if (netRange === 'lastMonth') return { from: localISO(new Date(base.getFullYear(), base.getMonth() - 1, 1)), to: localISO(new Date(base.getFullYear(), base.getMonth(), 0)) };
  let from = netFrom || netTo || end, to = netTo || from; if (from > to) [from, to] = [to, from];
  return { from, to };
}
// Clasifica primero por el tipo de gasto; si es genérico, por la descripción. Un gasto genérico pagado en efectivo desde la caja de un turno es caja menor.
function expenseGroup(expense) {
  const classify = text => {
    const s = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/arriendo|alquiler|canon|\brenta\b/.test(s)) return 'Arriendo';
    if (/nomina|personal|\bdj\b|musica|musico|salario|sueldo|honorario|prestacion|seguridad social|pago de turno|turnos? de|mesero|bartender|barista|cociner|chef|ayudante de cocina|vigilan/.test(s)) return 'Personal';
    if (/servicio|\bluz\b|energia|\bagua\b|acueducto|alcantarillado|\bgas\b|internet|telefon|celular|\bplan\b|television|\btv\b/.test(s)) return 'Servicios';
    if (/insumo|caja menor|transporte|domicilio|mantenimiento|reparacion|aseo|limpieza|hielo|desechable|papeleria|ferreteria/.test(s)) return 'Insumos / caja menor';
    return '';
  };
  return classify(expense.category) || classify(expense.description) || (expense.method === 'Efectivo' && expense.shiftId ? 'Insumos / caja menor' : 'Otros');
}
function netProfitDataset(from, to) {
  const payments = paymentsBetween(from, to), m = paymentMetrics(payments), groups = {};
  let expenses = 0, fromDrawer = 0, count = 0;
  // Un solo recorrido sobre los gastos; la fecha ISO (AAAA-MM-DD) se compara como texto, sin crear objetos Date
  for (const e of state.expenses) {
    if (!(e.date >= from && e.date <= to)) continue;
    const amount = Number(e.amount) || 0, key = expenseGroup(e), g = groups[key] || (groups[key] = { total: 0, items: [] });
    g.total += amount; g.items.push(e); expenses += amount; count++;
    if (e.method === 'Efectivo' && e.shiftId) fromDrawer += amount;
  }
  const net = m.profit - expenses;
  return { from, to, payments, sales: m.total, invoices: m.count, cogs: m.cost, gross: m.profit, grossMargin: m.margin, expenses, expenseCount: count, fromDrawer, groups, net, netMargin: m.total ? net / m.total * 100 : 0 };
}
const REPORT_TAB_FEATURE = { net: 'netProfit', inventory: 'inventoryValue' };
function applyReportTab() {
  if (typeof document === 'undefined') return;
  if (REPORT_TAB_FEATURE[reportTab] && !planAllows(REPORT_TAB_FEATURE[reportTab])) reportTab = 'summary';
  document.querySelectorAll('[data-report-tab]').forEach(b => { const on = b.dataset.reportTab === reportTab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  const panels = { summary: '#reportSummaryPanel', net: '#netProfitPanel', inventory: '#inventoryValuePanel' };
  Object.entries(panels).forEach(([tab, sel]) => { const el = document.querySelector(sel); if (el) el.hidden = reportTab !== tab; });
  if (reportTab === 'net') renderNetProfit();
  if (reportTab === 'inventory') renderInventoryValue();
}
function renderNetProfit() {
  const $ = s => document.querySelector(s); if (!$('#netProfitPanel')) return;
  const { from, to } = netBounds(), d = netProfitDataset(from, to), pct = v => `${v.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  document.querySelectorAll('[data-net-range]').forEach(b => b.classList.toggle('active', b.dataset.netRange === netRange));
  $('#netCustomRange').hidden = netRange !== 'custom';
  $('#netFrom').max = $('#netTo').max = today();
  if (netRange === 'custom') { $('#netFrom').value = from; $('#netTo').value = to; }
  $('#netRangeLabel').textContent = from === to ? `Período: ${shortDate(from, true)}` : `Período: ${shortDate(from)} – ${shortDate(to, true)}`;

  $('#netSales').textContent = money.format(d.sales);
  $('#netSalesNote').textContent = `${d.invoices} ${d.invoices === 1 ? 'factura cobrada' : 'facturas cobradas'}`;
  $('#netCogs').textContent = money.format(d.cogs);
  $('#netCogsNote').textContent = `Utilidad bruta ${money.format(d.gross)} · ${pct(d.grossMargin)}`;
  $('#netExpenses').textContent = money.format(d.expenses);
  $('#netExpensesNote').textContent = `${d.expenseCount} ${d.expenseCount === 1 ? 'registro' : 'registros'}`;
  const tone = !d.sales && !d.expenses ? 'flat' : d.net >= 0 ? 'gain' : 'loss';
  ['#netProfitCard', '#netMarginCard'].forEach(id => { $(id).classList.toggle('is-gain', tone === 'gain'); $(id).classList.toggle('is-loss', tone === 'loss'); });
  $('#netProfit').textContent = `${d.net < 0 ? '−' : ''}${money.format(Math.abs(d.net))}`;
  $('#netProfitNote').textContent = tone === 'flat' ? 'Sin movimientos' : tone === 'gain' ? 'Ganancia del período' : 'Pérdida del período';
  $('#netMargin').textContent = d.sales ? pct(d.netMargin) : '—';
  $('#netMarginNote').textContent = d.sales ? 'Sobre ventas netas' : 'Sin ventas en el período';

  $('#netWaterfall').innerHTML = rowList([
    ['Ventas netas', money.format(d.sales)],
    ['(−) Costo de ventas', `− ${money.format(d.cogs)}`],
    ['<strong>= Utilidad bruta</strong>', `${money.format(d.gross)} <small class="muted">· ${pct(d.grossMargin)}</small>`],
    ...NET_EXPENSE_GROUPS.filter(k => d.groups[k]).map(k => [`(−) ${escapeHtml(k)}`, `− ${money.format(d.groups[k].total)}`]),
    ['(−) Total gastos', `− ${money.format(d.expenses)}`],
    [`<strong>= Utilidad neta</strong>`, `<span class="net-figure ${tone}">${d.net < 0 ? '−' : ''}${money.format(Math.abs(d.net))}</span>`],
    ['Margen neto', d.sales ? `<span class="net-figure ${tone}">${pct(d.netMargin)}</span>` : '—'],
  ]);
  const verdict = $('#netVerdict');
  verdict.className = `net-verdict ${tone}`;
  verdict.textContent = tone === 'flat' ? 'No hay ventas ni gastos registrados en este período.'
    : tone === 'gain' ? `El negocio ganó ${money.format(d.net)} después de pagar mercancía y gastos.`
    : `Pérdida neta de ${money.format(Math.abs(d.net))}: los gastos superan la utilidad bruta del período.`;

  const groups = NET_EXPENSE_GROUPS.filter(k => d.groups[k]).sort((a, b) => d.groups[b].total - d.groups[a].total), max = groups.length ? d.groups[groups[0]].total || 1 : 1;
  $('#netExpenseGroups').innerHTML = groups.length ? groups.map(k => {
    const g = d.groups[k], items = g.items.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
    const share = d.expenses ? g.total / d.expenses * 100 : 0;
    return `<details class="net-group"><summary><span class="net-group-name">${escapeHtml(k)} <small class="muted">· ${g.items.length} · ${share.toFixed(0)}%</small></span><b>${money.format(g.total)}</b><span class="chart-track"><span class="chart-fill" style="width:${Math.max(4, g.total / max * 100)}%"></span></span></summary>`
      + `<div class="net-group-items">${items.map(e => `<div class="report-row"><span>${escapeHtml(shortDate(e.date))} · ${escapeHtml(e.description || e.category || 'Gasto')} <small class="muted">· ${escapeHtml(e.category || '')}${e.method ? ' · ' + escapeHtml(e.method) : ''}</small></span><b>${money.format(Number(e.amount) || 0)}</b></div>`).join('')}</div></details>`;
  }).join('') + (d.fromDrawer ? `<p class="muted net-drawer-note">${money.format(d.fromDrawer)} de estos gastos salieron del efectivo de caja de los turnos.</p>` : '')
    : '<p class="muted">No hay gastos registrados en este período.</p>';
}
globalThis.renderNetProfit = renderNetProfit;
globalThis.netProfitDataset = netProfitDataset;
const NET_RANGE_LABELS = { today: 'Hoy', week: 'Esta semana', month: 'Este mes', lastMonth: 'Mes pasado', custom: 'Personalizado' };
function netProfitSheets() {
  const { from, to } = netBounds(), d = netProfitDataset(from, to), period = from === to ? from : `${from} a ${to}`;
  const groups = NET_EXPENSE_GROUPS.filter(k => d.groups[k]).sort((a, b) => d.groups[b].total - d.groups[a].total);
  const share = v => cellP(d.expenses ? Number((v / d.expenses * 100).toFixed(1)) : 0);
  const summary = [
    [{ v: `Utilidad Neta - ${NET_RANGE_LABELS[netRange] || 'Período'} · ${state.profile?.name || 'NexoPos'}`, s: XS.title }], ['Período', period], ['Generado', new Date().toLocaleString('es-CO')], [],
    [cellH('Indicador'), cellH('Valor')],
    ['Ventas netas', cellM(d.sales)], ['Facturas cobradas', cellI(d.invoices)], ['Costo de mercancía vendida', cellM(d.cogs)], ['Utilidad bruta', cellM(d.gross)], ['Margen bruto', cellP(Number(d.grossMargin.toFixed(1)))],
    ['Gastos totales', cellM(d.expenses)], [cellB('Utilidad neta'), cellM(d.net)], [cellB('Margen neto'), d.sales ? cellP(Number(d.netMargin.toFixed(1))) : '—'], [],
    [cellH('Gastos por categoría'), cellH('Registros'), cellH('Total'), cellH('% del gasto')],
    ...groups.map(k => [k, cellI(d.groups[k].items.length), cellM(d.groups[k].total), share(d.groups[k].total)]),
    [cellB('Total gastos'), cellI(d.expenseCount), cellM(d.expenses), share(d.expenses)],
  ];
  if (d.fromDrawer) summary.push([], ['Pagado con efectivo de caja (turnos)', '', cellM(d.fromDrawer)]);
  const detail = groups.flatMap(k => d.groups[k].items.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(e => [e.date, k, e.category || '', e.description || '', e.method || '', cellM(Number(e.amount) || 0)]));
  return markDemoSheets([
    { name: 'Utilidad neta', widths: [34, 12, 16, 12], rows: summary },
    { name: 'Detalle de gastos', widths: [12, 20, 20, 34, 14, 14], rows: [['Fecha', 'Categoría', 'Tipo', 'Descripción', 'Medio de pago', 'Valor'].map(cellH), ...detail] },
  ]);
}

/* ============ Valoración de inventario ============
   Existencias actuales (state.inventory, enlazado 1:1 por product.inventoryId) × costo promedio y × precio de venta.
   Un stock negativo (vendido sin existencias registradas) se muestra tal cual, pero se valoriza en 0. */
function inventoryValuation() {
  const supplies = new Map(state.inventory.map(i => [i.id, i])), rows = [];
  let capital = 0, commercial = 0, negative = 0;
  for (const p of state.products) {
    const supply = supplies.get(p.inventoryId), stock = Number(supply ? supply.qty : p.stock) || 0, units = Math.max(0, stock);
    const cost = Number(p.cost) || 0, price = Number(p.price) || 0, totalCost = units * cost, totalValue = units * price;
    if (stock < 0) negative++;
    capital += totalCost; commercial += totalValue;
    rows.push({ id: p.id, name: p.name, category: p.category || 'Sin categoría', unit: supply?.unit || 'und', stock, cost, price, totalCost, totalValue, profit: totalValue - totalCost });
  }
  rows.sort((a, b) => b.totalCost - a.totalCost || a.name.localeCompare(b.name, 'es'));
  const profit = commercial - capital;
  return { rows, capital, commercial, profit, margin: commercial ? profit / commercial * 100 : 0, negative };
}
function renderInventoryValue() {
  const $ = s => document.querySelector(s); if (!$('#inventoryValuePanel')) return;
  const v = inventoryValuation(), tone = !v.commercial ? 'flat' : v.profit >= 0 ? 'gain' : 'loss', signed = n => `${n < 0 ? '−' : ''}${money.format(Math.abs(n))}`;
  $('#invCapital').textContent = money.format(v.capital);
  $('#invCapitalNote').textContent = `${v.rows.length} ${v.rows.length === 1 ? 'producto' : 'productos'}${v.negative ? ` · ${v.negative} con stock negativo` : ''}`;
  $('#invCommercial').textContent = money.format(v.commercial);
  $('#invProfit').textContent = signed(v.profit);
  $('#invMargin').textContent = v.commercial ? `${v.margin.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : '—';
  ['#invProfitCard', '#invMarginCard'].forEach(id => { $(id).classList.toggle('is-gain', tone === 'gain'); $(id).classList.toggle('is-loss', tone === 'loss'); });
  $('#inventoryValueTable').innerHTML = v.rows.length ? v.rows.map(r => `<tr><td><strong>${escapeHtml(r.name)}</strong><br><small class="muted">${escapeHtml(r.category)}</small></td><td>${r.stock < 0 ? `<span class="net-figure loss" title="Stock negativo: se valoriza en $0">${formatQty(r.stock)}</span>` : formatQty(r.stock)} <small class="muted">${escapeHtml(r.unit)}</small></td><td>${money.format(r.cost)}</td><td><strong>${money.format(r.totalCost)}</strong></td><td>${money.format(r.price)}</td><td><span class="net-figure ${r.profit < 0 ? 'loss' : r.profit > 0 ? 'gain' : ''}">${signed(r.profit)}</span></td></tr>`).join('')
    : '<tr><td colspan="6" class="muted" style="text-align:center;padding:28px 16px;">No hay productos en el catálogo.</td></tr>';
  $('#inventoryValueTotals').innerHTML = v.rows.length ? `<tr><td><strong>Total</strong></td><td></td><td></td><td><strong>${money.format(v.capital)}</strong></td><td></td><td><strong class="net-figure ${tone}">${signed(v.profit)}</strong></td></tr>` : '';
}
function inventoryValueSheets() {
  const v = inventoryValuation();
  const rows = [
    [{ v: `Inventario Valorizado · ${state.profile?.name || 'NexoPos'}`, s: XS.title }], ['Fecha de corte', today()], ['Generado', new Date().toLocaleString('es-CO')], [],
    [cellH('Indicador'), cellH('Valor')],
    ['Capital invertido total', cellM(v.capital)], ['Valor comercial total', cellM(v.commercial)], ['Ganancia proyectada en bodega', cellM(v.profit)], ['Margen potencial', v.commercial ? cellP(Number(v.margin.toFixed(1))) : '—'], [],
    ['Producto', 'Categoría', 'Stock actual', 'Unidad', 'Costo unitario', 'Total costo', 'Precio venta', 'Valor comercial', 'Utilidad proyectada'].map(cellH),
    ...v.rows.map(r => [r.name, r.category, cellD(r.stock), r.unit, cellM(r.cost), cellM(r.totalCost), cellM(r.price), cellM(r.totalValue), cellM(r.profit)]),
    [cellB('Total'), '', '', '', '', cellM(v.capital), '', cellM(v.commercial), cellM(v.profit)],
  ];
  if (v.negative) rows.push([], [`${v.negative} producto(s) con stock negativo se valorizan en $0.`]);
  return markDemoSheets([{ name: 'Inventario valorizado', widths: [30, 18, 12, 8, 14, 16, 14, 16, 18], rows }]);
}
function exportInventoryXlsx() {
  if (!can('view.reports')) return deny();
  if (!requirePlan('exports')) return;
  const isDemo = typeof isDemoMode === 'function' ? isDemoMode() : !!globalThis.isDemoMode?.();
  downloadBlob(buildXlsx(inventoryValueSheets()), `inventario-valorizado-${isDemo ? 'DEMO-NETXPREMIUM-' : ''}${today()}.xlsx`);
  showToast('Inventario valorizado descargado.');
}
globalThis.inventoryValuation = inventoryValuation;
globalThis.renderInventoryValue = renderInventoryValue;

/* ---------- Exportar a Excel (.xlsx real, sin librerías) ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  files.forEach(file => {
    const name = enc.encode(file.name), data = enc.encode(file.content), crc = crc32(data), local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true); cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name); offset += 30 + name.length + data.length;
  });
  const cdSize = central.reduce((s, c) => s + c.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function xmlEsc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
function colName(index) { let s = '', n = index + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
const XS = { head: 1, money: 2, int: 3, pct: 4, bold: 5, title: 6, dec: 7 };
const cellM = v => ({ v, s: XS.money }), cellI = v => ({ v, s: XS.int }), cellP = v => ({ v, s: XS.pct }), cellH = v => ({ v, s: XS.head }), cellB = v => ({ v, s: XS.bold }), cellD = v => ({ v, s: XS.dec });
function sheetXml(rows, widths = []) {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    const spec = cell !== null && typeof cell === 'object' ? cell : { v: cell, s: 0 }, ref = `${colName(c)}${r + 1}`, style = spec.s ? ` s="${spec.s}"` : '';
    if (spec.v === '' || spec.v === null || spec.v === undefined) return '';
    return typeof spec.v === 'number' && Number.isFinite(spec.v) ? `<c r="${ref}"${style}><v>${spec.v}</v></c>` : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(spec.v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews>${cols}<sheetData>${body}</sheetData></worksheet>`;
}
const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF155E41"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
function buildXlsx(sheets) {
  const files = [
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', content: XLSX_STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s.rows, s.widths) })),
  ];
  return zipStore(files);
}
function variation(cur, prev) { return prev ? cellP(Number(((cur - prev) / Math.abs(prev) * 100).toFixed(1))) : '—'; }
function reportSheets() {
  const d = reportDataset(), { cur, old } = d, time = p => new Date(paymentTimestamp(p)).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }), period = d.from === d.to ? d.from : `${d.from} a ${d.to}`;
  const sheets = [];
  sheets.push({ name: 'Resumen', widths: [34, 20, 20, 16], rows: [
    [{ v: `Reporte de ventas · ${state.profile?.name || 'NexoPos'}`, s: XS.title }], ['Período', period], ['Período anterior', d.prev.from === d.prev.to ? d.prev.from : `${d.prev.from} a ${d.prev.to}`], ['Generado', new Date().toLocaleString('es-CO')], [],
    [cellH('Indicador'), cellH('Actual'), cellH('Período anterior'), cellH('Variación')],
    ['Ventas', cellM(cur.total), cellM(old.total), variation(cur.total, old.total)], ['Facturas', cellI(cur.count), cellI(old.count), variation(cur.count, old.count)], ['Ticket promedio', cellM(cur.avg), cellM(old.avg), variation(cur.avg, old.avg)],
    ['Costo de ventas', cellM(cur.cost), cellM(old.cost), variation(cur.cost, old.cost)], ['Utilidad bruta', cellM(cur.profit), cellM(old.profit), variation(cur.profit, old.profit)], ['Margen bruto', cellP(Number(cur.margin.toFixed(1))), cellP(Number(old.margin.toFixed(1))), ''], [],
    [cellB('Inventario')], ['Mermas (costo)', cellM(d.mermas)], ['Faltantes en conteo', cellM(d.faltantes)], ['Sobrantes en conteo', cellM(d.sobrantes)], ['Pérdida neta de inventario', cellM(d.stockLoss)], ['Utilidad tras mermas', cellM(d.profitAfterLoss)], [],
    [cellH('Medio de pago'), cellH('Total')], ...Object.entries(d.byMethod).map(([m, v]) => [m, cellM(v)]),
  ] });
  sheets.push({ name: 'Facturas', widths: [12, 12, 8, 24, 18, 18, 14, 14, 10], rows: [['N.º', 'Fecha', 'Hora', 'Mesa / cliente', 'Mesero', 'Cajero', 'Medio de pago', 'Total', 'Editada'].map(cellH), ...[...d.payments].sort((a, b) => paymentTimestamp(a) - paymentTimestamp(b)).map(p => [p.invoiceNo || '', p.date, time(p), p.customer || '', p.waiterName || '', p.cashierName || '', p.method, cellM(p.amount), p.editedAt ? 'Sí' : ''])] });
  sheets.push({ name: 'Detalle de ventas', widths: [12, 12, 28, 16, 8, 12, 12, 14, 14, 14], rows: [['Factura', 'Fecha', 'Producto', 'Categoría', 'Cant.', 'Precio', 'Costo unit.', 'Venta', 'Costo', 'Utilidad'].map(cellH), ...d.payments.flatMap(p => (p.items || []).map(i => [p.invoiceNo || '', p.date, i.name, itemCategory(i), cellI(i.qty), cellM(i.price), cellM(itemCost(i)), cellM(i.price * i.qty), cellM(itemCost(i) * i.qty), cellM((i.price - itemCost(i)) * i.qty)]))] });
  const grouped = (obj, withCat) => Object.entries(obj).sort((a, b) => b[1].sales - a[1].sales).map(([name, v]) => [name, ...(withCat ? [v.category] : []), cellI(v.qty), cellM(v.sales), cellM(v.cost), cellM(v.sales - v.cost), cellP(v.sales ? Number(((v.sales - v.cost) / v.sales * 100).toFixed(1)) : 0)]);
  sheets.push({ name: 'Por producto', widths: [28, 16, 10, 14, 14, 14, 10], rows: [['Producto', 'Categoría', 'Cant.', 'Ventas', 'Costo', 'Utilidad', 'Margen'].map(cellH), ...grouped(d.byProduct, true)] });
  sheets.push({ name: 'Por categoría', widths: [24, 10, 14, 14, 14, 10], rows: [['Categoría', 'Cant.', 'Ventas', 'Costo', 'Utilidad', 'Margen'].map(cellH), ...grouped(d.byCategory, false)] });
  sheets.push({ name: 'Por hora', widths: [14, 14, 12], rows: [['Hora', 'Ventas', 'Facturas'].map(cellH), ...HOUR_ORDER.map(h => [`${hourLabel(h)} – ${hourLabel((h + 1) % 24)}`, cellM(d.hours[h]), cellI(d.hourCount[h])])] });
  sheets.push({ name: 'Por día de semana', widths: [14, 14, 12, 18], rows: [['Día', 'Ventas', 'Días en el período', 'Promedio por día'].map(cellH), ...WEEKDAY_ORDER.map((n, i) => [WEEKDAYS[i], cellM(d.weekdays[n]), cellI(d.weekdayDays[n]), cellM(d.weekdayDays[n] ? d.weekdays[n] / d.weekdayDays[n] : 0)])] });
  sheets.push({ name: 'Por vendedor', widths: [24, 14, 12], rows: [['Mesero', 'Ventas', 'Facturas'].map(cellH), ...Object.entries(d.byWaiter).sort((a, b) => b[1].sales - a[1].sales).map(([n, v]) => [n, cellM(v.sales), cellI(v.count)])] });
  sheets.push({ name: 'Compras', widths: [12, 24, 16, 14, 14, 10], rows: [['Fecha', 'Proveedor', 'Factura', 'Medio de pago', 'Total', 'Productos'].map(cellH), ...d.purchases.map(p => [p.date, p.supplier, p.invoice, p.method || '', cellM(p.total), cellI(p.lines.length)])] });
  sheets.push({ name: 'Gastos', widths: [12, 22, 34, 14, 14], rows: [['Fecha', 'Tipo', 'Descripción', 'Medio de pago', 'Valor'].map(cellH), ...d.expenses.map(e => [e.date, e.category, e.description, e.method, cellM(e.amount)])] });
  sheets.push({ name: 'Mermas y conteos', widths: [12, 16, 24, 12, 8, 14, 34, 16], rows: [['Fecha', 'Tipo', 'Insumo', 'Cantidad', 'Unidad', 'Valor', 'Motivo', 'Usuario'].map(cellH), ...d.stock.map(e => [e.date, STOCK_TYPES[e.type] || e.type, e.itemName, cellD(e.delta), e.unit || '', cellM(e.value || 0), e.reason || '', e.userName || ''])] });

  return markDemoSheets(sheets);
}
function markDemoSheets(sheets) {
  const isDemo = typeof isDemoMode === 'function' ? isDemoMode() : !!globalThis.isDemoMode?.();
  if (isDemo) {
    sheets.forEach(s => {
      s.rows.unshift([{ v: 'DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM', s: XS.title }]);
      s.rows.push([], [{ v: 'DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM', s: XS.bold }]);
    });
  }
  return sheets;
}
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
function exportReportXlsx() {
  if (!can('view.reports')) return deny();
  if (!requirePlan('exports')) return;
  if (reportTab === 'inventory') return exportInventoryXlsx(); // el botón del encabezado exporta la sub-pestaña que se está viendo
  const isDemo = typeof isDemoMode === 'function' ? isDemoMode() : !!globalThis.isDemoMode?.();
  if (reportTab === 'net') {
    const { from, to } = netBounds();
    downloadBlob(buildXlsx(netProfitSheets()), `utilidad-neta-${isDemo ? 'DEMO-NETXPREMIUM-' : ''}${from}${from === to ? '' : '_a_' + to}.xlsx`);
    return showToast('Utilidad neta descargada en Excel.');
  }
  const { from, to } = reportBounds();
  const filename = isDemo ? `reporte-DEMO-NETXPREMIUM-${from}${from === to ? '' : '_a_' + to}.xlsx` : `reporte-${from}${from === to ? '' : '_a_' + to}.xlsx`;
  downloadBlob(buildXlsx(reportSheets()), filename);
  showToast('Reporte de Excel descargado.');
}
function printReport() {
  if (!can('view.reports')) return deny();
  if (!requirePlan('exports')) return;
  const isDemo = typeof isDemoMode === 'function' ? isDemoMode() : !!globalThis.isDemoMode?.();
  const watermarkPrefix = isDemo ? 'DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM · ' : '';
  const { from, to } = reportBounds();
  const headerEl = document.querySelector('#printHeader');
  if (headerEl) {
    headerEl.textContent = `${watermarkPrefix}${state.profile?.name || 'NexoPos'} · Reporte ${from === to ? 'del ' + shortDate(from, true) : 'del ' + shortDate(from) + ' al ' + shortDate(to, true)} · generado ${new Date().toLocaleString('es-CO')}`;
  }
  const footerEl = document.querySelector('#printFooter');
  if (footerEl) {
    footerEl.textContent = isDemo ? 'DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM' : '';
    footerEl.hidden = !isDemo;
  }
  window.print();
}

/* ============ Plano de mesas ============
   Cada mesa guarda tipo ('mesa' | 'mostrador') y posición del centro en % del lienzo (posX, posY de 0 a 100). El lienzo
   es 16:10 y los tamaños también van en %, así el plano se ve igual en cualquier pantalla. Configuración (Mi negocio →
   Mesas y distribución) trabaja sobre un borrador que solo se aplica al pulsar «Guardar distribución»; la vista operativa
   del salón no arrastra nada: tocar una mesa abre su pedido como siempre (data-table).
   Sincronización: la distribución viaja en state.profile.floorPlan, que ya va dentro de negocios.configuracion en todas
   las subidas; la otra caja la aplica si su updatedAt es más reciente (applyRemoteFloorPlan). */
// Huella (tablero + sillas) en % del ancho y del alto del escenario 16:10. En un lienzo de ~1000 px el tablero de la mesa
// mide ~108×96 px y el de la barra ~205×80 px (ver .floor-body en design.css).
const FLOOR_SIZE = { mesa: { w: 12, h: 21 }, mostrador: { w: 21, h: 18.5 } };
const TABLE_VIEW_KEY = 'nexopos-table-view';
let floorDraft = null, floorDirty = false, floorSelected = null, floorDrag = null;
let tableView = (() => { try { return localStorage.getItem(TABLE_VIEW_KEY) || 'plano'; } catch { return 'plano'; } })();
function tableViewMode() { return tableView === 'grid' || !planAllows('floorMap') ? 'grid' : 'plano'; } // el plano del salón es del Plan Pro
function setTableView(mode) { tableView = mode === 'grid' ? 'grid' : 'plano'; try { localStorage.setItem(TABLE_VIEW_KEY, tableView); } catch { /* preferencia opcional */ } renderTables(); }
function tableTipo(table) { return table?.tipo === 'mostrador' || (!table?.tipo && table?.type === 'bar') ? 'mostrador' : 'mesa'; }
function clampFloorPos(tipo, x, y) {
  const s = FLOOR_SIZE[tipo] || FLOOR_SIZE.mesa, hw = s.w / 2 + 0.5, hh = s.h / 2 + 0.5, r = v => Math.round(v * 10) / 10;
  return { posX: r(Math.min(100 - hw, Math.max(hw, Number(x) || 0))), posY: r(Math.min(100 - hh, Math.max(hh, Number(y) || 0))) };
}
function floorOverlaps(a, b) {
  const sa = FLOOR_SIZE[tableTipo(a)], sb = FLOOR_SIZE[tableTipo(b)];
  return Math.abs(a.posX - b.posX) < (sa.w + sb.w) / 2 && Math.abs(a.posY - b.posY) < (sa.h + sb.h) / 2;
}
// Primer hueco libre (de arriba abajo, de izquierda a derecha); si el plano está lleno, el centro
function findFreeFloorSpot(tables, tipo) {
  const s = FLOOR_SIZE[tipo];
  for (let y = s.h / 2 + 2; y <= 100 - s.h / 2; y += 4) for (let x = s.w / 2 + 2; x <= 100 - s.w / 2; x += 3) {
    const probe = { tipo, posX: x, posY: y };
    if (!tables.some(t => Number.isFinite(t.posX) && floorOverlaps(probe, t))) return clampFloorPos(tipo, x, y);
  }
  return clampFloorPos(tipo, 50, 50);
}
// Disposición ordenada por defecto: mostradores en la franja superior y mesas en cuadrícula debajo, agrupadas por zona
function defaultFloorLayout(tables) {
  const zoneOrder = [...new Set(tables.map(t => t.zone))], counters = tables.filter(t => t.tipo === 'mostrador');
  const mesas = tables.filter(t => t.tipo !== 'mostrador').sort((a, b) => zoneOrder.indexOf(a.zone) - zoneOrder.indexOf(b.zone));
  const cCols = Math.max(1, Math.min(4, counters.length));
  const step = FLOOR_SIZE.mostrador.h + 2; // filas de barras sin tocarse
  counters.forEach((t, i) => Object.assign(t, clampFloorPos('mostrador', (i % cCols + 0.5) * 100 / cCols, (Math.floor(i / cCols) + 0.5) * step)));
  const top = counters.length ? Math.ceil(counters.length / cCols) * step : 0;
  const maxCols = Math.floor(100 / (FLOOR_SIZE.mesa.w + 1)); // columnas que caben sin que las mesas se toquen
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(mesas.length * 1.6)))), rows = Math.max(1, Math.ceil(mesas.length / cols));
  mesas.forEach((t, i) => Object.assign(t, clampFloorPos('mesa', (i % cols + 0.5) * 100 / cols, top + (Math.floor(i / cols) + 0.5) * (100 - top) / rows)));
}
function ensureTableLayout(tables) {
  if (!Array.isArray(tables)) return [];
  tables.forEach(t => { t.tipo = tableTipo(t); });
  const placed = tables.filter(t => Number.isFinite(Number(t.posX)) && Number.isFinite(Number(t.posY)) && t.posX !== null && t.posY !== null && t.posX !== '' && t.posY !== '');
  if (!placed.length) { defaultFloorLayout(tables); return tables; }
  placed.forEach(t => Object.assign(t, clampFloorPos(t.tipo, t.posX, t.posY)));
  tables.filter(t => !placed.includes(t)).forEach(t => Object.assign(t, findFreeFloorSpot(tables.filter(o => o !== t && Number.isFinite(o.posX)), t.tipo)));
  return tables;
}
function floorItemStyle(t) { return `left:${t.posX}%;top:${t.posY}%`; }

/* ---------- Vista operativa (Salón) ---------- */
function renderFloorLive(tables) {
  const el = document.querySelector('#tableFloor'); if (!el) return;
  if (!tables.length) { el.innerHTML = '<div class="floorplan-stage"><p class="muted floor-empty">No hay mesas en esta zona.</p></div>'; return; }
  el.innerHTML = '<div class="floorplan-stage">' + tables.map(table => {
    const order = activeOrderForTable(table.id), tipo = tableTipo(table), long = order && Date.now() - (order.createdAt || Date.now()) >= 120 * 60000;
    const status = order ? `<span class="floor-amount">${money.format(orderPending(order))}</span><span class="floor-time ${long ? 'long' : ''}">${escapeHtml(elapsedLabel(order.createdAt).replace(/^Abierta hace /, ''))}</span>` : '<span class="floor-status">Disponible</span>';
    return `<button type="button" class="floor-item ${tipo} ${order ? 'occupied' : 'free'}" data-table="${escapeHtml(table.id)}" style="${floorItemStyle(table)}" title="${escapeHtml(`${table.name} · ${table.zone}${order ? ' · ' + money.format(orderPending(order)) : ' · Disponible'}`)}"><span class="floor-body"><span class="floor-name">${escapeHtml(table.name)}</span>${status}</span></button>`;
  }).join('') + '</div>';
}

/* ---------- Diseñador (Configuración) ---------- */
function floorTables() { return floorDraft || state.tables; }
function beginFloorDraft() { if (!floorDraft) floorDraft = ensureTableLayout(structuredClone(state.tables)); return floorDraft; }
function markFloorDirty() { floorDirty = true; renderFloorDesigner(); }
function floorZones() { return [...new Set(['Salón', 'Barra', 'Terraza', 'VIP', ...floorTables().map(t => t.zone).filter(Boolean)])]; }
function renderFloorDesigner() {
  const canvas = document.querySelector('#floorplan-designer'); if (!canvas || floorDrag) return; // no repintar a mitad de un arrastre
  if (!floorDirty) { floorDraft = null; if (floorSelected && !state.tables.some(t => t.id === floorSelected)) floorSelected = null; }
  const tables = floorTables(), isDemo = typeof isDemoMode === 'function' && isDemoMode();
  canvas.innerHTML = '<div class="floorplan-stage">' + (tables.length ? tables.map(t => `<div class="floor-item ${tableTipo(t)} ${t.id === floorSelected ? 'selected' : ''} ${activeOrderForTable(t.id) ? 'occupied' : 'free'}" data-floor-item="${escapeHtml(t.id)}" role="button" tabindex="0" aria-label="${escapeHtml(`${t.name}, ${tableTipo(t) === 'mostrador' ? 'mostrador' : 'mesa'}. Arrastra para moverla.`)}" style="${floorItemStyle(t)}"><span class="floor-body"><span class="floor-name">${escapeHtml(t.name)}</span><span class="floor-zone">${escapeHtml(t.zone || '')}</span></span></div>`).join('')
    : '<p class="muted floor-empty">Aún no hay mesas. Usa «+ Mesa» o «+ Mostrador/Barra».</p>') + '</div>';
  const sel = tables.find(t => t.id === floorSelected), editor = document.querySelector('#floorEditor');
  if (editor) editor.innerHTML = sel ? `<div class="floor-editor-row">
      <label><span class="field-label">Nombre</span><input id="floorItemName" type="text" maxlength="40" value="${escapeHtml(sel.name)}" /></label>
      <label><span class="field-label">Zona</span><select id="floorItemZone">${floorZones().map(z => `<option ${z === sel.zone ? 'selected' : ''}>${escapeHtml(z)}</option>`).join('')}</select></label>
      <div><span class="field-label">Tipo</span><div class="segmented floor-tipo">${[['mesa', 'Mesa cuadrada'], ['mostrador', 'Barra alargada']].map(([v, l]) => `<button type="button" data-floor-tipo="${v}" class="${tableTipo(sel) === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      <button type="button" id="floorDeleteItem" class="danger-outline-button floor-delete" ${activeOrderForTable(sel.id) || isDemo ? 'disabled' : ''} title="${activeOrderForTable(sel.id) ? 'Tiene un pedido abierto: cóbralo o elimínalo primero' : isDemo ? 'En el modo demo el número de mesas es fijo' : 'Eliminar esta mesa'}">Eliminar</button>
    </div>` : '<p class="muted">Selecciona una mesa del plano para editarla.</p>';
  ['#floorAddTable', '#floorAddCounter'].forEach(id => { const b = document.querySelector(id); if (b) { b.disabled = isDemo; b.title = isDemo ? 'En el modo demo el número de mesas es fijo' : ''; } });
  renderFloorStatus();
}
// Botones Guardar/Descartar y aviso de cambios pendientes (sin repintar el lienzo ni el editor)
function renderFloorStatus() {
  const tables = floorTables(), label = document.querySelector('#floorDirtyLabel');
  ['#floorSaveButton', '#floorDiscardButton'].forEach(id => { const b = document.querySelector(id); if (b) b.disabled = !floorDirty; });
  if (typeof applyPlanGates === 'function') applyPlanGates(); // contador de mesas del Plan Básico
  if (label) label.textContent = floorDirty ? 'Cambios sin guardar: pulsa «Guardar distribución» para aplicarlos en el salón y en las demás cajas.' : `${tables.length} ${tables.length === 1 ? 'elemento' : 'elementos'} en el plano.`;
}
function addFloorItem(tipo) {
  if (typeof isDemoMode === 'function' && isDemoMode()) return showToast('En el modo demo el número de mesas es fijo.');
  if (!canAddTable(floorTables().length)) return requirePlan('tables', `Tu Plan Básico permite hasta ${planTableLimit()} mesas o barras. Mejora a Pro para tener mesas ilimitadas.`);
  const draft = beginFloorDraft(), base = tipo === 'mostrador' ? 'Barra' : 'Mesa', re = new RegExp(`^${base}\\s+(\\d+)$`, 'i');
  const n = 1 + Math.max(0, ...draft.map(t => Number(String(t.name).trim().match(re)?.[1]) || 0)); // sigue la numeración: Mesa 4 → Mesa 5
  const item = { id: uid('table'), name: `${base} ${n}`, zone: tipo === 'mostrador' ? 'Barra' : 'Salón', tipo, type: tipo === 'mostrador' ? 'bar' : undefined, ...findFreeFloorSpot(draft, tipo) };
  draft.push(item); floorSelected = item.id; markFloorDirty();
}
function deleteFloorItem() {
  if (typeof isDemoMode === 'function' && isDemoMode()) return showToast('En el modo demo el número de mesas es fijo.');
  const draft = beginFloorDraft(), item = draft.find(t => t.id === floorSelected); if (!item) return;
  if (activeOrderForTable(item.id)) return showToast('Cobra o elimina el pedido activo antes de eliminar esta mesa.');
  if (!window.confirm(`¿Eliminar ${item.name} del plano?`)) return;
  floorDraft = draft.filter(t => t.id !== item.id); floorSelected = null; markFloorDirty();
}
function updateFloorSelected(changes) { const item = beginFloorDraft().find(t => t.id === floorSelected); if (!item) return null; Object.assign(item, changes); floorDirty = true; return item; }
function setFloorTipo(tipo) { const item = updateFloorSelected({ tipo, type: tipo === 'mostrador' ? 'bar' : undefined }); if (item) { Object.assign(item, clampFloorPos(tipo, item.posX, item.posY)); renderFloorDesigner(); } }
function discardFloorLayout() { floorDraft = null; floorDirty = false; renderFloorDesigner(); showToast('Cambios del plano descartados.'); }
function floorPlanSnapshot() { return { updatedAt: Date.now(), tables: state.tables.map(t => ({ id: t.id, name: t.name, zone: t.zone, tipo: tableTipo(t), posX: t.posX, posY: t.posY })) }; }
function saveFloorLayout() {
  if (!floorDirty || !floorDraft) return showToast('No hay cambios en la distribución.');
  const draft = floorDraft.map(t => ({ ...t, name: String(t.name || '').trim() }));
  if (draft.some(t => !t.name)) return showToast('Todas las mesas necesitan un nombre.');
  const seen = new Set(); for (const t of draft) { const k = t.name.toLowerCase(); if (seen.has(k)) return showToast(`Hay dos mesas llamadas «${t.name}».`); seen.add(k); }
  if (draft.length > planTableLimit() && draft.length > state.tables.length) return requirePlan('tables', `Tu Plan Básico permite hasta ${planTableLimit()} mesas o barras.`);
  const removed = state.tables.filter(t => !draft.some(d => d.id === t.id));
  const busy = removed.find(t => activeOrderForTable(t.id)); if (busy) return showToast(`${busy.name} tiene un pedido abierto: cóbralo o elimínalo antes de quitarla.`);
  state.tables = draft.map(t => { const tipo = tableTipo(t), out = { ...t, tipo, ...clampFloorPos(tipo, t.posX, t.posY) }; if (tipo === 'mostrador') out.type = 'bar'; else if (out.type === 'bar' || out.type === undefined) delete out.type; return out; });
  state.orders.forEach(o => { const t = state.tables.find(x => x.id === o.tableId); if (t && o.tableName !== t.name) { o.tableName = t.name; o.sync_status = 'pending'; } });
  state.profile = { ...state.profile, floorPlan: floorPlanSnapshot(), sync_status: 'pending' };
  if (typeof logAudit === 'function') logAudit('Plano de mesas', `${state.tables.length} elementos · ${removed.length ? removed.length + ' eliminados' : 'sin eliminaciones'}`);
  floorDraft = null; floorDirty = false;
  saveState(); renderAll(); showToast('Distribución guardada.');
}
// Aplica la distribución que llegó de otra caja si es más reciente que la local. Las mesas locales con pedido abierto que el plano remoto no trae se conservan.
function applyRemoteFloorPlan(remote, localPlan = state.profile?.floorPlan) {
  if (typeof isDemoMode === 'function' && isDemoMode()) return false;
  if (!remote || !Array.isArray(remote.tables) || !remote.tables.length) return false;
  if ((Number(remote.updatedAt) || 0) <= (Number(localPlan?.updatedAt) || 0)) { if (localPlan && state.profile) state.profile.floorPlan = localPlan; return false; }
  const incoming = remote.tables.filter(r => r && r.id).map(r => { const tipo = r.tipo === 'mostrador' ? 'mostrador' : 'mesa', t = { id: String(r.id), name: String(r.name || 'Mesa').slice(0, 40), zone: String(r.zone || 'Salón').slice(0, 40), tipo, posX: Number(r.posX), posY: Number(r.posY) }; if (tipo === 'mostrador') t.type = 'bar'; return t; });
  const kept = state.tables.filter(t => activeOrderForTable(t.id) && !incoming.some(r => r.id === t.id));
  state.tables = ensureTableLayout([...incoming, ...kept]);
  if (state.profile) state.profile.floorPlan = remote;
  if (!floorDirty) floorDraft = null;
  return true;
}
function handleFloorPointerDown(event) {
  // Las posiciones son % del escenario interior (sin el margen perimetral del lienzo): se mide ese rectángulo
  const item = event.target.closest?.('[data-floor-item]'), canvas = item?.closest('#floorplan-designer') && item.closest('.floorplan-stage');
  if (!item || !canvas || event.button > 0) return;
  const t = beginFloorDraft().find(x => x.id === item.dataset.floorItem); if (!t) return;
  event.preventDefault();
  floorDrag = { id: t.id, el: item, canvas, rect: canvas.getBoundingClientRect(), x0: event.clientX, y0: event.clientY, px: t.posX, py: t.posY, moved: false, pointerId: event.pointerId };
  try { item.setPointerCapture(event.pointerId); } catch { /* opcional */ }
  item.classList.add('dragging');
}
function handleFloorPointerMove(event) {
  if (!floorDrag || event.pointerId !== floorDrag.pointerId) return;
  const dx = event.clientX - floorDrag.x0, dy = event.clientY - floorDrag.y0;
  if (!floorDrag.moved && Math.hypot(dx, dy) < 4) return; // un toque no mueve la mesa
  if (!planAllows('floorMap')) { floorDrag.el.classList.remove('dragging'); floorDrag = null; return requirePlan('floorMap', 'Con el Plan Básico las mesas se ubican solas. Mejora a Pro para diseñar tu salón arrastrándolas.'); }
  floorDrag.moved = true;
  const t = floorDraft?.find(x => x.id === floorDrag.id); if (!t) return;
  Object.assign(t, clampFloorPos(tableTipo(t), floorDrag.px + dx / floorDrag.rect.width * 100, floorDrag.py + dy / floorDrag.rect.height * 100));
  floorDrag.el.style.left = `${t.posX}%`; floorDrag.el.style.top = `${t.posY}%`;
}
function handleFloorPointerUp(event) {
  if (!floorDrag || event.pointerId !== floorDrag.pointerId) return;
  const { id, moved } = floorDrag; floorDrag = null;
  floorSelected = id; if (moved) floorDirty = true;
  renderFloorDesigner();
}
// Teclado: con una mesa enfocada, las flechas la mueven 1 % (5 % con Shift)
function handleFloorKeys(event) {
  const item = event.target.closest?.('[data-floor-item]'); if (!item || !item.closest('#floorplan-designer')) return;
  const step = event.shiftKey ? 5 : 1, moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }, mv = moves[event.key];
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); floorSelected = item.dataset.floorItem; return renderFloorDesigner(); }
  if (!mv) return;
  event.preventDefault();
  if (!planAllows('floorMap')) return requirePlan('floorMap');
  const t = beginFloorDraft().find(x => x.id === item.dataset.floorItem); if (!t) return;
  floorSelected = t.id; Object.assign(t, clampFloorPos(tableTipo(t), t.posX + mv[0], t.posY + mv[1])); floorDirty = true;
  renderFloorDesigner(); document.querySelector(`[data-floor-item="${CSS.escape(t.id)}"]`)?.focus();
}
function openFloorDesigner() {
  document.querySelector('.nav-link[data-view="profile"]')?.click();
  setTimeout(() => document.querySelector('#floorDesignerCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
globalThis.ensureTableLayout = ensureTableLayout;
globalThis.tableViewMode = tableViewMode;
globalThis.renderFloorLive = renderFloorLive;
globalThis.renderFloorDesigner = renderFloorDesigner;
globalThis.applyRemoteFloorPlan = applyRemoteFloorPlan;

/* ============ Eventos y arranque ============ */
function handleModuleClick(event) {
  const t = event.target.closest('button'); if (!t) return; const d = t.dataset;
  if (d.loginUser && !planAllowsRole(state.users.find(u => u.id === d.loginUser)?.role)) return requirePlan('multiRole', 'El Plan Básico incluye un solo usuario administrador. Mejora a Pro para que meseros y cajeros entren con su propio PIN.');
  if (d.loginUser) { loginTarget = d.loginUser; loginPin = ''; setLoginError(''); return renderLogin(); }
  if (d.key !== undefined) return pressPin(d.key);
  if (d.editUser) return openUserDialog(d.editUser);
  if (d.printInvoice) return printPaymentReceipt(d.printInvoice, { reprint: true });
  if (d.editInvoice) return openInvoiceEdit(d.editInvoice);
  if (d.deleteInvoice) return openInvoiceDelete(d.deleteInvoice);
  if (d.removeInvTender !== undefined && invoiceDraft) { invoiceDraft.tenders.splice(Number(d.removeInvTender), 1); if (invoiceDraft.tenders.length === 1) document.querySelector('#invoiceMethodEdit').value = invoiceDraft.tenders[0].method; return renderInvoiceTenders(); }
  if (d.removeInvLine !== undefined) { invoiceDraft.items.splice(Number(d.removeInvLine), 1); return renderInvoiceDraft(); }
  if (d.editSupplier) return openSupplierDialog(d.editSupplier);
  if (d.deleteSupplier) return deleteSupplier(d.deleteSupplier);
  if (d.reportTab) { reportTab = d.reportTab; return applyReportTab(); }
  if (d.tableView) return setTableView(d.tableView);
  if (d.floorTipo) return setFloorTipo(d.floorTipo);
  if (d.netRange) { if (d.netRange === 'custom' && !netFrom) ({ from: netFrom, to: netTo } = netBounds()); netRange = d.netRange; return renderNetProfit(); } // el personalizado arranca con el rango que se estaba viendo
  const actions = {
    loginBackButton: () => { loginTarget = null; loginPin = ''; setLoginError(''); renderLogin(); },
    forgotPinButton: openPinRecovery,
    pinRecoveryForgotPassword: () => globalThis.openRecovery?.(document.querySelector('#pinRecoveryEmail').value.trim().toLowerCase(), email => {
      document.querySelector('#pinRecoveryEmail').value = email; document.querySelector('#pinRecoveryPassword').value = '';
      document.querySelector('#pinRecoveryPassword').focus(); setPinRecoveryMessage('Contraseña actualizada. Escríbela aquí para restablecer el PIN.', true);
    }),
    userChip: openSessionDialog, logoutButton: showLogin, changePinButton: () => openPinDialog(false), savePinButton: savePin,
    newUserButton: () => openUserDialog(), saveUserButton: saveUser, saveInvoiceButton: saveInvoiceEdit, invoiceAddButton: addInvoiceLine, invoiceAddTender: () => { if (!invoiceDraft) return; invoiceDraft.tenders.push({ method: 'Nequi', amount: 0 }); renderInvoiceTenders(); }, confirmDeleteInvoiceButton: confirmDeleteInvoice,
    invoiceTodayButton: () => { invoiceFilter.date = ''; renderInvoices(); }, invoiceAllButton: () => { invoiceFilter.date = 'all'; renderInvoices(); },
    newSupplierButton: () => openSupplierDialog(), saveSupplierButton: saveSupplier, newWasteButton: openWasteDialog, saveWasteButton: saveWaste, newCountButton: openCountDialog, applyCountButton: applyCount,
    editFloorButton: openFloorDesigner, floorAddTable: () => addFloorItem('mesa'), floorAddCounter: () => addFloorItem('mostrador'),
    floorDeleteItem: () => deleteFloorItem(), floorSaveButton: () => saveFloorLayout(), floorDiscardButton: discardFloorLayout,
    exportXlsxButton: exportReportXlsx, exportInventoryXlsxButton: exportInventoryXlsx, printReportButton: printReport,
    downloadTemplateBtn: () => globalThis.downloadProductTemplate && globalThis.downloadProductTemplate(),
    importProductsBtn: () => globalThis.openImportProductsDialog && globalThis.openImportProductsDialog(),
    themeToggle: () => { const light = document.documentElement.dataset.theme !== 'light'; if (light) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme; try { localStorage.setItem('nexopos-theme', light ? 'light' : 'dark'); localStorage.setItem('brasa-theme', light ? 'light' : 'dark'); } catch { /* sin almacenamiento */ } },
    backupNowButton: () => { if (!can('backup')) return deny(); runBackup('Manual', 'manual'); },
    openBackupFolderButton: () => { if (globalThis.desktop) desktop.openBackupFolder(); },
    chooseBackupFolderButton: async () => { if (!can('backup') || !globalThis.desktop) return deny(); const dir = await desktop.chooseBackupFolder(); if (dir) { showToast('Carpeta de respaldos actualizada.'); refreshStorageInfo(true); } },
  };
  if (actions[t.id]) actions[t.id]();
}
function handleModuleInput(event) {
  const t = event.target;
  if (t.id === 'floorItemName') { const item = updateFloorSelected({ name: t.value }); if (item) { const label = document.querySelector(`[data-floor-item="${CSS.escape(item.id)}"] .floor-name`); if (label) label.textContent = t.value; renderFloorStatus(); } }
  if (t.dataset.invLine !== undefined && invoiceDraft) {
    const item = invoiceDraft.items[Number(t.dataset.invLine)]; if (!item) return; item[t.dataset.invField] = t.value === '' ? 0 : Number(t.value);
    const row = t.closest('.invoice-line'); if (row) row.querySelector('b').textContent = money.format((Number(item.price) || 0) * (Number(item.qty) || 0));
    const original = state.payments.find(p => p.id === invoiceDraft.id), total = draftTotal(), diff = total - (original?.amount || 0);
    renderInvoiceTendersStatus();
    document.querySelector('#invoiceNewTotal').textContent = money.format(total); document.querySelector('#invoiceDiff').textContent = diff === 0 ? 'El total no cambia.' : `Total original ${money.format(original?.amount || 0)} · diferencia ${diff > 0 ? '+' : '−'}${money.format(Math.abs(diff))}`;
  }
  if (t.dataset.invTender !== undefined && invoiceDraft) { const tender = invoiceDraft.tenders[Number(t.dataset.invTender)]; if (tender && t.dataset.invTenderField === 'amount') { tender.amount = t.value === '' ? 0 : Number(t.value); renderInvoiceTendersStatus(); } }
  if (t.id === 'wasteQty') updateWasteValue(); if (t.dataset.countItem !== undefined) updateCountTotals();
  if (t.id === 'invoiceSearch') { invoiceFilter.q = t.value; renderInvoices(); }
}
function handleModuleChange(event) {
  const t = event.target;
  if (t.id === 'floorItemZone') { if (updateFloorSelected({ zone: t.value })) renderFloorDesigner(); }
  if (t.dataset.invTender !== undefined && t.dataset.invTenderField === 'method' && invoiceDraft) { const tender = invoiceDraft.tenders[Number(t.dataset.invTender)]; if (tender) tender.method = t.value; }
  if (t.id === 'wasteItem') updateWasteValue();
  // Fecha anterior a la ventana en memoria (o «todas»): se traen los meses archivados y se vuelve a dibujar
  if (t.id === 'invoiceDate') { invoiceFilter.date = t.value || 'all'; renderInvoices(); globalThis.asegurarHistorial?.(t.value || '').then(n => { if (n) renderInvoices(); }); }
  if ((t.id === 'netFrom' || t.id === 'netTo') && t.value) { if (t.id === 'netFrom') netFrom = t.value; else netTo = t.value; netRange = 'custom'; renderNetProfit(); globalThis.asegurarHistorial?.(netBounds().from).then(n => { if (n) renderNetProfit(); }); }
  if (t.id === 'invoiceMethod') { invoiceFilter.method = t.value; renderInvoices(); }
  if (t.id === 'backupOnClose' || t.id === 'backupDaily') { if (!can('backup')) { renderBackupCard(); return deny(); } const s = backupSettings(); s[t.id === 'backupOnClose' ? 'onClose' : 'daily'] = t.checked; saveState(); showToast('Preferencia de respaldo guardada.'); }
}
function handleLoginKeys(event) {
  if (!document.querySelector('#loginDialog').open || !loginTarget) return;
  if (document.querySelector('#pinRecoveryDialog')?.open || document.querySelector('#recoveryDialog')?.open) return; // se está escribiendo en la recuperación
  if (/^\d$/.test(event.key)) { event.preventDefault(); pressPin(event.key); } else if (event.key === 'Backspace') { event.preventDefault(); pressPin('back'); }
}
function initModules() {
  ['openPayment', 'confirmPayment'].forEach(n => guard(n, 'charge'));
  ['openShiftDialog', 'openCloseDialog', 'confirmOpenShift', 'confirmClose'].forEach(n => guard(n, 'shift'));
  ['openProductDialog', 'saveProduct', 'deleteProduct', 'openImportProductsDialog', 'openModifierGroupDialog', 'saveModifierGroup', 'deleteModifierGroup'].forEach(n => guard(n, 'products'));
  ['addFloorItem', 'deleteFloorItem', 'saveFloorLayout'].forEach(n => guard(n, 'tables'));
  ['openCategoriesDialog', 'addCategory', 'saveCategory', 'deleteCategory'].forEach(n => guard(n, 'categories'));
  ['saveProfile'].forEach(n => guard(n, 'profile')); ['exportBackup', 'importBackup'].forEach(n => guard(n, 'backup'));
  ['openPurchaseDialog', 'savePurchase', 'openExpenseDialog', 'saveExpense'].forEach(n => guard(n, 'purchases'));
  ['openInventoryDialog', 'saveInventory', 'openInsumoDialog', 'saveInsumo', 'deleteInsumo'].forEach(n => guard(n, 'inventory'));
  guard('deleteCurrentOrder', 'cancelOrder');
  ['openExpenseDialog', 'saveExpense'].forEach(n => planGuard(n, 'expenses')); // seguimiento de gastos: Plan Pro
  const closeShift = globalThis.confirmClose; // al cerrar caja se respalda toda la base de datos
  globalThis.confirmClose = function (...args) { const wasOpen = isShiftOpen(), result = closeShift.apply(this, args); if (wasOpen && !isShiftOpen() && backupSettings().onClose) runBackup('Cierre de caja', 'cierre', true); return result; };
  document.addEventListener('pointerdown', handleFloorPointerDown); document.addEventListener('pointermove', handleFloorPointerMove); document.addEventListener('pointerup', handleFloorPointerUp); document.addEventListener('pointercancel', handleFloorPointerUp); document.addEventListener('keydown', handleFloorKeys);
  document.addEventListener('click', handleModuleClick); document.addEventListener('input', handleModuleInput); document.addEventListener('change', handleModuleChange); document.addEventListener('keydown', handleLoginKeys);
  document.querySelector('#loginDialog').addEventListener('cancel', e => e.preventDefault());
  document.querySelector('#pinRecoveryForm')?.addEventListener('submit', savePinRecovery);
  document.querySelector('#pinDialog').addEventListener('cancel', e => { if (forcedPinChange) e.preventDefault(); });
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    const guest = state.users.find(u => u.id === 'u_demo_guest') || state.users[0];
    if (guest) {
      session = guest.id;
      applyPermissions();
      renderAll();
      const loginDlg = document.querySelector('#loginDialog');
      if (loginDlg && loginDlg.open) loginDlg.close();
    }
    return;
  }
  const saved = sessionStorage.getItem('brasa-session');
  if (saved && state.users.some(u => u.id === saved && u.active !== false)) { session = saved; applyPermissions(); renderAll(); if (me().mustChangePin) openPinDialog(true); } else showLogin();
}
globalThis.initModules = initModules;
