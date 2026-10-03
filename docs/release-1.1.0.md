# 字相 · Glyph Studio 1.1.0

字相将图片转换为可以复制、编辑和分享的字符画。Windows 便携版无需安装，图片处理与导出均在本机完成。

## 亮点

- 新增“排版间距”侧栏：行间距 0–24 px、字符间距 0–12 px，默认均为 0。
- 画布预览以及 PNG、SVG、HTML 导出保留当前排版间距；设置会持久化，并支持撤销、重做和重置。
- “复制字符”、TXT 和 ANSI 保持字符字符串与换行不变，不携带像素间距；导出窗口会明确提示这一点。
- 延续四种转换模式、五种导出格式、拖放/打开/剪贴板导入和本机离线处理。

## 下载文件

本版本提供：

- `Glyph-Studio-1.1.0-Windows-x64.exe`
- `Glyph-Studio-1.1.0-Windows-x64.exe.sha256`

下载后可用 Windows PowerShell 验证哈希：

```powershell
Get-FileHash .\Glyph-Studio-1.1.0-Windows-x64.exe -Algorithm SHA256
```

## 已知限制

- 官方目标为 Windows 10/11 x64 portable；便携版未配置代码签名，Windows SmartScreen 可能显示发布者未知。请核对来源和 `.sha256` 后再决定是否运行，不要全局关闭系统安全功能。
- 动图只转换第一帧；不提供视频、动画导出或批量处理。
- 参与转换的图像最长边最多 1,600 像素；输出最多 600 行、180,000 个字符格。
- 跨设备查看 SVG/HTML/TXT/ANSI 时，字体和终端能力可能改变字形或颜色表现。
