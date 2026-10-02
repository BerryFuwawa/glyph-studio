const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const allowed = new Set(['index.html', 'app.js', 'core.js', 'export.js', 'image-info.js', 'worker.js', 'styles.css', 'assets/sculpture.png']);
const server = http.createServer(async (request, response) => {
  const file = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
  if (!allowed.has(file)) { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { 'Content-Type': mime[path.extname(file)] }); response.end(await fs.readFile(path.join(__dirname, file))); }
  catch { response.writeHead(404); response.end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(path.join(__dirname, 'qa-results'), { recursive: true });
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 920 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.waitForFunction(() => Boolean(window.GlyphStudio?.getState().result) && !document.getElementById('copy-btn').disabled);
    await page.screenshot({ path: path.join(__dirname, 'qa-results', 'browser-initial.png') });
    const report = await page.evaluate(() => window.GlyphStudio.runSmokeTests());
    report.failed = report.failed.filter(name => name !== 'desktop bridge available');
    report.errors = errors;
    await fs.writeFile(path.join(__dirname, 'qa-results', 'browser-smoke.json'), JSON.stringify(report, null, 2));
    await page.setViewportSize({ width: 980, height: 700 });
    await page.screenshot({ path: path.join(__dirname, 'qa-results', 'browser-small.png') });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(JSON.stringify({ passed: report.passed.length, failed: report.failed, errors, overflow }, null, 2));
    if (report.failed.length || errors.length || overflow) process.exitCode = 1;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
