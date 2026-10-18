const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { YouTubeExtractor } = require('./youtube.cjs');

const appId = 'local.musicplayer.desktop';
if (process.platform === 'win32') app.setAppUserModelId(appId);

// Tests use an isolated profile and never touch the user's library.
if (process.env.MUSIC_PLAYER_TEST_DATA) app.setPath('userData', process.env.MUSIC_PLAYER_TEST_DATA);
const extensions = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff', '.aif']);
let win;
let compact = false;
let compactQueueExpanded = false;
let normalBounds;
let wasMaximized = false;
let closing = false;
let quitting = false;
let tray;
let settingsWindow;
let youtubeWindow;
let youtubeExtractor;
const iconPath = path.join(__dirname, 'assets', 'music-player.ico');
let data = { tracks: [], playlists: [], favorites: [], settings: {} };
let saveChain = Promise.resolve();
const storeFile = () => path.join(app.getPath('userData'), 'library.json');

function filterPlaybackSettings(settings, ids) {
  const entries = (settings.queue || []).map((id, index) => ({ id, index })).filter(entry => ids.has(entry.id));
  const currentId = ids.has(settings.currentId) ? settings.currentId : null;
  let queueIndex = currentId ? entries.findIndex(entry => entry.index === settings.queueIndex && entry.id === currentId) : -1;
  if (currentId && queueIndex < 0) queueIndex = entries.findIndex(entry => entry.id === currentId);
  return { ...settings, currentId, queue: entries.map(entry => entry.id), queueIndex, position: currentId ? settings.position : 0 };
}

function persist() {
  const snapshot = JSON.stringify(data);
  const pending = saveChain.catch(() => {}).then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(`${storeFile()}.tmp`, snapshot, 'utf8');
    await fs.rename(`${storeFile()}.tmp`, storeFile());
  });
  saveChain = pending;
  return pending;
}

async function scan(entries, recursive = true) {
  const found = new Set();
  async function visit(entry, depth = 0) {
    try {
      const info = await fs.lstat(entry);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        if (depth > 0 && !recursive) return;
        for (const child of await fs.readdir(entry)) await visit(path.join(entry, child), depth + 1);
      } else if (info.isFile() && extensions.has(path.extname(entry).toLowerCase())) found.add(path.resolve(entry));
    } catch { /* Unreadable entries do not prevent importing the remaining folder. */ }
  }
  for (const entry of entries) await visit(entry);
  return [...found];
}

