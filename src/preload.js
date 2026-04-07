const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  log: (msg) => ipcRenderer.invoke('log-renderer', msg),
  authStateChanged: (loggedIn) => ipcRenderer.invoke('auth-state-changed', loggedIn),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  openWebApp: () => ipcRenderer.invoke('open-web-app'),
  updateTooltip: (count) => ipcRenderer.invoke('update-tooltip', count),
  showNotification: (notif) => ipcRenderer.invoke('show-notification', notif),
  closeNotification: (notifId) => ipcRenderer.invoke('close-notification', notifId),
  onSnoozeRequest: (cb) => ipcRenderer.on('snooze-request', (_, data) => cb(data)),
  onMarkRead: (cb) => ipcRenderer.on('mark-read', (_, notifId) => cb(notifId)),
});
