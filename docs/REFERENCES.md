# 开源参考

参考这些项目的公开文档与交互思路，未复制源代码、字符图集或素材。

- [TheZoraiz/ascii-image-converter](https://github.com/TheZoraiz/ascii-image-converter)：ASCII 与盲文点阵、抖动、宽度优先调整、纯文本与图片分别导出。
- [mir3z/aalib.js](https://github.com/mir3z/aalib.js)：读取、预处理、字符映射、渲染分离的处理流水线。
- [hpjansson/chafa](https://github.com/hpjansson/chafa)：字符宽高比例校正、Unicode 方块、色彩与抖动的控制思路。
- [AlesSystems/ASCII-art-generator](https://github.com/AlesSystems/ASCII-art-generator)：Rec.709 亮度、面积采样、Sobel 轮廓，以及与平台无关的转换核心。
- [ntbowen/chafa-gui](https://github.com/ntbowen/chafa-gui)：本机处理、参数面板与实时预览、原生打开与保存。

桌面实现遵循 [Electron 官方安全建议](https://www.electronjs.org/docs/latest/tutorial/security)，使用隔离的 preload、sandbox、CSP 和受限 IPC。

## 实现范围

独立实现亮度映射、面积采样、Rec.709 加权、明暗校正、Floyd–Steinberg 误差扩散、2×4 Braille 点位映射与 Sobel 方向边缘。当前实现不包含 Chafa 的字符形状匹配、视频转换或动画导出。
