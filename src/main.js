const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');

// ── File Logger ────────────────────────────────────────────────────────────
const LOG_FILE = path.join(app.getPath('userData'), 'wurxos-debug.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] [main] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log(msg);
}
log('=== App starting ===');
log(`Platform: ${process.platform}, Arch: ${process.arch}, Electron: ${process.versions.electron}`);

process.on('uncaughtException', (err) => { log(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`); });
process.on('unhandledRejection', (reason) => { log(`UNHANDLED REJECTION: ${reason}`); });

// ── Local Storage (JSON file) ──────────────────────────────────────────────
const STORE_PATH = path.join(app.getPath('userData'), 'wurxos-settings.json');
let localStore = {};

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      localStore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      log('Local store loaded: ' + Object.keys(localStore).join(', '));
    }
  } catch (e) { log('Failed to load store: ' + e.message); localStore = {}; }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(localStore, null, 2));
  } catch (e) { log('Failed to save store: ' + e.message); }
}

function getStoreValue(key) { return localStore[key] || null; }
function setStoreValue(key, value) { localStore[key] = value; saveStore(); }

loadStore();

// ── State ───────────────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let notifWindows = [];
let notifCounter = 0;
let wsServer = null;
let wsClients = new Set();

const NOTIF_WIDTH = 340;
const NOTIF_HEIGHT = 170;
const NOTIF_GAP = 8;
const MAX_VISIBLE = 4;
const WEB_APP_URL = 'https://wurxos.web.app';
const WS_PORT = 9123;

// ── Single instance lock ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

// ── App ready ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  log('App ready fired');
  log(`Platform: ${process.platform}`);

  // Auto-start on login
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  log('Auto-start on login: enabled');

  log('Creating tray...');
  createTray();
  log('Tray created. Creating main window...');
  createMainWindow();
  log('Main window created');
  startWebSocketServer();
});

app.on('window-all-closed', (e) => e.preventDefault());

// ── WebSocket Server ────────────────────────────────────────────────────────
function startWebSocketServer() {
  try {
    wsServer = new WebSocketServer({ port: WS_PORT });
    log('WebSocket server started on port ' + WS_PORT);

    wsServer.on('connection', (ws) => {
      wsClients.add(ws);
      log('WebSocket client connected (total: ' + wsClients.size + ')');

      // Send current settings to newly connected client
      ws.send(JSON.stringify({ type: 'connected', version: '1.0.0' }));

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          handleWsMessage(msg, ws);
        } catch (e) { log('WS parse error: ' + e.message); }
      });

      ws.on('close', () => {
        wsClients.delete(ws);
        log('WebSocket client disconnected (total: ' + wsClients.size + ')');
      });

      ws.on('error', () => { wsClients.delete(ws); });
    });

    wsServer.on('error', (err) => {
      log('WebSocket server error: ' + err.message);
    });
  } catch (e) {
    log('Failed to start WebSocket server: ' + e.message);
  }
}

function handleWsMessage(msg, ws) {
  log('WS received: ' + msg.type);

  if (msg.type === 'auth') {
    // Web app sends auth info (uid, role)
    setStoreValue('uid', msg.uid);
    setStoreValue('role', msg.role);
    // Relay to renderer
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('ws-auth', { uid: msg.uid, role: msg.role });
    }
    ws.send(JSON.stringify({ type: 'auth-ack' }));
  }

  if (msg.type === 'settings-update') {
    // Web app sends a specific settings key update
    const key = msg.key; // e.g., 'resetSchedule', 'tierNotifications', etc.
    const data = msg.data;
    log('Settings update via WS: ' + key + ' = ' + JSON.stringify(data));

    // Save to local storage
    const settings = getStoreValue('settings') || {};
    settings[key] = data;
    setStoreValue('settings', settings);

    // Relay to renderer so it can update in-memory + clear fired keys
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('ws-settings-update', { key, data });
    }
    ws.send(JSON.stringify({ type: 'settings-ack', key }));
  }

  if (msg.type === 'get-settings') {
    const settings = getStoreValue('settings') || {};
    ws.send(JSON.stringify({ type: 'current-settings', settings }));
  }

  if (msg.type === 'clear-log') {
    try { fs.writeFileSync(LOG_FILE, ''); log('=== Log cleared ==='); } catch {}
    ws.send(JSON.stringify({ type: 'log-cleared' }));
  }
}

// Broadcast to all connected web app clients
function wsBroadcast(msg) {
  const data = JSON.stringify(msg);
  wsClients.forEach((ws) => {
    try { ws.send(data); } catch {}
  });
}

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
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
      ]
    : [
        { label: 'Login', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
      ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ── Main Window ─────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 380, height: 460,
    resizable: false, maximizable: false, minimizable: true,
    frame: false, show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'main.html'));
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────
ipcMain.handle('auth-state-changed', (_, loggedIn) => {
  log(`auth-state-changed: loggedIn=${loggedIn}`);
  updateTrayMenu(loggedIn);
});

ipcMain.handle('hide-window', () => { log('hide-window called'); if (mainWindow) mainWindow.hide(); });
ipcMain.handle('log-renderer', (_, msg) => { log(`[renderer] ${msg}`); });
ipcMain.handle('open-web-app', (_, category) => {
  // Send goto to web app via WebSocket
  if (category) {
    wsBroadcast({ type: 'goto', category });
  }
  // Fallback: open in browser if web app isn't connected via WebSocket
  shell.openExternal(WEB_APP_URL);
});
ipcMain.handle('update-tooltip', (_, count) => { if (tray) tray.setToolTip(`WurxOS Notifier — ${count} unread`); });

// Local storage IPC — renderer reads/writes settings
ipcMain.handle('store-get', (_, key) => { return getStoreValue(key); });
ipcMain.handle('store-set', (_, key, value) => { setStoreValue(key, value); });

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
