(function attachAsciiCore(root) {
  'use strict';

  var DEFAULT_RAMP = ' .:-=+*#%@';
  var BLOCK_RAMP = ' ░▒▓█';
  var MAX_INPUT_DIMENSION = 4096;
  var MAX_INPUT_PIXELS = 4000000;
  var MAX_ROWS = 600;
  var MAX_CELLS = 180000;

  function fail(message) {
    throw new TypeError(message);
  }

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  }

  function numberOption(value, fallback, low, high) {
    var number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return clamp(number, low, high);
  }

  function integerOption(value, fallback, low, high) {
    var number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return clamp(Math.round(number), low, high);
  }

  function isCombining(code) {
    return (
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x0483 && code <= 0x0489) ||
      (code >= 0x0591 && code <= 0x05bd) ||
      code === 0x05bf ||
      (code >= 0x05c1 && code <= 0x05c2) ||
      (code >= 0x05c4 && code <= 0x05c5) ||
      (code >= 0x0610 && code <= 0x061a) ||
      (code >= 0x064b && code <= 0x065f) ||
      code === 0x0670 ||
      (code >= 0x06d6 && code <= 0x06ed) ||
      code === 0x0711 ||
      (code >= 0x0730 && code <= 0x074a) ||
      (code >= 0x07a6 && code <= 0x07b0) ||
      (code >= 0x07eb && code <= 0x07f3) ||
      (code >= 0x0816 && code <= 0x0819) ||
      (code >= 0x081b && code <= 0x0823) ||
      (code >= 0x0825 && code <= 0x0827) ||
      (code >= 0x0829 && code <= 0x082d) ||
      (code >= 0x0859 && code <= 0x085f) ||
      (code >= 0x08d3 && code <= 0x08e1) ||
      (code >= 0x08e3 && code <= 0x0903) ||
      (code >= 0x093a && code <= 0x093c) ||
      (code >= 0x093e && code <= 0x094f) ||
      (code >= 0x0951 && code <= 0x0957) ||
      (code >= 0x0962 && code <= 0x0963) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    );
  }

  function isWide(code) {
    return (
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f000 && code <= 0x1faff)
    );
  }

  function isControlOrFormat(code) {
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x00ad ||
      code === 0x061c ||
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      (code >= 0xfff9 && code <= 0xfffb) ||
      code === 0xfeff
    );
  }

  function validateRamp(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
      fail(label + ' must be a non-empty string');
    }
    var characters = Array.from(value);
    if (characters.length === 0) fail(label + ' must be a non-empty string');
    for (var i = 0; i < characters.length; i += 1) {
      var character = characters[i];
      var code = character.codePointAt(0);
      if (
        character.length !== 1 ||
        code > 0xffff ||
        (code >= 0xd800 && code <= 0xdfff) ||
        isControlOrFormat(code) ||
        isCombining(code) ||
        isWide(code)
      ) {
        fail(
          label +
            ' contains an unsupported character at index ' +
            i +
            '; use single-cell, non-combining characters'
        );
      }
    }
    return characters;
  }

  function validateBackground(value) {
    if (value === undefined) return [12, 15, 18];
    if (
      value === null ||
      typeof value.length !== 'number' ||
      value.length < 3
    ) {
      fail('background must be an RGB array with three finite values');
    }
    var result = new Array(3);
    for (var i = 0; i < 3; i += 1) {
      var number = Number(value[i]);
      if (!Number.isFinite(number)) {
        fail('background must contain only finite RGB values');
      }
      result[i] = clamp(number, 0, 255);
    }
    return result;
  }

  function normalizeOptions(options) {
    var source = options && typeof options === 'object' ? options : {};
    var mode = source.mode === undefined ? 'ascii' : source.mode;
    if (mode !== 'ascii' && mode !== 'braille' && mode !== 'blocks' && mode !== 'edges') {
      fail("mode must be one of 'ascii', 'braille', 'blocks', or 'edges'");
    }

    var hasRamp = Object.prototype.hasOwnProperty.call(source, 'ramp');
    var ramp = hasRamp ? validateRamp(source.ramp, 'ramp') : validateRamp(DEFAULT_RAMP, 'ramp');

    return {
      columns: integerOption(source.columns, 120, 24, 320),
      charAspect: numberOption(source.charAspect, 0.5, 0.05, 8),
      mode: mode,
      ramp: ramp,
      hasRamp: hasRamp,
      brightness: numberOption(source.brightness, 0, -100, 100),
      contrast: numberOption(source.contrast, 1, 0.2, 3),
      gamma: numberOption(source.gamma, 1, 0.3, 3),
      invert: source.invert === true,
      dither: source.dither === true,
      autoContrast: source.autoContrast === undefined ? true : source.autoContrast === true,
      threshold: numberOption(source.threshold, 0.5, 0, 1),
      background: validateBackground(source.background),
      color: source.color === undefined ? true : source.color === true
    };
  }

  function validateImage(image) {
    if (!image || typeof image !== 'object') {
      fail('image must be an object with width, height, and RGBA data');
    }
    var width = image.width;
    var height = image.height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      fail('image width and height must be positive safe integers');
    }
    if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION) {
      fail('image dimensions exceed the supported limit of ' + MAX_INPUT_DIMENSION + ' pixels');
    }
    var pixels = width * height;
    if (pixels > MAX_INPUT_PIXELS) {
      fail('image contains too many pixels');
    }
    var data = image.data;
    var isArray = Array.isArray(data);
    var isTypedArray =
      typeof ArrayBuffer !== 'undefined' &&
      typeof ArrayBuffer.isView === 'function' &&
      ArrayBuffer.isView(data) &&
      typeof data.length === 'number';
    if (!data || (!isArray && !isTypedArray) || data.length !== pixels * 4) {
      fail('image data must be an array containing exactly width * height * 4 RGBA values');
    }
    return { width: width, height: height, data: data, pixels: pixels };
  }

  function buildSource(image, background) {
    var count = image.pixels;
    var rgb = new Float32Array(count * 3);
    var luminance = new Float32Array(count);
    var data = image.data;
    var bgR = background[0];
    var bgG = background[1];
    var bgB = background[2];
    var min = 1;
    var max = 0;
    for (var p = 0; p < count; p += 1) {
      var input = p * 4;
      var alpha = Number(data[input + 3]);
      if (!Number.isFinite(alpha)) fail('image data contains a non-finite alpha value at index ' + (input + 3));
      alpha = clamp(alpha, 0, 255) / 255;
      var r = Number(data[input]);
      var g = Number(data[input + 1]);
      var b = Number(data[input + 2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        fail('image data contains a non-finite RGB value near index ' + input);
      }
      r = clamp(r, 0, 255) * alpha + bgR * (1 - alpha);
      g = clamp(g, 0, 255) * alpha + bgG * (1 - alpha);
      b = clamp(b, 0, 255) * alpha + bgB * (1 - alpha);
      var rgbIndex = p * 3;
      rgb[rgbIndex] = r;
      rgb[rgbIndex + 1] = g;
      rgb[rgbIndex + 2] = b;
      var value = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      luminance[p] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return {
      width: image.width,
      height: image.height,
      rgb: rgb,
      luminance: luminance,
      min: min,
      max: max
    };
  }

  function outputDimensions(width, height, options) {
    var columns = options.columns;
    var ratio = (height / width) * options.charAspect;
    var rows = Math.max(1, Math.round(columns * ratio));
    if (rows > MAX_ROWS || columns * rows > MAX_CELLS) {
      var scale = 1;
      if (rows > MAX_ROWS) scale = Math.min(scale, MAX_ROWS / rows);
      if (columns * rows > MAX_CELLS) {
        scale = Math.min(scale, Math.sqrt(MAX_CELLS / (columns * rows)));
      }
      columns = Math.max(1, Math.round(columns * scale));
      rows = Math.max(1, Math.round(columns * ratio));
    }
    while (rows > MAX_ROWS && columns > 1) {
      columns -= 1;
      rows = Math.max(1, Math.round(columns * ratio));
    }
    while (columns * rows > MAX_CELLS && columns > 1) {
      columns -= 1;
      rows = Math.max(1, Math.round(columns * ratio));
    }
    if (rows > MAX_ROWS) rows = MAX_ROWS;
    if (columns * rows > MAX_CELLS) {
      rows = Math.max(1, Math.floor(MAX_CELLS / columns));
    }
    return { columns: columns, rows: rows };
  }

  function sampleRegion(source, x0, y0, x1, y1) {
    var width = source.width;
    var height = source.height;
    var rgb = source.rgb;
    var luminance = source.luminance;
    var area = (x1 - x0) * (y1 - y0);
    var sumLuminance = 0;
    var sumR = 0;
    var sumG = 0;
    var sumB = 0;
    var startX = Math.max(0, Math.floor(x0));
    var endX = Math.min(width - 1, Math.ceil(x1) - 1);
    var startY = Math.max(0, Math.floor(y0));
    var endY = Math.min(height - 1, Math.ceil(y1) - 1);
    for (var y = startY; y <= endY; y += 1) {
      var yWeight = Math.min(y + 1, y1) - Math.max(y, y0);
      if (yWeight <= 0) continue;
      for (var x = startX; x <= endX; x += 1) {
        var xWeight = Math.min(x + 1, x1) - Math.max(x, x0);
        if (xWeight <= 0) continue;
        var weight = xWeight * yWeight;
        var pixel = y * width + x;
        var color = pixel * 3;
        sumLuminance += luminance[pixel] * weight;
        sumR += rgb[color] * weight;
        sumG += rgb[color + 1] * weight;
        sumB += rgb[color + 2] * weight;
      }
    }
    if (area <= 0) return { luminance: 0, r: 0, g: 0, b: 0 };
    return {
      luminance: sumLuminance / area,
      r: sumR / area,
      g: sumG / area,
      b: sumB / area
    };
  }

  function transformValue(value, source, options) {
    var result = value;
    if (options.autoContrast && source.max - source.min > 1e-7) {
      result = (result - source.min) / (source.max - source.min);
    }
    result += options.brightness / 100;
    result = (result - 0.5) * options.contrast + 0.5;
    result = clamp(result, 0, 1);
    result = Math.pow(result, 1 / options.gamma);
    if (options.invert) result = 1 - result;
    return clamp(result, 0, 1);
  }

  function sampleValueGrid(source, options, targetWidth, targetHeight) {
    var values = new Float32Array(targetWidth * targetHeight);
    var widthScale = source.width / targetWidth;
    var heightScale = source.height / targetHeight;
    var index = 0;
    for (var y = 0; y < targetHeight; y += 1) {
      var y0 = y * heightScale;
      var y1 = (y + 1) * heightScale;
      for (var x = 0; x < targetWidth; x += 1) {
        var x0 = x * widthScale;
        var x1 = (x + 1) * widthScale;
        values[index] = transformValue(sampleRegion(source, x0, y0, x1, y1).luminance, source, options);
        index += 1;
      }
    }
    return values;
  }

  function sampleColors(source, options, columns, rows) {
    var colors = new Uint8ClampedArray(columns * rows * 3);
    var widthScale = source.width / columns;
    var heightScale = source.height / rows;
    var index = 0;
    for (var y = 0; y < rows; y += 1) {
      var y0 = y * heightScale;
      var y1 = (y + 1) * heightScale;
      for (var x = 0; x < columns; x += 1) {
        var x0 = x * widthScale;
        var x1 = (x + 1) * widthScale;
        var sample = sampleRegion(source, x0, y0, x1, y1);
        var r = sample.r;
        var g = sample.g;
        var b = sample.b;
        if (options.invert) {
          r = 255 - r;
          g = 255 - g;
          b = 255 - b;
        }
        colors[index] = r;
        colors[index + 1] = g;
        colors[index + 2] = b;
        index += 3;
      }
    }
    return colors;
  }

  function dither(values, width, height, levels, threshold) {
    var result = levels <= 0xff ? new Uint8Array(values.length) : levels <= 0xffff ? new Uint16Array(values.length) : new Uint32Array(values.length);
    if (levels < 2) return result;
    var work = new Float64Array(values.length);
    for (var copy = 0; copy < values.length; copy += 1) work[copy] = values[copy];
    var denominator = levels - 1;
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        var index = y * width + x;
        var value = clamp(work[index], 0, 1);
        var quantized;
        if (levels === 2) {
          quantized = value >= threshold ? 1 : 0;
        } else {
          quantized = Math.round(value * denominator) / denominator;
        }
        result[index] = levels === 2 ? quantized : Math.round(quantized * denominator);
        var error = value - quantized;
        if (x + 1 < width) work[index + 1] += error * (7 / 16);
        if (y + 1 < height) {
          if (x > 0) work[index + width - 1] += error * (3 / 16);
          work[index + width] += error * (5 / 16);
          if (x + 1 < width) work[index + width + 1] += error * (1 / 16);
        }
      }
    }
    return result;
  }

  function asciiCharacters(values, width, height, ramp, useDither) {
    var result = new Array(values.length);
    var levels = ramp.length;
    var indices;
    if (useDither && levels > 1) {
      indices = dither(values, width, height, levels, 0.5);
    }
    for (var i = 0; i < values.length; i += 1) {
      var index = indices ? indices[i] : Math.round(values[i] * (levels - 1));
      result[i] = ramp[index];
    }
    return result;
  }

  function brailleCharacters(values, width, height, threshold, useDither) {
    var bits = useDither ? dither(values, width, height, 2, threshold) : null;
    var columns = Math.floor(width / 2);
    var rows = Math.floor(height / 4);
    var result = new Array(columns * rows);
    // Braille dots are numbered down the left column, then down the right:
    // 1 4 / 2 5 / 3 6 / 7 8.  The Unicode bits are dot number minus one.
    var dotOffsets = [0, 3, 1, 4, 2, 5, 6, 7];
    var output = 0;
    for (var y = 0; y < rows; y += 1) {
      for (var x = 0; x < columns; x += 1) {
        var mask = 0;
        for (var dotY = 0; dotY < 4; dotY += 1) {
          for (var dotX = 0; dotX < 2; dotX += 1) {
            var sampleIndex = (y * 4 + dotY) * width + x * 2 + dotX;
            var on = bits ? bits[sampleIndex] === 1 : values[sampleIndex] >= threshold;
            if (on) mask |= 1 << dotOffsets[dotY * 2 + dotX];
          }
        }
        result[output] = String.fromCharCode(0x2800 + mask);
        output += 1;
      }
    }
    return result;
  }

  function edgeCharacters(values, width, height, options) {
    var count = values.length;
    var magnitudes = new Float32Array(count);
    var directions = new Float32Array(count);
    var maximum = 0;
    function at(x, y) {
      var safeX = x < 0 ? 0 : x >= width ? width - 1 : x;
      var safeY = y < 0 ? 0 : y >= height ? height - 1 : y;
      return values[safeY * width + safeX];
    }
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        var gx = -at(x - 1, y - 1) + at(x + 1, y - 1) - 2 * at(x - 1, y) + 2 * at(x + 1, y) - at(x - 1, y + 1) + at(x + 1, y + 1);
        var gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        var magnitude = Math.sqrt(gx * gx + gy * gy);
        var index = y * width + x;
        magnitudes[index] = magnitude;
        directions[index] = Math.atan2(gy, gx) + Math.PI / 2;
        if (magnitude > maximum) maximum = magnitude;
      }
    }
    var result = new Array(count);
    var normalizer = options.autoContrast ? maximum : 4;
    for (var i = 0; i < count; i += 1) {
      var strength = normalizer > 1e-7 ? magnitudes[i] / normalizer : 0;
      strength = clamp(strength, 0, 1);
      if (strength < options.threshold) {
        result[i] = ' ';
        continue;
      }
      var angle = directions[i] % Math.PI;
      if (angle < 0) angle += Math.PI;
      if (angle < Math.PI / 8 || angle >= (7 * Math.PI) / 8) result[i] = '-';
      else if (angle < (3 * Math.PI) / 8) result[i] = '\\';
      else if (angle < (5 * Math.PI) / 8) result[i] = '|';
      else result[i] = '/';
    }
    return result;
  }

  function convert(imageInput, optionsInput) {
    var image = validateImage(imageInput);
    var options = normalizeOptions(optionsInput);
    var source = buildSource(image, options.background);
    var dimensions = outputDimensions(source.width, source.height, options);
    var columns = dimensions.columns;
    var rows = dimensions.rows;
    var values;
    var characters;

    if (options.mode === 'braille') {
      values = sampleValueGrid(source, options, columns * 2, rows * 4);
      characters = brailleCharacters(values, columns * 2, rows * 4, options.threshold, options.dither);
    } else {
      values = sampleValueGrid(source, options, columns, rows);
      if (options.mode === 'edges') {
        characters = edgeCharacters(values, columns, rows, options);
      } else {
        var ramp;
        if (options.mode === 'blocks' && !options.hasRamp) ramp = Array.from(BLOCK_RAMP);
        else ramp = options.ramp;
        characters = asciiCharacters(values, columns, rows, ramp, options.mode === 'ascii' && options.dither);
      }
    }

    if (characters.length !== columns * rows) {
      fail('internal conversion error: character grid has the wrong size');
    }
    var textRows = new Array(rows);
    for (var y = 0; y < rows; y += 1) {
      textRows[y] = characters.slice(y * columns, (y + 1) * columns).join('');
    }
    return {
      columns: columns,
      rows: rows,
      text: textRows.join('\n'),
      characters: characters,
      colors: sampleColors(source, options, columns, rows),
      mode: options.mode
    };
  }

  var api = { convert: convert };
  if (root) root.AsciiCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
