'use strict';

const API_URL = 'https://api.github.com/repos/BerryFuwawa/glyph-studio/releases/latest';
const RELEASE_URL_BASE = 'https://github.com/BerryFuwawa/glyph-studio/releases/tag';
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const STABLE_VERSION_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

class BodyTooLargeError extends Error {
  constructor() {
    super('response body exceeds the maximum size');
    this.name = 'BodyTooLargeError';
  }
}

class RedirectError extends Error {
  constructor() {
    super('response was redirected');
    this.name = 'RedirectError';
  }
}

class TimeoutError extends Error {
  constructor() {
    super('request timed out');
    this.name = 'TimeoutError';
  }
}

function parseVersion(value, { tag = false } = {}) {
  if (typeof value !== 'string') return null;
  const match = (tag ? STABLE_VERSION_PATTERN : VERSION_PATTERN).exec(value);
  if (!match) return null;
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function parseCurrentVersion(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('v')) return parseVersion(value.slice(1));
  return parseVersion(value);
}

function compareVersions(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 3 || right.length !== 3) {
    throw new TypeError('versions must contain three numeric components');
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function isStableTag(value) {
  return parseVersion(value, { tag: true }) !== null;
}

function releaseUrlForTag(tag) {
  return isStableTag(tag) ? `${RELEASE_URL_BASE}/${tag}` : null;
}

function byteLength(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return Buffer.byteLength(value, 'utf8');
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('response body chunk is not binary');
}

function decodeBytes(chunks, total) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readStreamBody(body) {
  const chunks = [];
  let total = 0;

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = asUint8Array(result.value);
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) {
          try { await reader.cancel(); } catch (_) { /* best effort */ }
          throw new BodyTooLargeError();
        }
        chunks.push(chunk);
      }
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
    return decodeBytes(chunks, total);
  }

  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const value of body) {
      const chunk = asUint8Array(value);
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
      chunks.push(chunk);
    }
    return decodeBytes(chunks, total);
  }

  throw new TypeError('response body is not readable');
}

async function readResponseText(response) {
  if (response && response.body) return readStreamBody(response.body);

  if (response && typeof response.arrayBuffer === 'function') {
    const value = await response.arrayBuffer();
    const bytes = asUint8Array(value);
    if (bytes.byteLength > MAX_BODY_BYTES) throw new BodyTooLargeError();
    return new TextDecoder().decode(bytes);
  }

  if (response && typeof response.text === 'function') {
    const value = await response.text();
    if (typeof value !== 'string') throw new TypeError('response text is not a string');
    if (byteLength(value) > MAX_BODY_BYTES) throw new BodyTooLargeError();
    return value;
  }

  return null;
}

async function readResponseJson(response) {
  const text = await readResponseText(response);
  if (text !== null) {
    const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return JSON.parse(normalized);
  }
  if (response && typeof response.json === 'function') {
    const value = await response.json();
    let serialized;
    try { serialized = JSON.stringify(value); } catch (_) { throw new TypeError('response JSON is not serializable'); }
    if (typeof serialized !== 'string' || byteLength(serialized) > MAX_BODY_BYTES) throw new BodyTooLargeError();
    return value;
  }
  throw new TypeError('response has no readable body');
}

