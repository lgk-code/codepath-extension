# CodePath 后续规划

CodePath 的方向不是只做 GitHub 源码解释器，而是逐步成为“项目经验提炼器”：从真实仓库中提取技术栈、实现路径、文件职责、可迁移工程模式和 agent 可复用的 Skill / 蓝图。

## 当前进展

- 浏览器插件：已支持项目概览、功能路径、当前文件解释、追问、Markdown 渲染、源码路径链接、动态推荐追问、耗时显示。
- 流式输出：已支持 OpenAI-compatible `stream=true` 的基础增量展示，并开始区分实时流式、接口缓冲、普通返回和失败回退。
- Skill / 蓝图：已支持在侧边栏生成 OpenClaw Skill、新项目蓝图和给人读的技术分析，并可复制或下载 Markdown。
- 缓存管理：已支持 tree、overview、file 持久化缓存，设置页可查看项目缓存列表，并按项目或单项删除。
- MCP：已提供 `analyze_github_project`、`analyze_github_feature`、`generate_openclaw_skill`、`generate_project_blueprint` 四个工具，返回结构化 JSON 文本。
- 分析质量 v2：已补强 WXT / 浏览器插件项目画像、功能意图加权、相对 import 路径映射和 OpenClaw Skill 中文结构标题。
- 工程流程：已支持 `deploy:edge`、本地 `quality` 质量门禁、GitHub Actions 基础 CI、构建版本可见规则、人工回归清单、演示网站和 PAGE4D 案例。
- 文档展示：仓库默认 README 已切换为中文，英文版保留为 `README.en.md`，演示站点默认中文展示。

## 近期优先级

1. **分析质量提升**
   - 增强项目类型模板：前端、Node 后端、Python 应用、Python ML、库项目、WXT / 浏览器插件项目，并补充入口、配置和目录信号。
   - 构建轻量 import graph：第一版只基于已读取 snippets，不全仓库深度解析；相对 import 尽量映射到真实仓库路径。
   - 改进功能路径候选排序：针对训练流程、MCP、缓存管理、浏览器侧边栏、Skill/蓝图等常见功能优先选择核心入口文件。
   - 在 prompt 和输出中稳定地区分“源码确认”“谨慎推断”“建议继续验证”。

2. **真实使用闭环**
   - 稳定流式体验：设置页显示实时流式、疑似缓冲、不支持流式和连接失败未测试；结果生成时显示当前输出模式。
   - 修复和维护中文文档，确保 README、ROADMAP、MCP 教程和测试清单能直接指导新用户。
   - 把错误诊断拆清楚：GitHub 权限、rate limit、模型 Key、Base URL、模型名、网络失败分别给出操作建议。
   - 固定人工回归流程：compile、build、deploy:edge、MCP 工具名 smoke test、密钥扫描、真实项目手测。

3. **质量门禁与发布流程**
   - 第一阶段：GitHub Actions 跑 CI 基础门禁，包括安装依赖、类型检查、构建、MCP 工具名检查、密钥和本机路径扫描。（已完成）
   - 第二阶段：在 CI 中上传 Chrome/Edge 构建 artifact，方便 PR、测试和发布前取用。（当前推进）
   - 第三阶段：通过 Git tag 触发 GitHub Release，自动生成 zip 包和发布说明；暂不自动发布到浏览器商店。

4. **演示与案例完善**
   - 首页展示浏览器插件、MCP、OpenClaw 交接、缓存管理四段真实使用流程。
   - PAGE4D 案例说明测试目标、截图含义、实际输出能力。
   - 增加 CodePath 自分析案例，展示 WXT、React、MCP、缓存管理在本项目中的调用关系。

5. **文档国际化与展示完善**
   - 中文 README 作为 GitHub 默认展示，英文 README 作为开源补充入口继续维护。
   - 后续补充 README 截图、安装动图、CI artifact 下载示意和 Edge 加载流程图。
   - 演示站点继续中文优先，后续如有海外用户再考虑英文站点或语言切换。

6. **Agent 使用深化**
   - 用 OpenClaw 实战验证 Skill 和蓝图的可执行性。
   - 支持保存多个 Skill，形成项目经验库。
   - 后续再考虑 Hermes 专用输出模板和批量学习材料导出。

## 中长期方向

- 本地项目分析模式：通过 MCP 或 CLI 读取本地目录，复用现有概览、功能路径、文件解释和 Skill 生成能力。
- 知识图谱视图：生成文件职责图、功能调用链、入口文件地图、二次开发风险清单。
- 更强缓存策略：增加缓存大小估算、来源说明、重新分析入口和缓存命中对比。
- 多模型适配：为不同 OpenAI-compatible 模型提供推荐上下文长度和 prompt 策略。
- 发布自动化：通过 Git tag 生成 GitHub Release、zip 包和发布说明；浏览器商店发布仍保持人工审核。
- 案例沉淀：补全 CodePath 自分析截图、OpenClaw 调用记录和可复用 Skill 示例。

## 版本更新规则

- 每次新增功能或用户可见行为变化，必须更新设置页绿色框显示的构建版本。
- 构建版本同时维护在 `src/components/Sidebar.tsx` 的 `UI_VERSION` 和 `entrypoints/content.tsx` 的 `CONTENT_BUILD`。
- 推荐格式：`dev-YYYY-MM-DD-feature-name`，例如 `dev-2026-05-12-usage-loop`。
- 验证时先确认绿色框版本变化，再判断功能是否加载成功。

## 质量门禁与 CI/CD 规则

- 本地提交前默认执行 `npm.cmd run quality` 和 `git diff --check`。
- `quality` 包含类型检查、扩展构建、MCP 工具名检查、密钥和本机私人路径扫描。
- 涉及浏览器可见行为时，额外执行 `npm.cmd run deploy:edge`，在 Edge 扩展页重新加载，并确认绿色构建版本变化。
- GitHub Actions 在 `main` push 和 pull request 上运行基础 CI，并上传 Chrome/Edge MV3 artifact，供人工下载验证。
- CI artifact 是测试包，不是正式发布包；正式 release/tag 自动化留到下一阶段。
- CI 不使用模型 API Key 或 GitHub Token，因此不能替代真实模型、私有仓库权限、流式输出和 UI 手感验证。

## 设计原则

- 不直接复制目标项目代码，而是提炼可复用的工程经验。
- 输出必须标明源码依据，避免把推断包装成事实。
- 默认服务学习者、二次开发者和 OpenClaw 兼容 agent。
- 先保证真实使用稳定，再扩展更复杂的分析能力。
