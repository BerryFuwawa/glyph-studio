const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const resultsDir = path.join(projectRoot, 'qa-results');
const PALETTE_IDS = ['ivory', 'amber', 'green', 'blue', 'paper'];
const MODES = ['ascii', 'braille', 'edges', 'blocks'];

function contentAspect(state) {
  const metric = state.metric;
  const source = state.source;
  const contentWidth = metric.width - metric.padding * 2;
  const contentHeight = metric.height - metric.padding * 2;
  const expectedHeight = contentWidth * source.height / source.width;
  return {
    contentWidth,
    contentHeight,
    expectedHeight,
    error: Math.abs(contentHeight - expectedHeight),
    tolerance: metric.lineHeight / 2 + 1,
    ratio: contentWidth / contentHeight,
    sourceRatio: source.width / source.height
  };
}

function ansiRows(ansi) {
  return ansi.split('\n').length;
}

function compactState(value) {
  return {
    settings: value.settings,
    source: value.source,
    result: {
      columns: value.result.columns,
      rows: value.result.rows,
      mode: value.result.mode,
      characters: value.result.characters
    },
    metric: value.metric
  };
}

(async () => {
  const application = await _electron.launch({
    executablePath: path.join(projectRoot, 'node_modules/electron/dist/electron.exe'),
    args: [projectRoot, '--desktop-qa'],
    cwd: projectRoot
  });
  const passed = [];
  const failed = [];
  const diagnostics = { palette: [], aspect: [], grids: [] };
  const pageErrors = [];

  async function check(name, callback) {
    try {
      await callback();
      passed.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ name, message });
      console.error(`FAIL ${name}: ${message}`);
    }
  }

  try {
    const page = await application.firstWindow();
    await fs.mkdir(resultsDir, { recursive: true });
    page.on('pageerror', error => pageErrors.push(error.message));

    const ready = () => page.waitForFunction(
      () => window.GlyphStudio?.getState().result && !document.getElementById('copy-btn').disabled,
      null,
      { timeout: 20000 }
    );
    const state = () => page.evaluate(() => {
      const current = window.GlyphStudio.getState();
      return {
        settings: current.settings,
        source: current.source,
        result: {
          columns: current.result.columns,
          rows: current.result.rows,
          text: current.result.text,
          mode: current.result.mode,
          characters: current.result.characters.length
        },
        metric: current.metric
      };
    });
    const waitForSource = name => page.waitForFunction(expected => window.GlyphStudio?.getState().source?.name === expected, name, { timeout: 20000 });
    async function slide(id, value) {
      await page.locator(`#${id}`).evaluate((element, nextValue) => {
        element.value = String(nextValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await ready();
    }
    async function setPreserveAspect(value) {
      await page.locator('#preserveAspect').evaluate((element, desired) => {
        if (element.checked !== desired) element.click();
      }, value);
      await ready();
    }
    async function setMode(mode) {
      await page.click(`[data-mode=${mode}]`);
      await ready();
    }
    async function reset() {
      await page.click('#reset-btn');
      await ready();
    }
    async function loadSynthetic(width, height, name) {
      await page.evaluate(async ({ width: imageWidth, height: imageHeight, name: imageName }) => {
        const canvas = document.createElement('canvas');
        canvas.width = imageWidth;
        canvas.height = imageHeight;
        const context = canvas.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, imageWidth, imageHeight);
        gradient.addColorStop(0, '#f4b655');
        gradient.addColorStop(0.5, '#305081');
        gradient.addColorStop(1, '#13171b');
        context.fillStyle = gradient;
        context.fillRect(0, 0, imageWidth, imageHeight);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const file = new File([blob], imageName, { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, { width, height, name });
      await waitForSource(name);
      await ready();
    }
    async function measurePalette() {
      return page.evaluate(() => {
        const row = document.getElementById('palette-row').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.palette-swatch')].map(element => {
          const button = element.getBoundingClientRect();
          const swatch = element.querySelector('.swatch').getBoundingClientRect();
          return {
            palette: element.dataset.palette,
            button: { x: button.x, y: button.y, width: button.width, height: button.height },
            swatch: { x: swatch.x, y: swatch.y, width: swatch.width, height: swatch.height },
            centerDelta: {
              x: swatch.x + swatch.width / 2 - (button.x + button.width / 2),
              y: swatch.y + swatch.height / 2 - (button.y + button.height / 2)
            }
          };
        });
        return { row: { x: row.x, y: row.y, width: row.width, height: row.height }, buttons };
      });
    }
    async function exportBundle() {
      return page.evaluate(() => ({
        txt: window.GlyphStudio.createExport('txt'),
        png: window.GlyphStudio.createExport('png'),
        svg: window.GlyphStudio.createExport('svg'),
        html: window.GlyphStudio.createExport('html'),
        ansi: window.GlyphStudio.createExport('ansi')
      }));
    }

    await page.evaluate(() => localStorage.removeItem('glyph-settings'));
    await page.reload();
    await ready();
    await reset();

    await check('preserve aspect checkbox defaults on', async () => {
      assert.equal(await page.locator('#preserveAspect').isChecked(), true);
      assert.equal((await state()).settings.preserveAspect, true);
    });

    await check('palette circles stay centered at every selection and window size', async () => {
      for (const viewport of [{ width: 980, height: 700 }, { width: 1400, height: 920 }]) {
        await page.setViewportSize(viewport);
        await page.click('[data-color=mono]');
        await ready();
        for (const palette of PALETTE_IDS) {
          await page.click(`[data-palette=${palette}]`);
          await ready();
          await page.locator('#palette-row').scrollIntoViewIfNeeded();
          const measured = await measurePalette();
          diagnostics.palette.push({ viewport, selected: palette, ...measured });
          assert.equal(measured.buttons.length, PALETTE_IDS.length);
          for (const button of measured.buttons) {
            assert.ok(Math.abs(button.button.width - 25) <= 0.01, `${palette}: button width ${button.button.width}`);
            assert.ok(Math.abs(button.button.height - 25) <= 0.01, `${palette}: button height ${button.button.height}`);
            assert.ok(Math.abs(button.swatch.width - 15) <= 0.01, `${palette}: circle width ${button.swatch.width}`);
            assert.ok(Math.abs(button.swatch.height - 15) <= 0.01, `${palette}: circle height ${button.swatch.height}`);
            assert.ok(Math.abs(button.centerDelta.x) <= 0.5, `${palette}: circle x offset ${button.centerDelta.x}`);
            assert.ok(Math.abs(button.centerDelta.y) <= 0.5, `${palette}: circle y offset ${button.centerDelta.y}`);
          }
        }
        await page.screenshot({ path: path.join(resultsDir, `palette-${viewport.width}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    });

    await page.setViewportSize({ width: 1400, height: 920 });
    await reset();
    const correctedBase = await state();
    diagnostics.grids.push({ label: 'corrected-base', state: compactState(correctedBase) });

    await check('line and character gaps adjust corrected row count', async () => {
      const baseRows = correctedBase.result.rows;
      const baseGlyph = correctedBase.metric.glyphWidth;
      await slide('lineSpacing', 12);
      const lineSpaced = await state();
      diagnostics.grids.push({ label: 'line-spacing-12', state: compactState(lineSpaced) });
      assert.ok(lineSpaced.result.rows < baseRows, `${lineSpaced.result.rows} is not below ${baseRows}`);
      assert.ok(Math.abs(lineSpaced.metric.glyphWidth - baseGlyph) <= 0.001, 'glyph width changed with line gap');
      await reset();
      await slide('characterSpacing', 8);
      const characterSpaced = await state();
      diagnostics.grids.push({ label: 'character-spacing-8', state: compactState(characterSpaced) });
      assert.ok(characterSpaced.result.rows > baseRows, `${characterSpaced.result.rows} is not above ${baseRows}`);
      assert.ok(Math.abs(characterSpaced.metric.glyphWidth - baseGlyph) <= 0.001, 'glyph width changed with character gap');
    });

    await reset();
    await slide('lineSpacing', 12);
    await slide('characterSpacing', 4);
    const corrected = await state();
    const correctedAspect = contentAspect(corrected);
    diagnostics.aspect.push({ label: 'corrected spacing', ...correctedAspect, result: compactState(corrected).result, metric: corrected.metric });

    await check('corrected grid keeps source content aspect and stable glyph size', async () => {
      assert.ok(correctedAspect.error <= correctedAspect.tolerance, `aspect error ${correctedAspect.error} > ${correctedAspect.tolerance}`);
      assert.equal(corrected.settings.preserveAspect, true);
      assert.ok(Math.abs(corrected.metric.glyphWidth - correctedBase.metric.glyphWidth) <= 0.001);
      assert.ok(Math.abs(corrected.metric.fontSize - correctedBase.metric.fontSize) <= 0.001);
      assert.ok(corrected.result.rows < correctedBase.result.rows);
    });

    await check('corrected TXT, ANSI and PNG exports follow the current grid', async () => {
      const bundle = await exportBundle();
      const png = Buffer.from(bundle.png.split(',')[1], 'base64');
      assert.equal(bundle.txt, corrected.result.text);
      assert.equal(ansiRows(bundle.ansi), corrected.result.rows);
      assert.equal(png.readUInt32BE(16), corrected.metric.width);
      assert.equal(png.readUInt32BE(20), corrected.metric.height);
      assert.ok(bundle.svg.startsWith('<svg'));
      assert.ok(bundle.html.includes(`letter-spacing:${corrected.metric.characterSpacing}px`));
      assert.ok(bundle.html.includes(`font:${corrected.metric.fontSize}px/${corrected.metric.lineHeight}px`));
    });

    await check('unchecked preserve aspect keeps the legacy fixed character grid', async () => {
      await reset();
      await setPreserveAspect(false);
      const legacyBase = await state();
      await slide('lineSpacing', 12);
      await slide('characterSpacing', 4);
      const legacySpaced = await state();
      diagnostics.grids.push({ label: 'legacy-spaced', state: compactState(legacySpaced) });
      assert.equal(legacySpaced.settings.preserveAspect, false);
      assert.equal(legacySpaced.result.columns, legacyBase.result.columns);
      assert.equal(legacySpaced.result.rows, legacyBase.result.rows);
      assert.equal(legacySpaced.result.text, legacyBase.result.text);
      assert.equal((await page.evaluate(() => window.GlyphStudio.createExport('txt'))), legacySpaced.result.text);
      assert.equal(ansiRows(await page.evaluate(() => window.GlyphStudio.createExport('ansi'))), legacySpaced.result.rows);
      assert.ok(Math.abs(legacySpaced.metric.glyphWidth - legacyBase.metric.glyphWidth) <= 0.001);
      assert.ok(Math.abs((legacySpaced.metric.width - legacyBase.metric.width) - (legacyBase.result.columns - 1) * 4) <= 1);
      assert.ok(Math.abs((legacySpaced.metric.height - legacyBase.metric.height) - (legacyBase.result.rows - 1) * 12) <= 1);
    });

    await check('portrait and landscape corrected grids work in all four modes', async () => {
      for (const image of [{ width: 160, height: 80, name: 'qa-landscape.png' }, { width: 80, height: 160, name: 'qa-portrait.png' }]) {
        await loadSynthetic(image.width, image.height, image.name);
        await setPreserveAspect(true);
        await slide('columns', 120);
        await slide('lineSpacing', 12);
        await slide('characterSpacing', 4);
        for (const mode of MODES) {
          await setMode(mode);
          const current = await state();
          const aspect = contentAspect(current);
          diagnostics.aspect.push({ label: `${image.name}/${mode}`, ...aspect, result: compactState(current).result, metric: current.metric });
          assert.equal(current.result.mode, mode);
          assert.equal(current.result.text.split('\n').length, current.result.rows);
          assert.ok(aspect.error <= aspect.tolerance, `${image.name}/${mode}: aspect error ${aspect.error} > ${aspect.tolerance}`);
          assert.equal(current.result.characters, current.result.columns * current.result.rows);
        }
      }
    });

    await check('corrected output honors the cell and character caps', async () => {
      await loadSynthetic(40, 1600, 'qa-cap-portrait.png');
      await setPreserveAspect(true);
      await setMode('ascii');
      await slide('columns', 280);
      await slide('lineSpacing', 12);
      await slide('characterSpacing', 12);
      const capped = await state();
      diagnostics.grids.push({ label: 'capped-portrait', state: compactState(capped) });
      assert.ok(capped.result.rows <= 600, `rows ${capped.result.rows} exceed cap`);
      assert.ok(capped.result.columns * capped.result.rows <= 180000, `cells ${capped.result.columns * capped.result.rows} exceed cap`);
      assert.ok(capped.result.columns < 280 || capped.result.rows === 600, 'cap did not constrain the requested grid');
    });

    await check('preserve aspect persists, supports undo/redo, reset and migration', async () => {
      await page.reload();
      await ready();
      await reset();
      assert.equal((await state()).settings.preserveAspect, true);
      await setPreserveAspect(false);
      assert.equal((await state()).settings.preserveAspect, false);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('glyph-settings')).preserveAspect), false);
      await page.reload();
      await ready();
      assert.equal((await state()).settings.preserveAspect, false);
      await setPreserveAspect(true);
      await page.click('#undo-btn');
      await ready();
      assert.equal((await state()).settings.preserveAspect, false);
      await page.click('#redo-btn');
      await ready();
      assert.equal((await state()).settings.preserveAspect, true);
      await page.click('#reset-btn');
      await ready();
      const resetState = await state();
      assert.equal(resetState.settings.preserveAspect, true);
      assert.equal(resetState.settings.lineSpacing, 0);
      assert.equal(resetState.settings.characterSpacing, 0);
      await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('glyph-settings'));
        delete saved.preserveAspect;
        localStorage.setItem('glyph-settings', JSON.stringify(saved));
      });
      await page.reload();
      await ready();
      assert.equal((await state()).settings.preserveAspect, true);
      assert.equal(await page.locator('#preserveAspect').isChecked(), true);
    });

    await check('final preview leaves the built-in example in the requested review state', async () => {
      await page.setViewportSize({ width: 1400, height: 920 });
      await setMode('ascii');
      await page.click('[data-color=mono]');
      await ready();
      await page.click('[data-palette=ivory]');
      await ready();
      await setPreserveAspect(true);
      await slide('lineSpacing', 8);
      await slide('characterSpacing', 3);
      await page.locator('#palette-row').scrollIntoViewIfNeeded();
      const reviewState = await state();
      assert.equal(reviewState.source.name, '石膏像 · 内置示例');
      assert.equal(reviewState.settings.mode, 'ascii');
      assert.equal(reviewState.settings.color, 'mono');
      assert.equal(reviewState.settings.palette, 'ivory');
      assert.equal(reviewState.settings.preserveAspect, true);
      assert.equal(reviewState.settings.lineSpacing, 8);
      assert.equal(reviewState.settings.characterSpacing, 3);
      await page.screenshot({ path: path.join(resultsDir, 'spacing-preview.png') });
      await reset();
      const cleanState = await state();
      assert.equal(cleanState.settings.mode, 'ascii');
      assert.equal(cleanState.settings.color, 'mono');
      assert.equal(cleanState.settings.palette, 'ivory');
      assert.equal(cleanState.settings.preserveAspect, true);
      assert.equal(cleanState.settings.lineSpacing, 0);
      assert.equal(cleanState.settings.characterSpacing, 0);
    });

    if (pageErrors.length) failed.push({ name: 'renderer page errors', message: pageErrors.join('; ') });
    const report = { passed, failed, errors: pageErrors, diagnostics };
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, 'spacing-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (failed.length) throw new Error(`${failed.length} spacing QA check(s) failed`);
  } finally {
    await application.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
