const test = require('node:test');
const assert = require('node:assert/strict');
const AsciiCore = require('./core.js');

function image(width, height, pixels) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const pixel = (pixels && pixels[i]) || [0, 0, 0, 255];
    data.set(pixel, i * 4);
  }
  return { width, height, data };
}

test('maps a dark to bright row through a custom density ramp', () => {
  const result = AsciiCore.convert(
    image(4, 1, [
      [0, 0, 0, 255],
      [85, 85, 85, 255],
      [170, 170, 170, 255],
      [255, 255, 255, 255]
    ]),
    { columns: 4, charAspect: 0.05, ramp: ' .#', autoContrast: false }
  );
  assert.equal(result.columns, 24);
  assert.equal(result.rows, 1);
  assert.equal(result.text.length, 24);
  assert.equal(result.text.slice(0, 6), '      ');
  assert.match(result.text, /\.{6,}/);
  assert.equal(result.colors.length, 72);
});

test('places braille dots using the standard 2 by 4 bit mapping', () => {
  const pixels = new Array(48 * 4).fill(null).map(() => [0, 0, 0, 255]);
  function setPixel(x, y) {
    pixels[y * 48 + x] = [255, 255, 255, 255];
  }
  setPixel(0, 0); // dot 1
  setPixel(1, 0); // dot 4
  setPixel(0, 1); // dot 2
  setPixel(0, 2); // dot 3
  setPixel(1, 2); // dot 6
  setPixel(0, 3); // dot 7
  setPixel(1, 3); // dot 8
  const result = AsciiCore.convert(image(48, 4, pixels), {
    columns: 24,
    charAspect: 0.5,
    mode: 'braille',
    autoContrast: false
  });
  assert.equal(result.columns, 24);
  assert.equal(result.rows, 1);
  assert.equal(result.characters[0], String.fromCharCode(0x2800 + 0xef));
});

test('composites alpha against the requested background before color output', () => {
  const result = AsciiCore.convert(
    image(1, 1, [[255, 0, 0, 128]]),
    { columns: 24, charAspect: 0.05, background: [10, 20, 30], autoContrast: false }
  );
  assert.deepEqual(Array.from(result.colors.slice(0, 3)), [133, 10, 15]);
});

test('preserves aspect ratio and caps oversized output grids', () => {
  const result = AsciiCore.convert(image(1600, 1600), { columns: 320, charAspect: 2 });
  assert.equal(result.columns, 300);
  assert.equal(result.rows, 600);
  assert.ok(result.columns * result.rows <= 180000);
  assert.equal(result.text.split('\n').length, result.rows);
});

test('rejects malformed images and unsafe custom ramp characters', () => {
  assert.throws(() => AsciiCore.convert({ width: 1, height: 1, data: [0, 0, 0] }), /exactly width \* height \* 4/);
  assert.throws(() => AsciiCore.convert(image(1, 1), { columns: 24, ramp: '' }), /non-empty/);
  assert.throws(() => AsciiCore.convert(image(1, 1), { columns: 24, ramp: '界' }), /single-cell/);
  assert.throws(() => AsciiCore.convert(image(1, 1), { columns: 24, ramp: 'e\u0301' }), /single-cell/);
  assert.throws(() => AsciiCore.convert(image(1, 1), { columns: 24, ramp: '🙂' }), /single-cell/);
});

test('Floyd-Steinberg output is deterministic', () => {
  const pixels = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const value = (x * 17 + y * 9) & 255;
      pixels.push([value, value, value, 255]);
    }
  }
  const input = image(16, 8, pixels);
  const a = AsciiCore.convert(input, { columns: 24, charAspect: 0.5, dither: true, autoContrast: false });
  const b = AsciiCore.convert(input, { columns: 24, charAspect: 0.5, dither: true, autoContrast: false });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.characters, b.characters);
});

test('edge mode emits directional glyphs and keeps the requested mode', () => {
  const pixels = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const value = x < 8 ? 0 : 255;
      pixels.push([value, value, value, 255]);
    }
  }
  const result = AsciiCore.convert(image(16, 8, pixels), {
    columns: 24,
    charAspect: 0.5,
    mode: 'edges',
    autoContrast: false,
    threshold: 0.1
  });
  assert.equal(result.mode, 'edges');
  assert.match(result.text, /\|/);
});
