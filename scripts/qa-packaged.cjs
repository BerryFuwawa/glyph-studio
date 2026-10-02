const { _electron } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const projectRoot = path.resolve(__dirname, '..');
const qaResults = path.join(projectRoot, 'qa-results');
(async () => {
  await fs.mkdir(qaResults, { recursive: true });
  const app = await _electron.launch({ executablePath: path.join(projectRoot, 'dist', 'win-unpacked', 'Glyph Studio.exe'), args: [], cwd: projectRoot });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.GlyphStudio?.getState().result && !document.getElementById('copy-btn').disabled);
    const state = await page.evaluate(() => { const state = window.GlyphStudio.getState(); return { source: state.source.name, columns: state.result.columns, rows: state.result.rows, mode: state.result.mode }; });
    const visibility = await app.evaluate(({ BrowserWindow, app }) => ({ visible: BrowserWindow.getAllWindows()[0].isVisible(), packaged: app.isPackaged }));
    assert.equal(visibility.packaged, true);
    assert.equal(visibility.visible, true);
    assert.ok(state.columns > 0 && state.rows > 0);
    await page.screenshot({ path: path.join(qaResults, 'packaged-preview.png'), scale: 'css' });
    await page.click('[data-mode=braille]');
    await page.waitForFunction(() => window.GlyphStudio.getState().result.mode === 'braille' && !document.getElementById('copy-btn').disabled);
    await page.click('#reset-btn');
    await page.waitForFunction(() => window.GlyphStudio.getState().result.mode === 'ascii' && !document.getElementById('copy-btn').disabled);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ...visibility, state, errors }, null, 2));
    await fs.writeFile(path.join(qaResults, 'packaged-smoke.json'), JSON.stringify({ ...visibility, state, errors }, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