async function importPaths(entries, recursive = true) {
  const { parseFile } = await import('music-metadata');
  const existing = new Set(data.tracks.map(track => track.path.toLowerCase()));
  const selectedFiles = await scan(entries, recursive);
  const files = selectedFiles.filter(file => !existing.has(file.toLowerCase()));
  const added = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      const metadata = await parseFile(file, { duration: true });
      const { common, format } = metadata;
      if (!format.duration || !Number.isFinite(format.duration)) { unreadable++; continue; }
      const picture = common.picture?.find(p => p.type === 'Cover (front)') || common.picture?.[0];
      const artwork = picture && picture.data.length < 8 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].includes(picture.format)
        ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}` : '';
      added.push({
        id: require('node:crypto').randomUUID(), path: file, url: pathToFileURL(file).href,
        title: common.title || path.basename(file, path.extname(file)),
        artist: common.artist || '알 수 없는 아티스트', album: common.album || '알 수 없는 앨범',
        duration: format.duration || 0, format: path.extname(file).slice(1).toUpperCase(),
        sampleRate: format.sampleRate || 0, artwork, addedAt: Date.now()
      });
    } catch { unreadable++; }
  }
  data.tracks.push(...added);
  await persist();
  const byPath = new Map(data.tracks.map(track => [track.path.toLowerCase(), track.id]));
  return { tracks: data.tracks, selectedIds: selectedFiles.map(file => byPath.get(file.toLowerCase())).filter(Boolean), added: added.length, unreadable };
}

function setMode(next) {
  if (compact === next) return compact;
  if (next) {
    normalBounds = win.getNormalBounds();
    wasMaximized = win.isMaximized();
    if (win.isMaximized()) win.unmaximize();
    compact = true;
    win.setMinimumSize(500, 270);
    win.setResizable(false);
    resizeCompactWindow();
  } else {
    compact = false;
    win.setResizable(true);
    win.setMinimumSize(1080, 700);
    if (normalBounds) win.setBounds(normalBounds);
    else win.setSize(1400, 880);
    if (wasMaximized) win.maximize();
  }
  win.webContents.send('mode-changed', compact);
  win.webContents.send('compact-queue-changed', compactQueueExpanded);
  return compact;
}

function resizeCompactWindow() {
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const height = Math.min(compactQueueExpanded ? 650 : 270, area.height);
  win.setBounds({
    width: 570, height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - 570)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))
  });
}

function showPlayer() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openSettings() {
  showPlayer();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 760, height: 690, minWidth: 680, minHeight: 600,
    parent: win, modal: true, frame: false, maximizable: false, minimizable: false,
    title: '설정 · Music Player', icon: iconPath, backgroundColor: '#f8fafc', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadFile(path.join(__dirname, 'src/settings.html'));
}

function openYouTube() {
  showPlayer();
  if (youtubeWindow && !youtubeWindow.isDestroyed()) { youtubeWindow.focus(); return; }
  youtubeWindow = new BrowserWindow({
    width: 500, height: 390, resizable: false, parent: win, modal: true, frame: false,
    title: '유튜브 링크 추출', icon: iconPath, backgroundColor: '#ffffff', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  youtubeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  youtubeWindow.webContents.on('will-navigate', event => event.preventDefault());
  youtubeWindow.once('ready-to-show', () => youtubeWindow?.show());
  youtubeWindow.on('closed', () => { youtubeExtractor.cancel(); youtubeWindow = null; });
  youtubeWindow.loadFile(path.join(__dirname, 'src/youtube.html'));
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('Music Player');
  tray.on('double-click', showPlayer);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Music Player 열기', click: showPlayer },
    { label: '설정', click: openSettings },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
app.on('second-instance', showPlayer);
app.on('before-quit', () => { quitting = true; youtubeExtractor?.cancel(); });
ipcMain.on('playback-shortcut', (event, action) => {
  if (![win, settingsWindow, youtubeWindow].some(window => window && !window.isDestroyed() && window.webContents === event.sender)) return;
  if (!['play', 'previous', 'next', 'seek-backward', 'seek-forward', 'volume-up', 'volume-down', 'mute', 'shuffle', 'repeat'].includes(action)) return;
  if (win && !win.isDestroyed()) win.webContents.send('playback-shortcut', action);
});

if (hasLock) app.whenReady().then(async () => {
  youtubeExtractor = new YouTubeExtractor(app.isPackaged ? path.join(process.resourcesPath, 'youtube') : path.join(__dirname, 'tools', 'youtube'), path.join(app.getPath('userData'), 'youtube-cache'));
  await youtubeExtractor.clearOldCache();
  try {
    const saved = JSON.parse(await fs.readFile(storeFile(), 'utf8'));
    if (Array.isArray(saved.tracks) && Array.isArray(saved.playlists)) data = { ...data, ...saved };
  } catch { /* First launch starts with an empty library. */ }
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1080, minHeight: 700, frame: false,
    backgroundColor: '#f8fafc', title: 'Music Player', icon: iconPath, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) {
    const executable = process.env.PORTABLE_EXECUTABLE_FILE;
    win.setAppDetails({
      appId, appIconPath: executable,
      relaunchCommand: `"${executable}"`, relaunchDisplayName: 'Music Player'
    });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('close', event => {
    if (closing || win.webContents.isCrashed()) return;
    event.preventDefault();
    win.webContents.send('save-before-close');
  });
  ipcMain.handle('load-library', () => data);
  ipcMain.handle('get-preferences', () => data.preferences || {});
  ipcMain.handle('open-settings', openSettings);
  ipcMain.handle('save-preferences', async (_event, preferences) => {
    data.preferences = {
      closeToTray: Boolean(preferences.closeToTray),
      seekSeconds: Number.isInteger(preferences.seekSeconds) && preferences.seekSeconds >= 1 && preferences.seekSeconds <= 600 ? preferences.seekSeconds : 5,
      appearance: preferences.appearance
    };
    if (data.preferences.closeToTray) ensureTray();
    else if (tray) { tray.destroy(); tray = null; }
    await persist();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('preferences-changed', data.preferences);
    return data.preferences;
  });
  ipcMain.handle('choose-music', async (_event, folder, recursive = true) => {
    const result = await dialog.showOpenDialog(win, {
      title: folder ? '음악 폴더 추가' : '음악 파일 추가 · Ctrl/Shift로 여러 파일 선택',
      defaultPath: data.lastImportPath || data.importPaths?.files || data.importPaths?.folders || app.getPath('music'),
      properties: folder ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: folder ? [] : [{ name: '음악 파일', extensions: [...extensions].map(ext => ext.slice(1)) }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    data.lastImportPath = folder ? result.filePaths[0] : path.dirname(result.filePaths[0]);
    await persist();
    return importPaths(result.filePaths, Boolean(recursive));
  });
  ipcMain.handle('import-dropped', (_event, entries) => importPaths(entries.filter(entry => typeof entry === 'string')));
  ipcMain.handle('open-youtube', openYouTube);
  const youtubeSender = event => youtubeWindow && event.sender === youtubeWindow.webContents;
  const youtubePreferences = () => ({ folder: data.youtube?.folder || path.join(app.getPath('music'), 'YouTube'), autoSave: Boolean(data.youtube?.autoSave) });
  ipcMain.handle('youtube-state', event => {
    if (!youtubeSender(event)) return null;
    return { ...youtubePreferences(), ready: youtubeExtractor.ready ? { title: youtubeExtractor.ready.title } : null };
  });
  ipcMain.handle('youtube-options', async (event, options) => {
    if (!youtubeSender(event)) return;
    if (typeof options?.folder !== 'string' || typeof options?.autoSave !== 'boolean') return;
    data.youtube = { folder: options.folder.slice(0, 32767), autoSave: options.autoSave };
    await persist();
  });
  ipcMain.handle('youtube-folder', async (event, folder) => {
    if (!youtubeSender(event)) return null;
    const result = await dialog.showOpenDialog(youtubeWindow, { title: '추출한 음악을 저장할 폴더', defaultPath: typeof folder === 'string' && path.isAbsolute(folder) ? folder : youtubePreferences().folder, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('youtube-open-folder', async (event, folder) => {
    if (!youtubeSender(event)) return { error: '추출 창에서 실행해주세요.' };
    if (typeof folder !== 'string' || !path.isAbsolute(folder.trim())) return { error: '저장할 폴더의 전체 경로를 입력해주세요.' };
    try {
      const target = path.resolve(folder.trim());
      if (!(await fs.stat(target)).isDirectory()) return { error: '폴더 경로를 입력해주세요.' };
      const error = await shell.openPath(target);
      return error ? { error: '폴더를 열지 못했습니다. 저장 경로를 확인해주세요.' } : {};
    } catch { return { error: '저장 폴더가 없습니다. 먼저 저장하거나 다른 폴더를 선택해주세요.' }; }
  });
  ipcMain.handle('youtube-extract', async (event, url) => {
    if (!youtubeSender(event)) return { error: '추출 창에서 실행해주세요.' };
    try {
      const result = await youtubeExtractor.extract(url, message => { if (!event.sender.isDestroyed()) event.sender.send('youtube-progress', message); });
      return { result };
    } catch (error) { return { error: error.message }; }
  });
  ipcMain.handle('youtube-save', async (event, folder) => {
    if (!youtubeSender(event)) return { error: '추출 창에서 실행해주세요.' };
    try {
      const result = await youtubeExtractor.save(folder, file => importPaths([file]));
      if (!win.isDestroyed()) win.webContents.send('library-imported', result.tracks);
      return { file: result.file };
    } catch (error) { return { error: error.code === 'EACCES' || error.code === 'EPERM' ? '폴더에 저장할 권한이 없습니다. 다른 경로를 선택해주세요.' : error.message }; }
  });
  ipcMain.handle('save-state', async (_event, state) => {
    // Track paths and metadata are owned by the main process.
    const ids = new Set(data.tracks.map(track => track.id));
    data.favorites = state.favorites.filter(id => ids.has(id));
    data.playlists = state.playlists.map(list => ({ id: String(list.id), name: String(list.name).slice(0, 100), trackIds: list.trackIds.filter(id => ids.has(id)) }));
    data.settings = filterPlaybackSettings(state.settings, ids);
    await persist();
  });
  ipcMain.handle('remove-tracks', async (event, selected) => {
    if (event.sender !== win.webContents || !Array.isArray(selected)) throw new Error('Invalid track selection');
    const removed = new Set(selected.filter(id => typeof id === 'string'));
    data.tracks = data.tracks.filter(track => !removed.has(track.id));
    const remaining = new Set(data.tracks.map(track => track.id));
    data.favorites = data.favorites.filter(id => remaining.has(id));
    data.playlists = data.playlists.map(list => ({ ...list, trackIds: list.trackIds.filter(id => remaining.has(id)) }));
    data.settings = filterPlaybackSettings(data.settings, remaining);
    await persist();
    return data.tracks;
  });
  ipcMain.handle('set-mode', (_event, next) => setMode(Boolean(next)));
  ipcMain.handle('set-compact-queue', (_event, expanded) => {
    if (!compact) return compactQueueExpanded;
    compactQueueExpanded = Boolean(expanded);
    resizeCompactWindow();
    win.webContents.send('compact-queue-changed', compactQueueExpanded);
    return compactQueueExpanded;
  });
  ipcMain.handle('close-ready', async () => {
    await saveChain.catch(() => {});
    if (data.preferences?.closeToTray && !quitting) {
      ensureTray();
      win.hide();
      return;
    }
    closing = true;
    win.close();
  });
  ipcMain.handle('window-action', (event, action) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return;
    if (action === 'minimize') target.minimize();
    if (action === 'maximize' && target === win && !compact) win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') target.close();
  });
  ipcMain.handle('show-file', (_event, id) => {
    const track = data.tracks.find(item => item.id === id);
    if (track) shell.showItemInFolder(track.path);
  });
  await win.loadFile(path.join(__dirname, 'src/index.html'));
  if (data.preferences?.closeToTray) ensureTray();
  win.show();
});

app.on('window-all-closed', () => app.quit());
