const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');

// ── State ───────────────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let notifWindows = [];
let notifCounter = 0;

const NOTIF_WIDTH = 390;
const NOTIF_HEIGHT = 190;
const NOTIF_GAP = 8;
const MAX_VISIBLE = 4;
const WEB_APP_URL = 'https://wurxos.web.app';

// ── Single instance lock ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

// ── App ready ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createTray();
  createMainWindow();
});

app.on('window-all-closed', (e) => e.preventDefault());

// ── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('WurxOS Notifier');
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  updateTrayMenu(false);
}

function updateTrayMenu(loggedIn) {
  const template = loggedIn
    ? [
        { label: 'Open WurxOS', click: () => shell.openExternal(WEB_APP_URL) },
        { type: 'separator' },
        { label: 'Show Window', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { label: 'Quit', click: () => { app.exit(0); } },
      ]
    : [
        { label: 'Login', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { label: 'Quit', click: () => { app.exit(0); } },
      ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ── Main Window ─────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 380, height: 460,
    resizable: false, maximizable: false, minimizable: true,
    frame: false, show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'main.html'));
  mainWindow.on('close', (e) => { e.preventDefault(); mainWindow.hide(); });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────
ipcMain.handle('auth-state-changed', (_, loggedIn) => {
  updateTrayMenu(loggedIn);
  if (loggedIn && mainWindow) mainWindow.hide();
});

ipcMain.handle('hide-window', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle('open-web-app', () => { shell.openExternal(WEB_APP_URL); });
ipcMain.handle('update-tooltip', (_, count) => { if (tray) tray.setToolTip(`WurxOS Notifier — ${count} unread`); });

function playNotificationSound() {
  if (process.platform === 'win32') {
    exec('powershell -c "(New-Object Media.SoundPlayer \'C:\\Windows\\Media\\Windows Notify Email.wav\').PlaySync()"', { windowsHide: true });
  } else if (process.platform === 'darwin') {
    exec('afplay /System/Library/Sounds/Glass.aiff');
  }
}

ipcMain.handle('show-notification', (_, notif) => {
  playNotificationSound();
  if (notifWindows.length >= MAX_VISIBLE) {
    const oldest = notifWindows.shift();
    try { oldest.win.close(); } catch {}
  }

  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const yOffset = notifWindows.length * (NOTIF_HEIGHT + NOTIF_GAP);
  const x = sw - NOTIF_WIDTH - 16;
  const y = sh - NOTIF_HEIGHT - 16 - yOffset;
  const label = `notif-${notifCounter++}`;

  const win = new BrowserWindow({
    width: NOTIF_WIDTH, height: NOTIF_HEIGHT, x, y,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-notif.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'notification.html'));
  win.webContents.on('did-finish-load', () => { win.webContents.send('show-notification', notif); });

  const entry = { id: notif.id, label, win };
  notifWindows.push(entry);
  win.on('closed', () => { notifWindows = notifWindows.filter(w => w.label !== label); repositionWindows(); });

  return label;
});

ipcMain.handle('mark-read', (_, notifId) => {
  // Relay to main window which has Firebase auth
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('mark-read', notifId);
  }
});

ipcMain.handle('close-notification', (_, notifId) => {
  const entry = notifWindows.find(w => w.id === notifId);
  if (entry) try { entry.win.close(); } catch {}
});

ipcMain.handle('snooze-notification', (_, notifId, minutes) => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('snooze-request', { notifId, minutes });
  }
});

function repositionWindows() {
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  notifWindows.forEach((entry, i) => {
    const x = sw - NOTIF_WIDTH - 16;
    const y = sh - NOTIF_HEIGHT - 16 - (i * (NOTIF_HEIGHT + NOTIF_GAP));
    try { entry.win.setPosition(x, y); } catch {}
  });
}
