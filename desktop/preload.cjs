const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harq', {
  request: (endpoint, method, body) => ipcRenderer.invoke('harq:request', endpoint, method, body),
  save: (format, content) => ipcRenderer.invoke('harq:save', format, content)
});
