# 贡献指南

感谢你改进 Glyph Studio。提交修改前，请先阅读[架构说明](docs/architecture.md)和[安全政策](SECURITY.md)，了解离线运行、IPC 边界和当前版本限制。

## 开始开发

需要 Node.js `>=24` 和 npm。安装并运行：

```powershell
npm ci
npm start
```

Electron 运行时可能在第一次 `npm start` 或 `npm run build` 时按需下载或准备；`npm ci --ignore-scripts` 适合依赖审计，但不保证桌面运行时已经就绪。源码开发阶段的依赖准备可能需要网络，应用运行阶段应保持离线。

## 提交修改前的检查

至少运行：

```powershell
npm test
npx electron . --qa
```

涉及文件对话框、剪贴板、导出或窗口行为时，再运行：

```powershell
node qa-desktop.cjs
```

涉及界面布局时运行 `node qa-browser.cjs`；脚本默认查找本机 Chrome，也接受 `CHROME_PATH` 绝对路径。所有检查产生的 `qa-results/` 文件不应提交。

## 代码和文档约定

- 转换核心保持无依赖，并继续支持 ASCII、Braille、轮廓和方块四种模式。
- 新的导出器必须转义字符、标题和颜色输入，并为有效内容和恶意/非法内容补测试。
- 新增桌面能力时只通过 `preload.cjs` 暴露最小接口，并在主进程验证 IPC 发送方、类型和大小。
- 不加入账号、遥测、远程字体、CDN、自动上传或未说明的网络请求。
- 用户可见行为、输入限制、快捷键或导出变化要同步更新 README、相关 `docs/` 页面和 `CHANGELOG.md`。
- 保持中文界面文案清楚、错误提示可操作；避免改变已有快捷键而不写迁移说明。

## 提交内容

提交说明应包含：

- 改动解决的用户问题或开发问题；
- 影响的模式、导出格式或平台；
- 已运行的测试和手动检查；
- 若是界面变化，附上本地截图或说明验证尺寸。

小而聚焦的修改更容易审阅。不要把生成的 `dist/`、`node_modules/`、`qa-results/` 或本机日志提交到版本库。

发现可能导致数据泄露、任意文件写入、远程代码执行或绕过离线边界的问题时，不要在公开问题中粘贴可利用样本；请先按 [SECURITY.md](SECURITY.md) 的说明联系维护者。
