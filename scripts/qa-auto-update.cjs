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

async function setMainValue(app, name, value) {
  await app.evaluate((_, payload) => { global[payload.name] = payload.value; }, { name, value });
}

async function mainValue(app, name) {
  return app.evaluate((_, target) => global[target], name);
}

async function waitForMainValue(app, name, predicate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate(await mainValue(app, name))) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${name}`);
}

async function waitForText(page, selector, matcher, timeout = 8000) {
  await page.waitForFunction(({ selector, matcher }) => {
    const element = document.querySelector(selector);
    return element && new RegExp(matcher).test(element.textContent || '');
  }, { selector, matcher: matcher.source }, { timeout });
}

async function waitForEnabled(page, selector, timeout = 8000) {
  await page.waitForFunction(target => {
    const element = document.querySelector(target);
    return element && !element.disabled;
  }, selector, { timeout });
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
    // Keep the renderer deterministic and replace only the install/check handlers used by this UI test.
    // The production sender checks and installer implementation are covered by the main-process tests.
    await launched.evaluate(({ ipcMain, session, shell }, payload) => {
      global.qaCheckCalls = 0;
      global.qaInstallCalls = 0;
      global.qaProgressEvents = [];
      global.qaInstallMode = 'installing';
      global.qaInstallRelease = null;
      global.qaUpdateResult = { ...payload.initialResult };
      global.openedUpdateURL = null;
      shell.openExternal = async url => { global.openedUpdateURL = url; };
      // Keep a real partition fetch mock installed so the test never reaches GitHub if a production
      // handler accidentally remains registered during startup.
      session.fromPartition('glyph-updates').fetch = async () => new Response(JSON.stringify({
        tag_name: global.qaUpdateResult.latestVersion,
        draft: false,
        prerelease: false
      }), { status: 200 });

      ipcMain.removeHandler('check-updates');
      ipcMain.handle('check-updates', async () => {
        global.qaCheckCalls += 1;
        return { ...global.qaUpdateResult };
      });

      ipcMain.removeHandler('open-update');
      ipcMain.handle('open-update', async () => {
        global.openedUpdateURL = global.qaUpdateResult.releaseUrl;
        return true;
      });

      ipcMain.removeHandler('install-update');
      ipcMain.handle('install-update', async event => {
        global.qaInstallCalls += 1;
        global.qaProgressEvents = [];
        const send = payload => {
          global.qaProgressEvents.push(payload);
          event.sender.send('update-progress', payload);
        };
        send({ phase: 'downloading', percent: 20 });
        if (global.qaInstallMode === 'canceled') return { status: 'canceled' };
        await new Promise(resolve => { global.qaInstallRelease = resolve; });
        global.qaInstallRelease = null;
        if (global.qaInstallMode === 'canceled') return { status: 'canceled' };
        send({ phase: 'downloading', percent: 80 });
        send({ phase: 'verifying', percent: 100 });
        send({ phase: 'installing', percent: 100 });
        if (global.qaInstallMode === 'error') throw new Error('更新失败：模拟安装器失败。');
        return { status: 'installing' };
      });
      ipcMain.removeHandler('cancel-update');
      ipcMain.handle('cancel-update', async () => {
        global.qaInstallMode = 'canceled';
        global.qaInstallRelease?.();
        return true;
      });
    }, {
      initialResult: {
        status: 'available',
        currentVersion: packageVersion,
        latestVersion: newerTag,
        releaseUrl,
        canInstall: false,
        installReason: '当前运行方式不支持就地更新，请下载 Windows 便携版。'
      }
    });

    const page = await launched.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.GlyphStudio?.getState().result);
    await page.waitForSelector('#startup-update-status', { state: 'attached' });
    await waitForMainValue(launched, 'qaCheckCalls', count => count === 1);
    await waitForText(page, '#startup-update-status', /发现|新版|更新|最新版|当前/);
    assert.equal(await page.locator('#update-notice').isVisible(), true);
    assert.match(await page.locator('#update-notice').innerText(), /检测到更新/);
    passed.push('startup check invokes the bridge once and renders the available notice');

    // Unpackaged/dev builds must route the notice to Help, where the safe browser download remains.
    await page.click('#update-notice');
    await page.waitForFunction(() => document.getElementById('help-dialog').open);
    const installFallback = page.locator('#install-update-btn');
    if (await installFallback.isVisible()) assert.equal(await installFallback.isDisabled(), true);
    assert.equal(await page.locator('#download-update-btn').isVisible(), true);
    await page.click('#download-update-btn');
    assert.equal(await mainValue(launched, 'openedUpdateURL'), releaseUrl);
    assert.equal(await mainValue(launched, 'qaInstallCalls'), 0);
    passed.push('canInstall=false opens Help and keeps the official download fallback without installing');
    await page.click('#help-done');

    // Replace the check result with an installable release and ask through the existing manual check UI.
    await setMainValue(launched, 'qaUpdateResult', {
      status: 'available',
      currentVersion: packageVersion,
      latestVersion: newerTag,
      releaseUrl,
      canInstall: true,
      installReason: null
    });
    await page.click('#help-btn');
    await page.click('#check-update-btn');
    await waitForText(page, '#update-status', /发现新版本/);
    assert.equal(await page.locator('#install-update-btn').isVisible(), true);
    assert.equal(await page.locator('#install-update-btn').isDisabled(), false);
    assert.equal(await page.locator('#download-update-btn').isVisible(), true);
    passed.push('installable result exposes both update actions in Help');

    // The mocked installer pauses after 20% so disabled controls can be observed in-flight.
    await setMainValue(launched, 'qaInstallMode', 'installing');
    await page.click('#install-update-btn');
    await waitForText(page, '#update-status', /20%|下载.*20|正在下载/);
    assert.equal(await page.locator('#install-update-btn').isDisabled(), true);
    assert.equal(await page.locator('#download-update-btn').isDisabled(), true);
    assert.equal(await page.locator('#update-notice').isDisabled(), true);
    assert.equal(await page.locator('#startup-update-status').isDisabled(), true);
    if (await page.locator('#check-update-btn').isVisible()) assert.equal(await page.locator('#check-update-btn').isDisabled(), true);
    assert.match(await page.locator('#update-notice').innerText(), /20%|下载|更新/);
    passed.push('install progress at 20% disables install and download actions and mirrors the notice');

    await launched.evaluate(() => global.qaInstallRelease?.());
    await waitForMainValue(launched, 'qaProgressEvents', events => Array.isArray(events) && events.some(item => item.phase === 'downloading' && item.percent === 80));
    await waitForMainValue(launched, 'qaProgressEvents', events => Array.isArray(events) && events.some(item => item.phase === 'verifying') && events.some(item => item.phase === 'installing'));
    assert.equal(await page.locator('#install-update-btn').isDisabled(), true);
    assert.equal(await page.locator('#download-update-btn').isDisabled(), true);
    const progress = await mainValue(launched, 'qaProgressEvents');
    assert.deepEqual(progress, [
      { phase: 'downloading', percent: 20 },
      { phase: 'downloading', percent: 80 },
      { phase: 'verifying', percent: 100 },
      { phase: 'installing', percent: 100 }
    ]);
    assert.equal((await launched.windows()).length, 1);
    passed.push('mock install reports 20%, 80%, verifying and installing without quitting the app');

    // The real installing result keeps controls disabled until the process exits; reload the
    // renderer to model the restarted application before exercising retry/cancel paths.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.GlyphStudio?.getState().result);
    await waitForText(page, '#update-status', /发现新版本/);
    await page.click('#help-btn');

    // Installer failure leaves an actionable available state for retry.
    await setMainValue(launched, 'qaInstallMode', 'error');
    await page.click('#install-update-btn');
    await waitForText(page, '#update-status', /20%|下载.*20|正在下载/);
    await launched.evaluate(() => global.qaInstallRelease?.());
    await waitForEnabled(page, '#install-update-btn');
    assert.equal(await page.locator('#update-notice').isVisible(), true);
    assert.equal(await page.locator('#download-update-btn').isDisabled(), false);
    assert.match(await page.locator('#update-status').innerText(), /失败|重试|更新/);
    passed.push('installer failure restores an available state with retry/download actions');

    // Cancellation through the visible button is a normal user outcome and restores the same available state.
    await setMainValue(launched, 'qaInstallMode', 'installing');
    await page.click('#install-update-btn');
    await waitForText(page, '#update-status', /20%|下载.*20|正在下载/);
    assert.equal(await page.locator('#cancel-update-btn').isVisible(), true);
    await page.click('#help-done');
    await page.click('#cancel-update-btn');
    await waitForMainValue(launched, 'qaInstallCalls', count => count >= 3);
    await waitForEnabled(page, '#install-update-btn');
    assert.equal(await page.locator('#update-notice').isVisible(), true);
    assert.equal(await page.locator('#install-update-btn').isDisabled(), false);
    assert.equal(await page.locator('#download-update-btn').isDisabled(), false);
    assert.doesNotMatch(await page.locator('#update-status').innerText(), /失败/);
    passed.push('cancel button returns a canceled install to available actions without a failure state');

    // A reload schedules another startup request after the initial load.
    const callsBeforeReload = await mainValue(launched, 'qaCheckCalls');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.GlyphStudio?.getState().result);
    await waitForMainValue(launched, 'qaCheckCalls', count => count === callsBeforeReload + 1);
    await waitForText(page, '#startup-update-status', /发现|新版|更新|最新版|当前/);
    passed.push('reloading the renderer triggers the startup update check again');

    assert.deepEqual(errors, []);
    await fs.mkdir(path.join(root, 'qa-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'qa-results/auto-update.png') });
    console.log(JSON.stringify({ passed, failed: [], errors, checkCalls: await mainValue(launched, 'qaCheckCalls'), installCalls: await mainValue(launched, 'qaInstallCalls') }, null, 2));
  } finally {
    await launched.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
