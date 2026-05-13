# CodePath 浏览器扩展

[中文](README.md) | [English](README.en.md)

[![CI](https://github.com/lgk-code/codepath-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/lgk-code/codepath-extension/actions/workflows/ci.yml)

CodePath 是一个面向 GitHub 源码阅读的浏览器扩展，也可以作为 MCP Server 提供给 OpenClaw 兼容 agent 使用。它的目标不是复制目标项目代码，而是在 GitHub 页面上快速提炼项目结构、技术栈、功能实现路径、源码依据和可复用的工程经验。

## 当前能力

- 在 GitHub 仓库页面注入可调整宽度的 CodePath 侧边栏。
- 分析项目概览：用途、技术栈、目录职责、入口文件和推荐阅读路线。
- 分析功能路径：例如登录、上传、搜索、训练流程、MCP、缓存管理等目标功能。
- 解释当前 GitHub 文件页面。
- 支持概览、功能、文件和历史记录视图中的连续追问。
- 根据当前分析结果和源码引用动态生成推荐追问，并支持本地刷新。
- 在浏览器侧生成并导出 OpenClaw Skill、新项目蓝图或给人读的技术分析 Markdown。
- 显示回答耗时、缓存命中、缓存状态、缓存单项管理和连接诊断。
- 支持 Markdown 渲染、源码路径链接、流式输出探测和普通返回回退。
- 提供 MCP Server，方便 OpenClaw 直接调用项目分析能力。

## 技术栈

- WXT
- React
- TypeScript
- Manifest V3
- React Markdown
- GitHub REST API
- Qwen / OpenAI-compatible Chat Completions API

## 快速开始

安装依赖：

```bash
npm install
```

构建并同步到本机 Edge 未打包扩展目录：

```bash
npm run deploy:edge
```

然后打开 `edge://extensions`，开启开发人员模式，重新加载 CodePath，刷新 GitHub 仓库页面。

在 CodePath 设置页中配置：

- API Key：Qwen 或 OpenAI-compatible 模型密钥。
- Base URL：默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
- Model：默认 `qwen-plus`。
- GitHub Token：可选，用于提高 GitHub API 限额和访问私有仓库。

点击“保存并测试”后，CodePath 会检查模型连接，并探测当前接口是否支持流式输出。支持时浏览器侧会自动增量展示，不支持时回退到普通一次性返回。

## 常用开发命令

```bash
npm run dev
npm run compile
npm run build
npm run deploy:edge
npm run quality
```

`quality` 会依次执行类型检查、扩展构建、MCP 工具名检查、密钥和本机私人路径扫描。需要定位问题时，可以拆开执行：

```bash
npm run compile
npm run build
npm run verify:mcp-tools
npm run scan:secrets
```

Chrome / Edge MV3 构建产物位于：

```text
.output/chrome-mv3
```

## MCP / OpenClaw

CodePath 可以作为 MCP Server 运行，让 OpenClaw 兼容 agent 不打开浏览器也能分析 GitHub 仓库。

启动 MCP Server：

```bash
npm run mcp
```

可用工具：

- `analyze_github_project`
- `analyze_github_feature`
- `generate_openclaw_skill`
- `generate_project_blueprint`

MCP 返回结构化 JSON 文本，包含 `repo`、`feature`、`summary`、`sources`、`timing`、`confirmedFacts`、`inferredNotes`、`nextActions` 等字段。

更多配置见 [CodePath MCP 使用教程](docs/MCP_USAGE.md)，集成设计见 [OpenClaw 集成方案](OPENCLAW_INTEGRATION.md)。

## 演示网站

静态演示网站位于 [docs/index.html](docs/index.html)，适合通过 GitHub Pages 发布。当前包含：

- 浏览器插件使用流程。
- MCP / OpenClaw 调用说明。
- PAGE4D 真实分析案例。
- CodePath 自分析案例。

人工回归清单见 [docs/TEST_CASES.md](docs/TEST_CASES.md)。

## 质量门禁与 CI

CodePath 使用三层门禁：

- 本地质量门禁：`npm run quality`。
- GitHub Actions CI：在 `main` push 和 pull request 上自动安装依赖、类型检查、构建扩展、检查 MCP 工具名、扫描密钥和本机私人路径，并上传 Chrome/Edge MV3 artifact。
- 人工浏览器门禁：涉及用户可见扩展行为时，必须执行 `npm run deploy:edge`，在 `edge://extensions` 重新加载扩展，刷新 GitHub 页面，并确认设置页绿色构建版本变化。

CI 不运行 `deploy:edge`，也不使用模型 API Key 或 GitHub Token，因此不能替代真实模型分析、私有仓库权限测试、流式输出体验和 UI 手测。

下载 CI 构建包试用：

1. 打开仓库的 Actions 页面，选择最新成功的 CI run。
2. 下载 `codepath-chrome-mv3-<commit>` artifact。
3. 解压 artifact，再解压其中的扩展 zip。
4. 在 Chrome / Edge 开发人员模式中加载解压后的目录。

CI artifact 是便于人工验证的测试包，不是浏览器商店签名发布包。

## 常见问题

- 浏览器里没有变化：确认设置页绿色构建版本是否变化，然后在 `edge://extensions` 重新加载 CodePath 并刷新 GitHub 页面。
- GitHub 404 或私有仓库无法访问：配置具备 Contents read 权限的 GitHub Token。
- GitHub rate limit：配置 GitHub Token 后重试。
- 模型 401/403：检查 API Key、模型访问权限和服务商账号状态。
- 模型 404：检查 Base URL 是否是 OpenAI-compatible `/v1` 地址，模型名是否正确。
- 回答慢：查看结果中的阶段耗时，区分 GitHub 请求、文件读取、上下文构造和模型请求耗时。
- 流式看起来像一次性返回：设置页会显示实时流式、疑似缓冲、不支持流式或失败回退；部分代理会缓冲 SSE。

## 后续路线

- 完善真实使用闭环：流式诊断、错误提示、人工回归和演示案例。
- 保持 CI/CD 轻量：基础门禁已完成，artifact 打包已接入，后续再做 tag release 自动化。
- 深化项目理解：项目类型模板、相对 import 映射、候选文件排序、源码确认/谨慎推断标注。
- 持续验证 OpenClaw Skill / 蓝图在真实项目中的可执行性。
- 在 GitHub 分析稳定后，再增加本地项目分析模式。
- 建立文件职责图、功能调用链和项目经验库。

完整计划见 [ROADMAP.md](ROADMAP.md)。

## 安全说明

CodePath 会把用户配置的 API Key 和 Token 存在当前浏览器扩展环境的本地存储中，不会写入仓库。开发、提交和 issue/PR 交流中不要粘贴真实密钥；临时测试 Token 使用后建议及时撤销。
