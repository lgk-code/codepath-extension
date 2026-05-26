# AGENTS.md

## 项目概览

CodePath 是一个基于 WXT、React 和 TypeScript 的浏览器扩展，用来在 GitHub 页面上直接阅读仓库代码。它会注入一个侧边栏，通过 GitHub 源码信息和兼容 OpenAI Chat Completions 的模型接口，帮助用户理解项目概览、功能路径、当前文件和后续追问。

## 开发命令

- 安装依赖：`npm install`
- 类型检查：`npm run compile`
- 构建 Chrome/Edge MV3 扩展：`npm run build`
- 构建并同步到 Edge 本地加载目录：`npm run deploy:edge`
- 启动 CodePath MCP Server：`npm run mcp`
- 检查 MCP 工具名：`npm run verify:mcp-tools`
- 扫描密钥和本机私人路径：`npm run scan:secrets`
- 本地统一质量门禁：`npm run quality`
- 构建产物目录：`.output/chrome-mv3`

MCP Server 使用环境变量读取配置：

- `CODEPATH_API_KEY` 或 `OPENAI_API_KEY`
- `CODEPATH_BASE_URL` 或 `OPENAI_BASE_URL`
- `CODEPATH_MODEL` 或 `OPENAI_MODEL`
- `CODEPATH_GITHUB_TOKEN` 或 `GITHUB_TOKEN`

## 扩展重载流程

源码修改后，按下面流程验证浏览器里的实际效果：

1. 执行 `npm run build`。
2. 将 `.output/chrome-mv3` 里的内容复制到浏览器当前加载的未打包扩展目录。
3. 打开 `edge://extensions`，重新加载 CodePath 扩展。
4. 刷新正在测试的 GitHub 页面。

当前常用 Edge 的未打包扩展加载目录是 `C:\CodePathExtension\chrome-mv3`。在 WSL 中执行 `npm run deploy:edge` 时会同步到对应的 `/mnt/c/CodePathExtension/chrome-mv3`。如果浏览器里显示的构建版本没有变化，优先检查是否只更新了 `.output/chrome-mv3`，但没有同步到这个实际加载目录。

推荐手动同步流程：

```powershell
npm run deploy:edge
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
npm run quality
```

`quality` 会依次执行类型检查、扩展构建、MCP 工具名检查、密钥和本机私人路径扫描。必要时仍可拆开执行 `compile`、`build`、`verify:mcp-tools`、`scan:secrets` 方便定位问题。

## 质量门禁与 CI/CD

CodePath 采用“两层门禁”：

1. 本地门禁保证开发体验和浏览器真实效果。
2. GitHub Actions CI 保证推送到 GitHub 后能复现基础检查。

本地提交前至少执行：

- `npm run quality`
- `git diff --check`

涉及浏览器侧、设置页、推荐追问、缓存、耗时、流式输出或其他用户可见行为时，还必须执行：

- `npm run deploy:edge`
- 在 `edge://extensions` 重新加载 CodePath
- 刷新 GitHub 页面
- 确认设置页绿色构建版本变化

GitHub Actions 分为 CI 和 Release 两条流水线。CI 会在 `main` 的 push 和 pull request 上执行：

- `npm ci`
- `npm run compile`
- `npm run build`
- `npm run verify:mcp-tools`
- `npm run scan:secrets`
- 打包 `.output/chrome-mv3` 为 `codepath-chrome-mv3-<commit>.zip`
- 上传 Chrome/Edge 扩展 artifact，保留 14 天，供 PR 和 main 推送后人工下载验证

Release 会在推送 `v*` tag 时执行质量门禁、运行 `npx wxt zip -b chrome`，并把 WXT 生成的 zip 复制为用户下载资产 `CodePath.zip` 上传到 GitHub Release。README 的用户下载链接必须指向这个固定资产名。

CI 不运行 `deploy:edge`，因为它依赖本机 Windows 的 Edge 未打包扩展目录。CI 也不使用模型 API Key 或 GitHub Token，因此不能替代真实模型分析、私有仓库权限测试和浏览器 UI 手测。CI artifact 是开发验证包；正式用户下载包来自 GitHub Release 的 `CodePath.zip`。

Codex / GitHub Actions 工具用于查看 GitHub 上的 workflow 状态、失败日志、job 步骤和重跑失败任务。它适合在 CI 失败后定位问题，但不能替代本地 Edge 扩展重载和真实项目手测。

## Git 开发管理流程

- `main` 只保留稳定、可演示、已验证版本。
- 新功能使用 `feat/*` 分支，问题修复使用 `fix/*` 分支，文档更新使用 `docs/*` 分支。
- 用户可见功能改动必须同步更新：
  - `src/components/Sidebar.tsx` 中的 `UI_VERSION`
  - `entrypoints/content.tsx` 中的 `CONTENT_BUILD`
- 每次提交前至少执行：
  - `npm run quality`
  - `git diff --check`
- 浏览器侧改动验证流程：
  - 执行 `npm run deploy:edge`
  - 打开 `edge://extensions` 重新加载 CodePath
  - 刷新 GitHub 页面
  - 确认绿色构建版本变化
- 提交前确认 `git status` 和 `git diff --stat`，确保只提交本次任务相关文件。
- 不提交 `.output/`、本机 Edge 加载目录、浏览器 profile、API Key、GitHub Token、本机私人路径。
- 功能稳定后再合并到 `main`；需要发布给用户下载时推送 `v*` tag，让 Release workflow 生成 `CodePath.zip`。
