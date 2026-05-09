# AGENTS.md

## 项目概览

CodePath 是一个基于 WXT、React 和 TypeScript 的浏览器扩展，用来在 GitHub 页面上直接阅读仓库代码。它会注入一个侧边栏，通过 GitHub 源码信息和兼容 OpenAI Chat Completions 的模型接口，帮助用户理解项目概览、功能路径、当前文件和后续追问。

## 开发命令

- 安装依赖：`npm install`
- Windows 下类型检查：`npm.cmd run compile`
- 构建 Chrome/Edge MV3 扩展：`npm.cmd run build`
- 构建产物目录：`.output/chrome-mv3`

## 扩展重载流程

源码修改后，按下面流程验证浏览器里的实际效果：

1. 执行 `npm.cmd run build`。
2. 将 `.output/chrome-mv3` 里的内容复制到浏览器当前加载的未打包扩展目录。
3. 打开 `edge://extensions`，重新加载 CodePath 扩展。
4. 刷新正在测试的 GitHub 页面。

当前常用 Edge 的未打包扩展加载目录是 `C:\CodePathExtension\chrome-mv3`。如果浏览器里显示的构建版本没有变化，优先检查是否只更新了 `.output/chrome-mv3`，但没有同步到这个实际加载目录。

推荐手动同步流程：

```powershell
npm.cmd run build
Remove-Item -Recurse -Force C:\CodePathExtension\chrome-mv3\*
Copy-Item -Recurse -Force .output\chrome-mv3\* C:\CodePathExtension\chrome-mv3
```

然后在 `edge://extensions` 里重新加载 CodePath 扩展，并刷新 GitHub 页面。

如果之前把扩展从 Edge 中移除了，需要在 `edge://extensions` 开启开发人员模式，点击“加载解压缩”，选择 `C:\CodePathExtension\chrome-mv3`。不要选择项目根目录，也不要选择 `.output` 的上级目录。

如果通过命令行 `--load-extension` 加载没有生效，通常是因为 Edge 已经在运行，现有进程会吞掉新的加载参数。这种情况下要么手动加载解压缩扩展，要么先关闭所有 Edge 进程，再用 `--load-extension=C:\CodePathExtension\chrome-mv3` 启动。

不要提交构建产物、浏览器 profile、本机扩展安装目录、API Key 或 GitHub Token。

## 代码规范

- 改动范围要贴近当前需求，不做无关重构。
- 优先复用 `src/lib` 中已有的本地工具函数，再考虑新增抽象。
- 面向用户的中文文案要清楚、简洁、可操作。
- 修改侧边栏行为时，要同步更新可见的 CodePath 构建版本，方便手动确认浏览器加载的是最新代码。
- 不要硬编码 API Key、GitHub Token、本机绝对路径或个人浏览器 profile 路径。

## 验证要求

发布或推送前至少执行：

```bash
npm.cmd run compile
npm.cmd run build
```

推送前还要扫描仓库，确认没有真实密钥、Token 或本机路径被提交。
