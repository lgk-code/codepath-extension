# OpenClaw 集成方案

## 命名说明

对外文档、MCP 工具和后续产品命名统一使用 OpenClaw。当前本地开发和验证可以继续使用 EasyClaw，但也直接配置并调用 OpenClaw 命名的 MCP 工具，不再保留单独的 EasyClaw 工具别名。

## 目标

让 OpenClaw 可以在项目开发或技能学习过程中，直接使用 CodePath 的 GitHub 源码分析能力。用户可以给 OpenClaw 一个 GitHub 地址和目标功能，OpenClaw 通过通讯插件、MCP 或 API/RPC 调用 CodePath 分析服务，拿到技术栈、实现路径、关键文件、可迁移设计、Skill 和新项目蓝图，再决定如何学习或执行开发任务。

核心目标是让 CodePath 从“浏览器侧边栏源码解释器”扩展为“可被 OpenClaw 调用的源码分析服务”。

## 结论

OpenClaw 不一定需要打开浏览器。

如果只是分析 GitHub 项目源码，最推荐的方式是 OpenClaw 直接通过 MCP、API/RPC 或 CLI bridge 调用 CodePath Analyzer。浏览器只在下面这些场景中需要：

- 仓库是私有的，GitHub API 没有权限，需要用户在浏览器里处理登录或授权。
- 需要观察 GitHub 页面上的 README 渲染、Issue、PR、图片、网页交互等视觉信息。
- CodePath 目前还没有独立 MCP/API 服务，只能临时通过浏览器扩展侧边栏产出结果。
- 用户希望 OpenClaw 自动操作浏览器插件按钮，复制分析结果。

长期架构应避免让 OpenClaw 依赖浏览器 UI。浏览器扩展服务人类阅读，MCP/API 服务 agent 自动化。

## 当前实现状态

当前已经完成 MCP 一期能力：

- 新增 `scripts/codepath-mcp.ts`，通过 stdio 暴露 MCP Server。
- 新增 `npm.cmd run mcp` 启动命令。
- MCP 客户端可以发现四个工具：
  - `analyze_github_project`
  - `analyze_github_feature`
  - `generate_openclaw_skill`
  - `generate_project_blueprint`
- `generate_openclaw_skill` 和 `generate_project_blueprint` 已复用 CodePath Analyzer 的仓库树、候选文件、源码片段和模型调用逻辑。
- 配置通过环境变量传入，不写入仓库：
  - `CODEPATH_API_KEY` / `OPENAI_API_KEY`
  - `CODEPATH_BASE_URL` / `OPENAI_BASE_URL`
  - `CODEPATH_MODEL` / `OPENAI_MODEL`
  - `CODEPATH_GITHUB_TOKEN` / `GITHUB_TOKEN`

当前仍待完善：

- MCP 返回值目前主要是 JSON 包裹 Markdown，后续需要补更细的结构化字段。
- 还没有浏览器侧“借鉴 / Skill”视图。
- 还没有自动导出 `SKILL.md` 文件。
- 阶段耗时还没有拆分到 MCP 工具返回中。
- 需要用真实 OpenClaw 开发任务验证输出是否足够可执行。

## 推荐主流程

```text
用户
  ↓
给 OpenClaw 一个 GitHub 地址和目标功能
  ↓
OpenClaw 调用 Claw 通讯插件 / MCP 工具
  ↓
CodePath Analyzer 获取仓库树和源码片段
  ↓
CodePath 返回结构化分析结果
  ↓
OpenClaw 学习 Skill、派生 sub-agent 或执行项目开发
```

示例指令：

```text
分析 https://github.com/owner/repo 里的插件系统，
总结技术栈、实现路径、关键文件、可迁移设计，
生成 OpenClaw Skill，并根据它改造我的项目。
```

理想工具调用：

```ts
generate_openclaw_skill({
  url: "https://github.com/owner/repo",
  feature: "插件系统",
  outputMode: "openclaw-skill"
})
```

## 架构分层

```text
              GitHub URL / 仓库信息
                       ↓
              CodePath Analyzer Core
        ┌──────────────┴──────────────┐
        ↓                             ↓
Browser Extension                 MCP/API Gateway
给人类阅读和交互                  给 OpenClaw 自动调用
        ↓                             ↓
GitHub 页面侧边栏                 Claw 通讯插件
                                      ↓
                                  OpenClaw
                                      ↓
                              Skill 学习 / 项目开发
```

## 组件职责

### CodePath Analyzer Core

负责源码理解，不依赖浏览器 UI：

- 解析 GitHub URL。
- 获取仓库默认分支、tree 和关键文件。
- 根据功能名筛选候选文件。
- 生成项目概览、功能分析、文件解释、追问回答。
- 生成 OpenClaw Skill 和新项目实现蓝图。

### Browser Extension

负责人类在 GitHub 页面上的交互：

- 注入侧边栏。
- 展示分析结果。
- 链接源码文件。
- 支持复制 Markdown。
- 支持手动生成 Skill 或蓝图。

### MCP/API Gateway

负责让 OpenClaw 调用 CodePath：

- 暴露分析工具。
- 接收 GitHub URL、功能名和输出模式。
- 返回结构化 JSON 和 Markdown。
- 可选地把结果投递给 OpenClaw Skill 系统。

### Claw 通讯插件

负责 OpenClaw 侧集成：

- 将用户的自然语言任务转成 CodePath 工具调用。
- 接收 CodePath 返回结果。
- 决定是学习 Skill、生成任务计划，还是派生 sub-agent 执行。
- 在需要用户确认时回到对话中询问。

## OpenClaw 能力假设

根据当前信息，OpenClaw 支持：

