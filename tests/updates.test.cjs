'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createUpdateChecker,
  API_URL,
  MAX_BODY_BYTES,
  isStableTag,
  releaseUrlForTag,
  selectPortableAsset
} = require('../src/updates.cjs');

function jsonResponse(value, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(value)
  };
}

function rateHeaders(remaining) {
  return { 'x-ratelimit-remaining': String(remaining) };
}

test('reports a newer stable release with numeric semver and a fixed release URL', async () => {
  const calls = [];
  const checker = createUpdateChecker({
    currentVersion: '1.2.9',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        tag_name: 'v1.10.0',
        draft: false,
        prerelease: false,
        html_url: 'https://example.invalid/malicious-release-link'
      });
    }
  });

  const result = await checker.check();
  assert.deepEqual(result, {
    status: 'available',
    currentVersion: '1.2.9',
    latestVersion: 'v1.10.0',
    releaseUrl: 'https://github.com/BerryFuwawa/glyph-studio/releases/tag/v1.10.0',
    asset: null,
    message: '发现新版本 v1.10.0。'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API_URL);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
});

test('portable update only selects the matching official, uploaded, hashed executable', () => {
  const name = 'Glyph-Studio-1.3.0-Windows-x64.exe';
  const url = `https://github.com/BerryFuwawa/glyph-studio/releases/download/v1.3.0/${name}`;
  const asset = { name, browser_download_url: url, size: 1024, digest: `sha256:${'a'.repeat(64)}`, state: 'uploaded' };
  assert.deepEqual(selectPortableAsset({ tag_name: 'v1.3.0', assets: [asset] }), { name, url, size: 1024, sha256: 'a'.repeat(64) });
  for (const patch of [{ browser_download_url: 'https://example.com/app.exe' }, { digest: null }, { size: 300 * 1024 * 1024 }, { state: 'new' }, { name: '../app.exe' }]) {
    assert.equal(selectPortableAsset({ tag_name: 'v1.3.0', assets: [{ ...asset, ...patch }] }), null);
  }
  assert.equal(selectPortableAsset({ tag_name: 'v1.3.0', assets: [asset, asset] }), null);
});

test('reports current when the latest release is equal or older', async () => {
  const releases = ['v1.1.0', 'v1.0.99'];
  for (const tag_name of releases) {
    const checker = createUpdateChecker({
      currentVersion: '1.1.0',
      fetchImpl: async () => jsonResponse({ tag_name, draft: false, prerelease: false })
    });
    const result = await checker.check();
    assert.equal(result.status, 'current');
    assert.equal(result.latestVersion, tag_name);
    assert.equal(result.releaseUrl, `https://github.com/BerryFuwawa/glyph-studio/releases/tag/${tag_name}`);
    assert.match(result.message, /最新/);
  }
});

test('rejects non-stable, draft, prerelease, and malformed release payloads', async () => {
  assert.equal(isStableTag('v1.1.1'), true);
  assert.equal(isStableTag('v01.1.1'), false);
  assert.equal(isStableTag('v1.1.1-beta.1'), false);
  assert.equal(releaseUrlForTag('v1.1'), null);

  const payloads = [
    { tag_name: 'v1.1.1-beta.1', draft: false, prerelease: true },
    { tag_name: 'v1.1.1', draft: true, prerelease: false },
    { tag_name: 'v1.1', draft: false, prerelease: false },
    null
  ];
  for (const payload of payloads) {
    const checker = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => jsonResponse(payload) });
    const result = await checker.check();
    assert.equal(result.status, 'error');
    assert.match(result.message, /稳定版本|版本信息无效/);
  }
});

test('maps offline, timeout, rate-limit, and 404 failures to Chinese errors', async () => {
  const offline = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('offline'); } });
  assert.match((await offline.check()).message, /连接 GitHub/);

  const timeout = createUpdateChecker({
    currentVersion: '1.0.0',
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  assert.match((await timeout.check()).message, /超时/);

  const rate = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => jsonResponse({}, 403, rateHeaders(0)) });
  assert.match((await rate.check()).message, /频率限制/);

  const missing = createUpdateChecker({ currentVersion: '1.0.0', fetchImpl: async () => jsonResponse({}, 404) });
  assert.match((await missing.check()).message, /404|稳定版本/);
});

test('bounds response bodies and deduplicates concurrent checks', async () => {
  let calls = 0;
  let resolveResponse;
  const responsePromise = new Promise(resolve => { resolveResponse = resolve; });
  const checker = createUpdateChecker({
    currentVersion: '1.0.0',
    fetchImpl: async () => {
      calls += 1;
      return responsePromise;
    }
  });
  const first = checker.check();
  const second = checker.check();
  assert.strictEqual(first, second);
  resolveResponse(jsonResponse({ tag_name: 'v1.1.0' }));
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await checker.check();
  assert.equal(calls, 2);

  const large = createUpdateChecker({
    currentVersion: '1.0.0',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(MAX_BODY_BYTES + 1) })
  });
  const result = await large.check();
  assert.equal(result.status, 'error');
  assert.match(result.message, /1 MB/);
});
