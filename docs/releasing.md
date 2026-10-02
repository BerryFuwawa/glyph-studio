# 发布流程

这份文档描述维护者的可选流程，不表示任何 GitHub Release 或下载链接已经发布。仓库所有者、签名证书和分发渠道应由维护者在执行外部操作前确认。

项目仓库是 [BerryFuwawa/glyph-studio](https://github.com/BerryFuwawa/glyph-studio)，[Releases 页面](https://github.com/BerryFuwawa/glyph-studio/releases)在发布前可能为空。

## 发布前检查

1. 在 Windows 10/11 x64 环境确认 Node.js `>=24`。
2. 修改 `package.json` 的版本，并把 `package-lock.json` 根包版本同步到同一个版本；为该版本新增 `docs/release-VERSION.md`。
3. 安装并准备依赖和 Electron：

   ```powershell
   npm ci
   npm run prebuild
   ```

4. 完成测试和人工检查：

   ```powershell
   npm test
   npx electron . --qa
   node scripts/qa-desktop.cjs
   node scripts/qa-browser.cjs
   ```

   有解包目录时，再运行 `node scripts/qa-packaged.cjs`。`scripts/qa-browser.cjs` 自动寻找 Chrome；必要时设置 `CHROME_PATH`。

5. 执行 `npm run build`，检查 `dist/` 中唯一的 Windows x64 portable exe，启动最终文件并验证四种模式、五种导出、剪贴板和离线行为。
6. 本地生成哈希并保存核对值：

   ```powershell
   Get-ChildItem .\dist\*.exe | Get-FileHash -Algorithm SHA256
   ```

7. 审阅 `docs/release-VERSION.md` 与更新日志，只记录实际完成的内容。便携版未签名，是否签名或如何分发由维护者决定。

## 首选：标签触发 GitHub Actions

提交版本文件后，在默认分支 `main` 上创建带注释的版本标签并推送：

```powershell
git add package.json package-lock.json docs/release-1.0.0.md docs/CHANGELOG.md
git commit -m "发布 1.0.0"
git tag -a v1.0.0 -m "发布 Glyph Studio 1.0.0"
git push origin main
git push origin v1.0.0
```

`.github/workflows/release.yml` 只响应 `v*` 标签。工作流会在 Windows runner 上确认标签与 `package.json` 版本一致，执行 `npm ci`、`npm test`、`npm run prebuild` 和 `npm run build`，计算 exe 的 SHA-256，随后使用 `--verify-tag` 发布 exe、`.sha256` 和 `docs/release-VERSION.md` 中的说明。推送标签后，维护者应在 [Releases 页面](https://github.com/BerryFuwawa/glyph-studio/releases)检查工作流结果、资产名称、哈希和发布说明。

不要在版本未提交、未通过本地检查或标签未存在时直接运行 `gh release create`；自动创建标签可能绕过本项目的版本和测试检查。

## 手动回退

只有在标签已经推送、自动化不可用且本地检查已通过时，才使用 GitHub CLI 手动发布。先登录并确认远程状态：

```powershell
gh auth login
gh auth status
gh repo view BerryFuwawa/glyph-studio
```

准备 exe 和校验文件后，使用已存在的标签、`--verify-tag` 和专用 release notes：

```powershell
$asset = Get-ChildItem .\dist\*.exe | Select-Object -First 1
$hash = Get-FileHash $asset.FullName -Algorithm SHA256
"$($hash.Hash.ToLower())  $($asset.Name)" | Set-Content -Encoding utf8NoBOM ".\dist\$($asset.Name).sha256"
gh release create v1.0.0 $asset.FullName ".\dist\$($asset.Name).sha256" --repo BerryFuwawa/glyph-studio --verify-tag --title "字相 · Glyph Studio v1.0.0" --notes-file docs/release-1.0.0.md
```

如果实际版本变化，请同步替换版本号、标签和 notes 文件名。手动流程不会代替维护者审阅，也不应把未经验证的 exe 上传为正式资产。
