const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: (limit, mode) => ipcRenderer.invoke('sessions:list', limit, mode),
  reply: (file, mode) => ipcRenderer.invoke('sessions:reply', file, mode),
  edgeVoices: () => ipcRenderer.invoke('tts:voices'),
  synthesize: (text, opts) => ipcRenderer.invoke('tts:synthesize', text, opts),
  togglePin: () => ipcRenderer.invoke('win:pin'),
  isPinned: () => ipcRenderer.invoke('win:isPinned'),
  toggleCollapse: () => ipcRenderer.invoke('win:collapse'),
  hide: () => ipcRenderer.invoke('win:hide'),
  quickDirs: () => ipcRenderer.invoke('dirs:list'),
  spawn: (dir, mode) => ipcRenderer.invoke('session:spawn', dir, mode),
  send: (id, text, mode) => ipcRenderer.invoke('sessions:send', { id, text, mode }),
  focus: (id, mode) => ipcRenderer.invoke('session:focus', id, mode),
  setFocusable: (on) => ipcRenderer.invoke('win:focusable', on),
  petLoad: () => ipcRenderer.invoke('pet:load'),
  petSessions: () => ipcRenderer.invoke('pet:sessions'),
  petExpand: (width, height) => ipcRenderer.invoke('pet:expand', width, height),
  petDismiss: (key) => ipcRenderer.invoke('pet:dismiss', key),
  petMoveBy: (dx, dy) => ipcRenderer.invoke('pet:move', dx, dy),
  petHide: () => ipcRenderer.invoke('pet:hide'),
});
