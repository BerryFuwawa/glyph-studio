importScripts('core.js');
let image = null;
self.onmessage = event => {
  const { type, id, pixels, options } = event.data;
  if (type === 'image') { image = pixels; return; }
  if (type !== 'convert') return;
  const started = performance.now();
  try {
    if (!image) throw new Error('请先打开一张图片。');
    const result = AsciiCore.convert(image, options);
    self.postMessage({ id, result, elapsed: performance.now() - started }, [result.colors.buffer]);
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
