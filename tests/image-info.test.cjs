const test = require('node:test');
const assert = require('node:assert/strict');
const GlyphImageInfo = require('../src/image-info.js');

function u32be(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function u32le(value) {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
}

function box(type, payload) {
  const typeBytes = Array.from(Buffer.from(type, 'ascii'));
  return Uint8Array.from([...u32be(8 + payload.length), ...typeBytes, ...payload]);
}

test('reads PNG and GIF logical screen dimensions', () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), 0x49, 0x48, 0x44, 0x52,
    ...u32be(640), ...u32be(480), 8, 2, 0, 0, 0
  ]);
  assert.deepEqual(GlyphImageInfo.inspect(png), { width: 640, height: 480, format: 'png' });

  const gif = Uint8Array.from([
    ...Buffer.from('GIF89a', 'ascii'),
    0x80, 0x02, 0xe0, 0x01
  ]);
  assert.deepEqual(GlyphImageInfo.inspect(gif), { width: 640, height: 480, format: 'gif' });
});

test('scans JPEG APP segments and returns SOF dimensions', () => {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
  const sof0 = [0xff, 0xc0, 0x00, 0x0b, 8, 0x01, 0x2c, 0x02, 0x80, 1, 1, 0x11, 0, 0];
  const jpeg = Uint8Array.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
  assert.deepEqual(GlyphImageInfo.inspect(jpeg), { width: 640, height: 300, format: 'jpeg' });
});

test('reads BMP including top-down signed heights', () => {
  const dib = [
    ...u32le(40), ...u32le(320), ...u32le(0xfffffed4),
    ...u32le(1), ...u32le(24), ...new Array(24).fill(0)
  ];
  const bmp = Uint8Array.from([
    0x42, 0x4d, ...u32le(14 + dib.length), 0, 0, 0, 0, 0, 0, 0, 0,
    ...dib
  ]);
  assert.deepEqual(GlyphImageInfo.inspect(bmp), { width: 320, height: 300, format: 'bmp' });
});

test('reads WebP VP8X, VP8L, and VP8 dimensions', () => {
  const vp8xPayload = [0, 0, 0, 0, 63, 1, 0, 239, 0, 0];
  const vp8xChunk = [...Buffer.from('VP8X', 'ascii'), ...u32le(10), ...vp8xPayload];
  const riff = Uint8Array.from([
    ...Buffer.from('RIFF', 'ascii'), ...u32le(4 + vp8xChunk.length), ...Buffer.from('WEBP', 'ascii'), ...vp8xChunk
  ]);
  assert.deepEqual(GlyphImageInfo.inspect(riff), { width: 320, height: 240, format: 'webp' });

  const prefixOfLargeWebp = Uint8Array.from([
    ...Buffer.from('RIFF', 'ascii'), ...u32le(0x100000), ...Buffer.from('WEBP', 'ascii'), ...vp8xChunk
  ]);
  assert.deepEqual(GlyphImageInfo.inspect(prefixOfLargeWebp), { width: 320, height: 240, format: 'webp' });

  const vp8lPayload = [0x2f, 0x3f, 0xc0, 0x0f, 0x00];
  const vp8lChunk = [...Buffer.from('VP8L', 'ascii'), ...u32le(5), ...vp8lPayload];
  const riffLossless = Uint8Array.from([
    ...Buffer.from('RIFF', 'ascii'), ...u32le(4 + vp8lChunk.length + 1), ...Buffer.from('WEBP', 'ascii'), ...vp8lChunk, 0
  ]);
  assert.deepEqual(GlyphImageInfo.inspect(riffLossless), { width: 64, height: 64, format: 'webp' });

  const vp8Payload = [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00];
  const vp8Chunk = [...Buffer.from('VP8 ', 'ascii'), ...u32le(10), ...vp8Payload];
  const riffLossy = Uint8Array.from([
    ...Buffer.from('RIFF', 'ascii'), ...u32le(4 + vp8Chunk.length), ...Buffer.from('WEBP', 'ascii'), ...vp8Chunk
  ]);
  assert.deepEqual(GlyphImageInfo.inspect(riffLossy), { width: 320, height: 240, format: 'webp' });
});

test('reads AVIF ispe dimensions and rejects malformed/truncated input safely', () => {
  const ftypPayload = [...Buffer.from('avif', 'ascii'), 0, 0, 0, 0, ...Buffer.from('avif', 'ascii')];
  const ispe = box('ispe', [0, 0, 0, 0, ...u32be(1920), ...u32be(1080)]);
  const ipco = box('ipco', Array.from(ispe));
  const iprp = box('iprp', Array.from(ipco));
  const meta = box('meta', [0, 0, 0, 0, ...Array.from(iprp)]);
  const ftyp = box('ftyp', ftypPayload);
  const avif = Uint8Array.from([...ftyp, ...meta]);
  assert.deepEqual(GlyphImageInfo.inspect(avif), { width: 1920, height: 1080, format: 'avif' });

  const malformed = [new Uint8Array(0), new Uint8Array([0x89, 0x50]), new Uint8Array([0xff, 0xd8, 0xff]), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff])];
  for (const bytes of malformed) assert.doesNotThrow(() => GlyphImageInfo.inspect(bytes));
  assert.equal(GlyphImageInfo.inspect(new Uint8Array([1, 2, 3])), null);
  assert.equal(GlyphImageInfo.inspect([0x89, 0x50, 0x4e, 0x47]), null);
});
