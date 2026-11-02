const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (d) => ipcRenderer.invoke('data:save', d),
  models: () => ipcRenderer.invoke('models'),
  chat: (req, onEvent) => {
    const handler = (_e, ev) => { if (ev.id === req.id) { onEvent(ev); if (ev.type !== 'token') ipcRenderer.removeListener('chat:event', handler); } };
    ipcRenderer.on('chat:event', handler);
    ipcRenderer.send('chat:start', req);
  },
  loaded: () => ipcRenderer.invoke('model:loaded'),
  power: (r) => ipcRenderer.invoke('model:power', r),
  caps: (m) => ipcRenderer.invoke('model:caps', m),
  extract: (f) => ipcRenderer.invoke('file:extract', f),
  exportChat: (d) => ipcRenderer.invoke('export:save', d),
  stop: (id) => ipcRenderer.send('chat:stop', id),
});
