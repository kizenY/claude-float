const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: (limit) => ipcRenderer.invoke('sessions:list', limit),
  reply: (file) => ipcRenderer.invoke('sessions:reply', file),
  edgeVoices: () => ipcRenderer.invoke('tts:voices'),
  synthesize: (text, opts) => ipcRenderer.invoke('tts:synthesize', text, opts),
  togglePin: () => ipcRenderer.invoke('win:pin'),
  isPinned: () => ipcRenderer.invoke('win:isPinned'),
  toggleCollapse: () => ipcRenderer.invoke('win:collapse'),
  hide: () => ipcRenderer.invoke('win:hide'),
  quickDirs: () => ipcRenderer.invoke('dirs:list'),
  spawnCf: (dir) => ipcRenderer.invoke('session:spawn', dir),
  send: (id, text) => ipcRenderer.invoke('sessions:send', { id, text }),
});
