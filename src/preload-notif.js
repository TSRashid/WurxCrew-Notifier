const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  onNotification: (cb) => ipcRenderer.on('show-notification', (_, data) => cb(data)),
  markRead: (id) => ipcRenderer.invoke('mark-read', id),
  closeNotification: (id) => ipcRenderer.invoke('close-notification', id),
  snooze: (id, minutes) => {
    ipcRenderer.invoke('close-notification', id);
    ipcRenderer.invoke('snooze-notification', id, minutes);
  },
  openWeb: (id) => {
    ipcRenderer.invoke('mark-read', id);
    ipcRenderer.invoke('open-web-app');
    ipcRenderer.invoke('close-notification', id);
  },
});
