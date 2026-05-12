# CodePath 后续规划

CodePath 的方向不是只做 GitHub 源码解释器，而是逐步成为“项目经验提炼器”：从真实仓库中提取技术栈、实现路径、文件职责、可迁移工程模式和 agent 可复用的 Skill / 蓝图。

## 当前进展

- 浏览器插件：已支持项目概览、功能路径、当前文件解释、追问、Markdown 渲染、源码路径链接、动态推荐追问、耗时显示。
- Skill / 蓝图：已支持在侧边栏生成 OpenClaw Skill、新项目蓝图和给人读的技术分析，并可复制或下载 Markdown。
- 缓存管理：已支持 tree、overview、file 持久化缓存，设置页可查看项目缓存列表，并按项目或单项删除。
- MCP：已提供 `analyze_github_project`、`analyze_github_feature`、`generate_openclaw_skill`、`generate_project_blueprint` 四个工具，返回结构化 JSON 文本。
- 工程流程：已支持 `deploy:edge`，并建立构建版本可见规则、人工回归清单、演示网站和 PAGE4D 案例。

## 近期优先级

1. **真实使用闭环**
   - 修复和维护中文文档，确保 README、ROADMAP、MCP 教程和测试清单能直接指导新用户。
   - 把错误诊断拆清楚：GitHub 权限、rate limit、模型 Key、Base URL、模型名、网络失败分别给出操作建议。
   - 固定人工回归流程：compile、build、deploy:edge、MCP 工具名 smoke test、密钥扫描、真实项目手测。

2. **演示与案例完善**
   - 首页展示浏览器插件、MCP、OpenClaw 交接、缓存管理四段真实使用流程。
   - PAGE4D 案例说明测试目标、截图含义、实际输出能力。
   - 增加 CodePath 自分析案例，展示 WXT、React、MCP、缓存管理在本项目中的调用关系。

3. **分析质量提升**
   - 增强项目类型模板：前端、Node 后端、Python 应用、Python ML、库项目。
   - 构建轻量 import graph，辅助判断文件职责和调用链。
   - 在输出中更稳定地区分“源码确认”和“谨慎推断”。

4. **Agent 使用深化**
   - 用 OpenClaw 实战验证 Skill 和蓝图的可执行性。
   - 支持保存多个 Skill，形成项目经验库。
   - 后续再考虑 Hermes 专用输出模板和批量学习材料导出。

## 中长期方向

- 本地项目分析模式：通过 MCP 或 CLI 读取本地目录，复用现有概览、功能路径、文件解释和 Skill 生成能力。
- 知识图谱视图：生成文件职责图、功能调用链、入口文件地图、二次开发风险清单。
- 更强缓存策略：增加缓存大小估算、来源说明、重新分析入口和缓存命中对比。
- 多模型适配：为不同 OpenAI-compatible 模型提供推荐上下文长度和 prompt 策略。

## 版本更新规则

- 每次新增功能或用户可见行为变化，必须更新设置页绿色框显示的构建版本。
- 构建版本同时维护在 `src/components/Sidebar.tsx` 的 `UI_VERSION` 和 `entrypoints/content.tsx` 的 `CONTENT_BUILD`。
- 推荐格式：`dev-YYYY-MM-DD-feature-name`，例如 `dev-2026-05-12-usage-loop`。
- 验证时先确认绿色框版本变化，再判断功能是否加载成功。

## 设计原则

- 不直接复制目标项目代码，而是提炼可复用的工程经验。
- 输出必须标明源码依据，避免把推断包装成事实。
- 默认服务学习者、二次开发者和 OpenClaw 兼容 agent。
- 先保证真实使用稳定，再扩展更复杂的分析能力。
