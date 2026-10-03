'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');

const RELEASE_OWNER = 'BerryFuwawa';
const RELEASE_REPOSITORY = 'glyph-studio';
const MAX_UPDATE_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000;
const DOWNLOAD_STALL_TIMEOUT_MS = 90 * 1000;
const VERSION_PART = '(0|[1-9]\\d*)';
const ASSET_NAME_PATTERN = new RegExp(`^Glyph-Studio-${VERSION_PART}\\.${VERSION_PART}\\.${VERSION_PART}-Windows-x64\\.exe$`);

class PortableUpdateError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PortableUpdateError';
    if (cause !== undefined) this.cause = cause;
  }
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function normalizedPath(value) {
  return path.normalize(path.resolve(value));
}

function samePath(left, right) {
  const leftValue = normalizedPath(left);
  const rightValue = normalizedPath(right);
  return process.platform === 'win32'
    ? leftValue.toLowerCase() === rightValue.toLowerCase()
    : leftValue === rightValue;
}

function assertAbsolutePath(value, label) {
  if (!isAbsolutePath(value)) throw new PortableUpdateError(`${label} 必须是绝对路径`);
  return normalizedPath(value);
}

function assertSameParent(oldExe, candidate, label) {
  if (!samePath(path.dirname(oldExe), path.dirname(candidate))) {
    throw new PortableUpdateError(`${label} 必须位于便携版程序所在文件夹`);
  }
}

function assertSafeAssetName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 240) {
    throw new PortableUpdateError('更新文件名无效');
  }
  if (name !== path.basename(name) || name !== path.win32.basename(name)) {
    throw new PortableUpdateError('更新文件名必须是安全的文件名');
  }
  if (name === '.' || name === '..' || /[\\/\0-\x1f]/u.test(name)) {
    throw new PortableUpdateError('更新文件名必须是安全的文件名');
  }
  if (!ASSET_NAME_PATTERN.test(name)) {
    throw new PortableUpdateError('更新文件不是官方 Glyph Studio 便携版程序');
  }
  return name;
}

function validateAsset(asset) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new PortableUpdateError('更新文件信息无效');
  }
  const name = assertSafeAssetName(asset.name);
  if (typeof asset.url !== 'string' || asset.url.length > 4096) {
    throw new PortableUpdateError('更新地址无效');
  }
  let parsed;
  try {
    parsed = new URL(asset.url);
  } catch (error) {
    throw new PortableUpdateError('更新地址无效', error);
  }
  const version = name.slice('Glyph-Studio-'.length, -'-Windows-x64.exe'.length);
  const expectedPath = `/BerryFuwawa/glyph-studio/releases/download/v${version}/${name}`;
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'github.com'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== expectedPath
  ) {
    throw new PortableUpdateError('更新地址不是官方 GitHub 发布地址');
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_UPDATE_BYTES) {
    throw new PortableUpdateError('更新文件大小超出便携版更新限制');
  }
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(asset.sha256)) {
    throw new PortableUpdateError('更新文件校验值无效');
  }
  return {
    name,
    url: parsed.toString(),
    size: asset.size,
    sha256: asset.sha256.toLowerCase(),
    version
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  if (typeof headers === 'object') {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return String(value || '');
    }
  }
  return '';
}

function responseIsOk(response) {
  if (!response || typeof response !== 'object') return false;
  if (typeof response.ok === 'boolean') return response.ok;
  const status = Number(response.status);
  return Number.isFinite(status) && status >= 200 && status < 300;
}

function isAllowedFinalDownloadUrl(value, asset) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return false;
  }
  const expectedPath = new URL(asset.url).pathname;
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  if (parsed.hostname === 'github.com') return parsed.pathname === expectedPath;
  return parsed.hostname === 'release-assets.githubusercontent.com'
    && parsed.pathname.startsWith('/github-production-release-asset/');
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new PortableUpdateError('更新下载内容不是二进制数据');
}

function progressValue(onProgress, phase, percent) {
  if (typeof onProgress !== 'function') return Promise.resolve();
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return Promise.resolve(onProgress({ phase, percent: value }));
}

