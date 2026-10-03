(function (root) {
  'use strict';
  const palettes = {
    ivory: { name: '象牙白', foreground: '#e8decb', background: '#0c0f12' },
    amber: { name: '琥珀', foreground: '#f5b957', background: '#15110c' },
    green: { name: '终端绿', foreground: '#88cba1', background: '#0a1510' },
    blue: { name: '冰蓝', foreground: '#91c8de', background: '#0c131a' },
    paper: { name: '白纸黑字', foreground: '#242729', background: '#f2f2ee' }
  };
  function escapeMarkup(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function getPalette(settings) { return settings.color === 'original' ? { name: '原图色', foreground: '#e8decb', background: '#0c0f12' } : palettes[settings.palette] || palettes.ivory; }
  function colorAt(result, index, settings) {
    if (settings.color !== 'original') return getPalette(settings).foreground;
    const offset = index * 3;
    return `#${Array.from(result.colors.slice(offset, offset + 3)).map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }
  function metricValue(metric, key, fallback) {
    const value = metric && Number(metric[key]);
    return Number.isFinite(value) ? value : fallback;
  }
  function validateResult(result) {
    if (!result || !Number.isInteger(result.columns) || !Number.isInteger(result.rows) || result.columns < 1 || result.rows < 1 || result.characters.length !== result.columns * result.rows || result.colors.length !== result.columns * result.rows * 3) throw new Error('无效的字符结果。');
  }
  function formatSVG(result, settings, metric) {
    validateResult(result);
    const width = metricValue(metric, 'width', 0);
    const height = metricValue(metric, 'height', 0);
    const cellWidth = metricValue(metric, 'cellWidth', metricValue(metric, 'glyphWidth', 0) + metricValue(metric, 'characterSpacing', 0));
    const lineHeight = metricValue(metric, 'lineHeight', metricValue(metric, 'glyphWidth', 0) * 2 + metricValue(metric, 'lineSpacing', 0));
    const fontSize = metricValue(metric, 'fontSize', 0);
    const padding = metricValue(metric, 'padding', 0);
    const palette = getPalette(settings);
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>Glyph Studio 字符画</title><rect width="100%" height="100%" fill="${palette.background}"/><g font-family="Cascadia Mono,Consolas,DejaVu Sans Mono,monospace" font-size="${fontSize}" xml:space="preserve">`];
    for (let y = 0; y < result.rows; y++) {
      for (let x = 0; x < result.columns; x++) {
        const index = y * result.columns + x;
        const char = result.characters[index];
        if (settings.color === 'original' && (char === ' ' || char === '\u2800')) continue;
        parts.push(`<text x="${(padding + x * cellWidth).toFixed(3)}" y="${(padding + y * lineHeight + fontSize).toFixed(3)}" fill="${settings.color === 'original' ? colorAt(result, index, settings) : palette.foreground}">${escapeMarkup(char)}</text>`);
      }
    }
    parts.push('</g></svg>');
    return parts.join('');
  }
  function formatHTML(result, settings, metric, title) {
    validateResult(result);
    const palette = getPalette(settings);
    const lines = [];
    if (settings.color !== 'original') lines.push(escapeMarkup(result.text));
    else {
      for (let y = 0; y < result.rows; y++) {
        let line = '';
        let lastColor = '';
        for (let x = 0; x < result.columns; x++) {
          const index = y * result.columns + x;
          const color = colorAt(result, index, settings);
          if (color !== lastColor) { if (lastColor) line += '</span>'; line += `<span style="color:${color}">`; lastColor = color; }
          line += escapeMarkup(result.characters[index]);
        }
        if (lastColor) line += '</span>';
        lines.push(line);
      }
    }
    const font = metricValue(metric, 'fontSize', 0);
    const lineHeight = metricValue(metric, 'lineHeight', metricValue(metric, 'glyphWidth', 0) * 2 + metricValue(metric, 'lineSpacing', 0));
    const characterSpacing = metricValue(metric, 'characterSpacing', 0);
    return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeMarkup(title || 'Glyph Studio 字符画')}</title><style>body{margin:0;padding:32px;background:${palette.background};color:${palette.foreground};overflow:auto}pre{margin:0;font:${font}px/${lineHeight}px "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace;font-variant-ligatures:none;letter-spacing:${characterSpacing}px;white-space:pre;tab-size:1}</style></head><body><pre>${lines.join('\n')}</pre></body></html>`;
  }
  function formatANSI(result, settings) {
    validateResult(result);
    const background = getPalette(settings).background;
    const bg = [1, 3, 5].map(index => parseInt(background.slice(index, index + 2), 16));
    const lines = [];
    for (let y = 0; y < result.rows; y++) {
      let line = `\x1b[48;2;${bg.join(';')}m`;
      let lastColor = '';
      for (let x = 0; x < result.columns; x++) {
        const index = y * result.columns + x;
        const color = colorAt(result, index, settings);
        if (color !== lastColor) {
          const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
          line += `\x1b[38;2;${rgb.join(';')}m`;
          lastColor = color;
        }
        line += result.characters[index];
      }
      lines.push(`${line}\x1b[0m`);
    }
    return lines.join('\n');
  }
  const api = { palettes, escapeMarkup, getPalette, colorAt, formatSVG, formatHTML, formatANSI };
  root.GlyphExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
