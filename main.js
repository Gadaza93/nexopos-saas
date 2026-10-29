/* NexoPos · Aplicación de escritorio nativa (Windows - Electron)
   Abre la aplicación POS en una ventana nativa con:
   - Resolución inicial de 1280x800 (redimensionable y maximizada)
   - Barra de menú oculta para experiencia inmersiva de POS
   - Soporte 100% offline con base de datos en disco y respaldos automáticos
   - Acceso al sistema de archivos local mediante IPC seguro (preload)
*/
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const espejo = require('./electron/espejo-partes.js');

// Control de instancia única (evita abrir dos cajas simultáneas en la misma máquina)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
let flushed = false;

const userDir = () => app.getPath('userData');
const configFile = () => path.join(userDir(), 'config.json');
const mirrorFile = () => path.join(userDir(), 'datos', 'nexopos.json');
const legacyMirrorFile = () => path.join(userDir(), 'datos', 'brasa-pos.json'); // instalaciones anteriores al cambio de nombre
const mirrorPartsDir = () => path.join(userDir(), 'datos', 'partes'); // espejo por partes (electron/espejo-partes.js)
const BACKUP_PATTERN = /^(nexopos|brasa-pos)-respaldo-.*\.json$/;
const KEEP_BACKUPS = 120;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

function backupDir() {
  const legacyDir = path.join(app.getPath('documents'), 'BrasaPOS', 'Respaldos');
  const defaultDir = fs.existsSync(legacyDir) ? legacyDir : path.join(app.getPath('documents'), 'NexoPos', 'Respaldos');
  const dir = readConfig().backupDir || defaultDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function pruneBackups(dir) {
  try {
    const files = fs.readdirSync(dir).filter(name => BACKUP_PATTERN.test(name)).sort().reverse();
    files.slice(KEEP_BACKUPS).forEach(name => {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* archivo en uso */ }
    });
  } catch {
    /* ignore */
  }
}

// Canales de comunicación segura (IPC)
ipcMain.handle('mirror:load', () => {
  try {
    const partes = espejo.cargarPartes(mirrorPartsDir());
    if (partes) return partes;
  } catch {
    /* espejo por partes ilegible: probar el archivo único */
  }
  for (const file of [mirrorFile(), legacyMirrorFile()]) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      /* no existe: probar el siguiente */
    }
  }
  return null;
});

ipcMain.handle('mirror:save', (_event, json) => {
  try {
    const file = mirrorFile();
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs > 3600 * 1000) {
      fs.copyFileSync(file, `${file}.bak`);
    }
    atomicWrite(file, String(json));
    return true;
  } catch {
    return false;
  }
});

// Espejo por partes: solo los meses que cambiaron y el núcleo (el archivo único anterior queda como estaba)
ipcMain.handle('mirror:saveParts', (_event, partes, borrar) => {
  try {
    return espejo.guardarPartes(mirrorPartsDir(), partes, borrar);
  } catch {
    return false;
  }
});

ipcMain.handle('mirror:index', () => espejo.leerIndice(mirrorPartsDir()));

