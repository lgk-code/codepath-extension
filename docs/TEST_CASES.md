# CodePath 人工回归测试清单

本文档用于每次发布前做人工 smoke test。目标是确认浏览器插件、MCP、动态推荐追问、Skill 导出、缓存管理和错误诊断没有回退。

## 发布前基础检查

每次提交或推送前至少执行：

```powershell
npm.cmd run compile
npm.cmd run build
npm.cmd run deploy:edge
```

然后执行：

- 在 `edge://extensions` 重新加载 CodePath。
- 刷新目标 GitHub 仓库页面，确认设置页绿色构建版本已变化。
- smoke test MCP 工具名仍为 4 个：`analyze_github_project`、`analyze_github_feature`、`generate_openclaw_skill`、`generate_project_blueprint`。
- 扫描仓库，确认没有 API Key、GitHub Token、本机私人路径和构建产物被提交。
- 设置页保存并测试后，确认流式输出模式能显示为实时流式、疑似缓冲、不支持流式或连接失败未测试之一。

## 案例 1：PAGE4D

- 仓库：`lgk-code/PAGE4D`
- 类型：Python ML / training flow
- 验证按钮：项目概览、功能路径、Skill / 蓝图、追问、复制 Markdown、下载 Markdown、缓存列表删除。
- 期望推荐追问：训练入口、数据加载、配置文件、评估流程、可视化或推理路径。
- 期望引用路径：`training/`、`eval/`、`requirements.txt`、`readme.md` 等。
- 通过标准：回答能说明训练/评估主线，能区分源码确认与谨慎推断，缓存列表能显示并删除 PAGE4D 项目缓存。
- 分析质量追加标准：能指出训练入口候选、数据加载、配置文件、评估路径，并把源码确认、谨慎推断和建议验证分开。
- 流式追加标准：项目概览和追问应显示实时流式或疑似缓冲提示；完成后 Markdown、sources、timing 正常。

## 案例 2：CodePath

- 仓库：`lgk-code/codepath-extension`
- 类型：WXT / React / MCP / browser extension
- 验证按钮：项目概览、功能路径、当前文件解释、缓存清理、缓存项目列表、Skill / 蓝图。
- 期望推荐追问：WXT 入口、content/background 通讯、Sidebar UI、MCP 工具注册、缓存策略。
- 期望引用路径：`entrypoints/`、`src/components/Sidebar.tsx`、`src/lib/analyzer.ts`、`scripts/codepath-mcp.ts`。
- 通过标准：回答能说明插件注入、后台通讯、分析器和 MCP 的分工；解释 `scripts/codepath-mcp.ts` 时能围绕工具注册和环境变量。
- 分析质量追加标准：能识别 WXT content/background 通讯、Sidebar UI、analyzer、MCP 工具注册和缓存策略的关键路径。

## 案例 3：前端项目

- 建议仓库：`vitejs/vite`
- 类型：前端工程 / TypeScript / 构建工具
- 验证按钮：项目概览、功能路径、追问。
- 期望推荐追问：入口文件、插件体系、配置加载、开发服务器、构建流程。
- 通过标准：能说明核心包目录和调用链，不把文档目录误判为主要实现。
- 分析质量追加标准：能识别配置加载、插件体系、开发服务器或构建入口，并标注依据路径。

## 案例 4：后端项目

- 建议仓库：`expressjs/express`
- 类型：Node.js API / middleware
- 验证按钮：项目概览、功能路径、当前文件解释。
- 期望推荐追问：路由、middleware、请求响应链路、错误处理、测试入口。
- 通过标准：能说明主入口、核心模块、测试或示例路径，并给出二次开发注意点。
- 分析质量追加标准：能识别 middleware、router、request/response 链路和错误处理相关路径。

## 错误诊断检查

至少手动确认以下场景的提示能指导用户下一步操作：

- 未填写模型 API Key：提示模型连接未测试。
- 错误模型 API Key：提示 Key 或模型权限问题。
- 错误 Base URL 或模型名：提示检查 OpenAI-compatible `/v1` 地址和模型名称。
- 不支持流式或接口缓冲：提示将使用普通一次性返回，或提示接口/代理可能缓冲 SSE。
- 未填写 GitHub Token 且触发 rate limit：提示填写 GitHub Token。
- 私有仓库或无权限仓库：提示仓库不存在、私有或 Token 权限不足。

## 回归关注点

- 推荐追问默认只用本地规则生成，不应触发额外模型请求。
- 点击推荐追问应立即发送，复制按钮应保留。
- Skill 输出应同时支持复制 Markdown 和下载 Markdown。
- 设置页应显示当前仓库缓存项数量、全部缓存项数量、最近一次清理结果和缓存项目列表。
- 缓存项目列表应支持展开 `owner/repo@branch`、删除某个项目缓存、删除某个单项缓存。
- 缓存命中结果顶部应显示“来自缓存”，并提示清空当前仓库缓存后可重新分析。
