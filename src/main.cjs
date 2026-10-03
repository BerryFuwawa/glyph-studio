const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, Menu, protocol, net, session, shell } = require('electron');
const { createUpdateChecker } = require('./updates.cjs');
const { installPortableUpdate } = require('./portable-update.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const qaDirectory = path.join(app.getAppPath(), 'qa-results');

protocol.registerSchemesAsPrivileged([{ scheme: 'glyph', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Glyph Studio');
const qaMode = process.argv.includes('--qa');
const desktopQA = process.argv.includes('--desktop-qa');
if (qaMode || desktopQA) app.setPath('userData', path.join(qaDirectory, 'profile'));
let window;
const allowedAssets = new Set(['index.html', 'styles.css', 'app.js', 'core.js', 'export.js', 'image-info.js', 'worker.js', 'assets/sculpture.png', 'assets/icon.png']);
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif', '.avif': 'image/avif' };

function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== 'glyph://app/index.html') throw new Error('无效的应用请求。');
}

async function readImage(filePath) {
  const mime = types[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error('请选择 PNG、JPG、WebP、BMP、GIF 或 AVIF 图片。');
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('图片不能超过 50 MB。');
  const bytes = await fs.readFile(filePath);
  return { name: path.basename(filePath), dataURL: `data:${mime};base64,${bytes.toString('base64')}`, size: bytes.length };
}

app.whenReady().then(async () => {
  app.setAppUserModelId('studio.glyph.desktop');
  protocol.handle('glyph', request => {
    const url = new URL(request.url);
    const asset = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (url.host !== 'app' || !allowedAssets.has(asset)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, asset)).toString());
  });
  Menu.setApplicationMenu(null);
  const updateSession = session.fromPartition('glyph-updates', { cache: false });
  updateSession.webRequest.onBeforeRequest((_details, callback) => {
    let allowed = false;
    try {
      const url = new URL(_details.url);
      allowed = _details.url === 'https://api.github.com/repos/BerryFuwawa/glyph-studio/releases/latest' ||
        (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
          ((url.hostname === 'github.com' && /^\/BerryFuwawa\/glyph-studio\/releases\/download\/v\d+\.\d+\.\d+\/Glyph-Studio-\d+\.\d+\.\d+-Windows-x64\.exe$/.test(url.pathname)) ||
           (url.hostname === 'release-assets.githubusercontent.com' && url.pathname.startsWith('/github-production-release-asset/'))));
    } catch { /* Reject invalid URLs. */ }
    callback({ cancel: !allowed });
  });
  const checkUpdate = createUpdateChecker({ currentVersion: app.getVersion(), fetchImpl: (url, options) => updateSession.fetch(url, options) });
  let availableRelease = null;
  let updateBusy = false;
  let updateApplying = false;
  let updateAbort = null;
  const portableExe = process.platform === 'win32' && app.isPackaged && process.arch === 'x64' ? process.env.PORTABLE_EXECUTABLE_FILE : null;
  const resultFile = path.join(app.getPath('userData'), 'update-result.json');
  let lastUpdateResult = null;
  try {
    lastUpdateResult = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    await fs.unlink(resultFile);
  } catch { /* No previous update result. */ }
  ipcMain.handle('app-version', event => { assertSender(event); return app.getVersion(); });
  ipcMain.handle('check-updates', async event => {
    assertSender(event);
    if (updateBusy) throw new Error('更新下载进行中，请稍候。');
    if (!lastUpdateResult) {
      try { lastUpdateResult = JSON.parse(await fs.readFile(resultFile, 'utf8')); await fs.unlink(resultFile); } catch { /* No completed update. */ }
    }
    const result = await checkUpdate.check();
    availableRelease = result.status === 'available' ? result : null;
    const canInstall = Boolean(portableExe && path.isAbsolute(portableExe) && result.asset);
    const previousUpdate = lastUpdateResult;
    lastUpdateResult = null;
    return { ...result, asset: undefined, canInstall, previousUpdate,
      installReason: !portableExe ? '当前运行方式不支持就地更新，请下载 Windows 便携版。' : !result.asset ? '新版缺少匹配的 Windows x64 文件或校验信息，请前往下载。' : '' };
  });
  ipcMain.handle('open-update', async event => {
    assertSender(event);
    if (!availableRelease) throw new Error('请先检查更新。');
    await shell.openExternal(availableRelease.releaseUrl);
    return true;
  });
  ipcMain.handle('install-update', async event => {
    assertSender(event);
    if (updateBusy) throw new Error('更新正在进行中。');
    if (!portableExe || !availableRelease?.asset) throw new Error('当前版本无法自动替换，请先检查更新或前往下载。');
    updateBusy = true;
    try {
      const choice = await dialog.showMessageBox(window, { type: 'question', title: '更新字相', message: `下载 ${availableRelease.latestVersion} 并重启？`, detail: '更新后会自动重启应用，并删除旧版本程序。当前图片不会保存，请先导出需要保留的作品。转换参数会保留。', buttons: ['取消', '更新并重启'], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return { status: 'canceled' };
      updateAbort = new AbortController();
      const result = await installPortableUpdate({ fetchImpl: (url, options) => updateSession.fetch(url, options), asset: availableRelease.asset, oldExe: portableExe, pid: process.pid, resultFile,
        signal: updateAbort.signal, currentVersion: app.getVersion(),
        onProgress: progress => { if (!window.isDestroyed()) window.webContents.send('update-progress', progress); } });
      if (result.status === 'installing') { updateApplying = true; setTimeout(() => app.quit(), 300); }
      return result;
    } catch (error) {
      if (updateAbort?.signal.aborted) return { status: 'canceled' };
      throw error;
    } finally { updateAbort = null; if (!updateApplying) updateBusy = false; }
  });
  ipcMain.handle('cancel-update', event => { assertSender(event); updateAbort?.abort(); return true; });
  window = new BrowserWindow({
    title: '字相 · Glyph Studio', width: 1400, height: 920, minWidth: 980, minHeight: 700,
    backgroundColor: '#101214', frame: false, show: false, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: !app.isPackaged }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  window.once('ready-to-show', () => {
    if (!qaMode) window.show();
    const readyFile = process.env.GLYPH_UPDATE_READY_FILE;
    if (readyFile && path.isAbsolute(readyFile) && path.basename(readyFile) === 'ready' && path.basename(path.dirname(readyFile)).startsWith('glyph-update-')) {
      fs.writeFile(readyFile, JSON.stringify({ pid: process.pid, version: app.getVersion() })).catch(() => {});
      delete process.env.GLYPH_UPDATE_READY_FILE;
    }
  });
  window.on('maximize', () => window.webContents.send('window-state', true));
  window.on('unmaximize', () => window.webContents.send('window-state', false));
  window.on('close', event => { if (updateBusy && !updateApplying) { event.preventDefault(); updateAbort?.abort(); } });
  ipcMain.handle('open-image', async event => {
    assertSender(event);
    const selected = await dialog.showOpenDialog(window, { title: '打开图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] }] });
    return selected.canceled ? null : readImage(selected.filePaths[0]);
  });
  ipcMain.handle('paste-image', event => {
    assertSender(event);
    const image = clipboard.readImage();
    const dimensions = image.getSize();
    if (dimensions.width * dimensions.height > 40000000) throw new Error('剪贴板图片过大，请先缩小到 4000 万像素以内。');
    return image.isEmpty() ? null : { name: '剪贴板图片.png', dataURL: image.toDataURL(), size: image.toPNG().length };
  });
  ipcMain.handle('copy-text', (event, text) => {
    assertSender(event);
    if (typeof text !== 'string' || text.length > 2000000) throw new Error('文本超出可复制范围。');
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('copy-image', (event, dataURL) => {
    assertSender(event);
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/png;base64,') || dataURL.length > 80000000) throw new Error('图片超出可复制范围。');
    const image = nativeImage.createFromDataURL(dataURL);
    if (image.isEmpty()) throw new Error('图片复制失败。');
    clipboard.writeImage(image);
    return true;
  });
  ipcMain.handle('save-output', async (event, { format, name, content }) => {
    assertSender(event);
    const formats = { txt: '纯文本', png: 'PNG 图片', svg: 'SVG 矢量图', html: 'HTML 字符画', ansi: 'ANSI 彩色文本' };
    if (!formats[format] || typeof content !== 'string' || content.length > 100000000) throw new Error('无效的导出内容。');
    const safeName = String(name || '字符画').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100);
    const selected = await dialog.showSaveDialog(window, { title: `导出${formats[format]}`, defaultPath: `${safeName}.${format}`, filters: [{ name: formats[format], extensions: [format] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
    if (selected.canceled || !selected.filePath) return null;
    let target = selected.filePath;
    if (path.extname(target).toLowerCase() !== `.${format}`) {
      target += `.${format}`;
      const exists = await fs.access(target).then(() => true, () => false);
      if (exists) {
        const choice = await dialog.showMessageBox(window, { type: 'warning', title: '替换文件', message: `${path.basename(target)} 已存在，是否替换？`, buttons: ['取消', '替换'], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) return null;
      }
    }
    const bytes = format === 'png' ? Buffer.from(content.replace(/^data:image\/png;base64,/, ''), 'base64') : Buffer.from(content, 'utf8');
    await fs.writeFile(target, bytes);
    return { name: path.basename(target) };
  });
  ipcMain.on('window-control', (event, action) => {
    assertSender(event);
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
  });
  await window.loadURL('glyph://app/index.html');
  if (qaMode) {
    await fs.mkdir(qaDirectory, { recursive: true });
    window.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') fs.appendFile(path.join(qaDirectory, 'console.log'), `${details.message}\n`).catch(() => {});
    });
    try {
      const result = await window.webContents.executeJavaScript('window.GlyphStudio.runSmokeTests()');
      await fs.writeFile(path.join(qaDirectory, 'smoke.json'), JSON.stringify(result, null, 2));
      window.setSize(1400, 920);
      await window.webContents.executeJavaScript('window.GlyphStudio.setView("compare")');
      await new Promise(resolve => setTimeout(resolve, 300));
      const capture = await window.webContents.capturePage();
      await fs.writeFile(path.join(qaDirectory, 'desktop.png'), capture.toPNG());
      app.exit(result.failed.length ? 1 : 0);
    } catch (error) {
      await fs.writeFile(path.join(qaDirectory, 'error.log'), String(error.stack));
      app.exit(1);
    }
  }
});
app.on('window-all-closed', () => app.quit());