function getHeader(headers, name) {
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

function isRateLimited(response) {
  if (Number(response?.status) === 429) return true;
  if (Number(response?.status) !== 403) return false;
  return getHeader(response.headers, 'x-ratelimit-remaining').trim() === '0';
}

function currentResult(currentVersion, latestVersion, releaseUrl) {
  return {
    status: 'current',
    currentVersion,
    latestVersion,
    releaseUrl,
    message: '当前已是最新版本。'
  };
}

function availableResult(currentVersion, latestVersion, releaseUrl) {
  return {
    status: 'available',
    currentVersion,
    latestVersion,
    releaseUrl,
    message: `发现新版本 ${latestVersion}。`
  };
}

function errorResult(currentVersion, message) {
  return { status: 'error', currentVersion, message };
}

function timeoutValue(value) {
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TIMEOUT_MS;
}

function responseIsOk(response) {
  if (!response || typeof response !== 'object') return false;
  if (typeof response.ok === 'boolean') return response.ok;
  const status = Number(response.status);
  return Number.isFinite(status) && status >= 200 && status < 300;
}

function httpError(currentVersion, response) {
  const status = Number(response?.status);
  if (status === 404) return errorResult(currentVersion, '暂未找到可用的稳定版本（404）。');
  if (isRateLimited(response)) return errorResult(currentVersion, 'GitHub 更新检查已达到频率限制，请稍后再试。');
  if (status === 403) return errorResult(currentVersion, 'GitHub 拒绝了更新检查请求（403）。');
  if (Number.isFinite(status)) return errorResult(currentVersion, `更新检查失败（HTTP ${status}）。`);
  return errorResult(currentVersion, 'GitHub 返回了无效的响应。');
}

function createUpdateChecker({ currentVersion, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const request = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
  const timeout = timeoutValue(timeoutMs);
  let inFlight = null;

  function check() {
    if (inFlight) return inFlight;
    const run = (async () => {
      const version = parseCurrentVersion(currentVersion);
      if (!version) return errorResult(currentVersion, '当前版本号无效，无法检查更新。');
      if (typeof request !== 'function') return errorResult(currentVersion, '当前环境不支持在线更新检查。');

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      let timer;
      const operation = (async () => {
        const response = await request(API_URL, {
          method: 'GET',
          headers: { Accept: 'application/vnd.github+json' },
          credentials: 'omit',
          redirect: 'error',
          ...(controller ? { signal: controller.signal } : {})
        });
        if (response?.redirected) throw new RedirectError();
        if (!responseIsOk(response)) return httpError(currentVersion, response);
        let release;
        try {
          release = await readResponseJson(response);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return errorResult(currentVersion, 'GitHub 返回内容超过 1 MB，已停止检查更新。');
          return errorResult(currentVersion, 'GitHub 返回的版本信息无效。');
        }
        if (!release || typeof release !== 'object' || Array.isArray(release)) {
          return errorResult(currentVersion, '暂未找到可用的稳定版本。');
        }
        if (release.draft || release.prerelease) {
          return errorResult(currentVersion, '暂未找到可用的稳定版本。');
        }
        const latestVersion = typeof release.tag_name === 'string' ? release.tag_name : '';
        const latest = parseVersion(latestVersion, { tag: true });
        const releaseUrl = releaseUrlForTag(latestVersion);
        if (!latest || !releaseUrl) return errorResult(currentVersion, 'GitHub 返回的版本信息无效。');
        return compareVersions(latest, version) > 0
          ? availableResult(currentVersion, latestVersion, releaseUrl)
          : currentResult(currentVersion, latestVersion, releaseUrl);
      })();

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (controller) controller.abort();
          reject(new TimeoutError());
        }, timeout);
      });
      try {
        return await Promise.race([operation, timeoutPromise]);
      } catch (error) {
        if (timedOut || error instanceof TimeoutError || error?.name === 'TimeoutError') {
          return errorResult(currentVersion, '检查更新超时，请稍后重试。');
        }
        if (error instanceof RedirectError) return errorResult(currentVersion, '更新检查遇到重定向，已停止请求。');
        return errorResult(currentVersion, '无法连接 GitHub，请检查网络连接。');
      } finally {
        clearTimeout(timer);
      }
    })();
    let shared;
    shared = run.finally(() => {
      if (inFlight === shared) inFlight = null;
    });
    inFlight = shared;
    return shared;
  }

  return { check };
}

module.exports = createUpdateChecker;
module.exports.createUpdateChecker = createUpdateChecker;
module.exports.API_URL = API_URL;
module.exports.RELEASE_URL_BASE = RELEASE_URL_BASE;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.parseVersion = parseVersion;
module.exports.compareVersions = compareVersions;
module.exports.isStableTag = isStableTag;
module.exports.releaseUrlForTag = releaseUrlForTag;
