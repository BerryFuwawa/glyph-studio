# 开发指南

## 环境

- Windows 10/11 x64 用于便携版验证；其他系统可用于阅读和测试无平台核心，但打包目标是 Windows x64。
- Node.js `>=24`，本项目已用 Node.js 24 验证。
- npm；开发依赖固定在 `package-lock.json`。
- Electron `44.5.1`、electron-builder `26.15.3`、playwright-core `1.63.0`。

## 安装和运行

```powershell
npm ci
npm start
```

依赖安装成功后，Electron 的运行时仍可能在第一次 `npm start` 或 `npm run build` 时才下载或准备。`npm ci --ignore-scripts` 可以用于不执行安装脚本的审计场景，但不能作为 Electron 可执行文件已经就绪的证明；需要运行桌面或打包验证时，让 Electron 按正常流程完成准备。

发布版不需要开发依赖。源码开发阶段若网络策略阻止 npm 或 Electron 下载，请在允许访问依赖源的环境中完成安装后，再把源码和 `node_modules` 按团队规范处理；程序本身运行时不请求网络。

## 测试和质量检查

单元测试使用 Node 内置测试器：

```powershell
npm test
```

覆盖转换核心、导出转义、图像尺寸解析、固定列宽、Braille 点位、透明度、抖动、轮廓模式和非法输入。测试文件分别是 `core.test.cjs`、`app.test.cjs` 和 `image-info.test.cjs`。

真实渲染器冒烟测试：

```powershell
npx electron . --qa
```

该命令验证内置示例、四种模式、参数撤销/重做、拖放、五种导出内容和 HTML 转义，并把报告、截图和错误日志写入 `qa-results/`。

桌面 IPC 与原生保存流程：

```powershell
node qa-desktop.cjs
```

该脚本通过 Playwright 启动 Electron，覆盖原生打开、TXT/PNG/SVG/HTML/ANSI 保存、扩展名修正、帮助窗口、标签页、缩放和快捷键。

浏览器渲染器检查：

```powershell
node qa-browser.cjs
```

脚本会启动本地临时 HTTP 服务并使用本机 Chrome。自动发现 Chrome 失败时，可设置绝对路径：

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node qa-browser.cjs
```

## 打包

```powershell
npm run build
```

打包配置在 `package.json`：目标为 Windows x64 portable，应用 ID 为 `studio.glyph.desktop`，产物目录为 `dist/`。文件名按版本、架构和扩展名生成；1.0.0 的文件名为 `Glyph-Studio-1.0.0-Windows-x64.exe`。构建未启用代码签名，交付前应由维护者决定签名、哈希和分发渠道。

如需检查解包后的应用，确认 `dist/win-unpacked/Glyph Studio.exe` 存在后运行：

```powershell
node qa-packaged.cjs
```

该检查只针对解包目录，不替代对最终 portable exe 的人工启动检查。每次交付前至少确认：文件可启动、内置示例可转换、四种模式可切换、五种格式可保存、SmartScreen 提示说明与实际构建状态一致。

## 代码约定

- 保持转换核心无外部运行时依赖；可复用逻辑优先放入 `core.js` 或独立模块。
- 任何新增导出格式都要处理字符、标题和颜色输入的转义，并补充格式级测试。
- 新的 IPC 必须经过 `preload.cjs` 白名单和 `main.cjs` 的发送方校验；不要把 Node.js 或文件系统 API 暴露给页面。
- 新增用户可见行为时，同步更新 README、用户指南、FAQ 和必要的更新日志。
- 保持离线运行假设，不加入遥测、远程字体、CDN、自动上传或未经说明的网络请求。

贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)，安全问题见 [SECURITY.md](../SECURITY.md)。
