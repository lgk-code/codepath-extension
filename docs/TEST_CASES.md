# CodePath 人工回归测试清单

本文档用于每次发布前做 smoke test。目标是确认浏览器插件、MCP、动态推荐追问、Skill 导出、缓存管理和错误诊断没有回退。

## 发布前基础检查

每次提交或推送前至少执行：

```powershell
npm.cmd run quality
git diff --check
```

`quality` 会依次执行类型检查、扩展构建、MCP 工具名检查、密钥和本机私人路径扫描。需要定位问题时，可以拆开执行 `compile`、`build`、`verify:mcp-tools`、`scan:secrets`。

## 自动 CI 与 Release 检查

GitHub Actions 会在 `main` 的 push 和 pull request 上自动执行基础 CI：

- 安装依赖。
- 类型检查。
- 构建 Chrome/Edge MV3 扩展。
- 检查 MCP 4 个工具名。
- 扫描常见密钥、Token 和本机私人路径。
- 打包并上传 `codepath-chrome-mv3-<commit>` artifact，供开发验证。

CI artifact 用于开发验证，不是正式发布包。面向用户的正式下载包由 `v*` tag 触发 Release workflow 生成，资产名固定为 `CodePath.zip`。

## 人工浏览器检查

涉及浏览器侧或用户可见行为时继续执行：

```powershell
npm.cmd run deploy:edge
```

然后手动执行：

- 在 `edge://extensions` 重新加载 CodePath。
- 刷新目标 GitHub 仓库页面，确认设置页绿色构建版本已变化。
- 设置页保存并测试后，确认流式输出模式能显示为实时流式、疑似缓冲、不支持流式或连接失败未测试之一。

CI 通过不代表浏览器扩展已经重新加载，也不代表真实模型 API、GitHub Token 权限、流式输出和 UI 手感已经验证。

## 三层门禁判定

- 自动 CI 门禁：保证代码能在 GitHub runner 上安装、类型检查、构建、基础扫描，并产出可下载 artifact。
- 本地质量门禁：保证当前工作区通过 `npm.cmd run quality` 和 `git diff --check`。
- 人工浏览器门禁：保证 Edge 实际加载的是新构建，真实 GitHub 页面、真实模型配置和真实 UI 交互没有回退。
- Release 门禁：推送 `v*` tag 后应产出 GitHub Release 资产 `CodePath.zip`，README 下载链接应能直接下载该文件。

## 文档展示检查

- GitHub 仓库首页默认展示中文 `README.md`。
- `README.en.md` 存在，且顶部能链接回中文 README。
- 中文 README 顶部能链接到英文 README。
- README 面向普通用户，不应出现本地构建、CI artifact 或测试门禁说明。
- README 的 `CodePath.zip` 下载链接应指向 `releases/latest/download/CodePath.zip`。
- 演示站点页脚应提供中文 README 和英文 README 入口。

## 案例 1：PAGE4D

- 仓库：`lgk-code/PAGE4D`
- 类型：Python ML / training flow
- 验证按钮：项目概览、功能路径、Skill / 蓝图、追问、复制 Markdown、下载 Markdown、缓存列表删除。
- 期望推荐追问：训练入口、数据加载、配置文件、评估流程、可视化或推理路径。
- 期望引用路径：`training/`、`eval/`、`requirements.txt`、`readme.md` 等。
- 通过标准：回答能说明训练/评估主线，能区分源码确认与谨慎推断，缓存列表能显示并删除 PAGE4D 项目缓存。
- 分析质量追加标准：能指出训练入口候选、数据加载、配置文件、评估路径，并把源码确认、谨慎推断和建议验证分开。
- 分析质量 v2 标准：功能路径查询“训练流程”时，候选来源应优先覆盖训练入口、数据加载、配置、评估相关文件，而不是只返回 README。
- 流式追加标准：项目概览和追问应显示实时流式或疑似缓冲提示；完成后 Markdown、sources、timing 正常。

## 案例 2：CodePath

- 仓库：`lgk-code/codepath-extension`
- 类型：WXT / React / MCP / browser extension
- 验证按钮：项目概览、功能路径、当前文件解释、缓存清理、缓存项目列表、Skill / 蓝图。
- 期望推荐追问：WXT 入口、content/background 通讯、Sidebar UI、MCP 工具注册、缓存策略。
- 期望引用路径：`entrypoints/`、`src/components/Sidebar.tsx`、`src/lib/analyzer.ts`、`scripts/codepath-mcp.ts`。
- 通过标准：回答能说明插件注入、后台通讯、分析器和 MCP 的分工；解释 `scripts/codepath-mcp.ts` 时能围绕工具注册和环境变量。
- 分析质量追加标准：能识别 WXT content/background 通讯、Sidebar UI、analyzer、MCP 工具注册和缓存策略的关键路径。
- 分析质量 v2 标准：项目类型应识别为 WXT / 浏览器插件；功能路径查询“MCP”“缓存管理”“浏览器侧边栏”时，应优先引用 `entrypoints/`、`src/components/Sidebar.tsx`、`src/lib/analyzer.ts`、`scripts/codepath-mcp.ts` 等核心路径，并在结构上下文中展示相对 import 映射。

## 案例 3：前端项目

- 建议仓库：`vitejs/vite`
- 类型：前端工程 / TypeScript / 构建工具
- 验证按钮：项目概览、功能路径、追问。
- 期望推荐追问：入口文件、插件体系、配置加载、开发服务器、构建流程。
- 通过标准：能说明核心包目录和调用链，不把文档目录误判为主要实现。
- 分析质量追加标准：能识别配置加载、插件体系、开发服务器或构建入口，并标注依据路径。
- 分析质量 v2 标准：功能路径查询“插件体系”时，应优先出现配置、插件容器、开发服务器或构建流程核心文件，且说明哪些结论来自源码确认。

## 案例 4：后端项目

- 建议仓库：`expressjs/express`
- 类型：Node.js API / middleware
- 验证按钮：项目概览、功能路径、当前文件解释。
- 期望推荐追问：路由、middleware、请求响应链路、错误处理、测试入口。
- 通过标准：能说明主入口、核心模块、测试或示例路径，并给出二次开发注意点。
- 分析质量追加标准：能识别 middleware、router、request/response 链路和错误处理相关路径。
- 分析质量 v2 标准：功能路径查询“middleware”或“路由”时，应优先覆盖入口、router、middleware、request/response 相关核心路径。

## 错误诊断检查

至少手动确认以下场景的提示能指导用户下一步操作：

- 未填写模型 API Key：提示模型连接未测试。
- 粘贴完整 `/chat/completions` 或 `/models` 地址：保存后 Base URL 应归一化为 OpenAI-compatible 基础地址。
- 填写 API Key 和 Base URL 后点击“获取模型”：可用模型列表自动填充并默认选中一个模型；接口不支持 `/models` 时提示可手动填写模型名。
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
