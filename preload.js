/* NexoPos · Puente seguro (Preload) entre Electron y la interfaz web del POS
   Expone APIs protegidas en window.desktop sin activar nodeIntegration.
*/
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  loadMirror: () => ipcRenderer.invoke('mirror:load'),
  saveMirror: json => ipcRenderer.invoke('mirror:save', json),
  saveMirrorParts: (partes, borrar) => ipcRenderer.invoke('mirror:saveParts', partes, borrar),
  mirrorIndex: () => ipcRenderer.invoke('mirror:index'),
  saveBackup: (name, json) => ipcRenderer.invoke('backup:save', name, json),
  openBackupFolder: () => ipcRenderer.invoke('backup:openFolder'),
  chooseBackupFolder: () => ipcRenderer.invoke('backup:chooseFolder'),
  info: () => ipcRenderer.invoke('app:info'),
  // Tickets térmicos: imprime el HTML en una ventana oculta del proceso principal
  printReceipt: (html, silent = false, printerName = null) => ipcRenderer.invoke('print:receipt', String(html), { silent: Boolean(silent), printerName: printerName ? String(printerName) : null }),
  listPrinters: () => ipcRenderer.invoke('print:listPrinters'),
  onFlushRequest: callback => ipcRenderer.on('app:flush', () => callback()),
  flushDone: () => ipcRenderer.send('app:flushed')
});
