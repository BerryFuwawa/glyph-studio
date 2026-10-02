(function attachGlyphImageInfo(root) {
  'use strict';

  function hasType(bytes, offset, text) {
    if (offset < 0 || offset + text.length > bytes.length) return false;
    for (var i = 0; i < text.length; i += 1) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  function readU16BE(bytes, offset) {
    if (offset < 0 || offset + 2 > bytes.length) return null;
    return bytes[offset] * 256 + bytes[offset + 1];
  }

  function readU16LE(bytes, offset) {
    if (offset < 0 || offset + 2 > bytes.length) return null;
    return bytes[offset] + bytes[offset + 1] * 256;
  }

  function readU24LE(bytes, offset) {
    if (offset < 0 || offset + 3 > bytes.length) return null;
    return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
  }

  function readU32BE(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    return (
      bytes[offset] * 0x1000000 +
      bytes[offset + 1] * 0x10000 +
      bytes[offset + 2] * 0x100 +
      bytes[offset + 3]
    );
  }

  function readU32LE(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    return (
      bytes[offset] +
      bytes[offset + 1] * 0x100 +
      bytes[offset + 2] * 0x10000 +
      bytes[offset + 3] * 0x1000000
    );
  }

  function readI32LE(bytes, offset) {
    var unsigned = readU32LE(bytes, offset);
    if (unsigned === null) return null;
    return unsigned >= 0x80000000 ? unsigned - 0x100000000 : unsigned;
  }

  function dimensions(width, height, format) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
    if (width < 1 || height < 1) return null;
    return { width: width, height: height, format: format };
  }

  function parsePng(bytes) {
    if (bytes.length < 24) return null;
    if (
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47 ||
      bytes[4] !== 0x0d ||
      bytes[5] !== 0x0a ||
      bytes[6] !== 0x1a ||
      bytes[7] !== 0x0a
    ) {
      return null;
    }
    var chunkLength = readU32BE(bytes, 8);
    if (chunkLength !== 13 || !hasType(bytes, 12, 'IHDR')) return null;
    var width = readU32BE(bytes, 16);
    var height = readU32BE(bytes, 20);
    return dimensions(width, height, 'png');
  }

  function parseGif(bytes) {
    if (bytes.length < 10) return null;
    if (!hasType(bytes, 0, 'GIF87a') && !hasType(bytes, 0, 'GIF89a')) return null;
    var width = readU16LE(bytes, 6);
    var height = readU16LE(bytes, 8);
    return dimensions(width, height, 'gif');
  }

  function isJpegSof(marker) {
    return (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    );
  }

  function parseJpeg(bytes) {
    if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    var offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      var marker = bytes[offset];
      offset += 1;

      // These markers have no length field. A restart marker is only valid
      // inside entropy-coded data, so it cannot lead a header segment here.
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return null;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (offset + 2 > bytes.length) return null;
      var segmentLength = readU16BE(bytes, offset);
      if (segmentLength === null || segmentLength < 2) return null;
      var segmentEnd = offset + segmentLength;
      if (segmentEnd > bytes.length) return null;

      if (isJpegSof(marker)) {
        // Length includes its own two bytes. The payload is precision,
        // height, width, component count, and component descriptors.
        if (segmentLength < 7) return null;
        var height = readU16BE(bytes, offset + 3);
        var width = readU16BE(bytes, offset + 5);
        return dimensions(width, height, 'jpeg');
      }

      // SOS is followed by entropy-coded bytes rather than length-prefixed
      // segments. All normal JPEGs place SOF before SOS; without a SOF now,
      // safely decline rather than scan unbounded compressed data.
      if (marker === 0xda) return null;
      offset = segmentEnd;
    }
    return null;
  }

  function parseBmp(bytes) {
    if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
    var dibSize = readU32LE(bytes, 14);
    if (dibSize === null || dibSize < 12 || dibSize > bytes.length - 14) return null;

    if (dibSize === 12) {
      var coreWidth = readU16LE(bytes, 18);
      var coreHeight = readU16LE(bytes, 20);
      return dimensions(coreWidth, coreHeight, 'bmp');
    }
    if (dibSize < 40 || bytes.length < 14 + 40) return null;
    var width = readI32LE(bytes, 18);
    var signedHeight = readI32LE(bytes, 22);
    if (width === null || signedHeight === null || width <= 0 || signedHeight === 0) return null;
    var height = signedHeight < 0 ? -signedHeight : signedHeight;
    return dimensions(width, height, 'bmp');
  }

  function parseVp8l(bytes, offset, size) {
    if (size < 5 || bytes[offset] !== 0x2f) return null;
    var widthBits = bytes[offset + 1] + ((bytes[offset + 2] & 0x3f) << 8);
    var heightBits =
      (bytes[offset + 2] >>> 6) +
      (bytes[offset + 3] << 2) +
      ((bytes[offset + 4] & 0x0f) << 10);
    return dimensions(widthBits + 1, heightBits + 1, 'webp');
  }

  function parseVp8(bytes, offset, size) {
    if (size < 10 || bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 0x01 || bytes[offset + 5] !== 0x2a) {
      return null;
    }
    var width = readU16LE(bytes, offset + 6);
    var height = readU16LE(bytes, offset + 8);
    if (width === null || height === null) return null;
    return dimensions(width & 0x3fff, height & 0x3fff, 'webp');
  }

  function parseWebp(bytes) {
    if (bytes.length < 20 || !hasType(bytes, 0, 'RIFF') || !hasType(bytes, 8, 'WEBP')) return null;
    var riffSize = readU32LE(bytes, 4);
    if (riffSize === null || riffSize < 4) return null;
    var declaredRiffEnd = 8 + riffSize;
    var riffEnd = Math.min(declaredRiffEnd, bytes.length);
    var prefixIsShort = declaredRiffEnd > bytes.length;
    var offset = 12;
    while (offset + 8 <= riffEnd) {
      var chunkType = String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3]
      );
      var chunkSize = readU32LE(bytes, offset + 4);
      if (chunkSize === null) return null;
      var payload = offset + 8;
      var chunkEnd = payload + chunkSize;
      var paddedEnd = chunkEnd + (chunkSize & 1);

      if (chunkType === 'VP8X') {
        if (chunkSize < 10 || payload + 10 > bytes.length || chunkEnd > declaredRiffEnd) return null;
        var width = readU24LE(bytes, payload + 4);
        var height = readU24LE(bytes, payload + 7);
        if (width === null || height === null) return null;
        return dimensions(width + 1, height + 1, 'webp');
      }
      if (chunkType === 'VP8L') {
        if (chunkSize < 5 || payload + 5 > bytes.length || chunkEnd > declaredRiffEnd) return null;
        return parseVp8l(bytes, payload, chunkSize);
      }
      if (chunkType === 'VP8 ') {
        if (chunkSize < 10 || payload + 10 > bytes.length || chunkEnd > declaredRiffEnd) return null;
        return parseVp8(bytes, payload, chunkSize);
      }
      if (chunkEnd > riffEnd || paddedEnd > riffEnd || chunkEnd > bytes.length) return null;
      offset = paddedEnd;
    }
    if (prefixIsShort) return null;
    return null;
  }

  function parseBox(bytes, start, end) {
    if (start < 0 || end < start || end - start < 8) return null;
    var size = readU32BE(bytes, start);
    if (size === null) return null;
    var header = 8;
    if (size === 1) {
      if (end - start < 16) return null;
      var high = readU32BE(bytes, start + 8);
      var low = readU32BE(bytes, start + 12);
      // A JavaScript Number cannot exactly represent arbitrarily large boxes.
      if (high === null || low === null || high > 0x1fffff) return null;
      size = high * 0x100000000 + low;
      header = 16;
    } else if (size === 0) {
      size = end - start;
    }
    if (size < header || size > end - start) return null;
    return {
      start: start,
      end: start + size,
      payload: start + header,
      type: String.fromCharCode(
        bytes[start + 4],
        bytes[start + 5],
        bytes[start + 6],
        bytes[start + 7]
      )
    };
  }

  function isContainer(type) {
    return (
      type === 'meta' ||
      type === 'iprp' ||
      type === 'ipco' ||
      type === 'moov' ||
      type === 'trak' ||
      type === 'mdia' ||
      type === 'minf' ||
      type === 'stbl'
    );
  }

  function findIspe(bytes, start, end, depth) {
    if (depth > 8) return null;
    var offset = start;
    while (offset < end) {
      var box = parseBox(bytes, offset, end);
      if (!box) return null;
      if (box.type === 'ispe') {
        if (box.end - box.start < 20) return null;
        var width = readU32BE(bytes, box.start + 12);
        var height = readU32BE(bytes, box.start + 16);
        var result = dimensions(width, height, 'avif');
        if (result) return result;
      } else if (isContainer(box.type)) {
        var childStart = box.payload;
        if (box.type === 'meta') {
          if (box.end - childStart < 4) return null;
          childStart += 4;
        }
        var nested = findIspe(bytes, childStart, box.end, depth + 1);
        if (nested) return nested;
      }
      offset = box.end;
    }
    return null;
  }

  function isAvifBrand(bytes, box) {
    if (box.type !== 'ftyp' || box.end - box.payload < 8) return false;
    if (hasType(bytes, box.payload, 'avif') || hasType(bytes, box.payload, 'avis')) return true;
    for (var offset = box.payload + 8; offset + 4 <= box.end; offset += 4) {
      if (hasType(bytes, offset, 'avif') || hasType(bytes, offset, 'avis')) return true;
    }
    return false;
  }

  function parseAvif(bytes) {
    if (bytes.length < 16) return null;
    var first = parseBox(bytes, 0, bytes.length);
    if (!first || !isAvifBrand(bytes, first)) return null;
    var offset = first.end;
    while (offset < bytes.length) {
      var box = parseBox(bytes, offset, bytes.length);
      if (!box) return null;
      var result = findIspe(bytes, box.start, box.end, 0);
      if (result) return result;
      offset = box.end;
    }
    return null;
  }

  function inspect(bytes) {
    try {
      if (!(bytes instanceof Uint8Array)) return null;
      return (
        parsePng(bytes) ||
        parseGif(bytes) ||
        parseJpeg(bytes) ||
        parseBmp(bytes) ||
        parseWebp(bytes) ||
        parseAvif(bytes) ||
        null
      );
    } catch (error) {
      return null;
    }
  }

  var api = { inspect: inspect };
  if (root) root.GlyphImageInfo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
