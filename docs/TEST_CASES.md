# CodePath 人工回归测试清单

本文档用于每次发布前做 smoke test。目标是确认浏览器插件、MCP、动态推荐追问、Skill 导出、缓存管理和错误诊断没有回退。

## 发布前基础检查

每次提交或推送前至少执行：

```powershell
cd E:\projects\CodePath
npm.cmd run quality
git diff --check
```

`quality` 会依次执行测试、类型检查、扩展构建、构建版本一致性检查、MCP 工具名检查、密钥和本机私人路径扫描。需要定位问题时，可以拆开执行 `test`、`compile`、`build`、`verify:build-version`、`verify:mcp-tools`、`scan:secrets`。

## 自动 CI 与 Release 检查

GitHub Actions 会在 `main` 的 push 和 pull request 上自动执行基础 CI：

- 安装依赖。
- 运行自动测试。
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

然后确认：

- CodePath 在 development install 中读取 `codepath-dev-reload.json` 后自行重载。首次升级到带 self reload 的版本时仍需要在 `edge://extensions` 手动重新加载一次。
- 已打开的 GitHub 仓库页自动刷新；如果没有自动刷新，手动刷新目标 GitHub 仓库页面。
- 设置页绿色构建版本已变化。
- 本轮安全加固版本应显示为 `dev-2026-07-09-adversarial-hardening-v2`。
- 设置页保存并测试后，确认流式输出模式能显示为实时流式、疑似缓冲、不支持流式或连接失败未测试之一。

CI 通过不代表浏览器扩展已经在本机 Edge 中 self reload，也不代表真实模型 API、GitHub Token 权限、流式输出和 UI 手感已经验证。

## 三层门禁判定

- 自动 CI 门禁：保证代码能在 GitHub runner 上安装、类型检查、构建、基础扫描，并产出可下载 artifact。
- 本地质量门禁：保证当前工作区通过 `npm.cmd run quality` 和 `git diff --check`。
- 人工浏览器门禁：保证 Edge 实际加载的是新构建，真实 GitHub 页面、真实模型配置和真实 UI 交互没有回退。
- Release 门禁：推送 `v*` tag 后应产出 GitHub Release 资产 `CodePath.zip`，README 下载链接应能直接下载该文件。

## 文档展示检查

- GitHub 仓库首页默认展示中文 `README.md`。
- `README.en.md` 存在，且顶部能链接回中文 README。
- 中文 README 顶部能链接到英文 README。
- README 面向普通用户，可以链接开发指南，但不应内嵌本地构建、CI artifact 或测试门禁步骤。
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
- 粘贴完整 `/chat/completions`、`/messages` 或 `/models` 地址：保存后 Base URL 应归一化为服务商 `/v1` 基础地址。
- 填写 API Key 和 Base URL 后点击“获取模型”：可用模型列表自动填充并默认选中一个模型；接口不支持 `/models` 时提示可手动填写模型名。
- 错误模型 API Key：提示 Key 或模型权限问题。
- 错误服务商类型、Base URL 或模型名：提示检查 OpenAI/Anthropic 接口类型、`/v1` 地址和模型名称。
- 不支持流式或接口缓冲：提示将使用普通一次性返回，或提示接口/代理可能缓冲 SSE。
- 未填写 GitHub Token 且触发 rate limit：提示填写 GitHub Token。
- 私有仓库或无权限仓库：提示仓库不存在、私有或 Token 权限不足。

## 缓存新鲜度与来源边界

- 对一个仓库完成分析后再次分析：HEAD 和 tree 均未变化时允许命中结果缓存，并显示原始 commit 与最近校验时间。
- 推送修改源码的 commit 后再次分析：tree SHA 变化，旧模型结果不得直接显示，必须重新读取源码并调用模型。
- 创建空提交后再次分析：HEAD 变化但 tree SHA 不变，允许复用结果，并显示“提交已更新，源码树未变”。
- 打开含 `/` 的分支文件 URL：只有 GitHub ref 与文件路径能唯一校验时才分析；多解、限流或无法校验时必须明确报错。
- commit/tag-like 首段不能提前丢弃其他边界；例如 `v1.2.3/hotfix` 必须作为候选 ref 交给 GitHub 校验。
- ref/path 歧义先用至多两次 bounded `matching-refs` 查询筛选真实 branch/tag，再对最多 8 个实际存在的 ref 各发一次 HEAD 类型检查；不得下载大文件正文、按路径深度拒绝正常 URL，或为每个候选下载 recursive tree。
- 同一个 `GithubClient` 内重复解析相同 ref/path 必须命中 memoized 结果，追问的 snapshot 校验和源码加载不能重复消耗整套消歧请求。
- 超长 GitHub URL 必须在二次复杂度的 ref/path 候选物化前拒绝。
- owner/repo 段包含编码后的 `/`、`\\`、`.` 或 `..` 时必须拒绝解析；所有 GitHub API 与 codeload 请求必须分别编码 owner/repo 路径段。
- API/ZIP client 的直接调用也必须复用同一 owner/repo validator；即使绕过 URL parser，`..` 或含分隔符的身份也不能带 Token 发出 fetch。
- branch/path 段解码后包含 `/`、`\\`、`.` 或 `..` 路径分量时也必须拒绝；`GithubClient.getFile` 在 fetch 前再次拒绝相对路径穿越。
- GitHub API 触发 rate limit 且当前是仓库根页面：ZIP fallback 应读取 codeload `HEAD`，状态显示为 `unchecked`，结果不得长期复用。
- ZIP fallback 收到显式 branch、tag 或 40 位 commit 时，应通过 codeload 通用 exact-ref 路径请求该 ref，不得强制拼接 `refs/heads/`。
- GitHub API 触发 rate limit 且当前文件 URL 存在 ref/path 歧义：不得用 ZIP 猜测分支，应提示改用 immutable commit URL 或仓库根页面。

