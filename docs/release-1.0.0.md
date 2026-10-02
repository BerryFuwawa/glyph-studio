# 字相 · Glyph Studio 1.0.0

字相将图片转换为可以复制、编辑和分享的字符画。Windows 便携版无需安装，图片处理与导出均在本机完成。

## 亮点

- 离线 Windows 10/11 x64 portable Electron 应用。
- 四种模式：经典 ASCII、盲文点阵、轮廓线稿、像素方块。
- 五种导出：TXT、PNG、SVG、HTML、ANSI。
- 支持 PNG、JPG/JPEG、WebP、BMP、GIF、AVIF；支持拖放、原生打开和剪贴板粘贴。
- 参数实时预览、撤销/重做、缩放、原图对照、单色配色和原图色输出。
- 本地尺寸检查、超大图缩小、受限 IPC 和 HTML/SVG 输入转义。

## 验证环境

- 本地验证：Windows 11 x64；支持目标：Windows 10/11 x64
- Node.js 24（源码构建与测试）
- Electron `44.5.1`
- `npm test`、Electron 渲染器冒烟、桌面 IPC/导出和浏览器渲染检查

## 下载文件

本版本提供：

- `Glyph-Studio-1.0.0-Windows-x64.exe`
- `Glyph-Studio-1.0.0-Windows-x64.exe.sha256`

下载后可用 Windows PowerShell 验证哈希：

```powershell
Get-FileHash .\Glyph-Studio-1.0.0-Windows-x64.exe -Algorithm SHA256
```

## 已知限制

- 动图只转换第一帧；不提供视频、动画导出或批量处理。
- 参与转换的图像最长边最多 1,600 像素；输出最多 600 行、180,000 个字符格。
- 便携版未配置代码签名，Windows SmartScreen 可能显示发布者未知。请核对来源和 `.sha256` 后再决定是否运行，不要全局关闭系统安全功能。
- 跨设备查看 SVG/HTML/TXT/ANSI 时，字体和终端能力可能改变字形或颜色表现。
