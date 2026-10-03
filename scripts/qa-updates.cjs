const { _electron } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const packageVersion = require(path.join(root, 'package.json')).version;
const [packageMajor, packageMinor] = packageVersion.split('.').map(Number);
const newerVersion = `${packageMajor}.${packageMinor + 1}.0`;
const newerTag = `v${newerVersion}`;
const releaseUrl = `https://github.com/BerryFuwawa/glyph-studio/releases/tag/${newerTag}`;

async function waitForUpdateState(page, predicate, timeout = 8000) {
  await page.waitForFunction(predicate, null, { timeout });
}

async function setMock(app, mock) {
  await app.evaluate((_, value) => { global.mockUpdate = value; }, mock);
}

async function updateCallCount(app) {
  return app.evaluate(() => global.updateCalls || 0);
}

async function waitForCallCount(app, expected, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await updateCallCount(app) >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`expected at least ${expected} update request(s), got ${await updateCallCount(app)}`);
}

(async () => {
  const launched = await _electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [root, '--desktop-qa'],
    cwd: root
  });
  const passed = [];
  const errors = [];
  try {
    // Install the deterministic transport before the renderer's 500 ms startup check.
    await launched.evaluate(({ session, shell }) => {
      global.updateCalls = 0;
      global.openedUpdateURL = null;
      global.mockUpdate = { status: 'available', latestVersion: '1.0.0' };
      global.mockDelay = 160;
      shell.openExternal = async url => { global.openedUpdateURL = url; };
      session.fromPartition('glyph-updates').fetch = async () => {
        global.updateCalls += 1;
        await new Promise(resolve => setTimeout(resolve, global.mockDelay));
        if (global.mockUpdate?.status === 'error') throw new Error(global.mockUpdate.message || 'network offline');
        const version = String(global.mockUpdate?.latestVersion || '1.0.0').replace(/^v/, '');
        const tag = `v${version}`;
        return new Response(JSON.stringify({
          tag_name: tag,
          draft: false,
          prerelease: false,
          html_url: `https://github.com/BerryFuwawa/glyph-studio/releases/tag/${tag}`
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    });
    await setMock(launched, { status: 'available', latestVersion: newerVersion });

    const page = await launched.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.GlyphStudio?.getState().result);
    await page.waitForSelector('#startup-update-status', { state: 'attached' });
    await waitForCallCount(launched, 1);
    await waitForUpdateState(page, () => !document.getElementById('startup-update-status').textContent.includes('自动检查更新'));
    assert.match(await page.locator('#startup-update-status').textContent(), new RegExp(newerVersion.replace(/\./g, '\\.')));
    assert.equal(await page.locator('#update-notice').isVisible(), true);
    assert.match(await page.locator('#update-notice').innerText(), /检测到更新/);
    passed.push('startup automatically checks once and exposes the detected release in the footer and notice');

    await page.click('#help-btn');
    await page.waitForFunction(version => document.getElementById('help-version').textContent === version, packageVersion);
    await page.click('#help-done');
    passed.push('help version comes from the desktop package');

    // Available updates in development mode retain the manual download fallback.
    await page.click('#update-notice');
    await page.waitForFunction(() => document.getElementById('help-dialog').open);
    assert.equal(await page.locator('#download-update-btn').isVisible(), true);
    await page.click('#download-update-btn');
    assert.equal(await launched.evaluate(() => global.openedUpdateURL), releaseUrl);
    passed.push('available release opens the validated official download URL without an external browser');
    await page.click('#help-done');

    // A failed request clears stale availability and leaves the retry action usable.
    await setMock(launched, { status: 'error', message: '连接失败，请检查网络后重试。' });
    await page.click('#help-btn');
    await page.click('#check-update-btn');
    await waitForUpdateState(page, () => {
      const status = document.getElementById('update-status').textContent;
      return !document.getElementById('check-update-btn').disabled && /失败|无法连接|网络/.test(status) && !status.includes('正在');
    });
    assert.equal(await page.locator('#download-update-btn').isVisible(), false);
    assert.equal(await page.locator('#update-notice').isVisible(), false);
    assert.equal(await page.locator('#check-update-btn').isDisabled(), false);
    assert.match(await page.locator('#check-update-btn').innerText(), /重新检查/);
    passed.push('failed manual check removes stale notice and leaves a retry action');

    // Retry with an equal release returns to current and does not resurrect the stale notice.
    await setMock(launched, { status: 'current', latestVersion: packageVersion });
    await page.click('#check-update-btn');
    await waitForUpdateState(page, () => document.getElementById('update-status').textContent.includes('已是最新版'));
    assert.equal(await page.locator('#update-notice').isVisible(), false);
    passed.push('retry returns to the package version current state');
    await page.click('#help-done');

    // A reload must schedule another automatic check, using the same transport.
    await setMock(launched, { status: 'available', latestVersion: newerVersion });
    const beforeReload = await updateCallCount(launched);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.GlyphStudio?.getState().result);
    await page.waitForSelector('#startup-update-status', { state: 'attached' });
    await waitForCallCount(launched, beforeReload + 1);
    await waitForUpdateState(page, () => document.getElementById('update-notice') && !document.getElementById('update-notice').hidden);
    assert.equal(await updateCallCount(launched), beforeReload + 1);
    passed.push('reload schedules a fresh automatic check without duplicate requests');

    // Do not let an in-flight startup request race a manual retry.
    await setMock(launched, { status: 'current', latestVersion: packageVersion });
    await launched.evaluate(() => { global.mockDelay = 1000; });
    const beforeRace = await updateCallCount(launched);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#help-btn');
    await page.click('#help-btn');
    await page.click('#check-update-btn');
    await waitForUpdateState(page, () => document.getElementById('update-status').textContent.includes('已是最新版'), 10000);
    await page.waitForTimeout(700);
    assert.equal(await updateCallCount(launched), beforeRace + 1);
    passed.push('manual and startup checks share one in-flight request');

    assert.equal(await page.evaluate(async () => { try { await fetch('https://example.com'); return false; } catch { return true; } }), true);
    passed.push('renderer still cannot request external network');
    await launched.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 700));
    assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
    passed.push('update controls remain accessible at the minimum window size');

    assert.deepEqual(errors, []);
    await fs.mkdir(path.join(root, 'qa-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'qa-results/updates.png') });
    console.log(JSON.stringify({ passed, failed: [], errors, updateCalls: await updateCallCount(launched) }, null, 2));
  } finally {
    await launched.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
