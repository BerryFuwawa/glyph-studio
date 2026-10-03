// Runs the real Windows replacement helper against disposable copies of portable builds.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { installPortableUpdate } = require('../src/portable-update.cjs');
const version = require('../package.json').version;
const root = path.resolve(__dirname, '..');
(async () => {
  if (process.platform !== 'win32') throw new Error('This integration test requires Windows.');
  const parent = path.join(root, 'qa-results', 'portable-update');
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'case-'));
  const oldExe = path.join(folder, '旧版 字相.exe');
  const name = `Glyph-Studio-${version}-Windows-x64.exe`;
  const source = path.join(root, 'dist', name);
  await fs.copyFile(source, oldExe);
  const bytes = await fs.readFile(source);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const resultFile = path.join(folder, 'result.json');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const locker = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$f = [IO.File]::Open($env:GLYPH_QA_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::WriteLine('locked'); Start-Sleep -Seconds 3; $f.Dispose()"], { windowsHide: true, env: { ...process.env, GLYPH_QA_LOCK_FILE: oldExe } });
  await new Promise((resolve, reject) => { locker.stdout.once('data', resolve); locker.once('error', reject); locker.once('exit', code => { if (code) reject(new Error('fixture lock failed')); }); });
  let newPid;
  try {
    const result = await installPortableUpdate({
      oldExe, pid: locker.pid, resultFile,
      asset: { name, url: `https://github.com/BerryFuwawa/glyph-studio/releases/download/v${version}/${name}`, size: bytes.length, sha256 },
      fetchImpl: async () => new Response(Readable.toWeb(createReadStream(source)), { status: 200, headers: { 'content-length': String(bytes.length) } })
    });
    assert.equal(result.status, 'installing');
    const deadline = Date.now() + 90000;
    let report;
    while (Date.now() < deadline) {
      try { report = JSON.parse(await fs.readFile(resultFile, 'utf8')); break; } catch { }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(report, 'replacement helper did not complete');
    newPid = report.newPid;
    assert.equal(report.status, 'success', JSON.stringify(report));
    assert.equal(report.newVersion, version);
    assert.ok(Number.isSafeInteger(newPid) && newPid > 0, 'new application PID missing');
    await assert.rejects(fs.access(oldExe));
    const installed = await fs.readFile(path.join(folder, name));
    assert.equal(crypto.createHash('sha256').update(installed).digest('hex'), sha256);
    assert.deepEqual((await fs.readdir(folder)).sort(), [name, 'result.json'].sort());
    console.log(JSON.stringify({ passed: ['helper waits for the old process and file lock', 'real portable starts and confirms expected version', 'old executable and backup removed only after new startup', 'replacement stays in original directory with correct hash'], version, folder, report }, null, 2));
  } finally {
    // Only terminate the test application's exact PID; all fixture files stay in qa-results.
    if (Number.isSafeInteger(newPid)) {
      try { process.kill(newPid); } catch { }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
