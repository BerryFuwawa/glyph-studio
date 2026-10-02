# 第三方许可与素材说明

本仓库自有源码、界面样式和图标采用根目录的 MIT 许可证。开发和打包依赖保留各自许可证，MIT 不替代第三方许可证。

## 桌面运行时

Windows 便携版包含 Electron 及 Chromium 等运行时组件。解包后的程序目录中包含 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`，打包时必须保留这两个文件。Electron 使用 MIT 许可证；Chromium 及所含组件的完整声明见对应 HTML 文件。

## 开发依赖

依赖版本与完整性信息记录在 `package-lock.json`。主要开发依赖为 Electron（MIT）、electron-builder（MIT）和 playwright-core（Apache-2.0）；传递依赖的许可证以各包附带声明为准。`node_modules` 不提交到源码仓库。

## 内置素材

`assets/icon.png`、`assets/icon.ico` 为本项目原创图标，生成脚本为 `make-icon.py`。

`assets/sculpture.png` 是 AI 生成的示例图片，生成提示词见 README。它用于演示转换效果，不是真实摄影作品，也不代表特定人物。本项目将该素材随源码一并开放使用。

## 算法参考

参考项目与独立实现范围见 [REFERENCES.md](REFERENCES.md)。本项目未直接复制这些项目的源码或素材，也未捆绑 Chafa、AA-lib 或 ascii-image-converter 可执行文件。
