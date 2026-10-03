const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatSVG, formatHTML, formatANSI, getPalette } = require('../src/export.js');
const sample = { columns: 5, rows: 1, text: '<&"\'>', characters: ['<', '&', '"', "'", '>'], colors: new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 100, 100, 100]) };
const metric = { width: 100, height: 60, cellWidth: 8, lineHeight: 16, fontSize: 14, padding: 16 };
const spaced = { columns: 2, rows: 2, text: 'AB\nCD', characters: ['A', 'B', 'C', 'D'], colors: new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]) };
const spacedMetric = { width: 100, height: 60, glyphWidth: 8, characterSpacing: 2, lineSpacing: 3, cellWidth: 10, lineHeight: 19, fontSize: 14, padding: 16 };
test('HTML and SVG escape custom glyphs and filename markup', () => {
  const html = formatHTML(sample, { color: 'mono' }, metric, '</title><script>oops</script>');
  assert.ok(html.includes('&lt;&amp;&quot;&#39;&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('default-src'));
  const svg = formatSVG(sample, { color: 'original' }, metric);
  assert.ok(svg.includes('&lt;'));
  assert.ok(!svg.includes('><&'));
  assert.ok(svg.includes('#ff0000'));
});
test('SVG keeps glyph widths stable and uses metric cell and line spacing', () => {
  for (const color of ['mono', 'original']) {
    const svg = formatSVG(spaced, { color }, spacedMetric);
    assert.ok(!svg.includes('textLength=') && !svg.includes('lengthAdjust='));
    assert.ok(svg.includes('x="16.000"') && svg.includes('x="26.000"'));
    assert.ok(svg.includes('y="30.000"') && svg.includes('y="49.000"'));
  }
});
test('HTML applies metric character and line spacing without changing copied text', () => {
  const mono = formatHTML(spaced, { color: 'mono' }, spacedMetric);
  const original = formatHTML(spaced, { color: 'original' }, spacedMetric);
  for (const html of [mono, original]) {
    assert.ok(html.includes('letter-spacing:2px'));
    assert.ok(html.includes('font:14px/19px'));
  }
  assert.ok(mono.includes('>AB\nCD</pre>'));
  assert.ok(original.includes('<span style="color:#ff0000">A</span>'));
  assert.ok(original.includes('</span><span'));
});
test('legacy metrics default export spacing to zero', () => {
  const html = formatHTML(sample, { color: 'mono' }, metric);
  assert.ok(html.includes('letter-spacing:0px'));
  const svg = formatSVG(sample, { color: 'mono' }, metric);
  assert.ok(!svg.includes('textLength=') && svg.includes('x="16.000"') && svg.includes('x="24.000"'));
});
test('ANSI truecolor is reset on every row and reflects mono palette', () => {
  const ansi = formatANSI(sample, { color: 'mono', palette: 'paper' });
  assert.ok(ansi.startsWith('\x1b[48;2;242;242;238m'));
  assert.ok(ansi.endsWith('\x1b[0m'));
  assert.ok(ansi.includes(sample.text));
  assert.equal(getPalette({ color: 'original', palette: 'paper' }).background, '#0c0f12');
});
test('exports reject malformed character grids', () => {
  assert.throws(() => formatHTML({ ...sample, columns: 9 }, {}, metric), /无效/);
});
