# Carnet PDF

Windows 本地 PDF 阅读器，当前版本 **1.12.1**。透明毛玻璃主题、连续滚动、分类与日期浏览、文本选择、彩色高亮、批注、书签、回收站与收藏夹，资料保存在本地。

打开 PDF 后点击工具栏爱心，输入单页或页码范围（例如 `2, 5-7`），将所选页面提取成独立 PDF，保留这些页的高亮、批注和书签。收藏夹按收录时间排列；可以自定名称、以后重命名，名称留空时使用收录时间。原报纸删除后，收录内容仍可阅读。

地中海已恢复 1.9.1 的柔和水波；巴黎雨滴、玫瑰光效和小新草木风动保留 1.10 的更新。

1.12 默认主题为地中海；收藏夹使用爱心入口；柠檬枝叶图标去除原图外部白边并保留内部画面。新增应用内屏保，默认 1 分钟无操作后显示完整背景、时间、日期与一句话，可在底部「屏保」通过滑块开关、数字及上下箭头设置等待时间，修改后自动保存。

## 源码与运行版

本仓库保存可修改的源码、构建脚本、测试、主题素材及第三方许可。已打包的 Windows 版本位于 GitHub Releases。运行版解压后为 `Carnet.exe`、`App/` 和 `Files/`。

`Files/` 是个人资料库，包含导入 PDF、分类、阅读位置、高亮、批注、书签和专用浏览器配置，**不会提交到 GitHub**。更新程序时保留自己的 `Files/`。

## 开发

需要 Node.js **24.19.0**、Windows 及 Chrome 或 Edge。EXE 构建使用 Windows 自带 .NET Framework 4 编译器。

```powershell
cd App
npm ci
Copy-Item (Get-Command node).Source runtime/node.exe
npm run build
npm start
```

浏览器打开 `http://127.0.0.1:4328`。完成运行时复制和构建后，也可使用根目录 `Carnet.exe`。EXE 需要 `App/runtime/node.exe`；资料库默认在仓库根目录 `Files/`。

## 测试

先完成上述运行时复制与构建，再在 `App/` 内运行（完整测试包含真实 Windows EXE 启停）：

```powershell
npm test
npm run test:browser
```

浏览器测试默认 Edge；使用 Chrome 时先设置 `$env:TEST_BROWSER='chrome'`。测试数据写入仓库内被忽略的 `.work/`，与个人资料库分开。测试 PDF 均为本项目的合成样本。

实际报刊回归为可选测试：设置 `CARNET_SELECTION_PDF` 为自己本机的 PDF 路径后运行；该原始 PDF 不随源码上传。

## 制作 Windows 便携包

需要 Python 3（只用标准库）。先完成上面的依赖安装、构建和测试，然后在仓库根目录运行：

```powershell
Copy-Item (Get-Command node).Source App/runtime/node.exe
python App/scripts/package.py
```

请使用 Node.js 24.19.0 的 Windows x64 运行时，与 `App/runtime/LICENSE.txt` 对应。打包输出在 `dist/Carnet-PDF-Windows.zip`，同时生成 SHA-256 文件。脚本只包含明确列出的程序资源，创建空的 `Files/`，不会打入本机资料、开发依赖或测试数据。

## 后续修改位置

| 目录 | 内容 |
| --- | --- |
| `App/src/` | 阅读界面、PDF.js 集成、选区、批注与主题动画 |
| `App/server/` | 本地 HTTP API、资料库与 PDF 持久保存 |
| `App/desktop/` | Windows 启动器、窗口生命周期与图标 |
| `App/public/` | 背景、字体及离线 PDF.js / Raindrop-FX 资源 |
| `App/scripts/` | 构建、启动、停止、窗口监测与打包 |
| `App/tests/` | 逻辑、API、浏览器回归和合成 PDF |

完整功能和限制见 [使用说明](App/README.md)，历史检查见 [验证记录](App/VERIFICATION.md)。背景图和图标使用现有素材；原 Carnet 项目及原画保持独立。素材和第三方代码的许可分别见 [第三方说明](App/THIRD-PARTY-NOTICES.txt) 及对应 LICENSE 文件；本仓库不额外授予第三方图片的再分发许可。