ipcMain.handle('backup:save', (_event, name, json) => {
  try {
    const dir = backupDir();
    const file = path.join(dir, path.basename(String(name)));
    fs.writeFileSync(file, String(json));
    pruneBackups(dir);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle('backup:openFolder', () => shell.openPath(backupDir()));

ipcMain.handle('backup:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Carpeta de respaldos de NexoPos',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const config = readConfig();
  config.backupDir = result.filePaths[0];
  writeConfig(config);
  return config.backupDir;
});

ipcMain.handle('app:info', () => ({
  backupDir: backupDir(),
  dataFile: mirrorPartsDir(),
  version: app.getVersion(),
  platform: process.platform
}));

// Impresión de tickets: ventana oculta temporal con el HTML del comprobante.
// - Solo la ventana principal del POS puede pedirla (ni la ventana de impresión ni otra).
// - Archivo temporal con nombre aleatorio criptográfico y creación exclusiva ('wx': nunca sobrescribe ni sigue un enlace);
//   va a un archivo y no a una data: URL porque un logo grande supera el límite de URL de Chromium.
// - Tiempo límite: si el controlador o la impresora no responden, se destruye la ventana y se responde con error.
//   Con diálogo del sistema el plazo es mayor: la persona puede tardar eligiendo impresora.
const PRINT_TIMEOUT_SILENT_MS = 30 * 1000, PRINT_TIMEOUT_DIALOG_MS = 3 * 60 * 1000;
const fromMainWindow = event => Boolean(win) && !win.isDestroyed() && event.sender === win.webContents;
ipcMain.handle('print:receipt', async (event, html, options = {}) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'Origen de impresión no autorizado.' };
  if (typeof html !== 'string' || !html || html.length > 8 * 1024 * 1024) return { ok: false, error: 'Contenido de impresión no válido.' };
  const silent = Boolean(options && options.silent);
  const deviceName = options && typeof options.printerName === 'string' ? options.printerName.trim() : '';
  const limitMs = silent ? PRINT_TIMEOUT_SILENT_MS : PRINT_TIMEOUT_DIALOG_MS;
  const tmpFile = path.join(app.getPath('temp'), `nexopos-ticket-${crypto.randomUUID()}.html`);
  let printWin = null, timer = null;
  try {
    fs.writeFileSync(tmpFile, html, { encoding: 'utf8', flag: 'wx' });
    printWin = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
    printWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    printWin.webContents.on('will-navigate', navEvent => navEvent.preventDefault());
    const printing = (async () => {
      await printWin.loadFile(tmpFile);
      return await new Promise(resolve => {
        printWin.webContents.print({ silent, printBackground: true, margins: { marginType: 'none' }, ...(deviceName ? { deviceName } : {}) }, (success, failureReason) => {
          const cancelled = !success && /cancel/i.test(String(failureReason || ''));
          resolve({ ok: success, cancelled, error: success || cancelled ? null : String(failureReason || 'Error de impresión') });
        });
      });
    })();
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true, error: `La impresora no respondió en ${Math.round(limitMs / 1000)} s.` }), limitMs);
    });
    return await Promise.race([printing, timeout]);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  } finally {
    clearTimeout(timer);
    if (printWin && !printWin.isDestroyed()) printWin.destroy();
    fs.unlink(tmpFile, () => {});
  }
});

ipcMain.handle('print:listPrinters', async event => {
  if (!fromMainWindow(event)) return [];
  try {
    const printers = await win.webContents.getPrintersAsync();
    return printers.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: Boolean(p.isDefault) }));
  } catch {
    return [];
  }
});

ipcMain.on('app:flushed', () => {
  flushed = true;
  if (win) win.close();
});

const INDEX_HTML = path.join(__dirname, 'index.html');
// Única excepción al bloqueo de ventanas: enlaces de WhatsApp (https://wa.me/...), abiertos fuera de la app
function isWhatsAppUrl(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'wa.me'; } catch { return false; }
}
// Se abre la URL ya normalizada por el parser WHATWG, no la cadena original
function openWhatsApp(url) { shell.openExternal(new URL(url).href); }
// Única navegación permitida dentro de la ventana: recargar la propia index.html entrando al Modo Demo (?demo=true)
// o volviendo a producción (sin parámetros). El modo demo se decide por la URL en cada carga (demo-mode.js).
function isDemoToggle(url) {
  try {
    const target = new URL(url), own = pathToFileURL(INDEX_HTML);
    return target.protocol === 'file:' && decodeURIComponent(target.pathname).toLowerCase() === decodeURIComponent(own.pathname).toLowerCase()
      && (target.search === '' || target.search === '?demo=true');
  } catch { return false; }
}
// Ningún permiso de hardware para el renderer (cámara, micrófono, ubicación, notificaciones…): el POS no los usa
function denyAllPermissions(ses) {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  const preloadPath = fs.existsSync(path.join(__dirname, 'preload.js'))
    ? path.join(__dirname, 'preload.js')
    : path.join(__dirname, 'electron', 'preload.js');

  const iconCandidates = [
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'logo.png')
  ];
  const iconPath = iconCandidates.find(p => fs.existsSync(p)) || iconCandidates[0];

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#12141A',
    title: 'NexoPos · POS Inteligente',
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // Ocultar barra de menú nativa para interfaz táctil/POS limpia
  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => {
    win.show();
  });

  // Seguridad: evitar navegación externa o popups accidentales
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWhatsAppUrl(url)) openWhatsApp(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (isDemoToggle(url)) return; event.preventDefault(); if (isWhatsAppUrl(url)) openWhatsApp(url); });
  denyAllPermissions(win.webContents.session);

  // Al cerrar la ventana, esperar hasta 4s para vaciar cualquier guardado en cola
  win.on('close', event => {
    if (flushed) return;
    event.preventDefault();
    win.webContents.send('app:flush');
    setTimeout(() => {
      flushed = true;
      if (win) win.close();
    }, 4000);
  });

  win.on('closed', () => {
    win = null;
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

if (gotLock) {
  app.whenReady().then(createWindow);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
