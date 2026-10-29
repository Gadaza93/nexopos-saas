/* Puente seguro entre la app web y el disco: solo expone estas funciones. */
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
  printReceipt: (html, silent = false, printerName = null) => ipcRenderer.invoke('print:receipt', String(html), { silent: Boolean(silent), printerName: printerName ? String(printerName) : null }),
  listPrinters: () => ipcRenderer.invoke('print:listPrinters'),
  onFlushRequest: callback => ipcRenderer.on('app:flush', () => callback()),
  flushDone: () => ipcRenderer.send('app:flushed'),
});