- CLI：正式方向可通过 OpenClaw CLI 和 `mcporter` 调用；当前本地测试可使用 `easyclaw`。
- MCP：支持内外 Server，是核心扩展机制。
- API/RPC：支持 Gateway call 和 webhook。
- Skills：支持 `SKILL.md` 驱动的指令包。
- Sub-agents：运行时派生专用 agent。
- 通道插件：支持多个消息平台。
- 监听目录：无内置，但可通过 cron 或外部 watcher 变通。

因此推荐优先使用 MCP 或 API/RPC，而不是浏览器自动点击。

## 工具设计

一期可以设计下面这些 MCP/API 工具：

### `analyze_github_project`

输入：

```json
{
  "url": "https://github.com/owner/repo"
}
```

输出：

- 项目目的
- 技术栈
- 目录职责
- 入口文件
- 阅读路线
- 来源文件

当前 MCP Server 启动命令：

```bash
npm.cmd run mcp
```

推荐通过环境变量传入配置：

```powershell
$env:CODEPATH_API_KEY="你的模型 API Key"
$env:CODEPATH_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:CODEPATH_MODEL="qwen-plus"
$env:CODEPATH_GITHUB_TOKEN="可选 GitHub Token"
npm.cmd run mcp
```

也兼容 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 和 `GITHUB_TOKEN`。

### `analyze_github_feature`

输入：

```json
{
  "url": "https://github.com/owner/repo",
  "feature": "插件系统"
}
```

输出：

- 功能目标
- 技术栈
- 实现路径
- 关键文件
- 调用链或数据流
- 可迁移设计
- 风险点

### `generate_openclaw_skill`

输入：

```json
{
  "url": "https://github.com/owner/repo",
  "feature": "插件系统",
  "target": "openclaw"
}
```

输出：

- `SKILL.md` 内容
- OpenClaw 执行步骤
- 适合派生的 sub-agents
- 需要用户确认的问题
- 不应照搬的内容

### `generate_project_blueprint`

输入：

```json
{
  "url": "https://github.com/owner/repo",
  "feature": "插件系统",
  "targetStack": "React + TypeScript"
}
```

输出：

- 新项目目录结构建议
- 模块边界
- 数据结构和接口草案
- 开发步骤
- 测试建议
- 可选技术栈替代方案

## OpenClaw 任务交接格式

CodePath 返回给 OpenClaw 的 Markdown 应当稳定、可复制、可作为 Skill 输入：

```md
# OpenClaw 任务交接

## 任务目标

## 来源项目

## 分析功能

## 功能技术栈

## 源码确认的实现路径

## 关键文件

## 可迁移设计

## 不应照搬的内容

## OpenClaw 执行步骤

## 适合派生的 Sub-agents

## 需要向用户确认的问题

## 风险与验证建议
```

## 是否需要浏览器

### 不需要浏览器的情况

- 公共 GitHub 仓库。
- 已提供 GitHub Token。
- 只需要读取源码树、README、配置文件和源码内容。
- CodePath Analyzer 已经通过 MCP/API 暴露。
- OpenClaw 只需要学习 Skill 或执行项目开发。

### 需要浏览器的情况

- 私有仓库需要网页登录授权。
- 需要看 GitHub 页面的渲染效果或图片内容。
- 需要操作 Issue、PR、讨论区等 GitHub 页面功能。
- 当前还没有 MCP/API 服务，只能通过浏览器插件生成结果。

### 临时浏览器方案

如果 MCP/API 尚未实现，可以临时采用：

1. OpenClaw 打开 GitHub 页面。
2. 操作 CodePath 浏览器插件。
3. 输入目标功能。
4. 点击生成分析或 Skill。
5. 复制结果回 OpenClaw。

该方案可用，但不推荐作为长期主路径，因为它依赖 UI、速度慢、容易受页面变化影响。

## 阶段计划

### 第一阶段：稳定交接格式

- 在浏览器扩展中生成 OpenClaw 任务交接 Markdown。
- 支持复制 Markdown。
- 支持导出 `SKILL.md`。
- 明确源码确认与工程推断。

### 第二阶段：抽离 Analyzer Core

- 将 GitHub 读取、文件筛选、prompt 构造、Skill 生成逻辑整理成可复用模块。
- 浏览器扩展继续调用该模块。
- 为 MCP/API Gateway 复用同一套分析逻辑做准备。

### 第三阶段：MCP/API Gateway

- 暴露 `analyze_github_project`、`analyze_github_feature`、`generate_openclaw_skill`、`generate_project_blueprint`。
- 支持 GitHub Token 和模型配置。
- 返回 Markdown 和结构化 JSON。
- 状态：已完成基础 MCP Server；结构化 JSON 还需要继续增强。

### 第四阶段：OpenClaw 通讯插件

- OpenClaw 通过 MCP 或 Gateway 调用 CodePath。
- 支持把返回结果注册为 Skill。
- 支持派生 sub-agent 执行开发任务。
- 对需要用户确认的事项进行对话确认。
- 状态：待在 OpenClaw 中配置并进行真实任务验证。

### 第五阶段：自动化学习和执行

- OpenClaw 接收 GitHub 地址后自动分析。
- 根据结果生成或更新 Skill。
- 根据蓝图修改目标项目。
- 运行验证命令并回报结果。

## 设计原则

- OpenClaw 主导任务，CodePath 提供源码分析能力。
- 能用 API/MCP 就不依赖浏览器 UI。
- 浏览器扩展继续服务人类阅读和手动验证。
- 返回内容必须结构化，能被人读，也能被 agent 消化。
- 不直接复制源项目代码，而是提炼技术栈、实现路径和工程模式。
- 明确区分源码确认和工程推断。
- 避免泄露 API Key、GitHub Token、本机路径或私有仓库内容。
