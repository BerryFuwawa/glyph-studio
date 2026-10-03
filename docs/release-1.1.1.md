# 字相 · Glyph Studio 1.1.1

1.1.1 在保持图像处理本机完成的基础上，加入用户主动触发的版本检查。

## 亮点

- 按 `F1` 打开帮助并选择“检查更新”，可看到检查中、已是最新、可用版本或失败状态；失败时可以重试。
- 发现新版本后，点击“前往下载”会在默认浏览器打开 [官方 GitHub Release 页面](https://github.com/BerryFuwawa/glyph-studio/releases)。程序不会自动下载、安装或重启，也不会在启动时检查更新。
- 延续四种转换模式、五种导出格式和本机图像处理能力。

## 网络与隐私

图片解码、转换和导出仍在本机完成，不上传图片、不需要账号。只有用户主动选择“检查更新”时，程序才会向 `api.github.com` 请求版本元数据；主窗口会话的普通 HTTP、HTTPS 和 WebSocket 网络阻断保持不变。

## 下载文件

本版本提供：

- `Glyph-Studio-1.1.1-Windows-x64.exe`
- `Glyph-Studio-1.1.1-Windows-x64.exe.sha256`

下载后可用 Windows PowerShell 验证哈希：

```powershell
Get-FileHash .\Glyph-Studio-1.1.1-Windows-x64.exe -Algorithm SHA256
```