async function writeAll(fileHandle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await fileHandle.write(bytes, offset, bytes.byteLength - offset);
    const written = Number(result?.bytesWritten);
    if (!Number.isSafeInteger(written) || written <= 0) throw new PortableUpdateError('更新文件写入失败');
    offset += written;
  }
}

async function readMZHeader(stagePath) {
  const handle = await fs.open(stagePath, 'r');
  try {
    const header = Buffer.alloc(2);
    const result = await handle.read(header, 0, 2, 0);
    return result.bytesRead === 2 && header[0] === 0x4d && header[1] === 0x5a;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function removeOwnFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') return;
  }
}

async function removeHelperDirectory(helperDirectory, helperPath, manifestPath) {
  await removeOwnFile(helperPath);
  await removeOwnFile(manifestPath);
  try {
    await fs.rmdir(helperDirectory);
  } catch (_) {
    // The helper may still have the script open. This is best effort only.
  }
}

function powerShellPath() {
  const systemRoot = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot.length > 0
    ? process.env.SystemRoot
    : 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function waitForSpawn(child) {
  if (!child || typeof child.once !== 'function') {
    return Promise.reject(new PortableUpdateError('更新助手未返回可用的进程'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.once('spawn', () => finish(resolve, child));
    child.once('error', error => finish(reject, new PortableUpdateError('无法启动更新助手', error)));
  });
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) return;
    } catch (_) {
      // The helper may still be loading the script.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new PortableUpdateError('更新助手未能启动');
}

async function downloadToStage({ request, asset, stagePath, stageHandle, onProgress, signal }) {
  if (typeof request !== 'function') throw new PortableUpdateError('当前环境不支持下载更新');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  let activeReader = null;
  let fileHandle = null;
  let timeoutHandle;
  let stallHandle;
  let rejectTimeout;
  const expire = () => {
    timedOut = true;
    controller?.abort();
    activeReader?.cancel?.().catch(() => {});
    rejectTimeout(new PortableUpdateError('更新下载超时，请稍后重试'));
  };
  const resetStallTimer = () => {
    clearTimeout(stallHandle);
    stallHandle = setTimeout(expire, DOWNLOAD_STALL_TIMEOUT_MS);
    stallHandle.unref?.();
  };
  let rejectCallerAbort;
  const callerAbort = new Promise((_, reject) => { rejectCallerAbort = reject; });
  const abortFromCaller = () => {
    controller?.abort();
    if (activeReader && typeof activeReader.cancel === 'function') activeReader.cancel().catch(() => {});
    rejectCallerAbort(new PortableUpdateError('更新下载已取消'));
  };
  if (signal?.aborted) throw new PortableUpdateError('更新下载已取消');
  if (signal && controller) signal.addEventListener('abort', abortFromCaller, { once: true });
  const hash = crypto.createHash('sha256');
  let downloaded = 0;
  let lastPercent = -1;

  const operation = (async () => {
    const response = await request(asset.url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      ...(controller ? { signal: controller.signal } : {})
    });
    if (response?.redirected && !isAllowedFinalDownloadUrl(response.url, asset)) throw new PortableUpdateError('更新下载发生了不安全的跳转');
    if (response?.url && !isAllowedFinalDownloadUrl(response.url, asset)) throw new PortableUpdateError('更新下载地址不是 GitHub 官方发布地址');
    if (!responseIsOk(response)) throw new PortableUpdateError(`更新下载失败（HTTP ${Number(response?.status) || '未知'}）`);
    resetStallTimer();
    const contentLength = headerValue(response.headers, 'content-length').trim();
    if (contentLength) {
      if (!/^\d+$/u.test(contentLength) || Number(contentLength) !== asset.size) {
        throw new PortableUpdateError('更新下载大小与发布信息不一致');
      }
    }

    // The caller created this path with an exclusive open. Reopen it without
    // truncating so a collision can never turn into an overwrite.
    fileHandle = stageHandle || await fs.open(stagePath, 'r+');
    await progressValue(onProgress, 'downloading', 0);

    async function consumeChunk(value) {
      if (controller?.signal.aborted) throw new PortableUpdateError('更新下载已取消');
      const bytes = asBuffer(value);
      if (bytes.byteLength === 0) return;
      resetStallTimer();
      downloaded += bytes.byteLength;
      if (downloaded > asset.size || downloaded > MAX_UPDATE_BYTES) throw new PortableUpdateError('更新下载内容超出发布信息');
      hash.update(bytes);
      await writeAll(fileHandle, bytes);
      const percent = Math.floor((downloaded * 100) / asset.size);
      if (percent !== lastPercent) {
        lastPercent = percent;
        await progressValue(onProgress, 'downloading', percent);
      }
    }

    if (response.body && typeof response.body.getReader === 'function') {
      activeReader = response.body.getReader();
      try {
        while (true) {
          const result = await activeReader.read();
          if (result.done) break;
          await consumeChunk(result.value);
        }
      } finally {
        activeReader = null;
        if (typeof response.body.cancel === 'function' && controller?.signal.aborted) {
          await response.body.cancel().catch(() => {});
        }
      }
    } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const value of response.body) await consumeChunk(value);
    } else if (typeof response.arrayBuffer === 'function') {
      await consumeChunk(await response.arrayBuffer());
    } else {
      throw new PortableUpdateError('无法读取更新下载内容');
    }

    if (downloaded !== asset.size) throw new PortableUpdateError('更新下载不完整或大小异常');
    if (!fileHandle) throw new PortableUpdateError('更新文件暂存失败');
    await progressValue(onProgress, 'verifying', 0);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    const digest = hash.digest('hex');
    if (digest !== asset.sha256) throw new PortableUpdateError('更新文件校验失败');
    const stat = await fs.stat(stagePath);
    if (!stat.isFile() || stat.size !== asset.size) throw new PortableUpdateError('暂存的更新文件大小异常');
    if (!(await readMZHeader(stagePath))) throw new PortableUpdateError('暂存的更新文件不是 Windows 可执行文件');
    await progressValue(onProgress, 'verifying', 100);
  })();

  const timeout = new Promise((_, reject) => {
    rejectTimeout = reject;
    timeoutHandle = setTimeout(expire, DOWNLOAD_TIMEOUT_MS);
    resetStallTimer();
    if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  });
  try {
    await Promise.race([operation, timeout, callerAbort]);
  } catch (error) {
    if (timedOut) throw new PortableUpdateError('更新下载超时，请稍后重试', error);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    clearTimeout(stallHandle);
    if (signal && controller) signal.removeEventListener('abort', abortFromCaller);
    if (fileHandle) await fileHandle.close().catch(() => {});
  }
}

