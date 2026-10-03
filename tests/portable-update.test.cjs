'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { installPortableUpdate, validateAsset } = require('../src/portable-update.cjs');

const ASSET_NAME = 'Glyph-Studio-2.0.0-Windows-x64.exe';
const ASSET_URL = `https://github.com/BerryFuwawa/glyph-studio/releases/download/v2.0.0/${ASSET_NAME}`;

function createAsset(bytes, overrides = {}) {
  return {
    name: ASSET_NAME,
    url: ASSET_URL,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    ...overrides
  };
}

function responseFor(bytes, { contentLength = String(bytes.length), url, redirected = false } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { 'content-length': contentLength },
    ...(url ? { url } : {}),
    redirected,
    body: (async function* () {
      yield bytes.subarray(0, 2);
      yield bytes.subarray(2);
    })()
  };
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-update-test-'));
  const oldExe = path.join(root, 'Glyph-Studio-1.2.0-Windows-x64.exe');
  await fs.writeFile(oldExe, Buffer.from('MZ-old-executable'));
  return { root, oldExe };
}

async function removeFixture(fixture) {
  await fs.rm(fixture.root, { recursive: true, force: true });
}

function fakeSpawner(capture) {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    const child = new EventEmitter();
    child.unref = () => { capture.unref = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

async function assertNoStageFiles(root) {
  const entries = await fs.readdir(root);
  assert.equal(entries.some(entry => entry.endsWith('.part')), false);
}

test('streams a verified download, writes a manifest, and returns only after helper spawn', async () => {
  const fixture = await makeFixture();
  try {
    const bytes = Buffer.from('MZ-new-portable-executable');
    const capture = {};
    const progress = [];
    const result = await installPortableUpdate({
      asset: createAsset(bytes),
      oldExe: fixture.oldExe,
      pid: process.pid,
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'follow');
        assert.equal(options.credentials, 'omit');
        return responseFor(bytes);
      },
      onProgress: value => progress.push(value),
      spawnHelper: fakeSpawner(capture),
      resultFile: path.join(fixture.root, 'update-result.json')
    });

    assert.deepEqual(result, { status: 'installing' });
    assert.equal(capture.options.windowsHide, true);
    assert.equal(capture.options.detached, false);
    assert.equal(capture.options.stdio, 'ignore');
    assert.equal(capture.unref, true);
    assert.match(capture.command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.deepEqual(capture.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(Object.keys(capture.options.env).some(key => key.toLowerCase() === 'psmodulepath'), false);
    const manifestPath = capture.args[capture.args.indexOf('-Manifest') + 1];
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(manifest.oldExe, fixture.oldExe);
    assert.equal(manifest.newExe, path.join(fixture.root, ASSET_NAME));
    assert.equal(path.dirname(manifest.stagePath), fixture.root);
    assert.match(path.basename(manifest.stagePath), /\.part$/u);
    assert.equal(path.basename(manifest.readyFile), 'ready');
    assert.equal(path.basename(manifest.startedFile), 'started');
    assert.match(path.basename(path.dirname(manifest.readyFile)), /^glyph-update-/u);
    assert.equal(manifest.expectedSize, bytes.length);
    assert.equal(manifest.expectedSha256, createAsset(bytes).sha256);
    assert.equal((await fs.readFile(fixture.oldExe)).toString(), 'MZ-old-executable');
    assert.deepEqual(progress.at(-1), { phase: 'installing', percent: 100 });
  } finally {
    await removeFixture(fixture);
  }
});

test('rejects hash mismatch, network failure, and truncated streams while preserving the old executable', async () => {
  const cases = [
    {
      name: 'hash mismatch',
      run: async ({ oldExe, bytes }) => installPortableUpdate({
        asset: createAsset(bytes, { sha256: '0'.repeat(64) }),
        oldExe,
        fetchImpl: async () => responseFor(bytes),
        spawnHelper: fakeSpawner({})
      })
    },
    {
      name: 'network failure',
      run: async ({ oldExe, bytes }) => installPortableUpdate({
        asset: createAsset(bytes),
        oldExe,
        fetchImpl: async () => { throw new Error('offline'); },
        spawnHelper: fakeSpawner({})
      })
    },
    {
      name: 'truncated stream',
      run: async ({ oldExe, bytes }) => installPortableUpdate({
        asset: createAsset(bytes, { size: bytes.length + 1 }),
        oldExe,
        fetchImpl: async () => responseFor(bytes, { contentLength: '' }),
        spawnHelper: fakeSpawner({})
      })
    }
  ];
  for (const currentCase of cases) {
    const fixture = await makeFixture();
    try {
      const bytes = Buffer.from('MZ-new-portable-executable');
      await assert.rejects(currentCase.run({ ...fixture, bytes }), currentCase.name);
      assert.equal((await fs.readFile(fixture.oldExe)).toString(), 'MZ-old-executable');
      await assertNoStageFiles(fixture.root);
    } finally {
      await removeFixture(fixture);
    }
  }
});

test('rejects an existing official target before download and rejects unsafe metadata', async () => {
  const fixture = await makeFixture();
  try {
    const bytes = Buffer.from('MZ-new-portable-executable');
    const target = path.join(fixture.root, ASSET_NAME);
    await fs.writeFile(target, Buffer.from('keep this file'));
    let fetchCalls = 0;
    await assert.rejects(installPortableUpdate({
      asset: createAsset(bytes),
      oldExe: fixture.oldExe,
      fetchImpl: async () => { fetchCalls += 1; return responseFor(bytes); }
    }), /已存在|already exists/u);
    assert.equal(fetchCalls, 0);
    assert.equal((await fs.readFile(fixture.oldExe)).toString(), 'MZ-old-executable');
    assert.equal((await fs.readFile(target)).toString(), 'keep this file');
    assert.throws(() => validateAsset({
      ...createAsset(bytes),
      name: '../Glyph-Studio-2.0.0-Windows-x64.exe'
    }), /安全的文件名|官方/u);
  } finally {
    await removeFixture(fixture);
  }
});

test('follows GitHub release asset redirects and rejects an unapproved final host', async () => {
  const bytes = Buffer.from('MZ-new-portable-executable');
  const allowedFixture = await makeFixture();
  try {
    const capture = {};
    const result = await installPortableUpdate({
      asset: createAsset(bytes),
      oldExe: allowedFixture.oldExe,
      fetchImpl: async () => responseFor(bytes, {
        url: 'https://release-assets.githubusercontent.com/github-production-release-asset/123/example?X-Amz-Signature=test',
        redirected: true
      }),
      spawnHelper: fakeSpawner(capture)
    });
    assert.deepEqual(result, { status: 'installing' });
  } finally {
    await removeFixture(allowedFixture);
  }

  const rejectedFixture = await makeFixture();
  try {
    await assert.rejects(installPortableUpdate({
      asset: createAsset(bytes),
      oldExe: rejectedFixture.oldExe,
      fetchImpl: async () => responseFor(bytes, { url: 'https://example.invalid/download.exe', redirected: true }),
      spawnHelper: fakeSpawner({})
    }), /跳转|官方发布地址/u);
    assert.equal((await fs.readFile(rejectedFixture.oldExe)).toString(), 'MZ-old-executable');
    await assertNoStageFiles(rejectedFixture.root);
  } finally {
    await removeFixture(rejectedFixture);
  }
});

test('cancels a pending body read and removes only its staged file', async () => {
  const fixture = await makeFixture();
  const controller = new AbortController();
  let cancelled = false;
  try {
    const bytes = Buffer.from('MZ-new-portable-executable');
    const pendingBody = {
      getReader() {
        return {
          read: () => new Promise(() => {}),
          cancel: async () => { cancelled = true; },
          releaseLock() {}
        };
      }
    };
    const update = installPortableUpdate({
      asset: createAsset(bytes),
      oldExe: fixture.oldExe,
      signal: controller.signal,
      fetchImpl: async () => ({ ok: true, status: 200, headers: {}, body: pendingBody }),
      spawnHelper: fakeSpawner({})
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(update, /取消/u);
    assert.equal(cancelled, true);
    assert.equal((await fs.readFile(fixture.oldExe)).toString(), 'MZ-old-executable');
    await assertNoStageFiles(fixture.root);
  } finally {
    await removeFixture(fixture);
  }
});

test('PowerShell helper restores the old executable when the replacement cannot launch', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await makeFixture();
  const helper = path.join(fixture.root, 'update-helper.ps1');
  const stagePath = path.join(fixture.root, '.replacement.part');
  const newPath = path.join(fixture.root, ASSET_NAME);
  const readyPath = path.join(fixture.root, 'ready');
  const resultPath = path.join(fixture.root, 'update-result.json');
  const invalidMZ = Buffer.from('MZ');
  const helperSource = await fs.readFile(path.join(__dirname, '..', 'src', 'update-helper.ps1'));
  const helperWithBom = helperSource[0] === 0xef && helperSource[1] === 0xbb && helperSource[2] === 0xbf
    ? helperSource
    : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), helperSource]);
  await fs.writeFile(helper, helperWithBom);
  await fs.writeFile(stagePath, invalidMZ);
  const manifest = {
    oldExe: fixture.oldExe,
    newExe: newPath,
    stagePath,
    expectedSha256: crypto.createHash('sha256').update(invalidMZ).digest('hex'),
    expectedSize: invalidMZ.length,
    pid: 2147483647,
    readyFile: readyPath,
    resultFile: resultPath,
    newVersion: '2.0.0'
  };
  const manifestPath = path.join(fixture.root, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Manifest', manifestPath], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal((await fs.readFile(fixture.oldExe)).toString(), 'MZ-old-executable');
    assert.equal(await fs.stat(newPath).then(() => true, () => false), false);
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    assert.equal(result.status, 'error');
    assert.match(result.message, /新程序启动失败/u);
  } finally {
    await removeFixture(fixture);
  }
});

test('production helper keeps running after its parent exits and rolls back a failed launch', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const fixture = await makeFixture();
  const resultFile = path.join(fixture.root, 'result.json');
  const bytes = Buffer.from('MZ');
  const payload = { oldExe: fixture.oldExe, resultFile, asset: createAsset(bytes) };
  const script = `const {installPortableUpdate}=require(process.env.GLYPH_TEST_MODULE); const p=JSON.parse(process.env.GLYPH_TEST_PAYLOAD); installPortableUpdate({...p,fetchImpl:async()=>new Response(Buffer.from('MZ'))}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});`;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: 'ignore', env: { ...process.env, GLYPH_TEST_MODULE: path.resolve(__dirname, '../src/portable-update.cjs'), GLYPH_TEST_PAYLOAD: JSON.stringify(payload) } });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(exitCode, 0);
    let report;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { report = JSON.parse(await fs.readFile(resultFile, 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(report, 'helper did not run after its parent exited');
    assert.equal(report.status, 'error');
    assert.match(report.message, /新程序启动失败/u);
    assert.equal((await fs.readFile(fixture.oldExe)).toString(), 'MZ-old-executable');
    await assertNoStageFiles(fixture.root);
  } finally {
    await removeFixture(fixture);
  }
});
