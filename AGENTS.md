# AGENTS.md

## 项目概览

CodePath 是一个基于 WXT、React 和 TypeScript 的浏览器扩展，用来在 GitHub 页面上直接阅读仓库代码。它会注入一个侧边栏，通过 GitHub 源码信息和兼容 OpenAI Chat Completions 的模型接口，帮助用户理解项目概览、功能路径、当前文件和后续追问。

## 开发命令

- 安装依赖：`npm install`
- Windows 下类型检查：`npm.cmd run compile`
- 构建 Chrome/Edge MV3 扩展：`npm.cmd run build`
- 构建并同步到 Edge 本地加载目录：`npm.cmd run deploy:edge`
- 启动 CodePath MCP Server：`npm.cmd run mcp`
- 构建产物目录：`.output/chrome-mv3`

MCP Server 使用环境变量读取配置：

- `CODEPATH_API_KEY` 或 `OPENAI_API_KEY`
- `CODEPATH_BASE_URL` 或 `OPENAI_BASE_URL`
- `CODEPATH_MODEL` 或 `OPENAI_MODEL`
- `CODEPATH_GITHUB_TOKEN` 或 `GITHUB_TOKEN`

## 扩展重载流程

源码修改后，按下面流程验证浏览器里的实际效果：

1. 执行 `npm.cmd run build`。
2. 将 `.output/chrome-mv3` 里的内容复制到浏览器当前加载的未打包扩展目录。
3. 打开 `edge://extensions`，重新加载 CodePath 扩展。
4. 刷新正在测试的 GitHub 页面。

当前常用 Edge 的未打包扩展加载目录是 `C:\CodePathExtension\chrome-mv3`。如果浏览器里显示的构建版本没有变化，优先检查是否只更新了 `.output/chrome-mv3`，但没有同步到这个实际加载目录。

推荐手动同步流程：

```powershell
npm.cmd run deploy:edge
```

然后在 `edge://extensions` 里重新加载 CodePath 扩展，并刷新 GitHub 页面。

如果之前把扩展从 Edge 中移除了，需要在 `edge://extensions` 开启开发人员模式，点击“加载解压缩”，选择 `C:\CodePathExtension\chrome-mv3`。不要选择项目根目录，也不要选择 `.output` 的上级目录。

如果通过命令行 `--load-extension` 加载没有生效，通常是因为 Edge 已经在运行，现有进程会吞掉新的加载参数。这种情况下要么手动加载解压缩扩展，要么先关闭所有 Edge 进程，再用 `--load-extension=C:\CodePathExtension\chrome-mv3` 启动。

不要提交构建产物、浏览器 profile、本机扩展安装目录、API Key 或 GitHub Token。

## 代码规范

- 改动范围要贴近当前需求，不做无关重构。
- 优先复用 `src/lib` 中已有的本地工具函数，再考虑新增抽象。
- 面向用户的中文文案要清楚、简洁、可操作。
- 任何新功能、用户可见行为变更、设置页变更、推荐追问变更、缓存/耗时显示变更，都必须同步更新可见的 CodePath 构建版本。
- 构建版本需要同时更新 `src/components/Sidebar.tsx` 的 `UI_VERSION` 和 `entrypoints/content.tsx` 的 `CONTENT_BUILD`，两者保持一致。
- 不要硬编码 API Key、GitHub Token、本机绝对路径或个人浏览器 profile 路径。

## 验证要求

发布或推送前至少执行：

```bash
npm.cmd run compile
npm.cmd run build
```

推送前还要扫描仓库，确认没有真实密钥、Token 或本机路径被提交。

## Git 开发管理流程

- `main` 只保留稳定、可演示、已验证版本。
- 新功能使用 `feat/*` 分支，问题修复使用 `fix/*` 分支，文档更新使用 `docs/*` 分支。
- 用户可见功能改动必须同步更新：
  - `src/components/Sidebar.tsx` 中的 `UI_VERSION`
  - `entrypoints/content.tsx` 中的 `CONTENT_BUILD`
- 每次提交前至少执行：
  - `npm.cmd run compile`
  - `npm.cmd run build`
  - `npm.cmd run deploy:edge`
  - `git diff --check`
  - 密钥、Token、本机路径扫描
- 浏览器侧改动验证流程：
  - 执行 `npm.cmd run deploy:edge`
  - 打开 `edge://extensions` 重新加载 CodePath
  - 刷新 GitHub 页面
  - 确认绿色构建版本变化
- 提交前确认 `git status` 和 `git diff --stat`，确保只提交本次任务相关文件。
- 不提交 `.output/`、本机 Edge 加载目录、浏览器 profile、API Key、GitHub Token、本机私人路径。
- 功能稳定后再合并到 `main`，阶段性稳定版本使用 Git tag 标记。
