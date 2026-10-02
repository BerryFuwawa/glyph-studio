(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const defaults = { mode: 'ascii', columns: 120, brightness: 0, contrast: 1, gamma: 1, threshold: 0.5, autoContrast: true, dither: false, invert: false, ramp: ' .:-=+*#%@', color: 'mono', palette: 'ivory' };
  const modeNames = { ascii: ['经典 ASCII', 'ASCII', '10 级明暗'], braille: ['盲文点阵', 'BRAILLE', '每格 8 个点'], edges: ['轮廓线稿', 'CONTOUR', '方向边缘'], blocks: ['像素方块', 'BLOCKS', '5 级像素'] };
  let settings = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem('glyph-settings') || 'null');
    if (saved && ['ascii', 'braille', 'edges', 'blocks'].includes(saved.mode) && GlyphExport.palettes[saved.palette] && ['mono', 'original'].includes(saved.color)) {
      for (const key of Object.keys(defaults)) if (typeof saved[key] === typeof defaults[key]) settings[key] = saved[key];
      settings.columns = Math.max(40, Math.min(280, settings.columns));
      settings.brightness = Math.max(-80, Math.min(80, settings.brightness));
      settings.contrast = Math.max(0.5, Math.min(2.5, settings.contrast));
      settings.gamma = Math.max(0.4, Math.min(2.4, settings.gamma));
      settings.threshold = Math.max(0.1, Math.min(0.9, settings.threshold));
      AsciiCore.convert({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) }, { ramp: settings.ramp });
    }
  } catch { settings = { ...defaults }; }
  let result = null;
  let renderedSettings = { ...settings };
  let source = null;
  let sourceURL = null;
  let loadSequence = 0;
  let view = 'compare';
  let heldView = null;
  let zoom = 'fit';
  let metric = null;
  let toastTimer;
  let renderTimer;
  let requestSequence = 0;
  let latestRequest = 0;
  let busy = false;
  let pendingJob = null;
  let history = [JSON.stringify(settings)];
  let historyIndex = 0;
  const jobSettings = new Map();
  let sourcePixels = null;
  let workerRecoveries = 0;
  let workerBroken = false;
  let worker = createWorker();
  const resultWaiters = new Set();
  const initialReady = loadDemo(false);

  function notify(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 5000 : 2600);
  }
  function setStatus(message) { $('status-text').textContent = message; }
  function persist() { try { localStorage.setItem('glyph-settings', JSON.stringify(settings)); } catch { /* Storage is optional. */ } }
  function commitHistory() {
    const snapshot = JSON.stringify(settings);
    if (history[historyIndex] === snapshot) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot);
    if (history.length > 60) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
    persist();
  }
  function updateHistoryButtons() { $('undo-btn').disabled = historyIndex <= 0; $('redo-btn').disabled = historyIndex >= history.length - 1; }
  function travelHistory(delta) {
    const target = historyIndex + delta;
    if (target < 0 || target >= history.length) return;
    historyIndex = target;
    settings = JSON.parse(history[historyIndex]);
    updateControls();
    updateHistoryButtons();
    persist();
    scheduleRender(0);
  }
  function setSettings(patch, commit = true) {
    settings = { ...settings, ...patch };
    updateControls();
    if (commit) commitHistory();
    scheduleRender(0);
  }
  function updateControls() {
    for (const id of ['columns', 'brightness', 'contrast', 'gamma', 'threshold']) {
      $(id).value = settings[id];
      updateRange(id);
    }
    $('auto-contrast').checked = settings.autoContrast;
    $('dither').checked = settings.dither;
    $('invert').checked = settings.invert;
    $('ramp').value = settings.ramp;
    document.querySelectorAll('[data-mode]').forEach(button => { const selected = button.dataset.mode === settings.mode; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
    document.querySelectorAll('[data-color]').forEach(button => { const selected = button.dataset.color === settings.color; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
    document.querySelectorAll('[data-palette]').forEach(button => { const selected = button.dataset.palette === settings.palette; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); button.disabled = settings.color === 'original'; });
    $('palette-row').classList.toggle('muted', settings.color === 'original');
    $('palette-name').textContent = GlyphExport.palettes[settings.palette].name;
    $('style-label').textContent = settings.mode === 'ascii' ? `${Array.from(settings.ramp).length} 级明暗` : modeNames[settings.mode][2];
    $('ramp-control').hidden = settings.mode !== 'ascii';
    $('threshold-control').hidden = !['braille', 'edges'].includes(settings.mode);
    document.querySelector('label[for=threshold]').textContent = settings.mode === 'edges' ? '轮廓阈值' : '点阵阈值';
    $('dither').disabled = ['edges', 'blocks'].includes(settings.mode);
    $('dither').closest('label').style.opacity = $('dither').disabled ? '0.45' : '1';
  }
  function updateRange(id) {
    const input = $(id);
    const value = Number(input.value);
    input.style.setProperty('--fill', `${(value - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
    $(`${id}-out`).textContent = ['contrast', 'gamma', 'threshold'].includes(id) ? value.toFixed(2) : id === 'brightness' && value > 0 ? `+${value}` : String(value);
  }
  function validateRamp() {
    if (settings.mode !== 'ascii') { $('ramp-error').hidden = true; $('ramp').classList.remove('invalid'); return true; }
    try {
      if (!settings.ramp.length) throw new Error('empty');
      AsciiCore.convert({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) }, { ramp: settings.ramp, columns: 24 });
      $('ramp-error').hidden = true;
      $('ramp').classList.remove('invalid');
      return true;
    } catch {
      $('ramp-error').textContent = settings.ramp.length ? '请使用单格字符，不能包含汉字、表情、换行或组合字符。' : '至少输入一个字符，空格也可以。';
      $('ramp-error').hidden = false;
      $('ramp').classList.add('invalid');
      return false;
    }
  }
  function setExportEnabled(enabled) { for (const id of ['export-btn', 'copy-btn']) $(id).disabled = !enabled; }
  function scheduleRender(delay = 80) {
    clearTimeout(renderTimer);
    latestRequest = ++requestSequence;
    setExportEnabled(false);
    if (!source || !validateRamp()) { $('processing').hidden = true; pendingJob = null; return; }
    $('processing-label').textContent = '正在生成字符画…';
    $('processing').hidden = false;
    setStatus('正在生成字符画');
    const snapshot = { ...settings };
    const id = latestRequest;
    renderTimer = setTimeout(() => {
      const paper = snapshot.color === 'mono' && snapshot.palette === 'paper';
      const options = { ...snapshot, charAspect: 0.5, invert: snapshot.invert !== paper, background: paper ? [242, 242, 238] : [12, 15, 18] };
      if (snapshot.mode !== 'ascii') delete options.ramp;
      pendingJob = { type: 'convert', id, options };
      jobSettings.set(id, snapshot);
      flushJob();
    }, delay);
  }
  function flushJob() {
    if (busy || !pendingJob) return;
    busy = true;
    const job = pendingJob;
    pendingJob = null;
    worker.postMessage(job);
  }
  function handleWorkerMessage(event) {
    busy = false;
    const data = event.data;
    const snapshot = jobSettings.get(data.id);
    jobSettings.delete(data.id);
    if (data.id === latestRequest) {
      $('processing').hidden = true;
      if (data.error) { notify(`转换失败：${data.error}`, true); setStatus('转换失败，请调整参数或更换图片'); }
      else {
        result = data.result;
        renderedSettings = snapshot;
        drawResult();
        $('result-size').textContent = `${result.columns} × ${result.rows}`;
        $('result-mode-label').textContent = modeNames[result.mode][1];
        $('character-strip').textContent = result.mode === 'ascii' ? snapshot.ramp : result.mode === 'braille' ? '⠁⠃⠇⠏⠟⠿⡿⣿' : result.mode === 'blocks' ? ' ░▒▓█' : ' / | \\ -';
        $('render-stats').textContent = `${(result.columns * result.rows).toLocaleString()} 字符 / ${Math.round(data.elapsed)} ms`;
        setStatus(`已就绪 · ${source.name}${result.columns !== snapshot.columns ? ' · 已按长图比例调整字符宽度' : ''}`);
        setExportEnabled(true);
        resultWaiters.forEach(waiter => waiter());
        resultWaiters.clear();
      }
    }
    for (const id of jobSettings.keys()) if (id < latestRequest && (!pendingJob || id !== pendingJob.id)) jobSettings.delete(id);
    flushJob();
  }
  function handleWorkerError(event) {
    event.preventDefault();
    busy = false;
    pendingJob = null;
    jobSettings.clear();
    worker.terminate();
    if (sourcePixels && workerRecoveries < 1) {
      workerRecoveries++;
      worker = createWorker();
      worker.postMessage({ type: 'image', pixels: sourcePixels });
      scheduleRender(0);
      return;
    }
    workerBroken = true;
    $('processing').hidden = true;
    setStatus('转换失败，可重新导入图片重试');
    notify('转换未完成，请重新导入图片重试。', true);
    console.error(event.message);
  }
  function createWorker() {
    const next = new Worker('worker.js');
    next.onmessage = handleWorkerMessage;
    next.onerror = handleWorkerError;
    return next;
  }

  async function loadDemo(showToast = true) {
    try {
      await loadImage('assets/sculpture.png', '石膏像 · 内置示例', { demo: true });
      if (showToast) notify('已恢复示例图片');
    } catch (error) { notify(error.message, true); setStatus('图片加载失败，可打开自己的图片'); }
  }
  async function loadImage(url, name, metadata = {}) {
    const sequence = ++loadSequence;
    latestRequest = ++requestSequence;
    clearTimeout(renderTimer);
    pendingJob = null;
    const previousURL = sourceURL;
    $('processing-label').textContent = '正在读取图片…';
    $('processing').hidden = false;
    setExportEnabled(false);
    setStatus(`正在读取 ${name}`);
    let bitmap;
    try {
      if (metadata.file) {
        await inspectBeforeDecode(metadata.file);
        bitmap = await createImageBitmap(metadata.file, { imageOrientation: 'from-image' });
      } else if (metadata.dataURL) {
        const encoded = metadata.dataURL.split(',')[1];
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        const mime = metadata.dataURL.slice(5, metadata.dataURL.indexOf(';'));
        const blob = new Blob([bytes], { type: mime });
        await inspectBeforeDecode(blob);
        bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } else {
        const img = new Image();
        img.src = url;
        await img.decode();
        bitmap = await createImageBitmap(img, { imageOrientation: 'from-image' });
      }
      if (sequence !== loadSequence) { bitmap.close(); if (url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
      if (bitmap.width * bitmap.height > 40000000 || bitmap.width > 20000 || bitmap.height > 20000) throw new Error('图片尺寸过大，请先缩小到 4000 万像素、最长边 20000 像素以内。');
      const originalWidth = bitmap.width;
      const originalHeight = bitmap.height;
      const scale = Math.min(1, 1600 / originalWidth, 1600 / originalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(originalWidth * scale));
      canvas.height = Math.max(1, Math.round(originalHeight * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Freeze the first frame, including animated GIF/WebP input, for both sides.
      const frozenURL = canvas.toDataURL('image/png');
      source = { name, width: originalWidth, height: originalHeight, demo: metadata.demo === true, scaled: scale < 1 };
      sourceURL = frozenURL;
      $('original-image').src = frozenURL;
      $('source-thumb').src = frozenURL;
      $('source-name').textContent = name;
      $('source-card').title = `${name} · 点击更换图片`;
      $('source-dimensions').textContent = `${originalWidth} × ${originalHeight}`;
      sourcePixels = { width: pixels.width, height: pixels.height, data: pixels.data };
      if (workerBroken) { worker = createWorker(); workerBroken = false; }
      workerRecoveries = 0;
      worker.postMessage({ type: 'image', pixels: sourcePixels });
      zoom = 'fit';
      updateZoom();
      scheduleRender(0);
      if (previousURL?.startsWith('blob:')) URL.revokeObjectURL(previousURL);
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    } catch (error) {
      bitmap?.close();
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      if (sequence !== loadSequence) return;
      $('processing').hidden = true;
      setExportEnabled(false);
      setStatus(source ? `已就绪 · ${source.name}` : '请打开一张图片');
      if (source) scheduleRender(0);
      throw new Error(error.message === 'The source image could not be decoded.' ? '无法读取这张图片，请确认文件没有损坏。' : error.message);
    }
  }
  async function inspectBeforeDecode(blob) {
    const prefix = new Uint8Array(await blob.slice(0, 2 * 1024 * 1024).arrayBuffer());
    const info = GlyphImageInfo.inspect(prefix);
    if (info && (info.width * info.height > 40000000 || info.width > 20000 || info.height > 20000)) throw new Error('图片尺寸过大，请先缩小到 4000 万像素、最长边 20000 像素以内。');
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { notify('图片不能超过 50 MB。', true); return; }
    if (!/\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(file.name) && !/^image\/(png|jpeg|webp|bmp|gif|avif)$/.test(file.type)) { notify('请选择 PNG、JPG、WebP、BMP、GIF 或 AVIF 图片。', true); return; }
    const url = URL.createObjectURL(file);
    try { await loadImage(url, file.name, { file }); }
    catch (error) { notify(error.message, true); }
  }
  async function openImage() {
    try {
      if (!window.desktop) { $('file-input').click(); return; }
      const imported = await desktop.openImage();
      if (imported) await loadImage(imported.dataURL, imported.name, { dataURL: imported.dataURL });
    } catch (error) { notify(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true); }
  }
  async function pasteImage() {
    if (!window.desktop) { notify('请通过 Ctrl V 或拖拽导入图片。'); return; }
    try {
      const imported = await desktop.pasteImage();
      if (!imported) { notify('剪贴板中没有图片。先复制一张图片，再粘贴。'); return; }
      if (imported.size > 50 * 1024 * 1024) throw new Error('剪贴板图片不能超过 50 MB。');
      await loadImage(imported.dataURL, imported.name, { dataURL: imported.dataURL });
    } catch (error) { notify(error.message, true); }
  }

  function calculateMetrics(output, fontSize = 14, padding = 28) {
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${fontSize}px "Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace`;
    let cellWidth = measure.measureText('M').width;
    let lineHeight = cellWidth * 2;
    let width = Math.ceil(output.columns * cellWidth + padding * 2);
    let height = Math.ceil(output.rows * lineHeight + padding * 2);
    const limitScale = Math.min(1, 8192 / Math.max(width, height), Math.sqrt(18000000 / (width * height)));
    if (limitScale < 1) { fontSize *= limitScale; padding *= limitScale; cellWidth *= limitScale; lineHeight *= limitScale; width = Math.ceil(width * limitScale); height = Math.ceil(height * limitScale); }
    return { fontSize, cellWidth, lineHeight, width, height, padding };
  }
  function paintCanvas(canvas, output, snapshot, metrics) {
    const palette = GlyphExport.getPalette(snapshot);
    canvas.width = metrics.width;
    canvas.height = metrics.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${metrics.fontSize}px "Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = palette.foreground;
    for (let y = 0; y < output.rows; y++) {
      const baseline = metrics.padding + y * metrics.lineHeight + metrics.fontSize;
      for (let x = 0; x < output.columns; x++) {
        const index = y * output.columns + x;
        const character = output.characters[index];
        if (character === ' ' || character === '\u2800') continue;
        if (snapshot.color === 'original') ctx.fillStyle = GlyphExport.colorAt(output, index, snapshot);
        ctx.fillText(character, metrics.padding + x * metrics.cellWidth, baseline, metrics.cellWidth * 1.02);
      }
    }
  }
  function drawResult() {
    if (!result) return;
    metric = calculateMetrics(result);
    paintCanvas($('art-canvas'), result, renderedSettings, metric);
    updateZoom();
  }
  function setView(next) {
    if (!['compare', 'result', 'source'].includes(next)) return;
    view = next;
    $('stage').dataset.view = next;
    document.querySelectorAll('[data-view]').forEach(button => {
      if (button.tagName !== 'BUTTON') return;
      const selected = button.dataset.view === next;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }
  function updateZoom() {
    const stage = $('stage');
    stage.dataset.zoom = zoom === 'fit' ? 'fit' : 'manual';
    $('zoom-label').textContent = zoom === 'fit' ? '适应' : `${Math.round(zoom * 100)}%`;
    $('zoom-fit').classList.toggle('active', zoom === 'fit');
    if (metric) {
      stage.style.setProperty('--art-width', `${Math.round(metric.width * (zoom === 'fit' ? 1 : zoom))}px`);
      stage.style.setProperty('--art-height', `${Math.round(metric.height * (zoom === 'fit' ? 1 : zoom))}px`);
    }
  }
  function adjustZoom(direction) {
    if (!metric) return;
    if (zoom === 'fit') {
      const availableWidth = view === 'compare' ? ($('stage').clientWidth - 72) / 2 : $('stage').clientWidth - 70;
      const availableHeight = $('stage').clientHeight - 90;
      zoom = Math.min(availableWidth / metric.width, availableHeight / metric.height);
    }
    zoom = Math.max(0.15, Math.min(3, zoom * (direction > 0 ? 1.25 : 0.8)));
    updateZoom();
  }
  function currentReady() { return Boolean(result) && !$('copy-btn').disabled; }
  async function copyText() {
    if (!currentReady()) return;
    try {
      if (window.desktop) await desktop.copyText(result.text);
      else await navigator.clipboard.writeText(result.text);
      notify(`已复制 ${result.columns} 列 × ${result.rows} 行字符`);
    } catch { notify('复制失败，请导出 TXT 文件。', true); }
  }
  function openExport() {
    if (!currentReady()) return;
    $('export-thumb').src = $('art-canvas').toDataURL('image/png');
    $('export-title').textContent = source.name.replace(/\.[^.]+$/, '') + ' · 字符画';
    $('export-dimensions').textContent = `${result.columns} 列 × ${result.rows} 行 / ${modeNames[result.mode][0]} / ${GlyphExport.getPalette(renderedSettings).name}`;
    $('export-dialog').showModal();
  }
  function createExport(format) {
    if (!result) throw new Error('还没有可导出的字符画。');
    if (format === 'txt') return result.text;
    if (format === 'png') return $('art-canvas').toDataURL('image/png');
    if (format === 'svg') return GlyphExport.formatSVG(result, renderedSettings, metric);
    if (format === 'html') return GlyphExport.formatHTML(result, renderedSettings, metric, `${source.name} · 字符画`);
    if (format === 'ansi') return GlyphExport.formatANSI(result, renderedSettings);
    throw new Error('未知的导出格式。');
  }
  function updateExportOptions() {
    const format = document.querySelector('input[name=export-format]:checked').value;
    document.querySelectorAll('.export-option').forEach(label => label.classList.toggle('selected', label.querySelector('input').checked));
    const notes = { txt: '纯文本保存字符和换行，不包含颜色。请用等宽字体查看。', png: `图片大小 ${metric.width} × ${metric.height} 像素，保留当前背景与配色。`, svg: '保留矢量文字和颜色。另一台设备的字体不同，字形可能略有差别。', html: '独立 HTML 文件，无需网络。颜色、字符与换行都会保留。', ansi: '含 ANSI 真彩色控制码。请在支持 UTF-8 和真彩色的终端查看。' };
    $('export-note').textContent = notes[format];
  }
  async function saveOutput() {
    const format = document.querySelector('input[name=export-format]:checked').value;
    $('save-btn').disabled = true;
    try {
      const content = createExport(format);
      const name = `${source.name.replace(/\.[^.]+$/, '')}-glyph`;
      if (window.desktop) {
        const saved = await desktop.saveOutput({ format, name, content });
        if (saved) { $('export-dialog').close(); notify(`已保存 ${saved.name}`); }
      } else {
        const blob = format === 'png' ? await (await fetch(content)).blob() : new Blob([content], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${name}.${format}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 500);
        $('export-dialog').close();
        notify('作品已导出');
      }
    } catch (error) { notify(`保存失败：${error.message}`, true); }
    finally { $('save-btn').disabled = false; }
  }
  async function copyImage() {
    try {
      if (!window.desktop) throw new Error('请保存 PNG 文件。');
      await desktop.copyImage(createExport('png'));
      notify('已复制图片，可直接粘贴到聊天或文档');
    } catch (error) { notify(error.message, true); }
  }

  for (const id of ['columns', 'brightness', 'contrast', 'gamma', 'threshold']) {
    $(id).addEventListener('input', () => { settings[id] = Number($(id).value); updateRange(id); scheduleRender(); });
    $(id).addEventListener('change', commitHistory);
  }
  for (const [id, key] of [['auto-contrast', 'autoContrast'], ['dither', 'dither'], ['invert', 'invert']]) $(id).addEventListener('change', () => setSettings({ [key]: $(id).checked }));
  $('ramp').addEventListener('input', () => { settings.ramp = $('ramp').value; $('style-label').textContent = `${Array.from(settings.ramp).length} 级明暗`; scheduleRender(140); });
  $('ramp').addEventListener('change', () => { if (validateRamp()) commitHistory(); });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setSettings({ mode: button.dataset.mode, threshold: button.dataset.mode === 'edges' ? 0.18 : 0.5 })));
  document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => setSettings({ color: button.dataset.color })));
  document.querySelectorAll('[data-palette]').forEach(button => button.addEventListener('click', () => setSettings({ palette: button.dataset.palette })));
  document.querySelectorAll('button[data-view]').forEach(button => {
    button.addEventListener('click', () => setView(button.dataset.view));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const views = ['compare', 'result', 'source'];
      const next = views[(views.indexOf(view) + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
      setView(next); $(`view-${next}`).focus();
    });
  });
  $('open-btn').onclick = openImage;
  $('source-card').onclick = openImage;
  $('paste-btn').onclick = pasteImage;
  $('demo-btn').onclick = () => loadDemo();
  $('reset-btn').onclick = () => { setSettings({ ...defaults }); notify('已重置全部参数'); };
  $('undo-btn').onclick = () => travelHistory(-1);
  $('redo-btn').onclick = () => travelHistory(1);
  $('copy-btn').onclick = copyText;
  $('export-btn').onclick = () => { openExport(); if ($('export-dialog').open) updateExportOptions(); };
  $('save-btn').onclick = saveOutput;
  $('copy-image-btn').onclick = copyImage;
  $('help-btn').onclick = () => $('help-dialog').showModal();
  $('help-done').onclick = () => $('help-dialog').close();
  $('zoom-fit').onclick = () => { zoom = 'fit'; updateZoom(); };
  $('zoom-in').onclick = () => adjustZoom(1);
  $('zoom-out').onclick = () => adjustZoom(-1);
  $('zoom-label').onclick = () => { zoom = zoom === 1 ? 'fit' : 1; updateZoom(); };
  $('file-input').onchange = () => { importFile($('file-input').files[0]); $('file-input').value = ''; };
  ['minimize', 'maximize'].forEach(action => $(action).onclick = () => window.desktop?.windowControl(action));
  $('close-window').onclick = () => window.desktop?.windowControl('close');
  window.desktop?.onWindowState(maximized => $('maximize').setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口'));
  document.querySelectorAll('.modal-close').forEach(button => button.onclick = () => button.closest('dialog').close());
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
  document.querySelectorAll('input[name=export-format]').forEach(input => input.addEventListener('change', updateExportOptions));

  let dragDepth = 0;
  document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } });
  document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
  document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; const files = Array.from(event.dataTransfer?.files || []); if (!files.length) return; if (files.length > 1) notify('一次处理一张图片，已打开第一张。'); importFile(files[0]); });
  document.addEventListener('paste', event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    if (window.desktop) pasteImage();
    else { const item = Array.from(event.clipboardData?.items || []).find(item => item.type.startsWith('image/')); if (item) importFile(item.getAsFile()); }
  });
  $('stage').addEventListener('wheel', event => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) return;
    event.preventDefault(); adjustZoom(event.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  document.addEventListener('keydown', event => {
    const editing = (event.target instanceof HTMLInputElement && ['text', 'number', 'search', 'password', 'email', 'url'].includes(event.target.type)) || event.target instanceof HTMLTextAreaElement;
    const dialogOpen = Boolean(document.querySelector('dialog[open]'));
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'F1') { event.preventDefault(); if (!dialogOpen) $('help-dialog').showModal(); return; }
    if (editing || dialogOpen) return;
    if (mod) {
      const key = event.key.toLowerCase();
      if (key === 'o') { event.preventDefault(); openImage(); }
      if (key === 'v') { event.preventDefault(); pasteImage(); }
      if (key === 'c') { event.preventDefault(); copyText(); }
      if (key === 's') { event.preventDefault(); openExport(); if ($('export-dialog').open) updateExportOptions(); }
      if (key === 'z') { event.preventDefault(); travelHistory(event.shiftKey ? 1 : -1); }
      if (key === 'y') { event.preventDefault(); travelHistory(1); }
      if (key === '0') { event.preventDefault(); zoom = 'fit'; updateZoom(); }
      if (key === '+' || key === '=') { event.preventDefault(); adjustZoom(1); }
      if (key === '-') { event.preventDefault(); adjustZoom(-1); }
    } else if (event.code === 'Space' && !event.repeat) {
      if (['BUTTON', 'SUMMARY'].includes(event.target.tagName)) return;
      event.preventDefault(); heldView = view; setView('source');
    }
  });
  function releaseHeldView() { if (heldView) { setView(heldView); heldView = null; } }
  document.addEventListener('keyup', event => { if (event.code === 'Space') releaseHeldView(); });
  window.addEventListener('blur', releaseHeldView);
  updateControls();
  setView('compare');

  function waitForResult(timeout = 12000) {
    if (currentReady()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const complete = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { resultWaiters.delete(complete); reject(new Error('等待转换超时')); }, timeout);
      resultWaiters.add(complete);
    });
  }
  async function runSmokeTests() {
    const passed = [];
    const failed = [];
    const check = (name, value) => (value ? passed : failed).push(name);
    await initialReady;
    await waitForResult();
    check('demo decodes locally', source?.width > 0 && source.height > 0);
    check('initial conversion contains a fixed-width grid', result.text.split('\n').every(row => row.length === result.columns));
    for (const mode of ['ascii', 'braille', 'edges', 'blocks']) {
      setSettings({ ...defaults, mode, threshold: mode === 'edges' ? 0.18 : 0.5 });
      await waitForResult();
      check(`${mode} output and canvas`, result.mode === mode && result.characters.length === result.columns * result.rows && $('art-canvas').width > 0);
    }
    setSettings({ ...defaults, color: 'original' });
    await waitForResult();
    for (const format of ['txt', 'png', 'svg', 'html', 'ansi']) {
      const content = createExport(format);
      check(`${format} export`, typeof content === 'string' && content.length > 100 && (format !== 'png' || content.startsWith('data:image/png;base64,')));
    }
    check('custom markup escaped in HTML', !GlyphExport.formatHTML({ columns: 1, rows: 1, characters: ['<'], text: '<', colors: new Uint8ClampedArray([10, 20, 30]) }, defaults, metric, '<script>x</script>').includes('<script>'));
    // Exercise actual drop event and file decoding, including alpha and UTF-8 name.
    const small = document.createElement('canvas'); small.width = 96; small.height = 48;
    const ctx = small.getContext('2d'); ctx.fillStyle = '#f4b655'; ctx.fillRect(0, 0, 48, 48); ctx.fillStyle = '#305081'; ctx.fillRect(48, 0, 48, 48);
    const blob = await new Promise(resolve => small.toBlob(resolve));
    const file = new File([blob], '拖拽验证.png', { type: 'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(file);
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 250));
    await waitForResult();
    check('drag drop opens image with Unicode filename', source.name === '拖拽验证.png' && source.width === 96 && source.height === 48);
    check('landscape aspect correction', result.rows === Math.round(result.columns * 0.25));
    setSettings({ brightness: 23 }); await waitForResult();
    travelHistory(-1); await waitForResult();
    check('parameter undo', settings.brightness === 0);
    travelHistory(1); await waitForResult();
    check('parameter redo', settings.brightness === 23);
    settings.ramp = ''; scheduleRender(0);
    check('invalid ramp disables export with inline feedback', !validateRamp() && $('copy-btn').disabled && !$('ramp-error').hidden);
    setSettings({ ...defaults, palette: 'paper' }); await waitForResult();
    check('paper palette sets light background', GlyphExport.getPalette(renderedSettings).background === '#f2f2ee');
    setView('result'); zoom = 1; updateZoom();
    check('zoom and single view', $('stage').dataset.zoom === 'manual' && $('stage').dataset.view === 'result');
    setSettings({ ...defaults }); await loadDemo(false); await waitForResult();
    zoom = 'fit'; updateZoom(); setView('compare');
    history = [JSON.stringify(settings)]; historyIndex = 0; updateHistoryButtons();
    check('desktop bridge available', Boolean(window.desktop?.openImage && window.desktop?.saveOutput));
    return { passed, failed, source, result: { columns: result.columns, rows: result.rows, characters: result.characters.length }, metric };
  }
  window.GlyphStudio = { runSmokeTests, setView, waitForResult, getState: () => ({ settings: { ...settings }, source, result, metric, view, zoom }), createExport, importFile, setSettings };
})();
