const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: (limit) => ipcRenderer.invoke('sessions:list', limit),
  reply: (file) => ipcRenderer.invoke('sessions:reply', file),
  togglePin: () => ipcRenderer.invoke('win:pin'),
  isPinned: () => ipcRenderer.invoke('win:isPinned'),
  toggleCollapse: () => ipcRenderer.invoke('win:collapse'),
  close: () => ipcRenderer.invoke('win:close'),
});
