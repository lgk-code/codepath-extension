# CodePath 开发指南

## 本机开发环境

CodePath 的权威工作副本位于 `E:\projects\CodePath`，后续开发使用 Windows 原生 Git、Node.js 和 npm。原 WSL 仓库仅作为迁移备份，不再用于日常编辑、构建或提交。

要求：

- Git for Windows。
- Node.js 22.13 或更高版本；推荐与 CI 一致使用 Node.js 24。
- npm 10 或更高版本。
- Edge 或 Chrome，并开启扩展开发人员模式。

首次安装：

```powershell
cd E:\projects\CodePath
npm.cmd ci
```

`npm ci` 会严格使用 `package-lock.json`。不要从 WSL 复制 `node_modules`、`.wxt` 或 `.output`，这些目录必须由当前 Windows 环境重新生成。

## Git 工作流

`main` 只保留稳定、已验证的版本。开始工作前从最新 `main` 建立主题分支：

```powershell
git switch main
git pull --ff-only
git switch -c feat/example-feature
```

问题修复使用 `fix/*`，文档更新使用 `docs/*`。提交前检查实际范围：

```powershell
git status --short
git diff --stat
git diff --check
```

提交信息使用简短的 Conventional Commit 风格，例如：

```text
feat: add repository snapshot validation
fix: avoid stale analysis cache reuse
docs: update Windows development workflow
```

本地门禁和独立审查通过后，推送当前主题分支并创建以 `main` 为目标的 Pull Request：

```powershell
git push -u origin HEAD
```

不要直接把未审查的功能提交推送到 `main`。

不要提交依赖、构建产物、浏览器 profile、API Key、GitHub Token 或本机扩展安装目录。

## 质量门禁

提交或推送前运行：

```powershell
npm.cmd run quality
git diff --check
```

`quality` 包含自动测试、类型检查、扩展构建、构建版本一致性检查、MCP 工具名检查和敏感信息扫描。需要定位问题时，可以单独运行 `npm.cmd run test`、`compile`、`build`、`verify:build-version`、`verify:mcp-tools` 或 `scan:secrets`。

GitHub Actions 会在 `main` 的 push 和 pull request 上使用 Linux runner 重复基础门禁。Windows 本机门禁与 Linux CI 都必须保持可用。

## Edge 扩展部署

浏览器加载的是独立的未打包扩展目录，不是项目根目录。当前默认目标是 `D:\edge下载\CodePath`：

```powershell
npm.cmd run deploy:edge
```

需要使用其他目录时，在当前 PowerShell 会话设置：

```powershell
$env:CODEPATH_EDGE_EXTENSION_DIR="D:\path\to\CodePath"
$env:CODEPATH_EDGE_EXTENSION_ROOT="D:\path\to"
npm.cmd run deploy:edge
```

脚本会构建 `.output/chrome-mv3`，安全同步到目标目录，并写入 `codepath-dev-reload.json`。已经加载 self reload 版本的 development install 会自动重载；首次从旧版本升级时仍可能需要在 `edge://extensions` 手动重新加载一次。

## MCP Server

本机启动：

```powershell
cd E:\projects\CodePath
npm.cmd run mcp
```

模型和 GitHub 配置通过环境变量提供，详见 [MCP 使用教程](MCP_USAGE.md)。不要把真实密钥写入仓库文件。

## 发布边界

- 本地 `deploy:edge` 只验证当前开发安装，不生成正式发布包。
- CI artifact 用于开发验证。
- 正式发布使用 annotated `v*` tag（例如 `git tag -a v0.1.3 -m "v0.1.3"`）；tag 必须匹配 `package.json` 版本、指向当前 checkout `HEAD`，且 commit 已进入 `origin/main`。
- 推送 annotated tag 后，从默认分支发送受信发布事件：`gh api repos/lgk-code/codepath-extension/dispatches --method POST -f event_type=release -f "client_payload[tag]=v0.1.3"`。tag push 本身不发布。
- Release workflow 先以只读权限验证 tag/main/package 并构建，再由 `release` environment 的独立写权限 job 发布固定资产 `CodePath.zip`；仓库应为该 environment 配置所需审批。
- 迁移备份和 `E:\projects\CodePath-migration.bundle` 不属于仓库，也不得上传到 Release。