function validateOptionalPath(value, label, fallback) {
  const candidate = value === undefined || value === null ? fallback : value;
  return assertAbsolutePath(candidate, label);
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function installPortableUpdate({
  fetchImpl,
  asset,
  oldExe,
  pid = process.pid,
  onProgress,
  spawnHelper,
  signal,
  readyFile,
  resultFile,
  currentVersion
} = {}) {
  const releaseAsset = validateAsset(asset);
  const oldPath = assertAbsolutePath(oldExe, 'oldExe');
  let oldStat;
  try {
    oldStat = await fs.lstat(oldPath);
  } catch (error) {
    throw new PortableUpdateError('当前便携版程序文件不存在', error);
  }
  if (!oldStat.isFile() || oldStat.isSymbolicLink()) throw new PortableUpdateError('当前便携版程序文件无效');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new PortableUpdateError('更新进程号无效');

  const oldDirectory = path.dirname(oldPath);
  const targetPath = assertAbsolutePath(path.join(oldDirectory, releaseAsset.name), 'newExe');
  assertSameParent(oldPath, targetPath, 'newExe');
  if (samePath(oldPath, targetPath) || await pathExists(targetPath)) {
    throw new PortableUpdateError('官方更新文件已存在，未覆盖现有文件');
  }

  const resultPath = validateOptionalPath(resultFile, 'resultFile', path.join(os.tmpdir(), 'glyph-studio-update-result.json'));

  const stagePrefix = path.join(oldDirectory, `.glyph-studio-update-${crypto.randomUUID()}-`);
  let stagePath;
  let stageHandle;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${stagePrefix}${crypto.randomBytes(8).toString('hex')}.part`;
    try {
      stageHandle = await fs.open(candidate, 'wx');
      stagePath = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new PortableUpdateError('无法创建更新暂存文件', error);
    }
  }
  if (!stagePath) throw new PortableUpdateError('无法创建唯一的更新暂存文件');
  assertSameParent(oldPath, stagePath, 'staging file');

  let helperDirectory;
  let helperPath;
  let manifestPath;
  try {
    await downloadToStage({ request: fetchImpl === undefined ? globalThis.fetch : fetchImpl, asset: releaseAsset, stagePath, stageHandle, onProgress, signal });
    stageHandle = null;
    if (signal?.aborted) throw new PortableUpdateError('更新下载已取消');
    await progressValue(onProgress, 'installing', 0);

    helperDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'glyph-update-'));
    helperDirectory = normalizedPath(helperDirectory);
    helperPath = path.join(helperDirectory, 'update-helper.ps1');
    manifestPath = path.join(helperDirectory, 'manifest.json');
    const readyPath = readyFile === undefined || readyFile === null
      ? path.join(helperDirectory, 'ready')
      : validateOptionalPath(readyFile, 'readyFile', path.join(helperDirectory, 'ready'));
    const startedPath = path.join(helperDirectory, 'started');
    if (path.basename(readyPath) !== 'ready' || samePath(readyPath, oldPath) || samePath(readyPath, targetPath)) {
      throw new PortableUpdateError('握手文件必须是单独的 ready 文件');
    }
    const manifest = {
      oldExe: oldPath,
      newExe: targetPath,
      stagePath,
      stagedExe: stagePath,
      expectedSha256: releaseAsset.sha256,
      sha256: releaseAsset.sha256,
      expectedSize: releaseAsset.size,
      size: releaseAsset.size,
      pid,
      parentPid: pid,
      readyFile: readyPath,
      startedFile: startedPath,
      resultFile: resultPath,
      currentVersion: typeof currentVersion === 'string' ? currentVersion : undefined,
      newVersion: releaseAsset.version
    };
    const helperSource = await fs.readFile(path.join(__dirname, 'update-helper.ps1'));
    const helperWithBom = helperSource[0] === 0xef && helperSource[1] === 0xbb && helperSource[2] === 0xbf
      ? helperSource
      : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), helperSource]);
    await fs.writeFile(helperPath, helperWithBom, { flag: 'wx' });
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' });
    if (signal?.aborted) throw new PortableUpdateError('更新下载已取消');
    // Windows PowerShell must discover its own modules rather than inherit a
    // PowerShell 7 host's module paths. windowsHide hides the helper without the
    // console-dependent -WindowStyle argument.
    const helperEnv = { ...process.env };
    for (const key of Object.keys(helperEnv)) {
      if (key.toLowerCase() === 'psmodulepath') delete helperEnv[key];
    }
    const helper = (spawnHelper || defaultSpawn)(
      powerShellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-Manifest', manifestPath],
      // DETACHED_PROCESS makes Windows PowerShell terminate without running a
      // script on some hosts. Windows children survive parent exit; ignored
      // handles plus unref() let Electron quit without waiting for the helper.
      { windowsHide: true, detached: false, stdio: 'ignore', env: helperEnv }
    );
    const child = await waitForSpawn(helper);
    // The spawn event only confirms process creation. Wait until the helper
    // has loaded its manifest so an Electron parent can quit immediately
    // without racing the detached child during startup.
    if (!spawnHelper) await waitForFile(startedPath);
    if (typeof child.unref === 'function') child.unref();
    await progressValue(onProgress, 'installing', 100);
    return { status: 'installing' };
  } catch (error) {
    if (stageHandle) await stageHandle.close().catch(() => {});
    await removeOwnFile(stagePath);
    if (helperDirectory) await removeHelperDirectory(helperDirectory, helperPath, manifestPath);
    if (error instanceof PortableUpdateError) throw error;
    throw new PortableUpdateError('更新失败，旧程序保持不变', error);
  }
}

module.exports = {
  installPortableUpdate,
  validateAsset,
  assertSafeAssetName,
  isAllowedFinalDownloadUrl,
  MAX_UPDATE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  PortableUpdateError
};
