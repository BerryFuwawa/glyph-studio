const { _electron } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packageVersion = require(path.join(root, 'package.json')).version;
const [packageMajor, packageMinor] = packageVersion.split('.').map(Number);
const newerVersion = `${packageMajor}.${packageMinor + 1}.0`;
(async () => {
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--desktop-qa'], cwd: root });
  const passed = [];
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.GlyphStudio?.getState().result);
    await page.click('#help-btn');
    await page.waitForFunction(version => document.getElementById('help-version').textContent === version, packageVersion);
    passed.push('version comes from desktop package');
    await assert.rejects(page.evaluate(() => window.desktop.openUpdatePage()));
    passed.push('download cannot open before validated newer release');
    // Exercise real transport once; network failure is also an accepted user-visible result.
    const live = await page.evaluate(() => window.desktop.checkForUpdates());
    assert.ok(['current', 'available', 'error'].includes(live.status));
    console.log('Live GitHub check:', JSON.stringify(live));
    await app.evaluate(({ session, shell }) => {
      global.updateCalls = 0;
      global.openedUpdateURL = null;
      shell.openExternal = async url => { global.openedUpdateURL = url; };
      session.fromPartition('glyph-updates').fetch = async () => {
        global.updateCalls++;
        await new Promise(resolve => setTimeout(resolve, 350));
        if (global.mockUpdate.status === 'error') throw new Error('network offline');
        const version = global.mockUpdate.latestVersion;
        return new Response(JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://github.com/BerryFuwawa/glyph-studio/releases/tag/v${version}` }), { status: 200 });
      };
    });
    const mock = value => app.evaluate((_, result) => { global.mockUpdate = result; }, value);
    await mock({ status: 'available', currentVersion: packageVersion, latestVersion: newerVersion, releaseUrl: `https://github.com/BerryFuwawa/glyph-studio/releases/tag/v${newerVersion}` });
    await page.click('#check-update-btn');
    assert.equal(await page.locator('#check-update-btn').isDisabled(), true);
    await page.waitForFunction(() => !document.getElementById('check-update-btn').disabled);
    assert.match(await page.locator('#update-status').innerText(), new RegExp(newerVersion.replace(/\./g, '\\.')));
    assert.equal(await page.locator('#download-update-btn').isVisible(), true);
    passed.push('checking disables repeated requests and newer version displays download');
    await page.click('#download-update-btn');
    assert.equal(await app.evaluate(() => global.openedUpdateURL), `https://github.com/BerryFuwawa/glyph-studio/releases/tag/v${newerVersion}`);
    passed.push('download opens only main-process validated official release URL');
    await mock({ status: 'error', currentVersion: packageVersion, message: '连接失败，请检查网络后重试。' });
    await page.click('#check-update-btn');
    await page.waitForFunction(() => document.getElementById('check-update-btn').textContent === '重新检查');
    assert.equal(await page.locator('#download-update-btn').isVisible(), false);
    assert.match(await page.locator('#update-status').innerText(), /网络/);
    passed.push('failed recheck hides stale download and permits retry');
    await mock({ status: 'current', currentVersion: packageVersion, latestVersion: packageVersion });
    await page.click('#check-update-btn');
    await page.waitForFunction(() => document.getElementById('update-status').textContent.includes('已是最新版'));
    passed.push('retry returns to latest version state');
    assert.equal(await page.evaluate(async () => { try { await fetch('https://example.com'); return false; } catch { return true; } }), true);
    passed.push('renderer still cannot request external network');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 700));
    await page.locator('#check-update-btn').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#help-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await fs.mkdir(path.join(root, 'qa-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'qa-results/updates.png') });
    passed.push('update section accessible at minimum window size');
    console.log(JSON.stringify({ passed, failed: [] }, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
