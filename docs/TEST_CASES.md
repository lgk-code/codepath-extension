# CodePath 人工回归测试清单

本文档用于每次发布前做人工 smoke test。重点确认浏览器插件、MCP、推荐追问、Skill 导出和缓存状态没有回退。

## 通用验证步骤

1. 执行 `npm.cmd run compile`。
2. 执行 `npm.cmd run build`。
3. 执行 `npm.cmd run deploy:edge`。
4. 在 `edge://extensions` 重新加载 CodePath。
5. 刷新目标 GitHub 仓库页面，确认设置页绿色构建版本已变化。

## 案例 1：PAGE4D

- 仓库：`lgk-code/PAGE4D`
- 类型：Python ML / training flow
- 验证按钮：项目概览、功能路径、Skill / 蓝图、追问、复制和下载 Markdown。
- 推荐追问方向：训练入口、数据加载、配置文件、评估流程、可视化或推理路径。
- 期望输出：能引用 `training/`、`eval/`、`requirements.txt`、`readme.md` 等路径，并区分源码确认与谨慎推断。

## 案例 2：CodePath

- 仓库：`lgk-code/codepath-extension`
- 类型：WXT / React / MCP / browser extension
- 验证按钮：项目概览、功能路径、当前文件解释、缓存清理、缓存状态、Skill / 蓝图。
- 推荐追问方向：WXT 入口、content/background 通讯、Sidebar UI、MCP 工具注册、缓存策略。
- 期望输出：能引用 `entrypoints/`、`src/components/Sidebar.tsx`、`src/lib/analyzer.ts`、`scripts/codepath-mcp.ts`。

## 案例 3：前端项目

- 建议仓库：`vitejs/vite`
- 类型：前端工程 / TypeScript / 构建工具
- 验证按钮：项目概览、功能路径、追问。
- 推荐追问方向：入口文件、插件体系、配置加载、开发服务器、构建流程。
- 期望输出：能说明核心包目录和调用链，不把文档目录误判成主要实现。

## 案例 4：后端项目

- 建议仓库：`expressjs/express`
- 类型：Node.js API / middleware
- 验证按钮：项目概览、功能路径、当前文件解释。
- 推荐追问方向：路由、middleware、请求响应链路、错误处理、测试入口。
- 期望输出：能说明主入口、核心模块、测试或示例路径，并给出二次开发注意点。

## 回归关注点

- 推荐追问默认只用本地规则生成，不应触发额外模型请求。
- 点击推荐追问应立即发送，复制按钮应保留。
- Skill 输出应同时支持复制 Markdown 和下载 Markdown。
- 设置页应显示当前仓库缓存项数量、全部缓存项数量和最近一次清理结果。
- 缓存命中结果顶部应显示“来自缓存”，并提示清空当前仓库缓存后可重新分析。
- MCP 工具名保持不变：`analyze_github_project`、`analyze_github_feature`、`generate_openclaw_skill`、`generate_project_blueprint`。
