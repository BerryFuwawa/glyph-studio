// Optional network QA: download a real official release through the app's
// privileged Electron session, verify it, and stop before executing any helper.
const { _electron } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs/promises');
const root = path.resolve(__dirname, '..');
(async () => {
  const parent = path.join(root, 'qa-results', 'update-download');
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'case-'));
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--desktop-qa'], cwd: root });
  try {
    await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    const report = await app.evaluate(async ({ session }, { folder, root }) => {
      const require = process.getBuiltinModule('node:module').createRequire(root + '/package.json');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const { EventEmitter } = require('node:events');
      const { selectPortableAsset } = require(path.join(root, 'src/updates.cjs'));
      const { installPortableUpdate } = require(path.join(root, 'src/portable-update.cjs'));
      const updates = session.fromPartition('glyph-updates');
      const release = await (await updates.fetch('https://api.github.com/repos/BerryFuwawa/glyph-studio/releases/latest', { signal: AbortSignal.timeout(15000) })).json();
      const asset = selectPortableAsset(release);
      if (!asset) throw new Error('Official release is missing a verified x64 asset');
      const oldExe = path.join(folder, 'QA-old.exe');
      await fs.writeFile(oldExe, 'MZ-fixture');
      let manifestPath;
      const result = await installPortableUpdate({ oldExe, asset, resultFile: path.join(folder, 'result.json'), fetchImpl: (url, options) => updates.fetch(url, options),
        spawnHelper(_command, args) {
          manifestPath = args[args.indexOf('-Manifest') + 1];
          const child = new EventEmitter();
          child.unref = () => {};
          queueMicrotask(() => child.emit('spawn'));
          return child;
        }
      });
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if ((await fs.readFile(oldExe, 'utf8')) !== 'MZ-fixture') throw new Error('Old fixture changed');
      const stage = await fs.stat(manifest.stagePath);
      const report = { status: result.status, release: release.tag_name, name: asset.name, bytes: stage.size, sha256: asset.sha256, passed: ['official GitHub redirect allowed by dedicated session', 'streamed download size and SHA-256 verified', 'old file preserved and no downloaded program executed'] };
      // Remove only exact paths created by this invocation; never recursive.
      await fs.unlink(manifest.stagePath);
      await fs.unlink(path.join(path.dirname(manifestPath), 'update-helper.ps1'));
      await fs.unlink(manifestPath);
      await fs.rmdir(path.dirname(manifestPath));
      return report;
    }, { folder, root });
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
