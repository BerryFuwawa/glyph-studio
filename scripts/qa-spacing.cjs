const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const projectRoot = path.resolve(__dirname, '..');
(async () => {
  const application = await _electron.launch({ executablePath: path.join(projectRoot, 'node_modules/electron/dist/electron.exe'), args: [projectRoot, '--desktop-qa'], cwd: projectRoot });
  const passed = [];
  const errors = [];
  try {
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => window.GlyphStudio?.getState().result && !document.getElementById('copy-btn').disabled);
    await ready();
    await page.click('#reset-btn');
    await ready();
    const base = await page.evaluate(() => {
      const { metric, result } = window.GlyphStudio.getState();
      return { metric, text: result.text, columns: result.columns, rows: result.rows, ansi: window.GlyphStudio.createExport('ansi') };
    });
    async function slide(id, value) {
      await page.locator(`#${id}`).evaluate((element, value) => {
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await ready();
    }
    await slide('lineSpacing', 12);
    await slide('characterSpacing', 4);
    const spaced = await page.evaluate(() => {
      const state = window.GlyphStudio.getState();
      return { metric: state.metric, text: state.result.text, settings: state.settings, png: window.GlyphStudio.createExport('png'), ansi: window.GlyphStudio.createExport('ansi'), stored: JSON.parse(localStorage.getItem('glyph-settings')) };
    });
    assert.equal(spaced.metric.width, base.metric.width + (base.columns - 1) * 4);
    assert.equal(spaced.metric.height, base.metric.height + (base.rows - 1) * 12);
    assert.equal(spaced.metric.glyphWidth, base.metric.glyphWidth);
    assert.equal(spaced.text, base.text);
    assert.equal(spaced.ansi, base.ansi);
    assert.equal(await page.locator('#lineSpacing-out').textContent(), '12 px');
    assert.equal(await page.locator('#characterSpacing-out').textContent(), '4 px');
    const png = Buffer.from(spaced.png.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), spaced.metric.width);
    assert.equal(png.readUInt32BE(20), spaced.metric.height);
    passed.push('sliders change layout without stretching glyphs or changing TXT/ANSI', 'PNG matches preview dimensions');
    assert.equal(spaced.stored.lineSpacing, 12);
    assert.equal(spaced.stored.characterSpacing, 4);
    await page.reload();
    await ready();
    assert.deepEqual(await page.evaluate(() => { const { settings } = window.GlyphStudio.getState(); return [settings.lineSpacing, settings.characterSpacing]; }), [12, 4]);
    passed.push('spacing persists after reload');
    await slide('characterSpacing', 7);
    await page.click('#undo-btn'); await ready();
    assert.equal(await page.evaluate(() => window.GlyphStudio.getState().settings.characterSpacing), 4);
    await page.click('#redo-btn'); await ready();
    assert.equal(await page.evaluate(() => window.GlyphStudio.getState().settings.characterSpacing), 7);
    passed.push('spacing undo and redo');
    for (const mode of ['braille', 'edges', 'blocks', 'ascii']) {
      await page.click(`[data-mode=${mode}]`); await ready();
      assert.deepEqual(await page.evaluate(() => { const { metric } = window.GlyphStudio.getState(); return [metric.lineSpacing, metric.characterSpacing]; }), [12, 7]);
    }
    await page.click('[data-color=original]'); await ready();
    assert.ok((await page.evaluate(() => window.GlyphStudio.createExport('svg'))).includes('<svg'));
    passed.push('all modes and original color retain spacing');
    await page.setViewportSize({ width: 980, height: 700 });
    await page.locator('#characterSpacing').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    passed.push('spacing controls accessible at minimum window size');
    await page.setViewportSize({ width: 1400, height: 920 });
    await slide('lineSpacing', 6); await slide('characterSpacing', 2);
    await page.locator('#lineSpacing').scrollIntoViewIfNeeded();
    await fs.mkdir(path.join(projectRoot, 'qa-results'), { recursive: true });
    await page.screenshot({ path: path.join(projectRoot, 'qa-results/spacing-preview.png') });
    await page.click('#reset-btn'); await ready();
    assert.deepEqual(await page.evaluate(() => { const { settings } = window.GlyphStudio.getState(); return [settings.lineSpacing, settings.characterSpacing]; }), [0, 0]);
    passed.push('reset restores default spacing');
    await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem('glyph-settings')); delete saved.lineSpacing; delete saved.characterSpacing; localStorage.setItem('glyph-settings', JSON.stringify(saved)); });
    await page.reload(); await ready();
    assert.deepEqual(await page.evaluate(() => { const { settings } = window.GlyphStudio.getState(); return [settings.lineSpacing, settings.characterSpacing]; }), [0, 0]);
    passed.push('old settings migrate to zero spacing');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed, errors }, null, 2));
    await fs.writeFile(path.join(projectRoot, 'qa-results/spacing-smoke.json'), JSON.stringify({ passed, errors }, null, 2));
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