## 传输、流式与安全窗口

- 安全窗口保存 API Key 和 GitHub Token 后，设置页重新读取的值掩码应立即变化；清除后也应同步生效。
- 中性代理 URL 配置为 Anthropic provider 时，应发送 `/messages` 与 `x-api-key`，不得退回 OpenAI 格式。
- 长时间模型请求期间后台每 20 秒发送 heartbeat；前端不得因端口超时通过 `sendMessage` 重放分析。
- `list-models` 只有在 port 请求尚未成功投递时才允许本地 fallback；投递后的超时、断连或流错误不得切换 transport 重放。
- GitHub 单页导航后、Sidebar 状态刷新前发起的旧页面请求必须被当前位置校验拒绝，不得发送旧 branch/path。
- 已投递分析在 GitHub 单页导航后返回时，完成、错误、fallback 和流式 delta 都必须直接比对当前 `location.href`，不得在 800 ms 轮询窗口内提交旧结果。
- 同一 repo/target 的新任务启动后，旧任务的 fallback 必须因 runId 不同而被拒绝，不能修改新任务的 stream 状态。
- OpenAI `[DONE]` 和 Anthropic `message_stop` 到达后应立即完成，不等待服务端关闭连接。
- 大量流式 delta 应按批次刷新 Markdown；最终文本不能丢字、重复或跨仓库显示。

## 部署与发布门禁

- 临时允许根目录部署时，staging 复制或提升失败必须保留原目标内容并清理 staging/backup。
- 部署目标等于项目、位于项目内、包含项目，或经 junction 解析后与项目树重叠时必须拒绝。
- 两个进程同时部署到同一目标时必须由独占锁串行提升；后完成的有效部署不得被另一进程的 rollback 恢复为旧版本。
- Windows 与 WSL 共享部署目标时，锁不得依赖 PID 命名空间；新鲜 lease 必须通过 heartbeat 保持，过期 lease 和创建后崩溃留下的空锁必须可恢复。
- heartbeat 只能更新 token 专属 sidecar 的时间戳，不能截断 lock 文件；promotion 和 backup 清理前必须复验 lease，backup 名必须绑定单次部署。
- 初始 lock 必须先完整写入候选文件，再通过同目录 hard-link 排他发布；同名但无合法事务 marker 的 `CodePath.backup-*` 目录不得读取、恢复或删除。
- stale 接管必须先原子移走 token heartbeat 形成 fencing；若移走瞬间 heartbeat 已刷新，应恢复并放弃接管，旧 owner 失去 heartbeat 后不得继续目标变更。
- 目标变更必须持有按规范化目标路径命名的 Windows system Mutex；Windows 与 WSL 使用同一个 Mutex，owner 进程退出时 helper 必须自动释放。文件 lease 仅用于恢复状态，不得依赖跨 runtime PID 或 PID 未复用假设。
- 默认 `D:\edge下载\CodePath` 部署后同时存在有效 MV3 `manifest.json` 和新版本 `codepath-dev-reload.json`。
- Release 必须使用与 `package.json` 版本完全一致的 annotated tag；tag peel 后的 commit 必须等于 checkout `HEAD` 且是 `origin/main` 的祖先，否则 workflow 在发布前失败。
- `.github/workflows` 中所有 `uses:` 必须固定为 40 位 commit SHA。
- `npm.cmd audit` 应报告 0 个已知漏洞；锁文件策略测试应同时拒绝脆弱版本和不满足上游 semver/Node engine 的强制 override。
- esbuild 必须同时满足 WXT/tsx 的 `0.27.x` 范围并避开 `>=0.27.3 <0.28.1` 公告区间；当前固定为 `0.27.2`，不得用不兼容的 `0.28.x` override。
- `package.json` 的 Node engine 最低版本必须满足锁文件中每个已安装包的 `engines.node`；当前最低版本为 Node.js 22.13。

## 缓存并发与身份边界

- owner/repo 大小写变体必须映射到同一个内存和持久化缓存身份；用任意大小写清理当前仓库后不得复用另一变体留下的结果。
- `feature@x` 等包含合法 `@` 的 Git ref 必须使用可逆 key 编码；缓存管理、单仓库清理和内存清理不得把 `@` 误判为 owner/repo/ref 分隔符。
- 编码 key 使用显式 `codepath-cache-v2:e:` 子命名空间；旧 ref `release%2Fx` 与新 ref `release/x` 必须分组、删除和复用隔离。
- persistent cache 配额必须按 UTF-8 字节计算；多字节文本超过单仓库限制时不得写入，也不得为其驱逐有效记录。
- persistent 删除尚未完成时启动的新分析必须等待删除线性化完成，不得读取即将删除的旧结果。

## 回归关注点

- 推荐追问默认只用本地规则生成，不应触发额外模型请求。
- 点击推荐追问应立即发送，复制按钮应保留。
- Skill 输出应同时支持复制 Markdown 和下载 Markdown。
- 设置页应显示当前仓库缓存项数量、全部缓存项数量、最近一次清理结果和缓存项目列表。
- 缓存项目列表应支持展开 `owner/repo@branch`、删除某个项目缓存、删除某个单项缓存。
- 缓存命中结果顶部应显示“来自缓存”，并提示清空当前仓库缓存后可重新分析。
