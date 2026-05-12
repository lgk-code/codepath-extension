# CodePath MCP 使用教程

CodePath 可以作为 MCP Server 运行，把 GitHub 源码分析能力提供给 OpenClaw 兼容 agent 使用。这样 OpenClaw 不需要打开浏览器，也可以直接分析 GitHub 仓库、理解某个功能、生成 Skill 或新项目实现蓝图。

## 适用场景

- 让 OpenClaw 分析一个 GitHub 仓库的项目结构。
- 让 OpenClaw 分析某个功能的技术栈、实现路径和关键文件。
- 从 GitHub 项目中生成 OpenClaw Skill。
- 借鉴某个项目功能，生成新项目实现蓝图。

## 前置要求

- Node.js 18 或更高版本。
- 已执行 `npm install`。
- 一个 Qwen 或 OpenAI-compatible 模型 API Key。
- 私有仓库需要额外准备 GitHub Token。

## 安装依赖

在项目目录执行：

```powershell
cd "C:\path\to\codepath-extension"
npm install
```

## 配置环境变量

PowerShell 示例：

```powershell
$env:CODEPATH_API_KEY="your-model-api-key"
$env:CODEPATH_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:CODEPATH_MODEL="qwen-plus"
```

如果要分析私有 GitHub 仓库，再加：

```powershell
$env:CODEPATH_GITHUB_TOKEN="your-github-token"
```

也可以使用兼容变量名：

```powershell
$env:OPENAI_API_KEY="your-model-api-key"
$env:OPENAI_BASE_URL="https://your-openai-compatible-endpoint/v1"
$env:OPENAI_MODEL="your-model"
$env:GITHUB_TOKEN="your-github-token"
```

优先级为：

1. `CODEPATH_API_KEY`
2. `OPENAI_API_KEY`

GitHub Token 优先级为：

1. `CODEPATH_GITHUB_TOKEN`
2. `GITHUB_TOKEN`

## 启动 MCP Server

在项目目录执行：

```powershell
npm.cmd run mcp
```

看到下面的输出表示服务已启动：

```text
CodePath MCP server running on stdio
```

注意：MCP Server 会占用当前终端，这是正常现象。实际接入 OpenClaw 时，OpenClaw 会按配置自动启动它。

## OpenClaw 配置示例

在 OpenClaw 的 MCP 配置中加入：

```json
{
  "codepath": {
    "command": "npm.cmd",
    "args": ["run", "mcp"],
    "cwd": "C:\\path\\to\\codepath-extension",
    "env": {
      "CODEPATH_API_KEY": "your-model-api-key",
      "CODEPATH_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "CODEPATH_MODEL": "qwen-plus",
      "CODEPATH_GITHUB_TOKEN": "optional-github-token"
    }
  }
}
```

不要把真实 API Key 提交到 GitHub。建议只放在本机 OpenClaw 配置、环境变量或系统密钥管理里。

## 可用工具

所有工具都会返回 JSON 文本，核心字段包括：

- `repo`：仓库信息。
- `feature`：被分析功能，项目概览工具可能为空。
- `summary`：主要 Markdown 分析内容。
- `sources`：源码引用路径。
- `timing`：阶段耗时，包括 GitHub、tree、文件读取、模型请求和总耗时。
- `confirmedFacts`：由源码引用支撑的事实列表。
- `inferredNotes`：需要谨慎看待的推断说明。
- `nextActions`：建议 OpenClaw / Hermes 继续执行的动作。

### `analyze_github_project`

分析一个 GitHub 项目整体结构。

输入：

```json
{
  "url": "https://github.com/owner/repo"
}
```

输出包括：

- 项目用途
- 技术栈
- 目录职责
- 入口文件
- 推荐阅读路线
- 参考源码文件

### `analyze_github_feature`

分析某个功能的实现路径。

输入：

```json
{
  "url": "https://github.com/owner/repo",
  "feature": "插件系统"
}
```

输出包括：

- 功能目标
- 关键文件
- 实现步骤
- 文件职责
- 可修改位置
- 源码确认与谨慎推断

### `generate_openclaw_skill`

从 GitHub 项目的某个功能生成 OpenClaw 任务交接或 Skill 草案。

输入：

```json
{
  "url": "https://github.com/owner/repo",
  "feature": "插件系统"
}
```

输出结构包括：

- 任务目标
- 来源项目
- 分析功能
- 功能技术栈
- 源码确认的实现路径
- 关键文件
- 可迁移设计
- 不应照搬的内容
- OpenClaw 执行步骤
- 适合派生的 Sub-agents
- 需要向用户确认的问题
- 风险与验证建议

### `generate_project_blueprint`

根据某个 GitHub 功能生成新项目实现蓝图。

输入：

```json
{
  "url": "https://github.com/owner/repo",
  "feature": "插件系统",
  "mode": "new-project"
}
```

`mode` 可选：

- `new-project`：生成新项目实现蓝图。
- `openclaw-skill`：生成 OpenClaw 任务交接。
- `human`：生成人类可读技术分析。

输出包括：

- 目标功能
- 来源项目启发
- 推荐技术栈
- 推荐目录结构
- 模块职责划分
- 数据结构和接口草案
- 实现步骤
- 测试与验证
- 可迁移模式
- 不能照搬的细节

## OpenClaw 测试指令

你可以在 OpenClaw 中输入：

```text
调用 CodePath MCP，分析 https://github.com/owner/repo 的插件系统，
生成 OpenClaw Skill，并给出可迁移到新项目的实现蓝图。
```

或者：

```text
调用 CodePath MCP 的 analyze_github_project，
分析 https://github.com/owner/repo 的项目结构和阅读路线。
```

如果要分析私有仓库：

```text
调用 CodePath MCP，使用已配置的 GitHub Token，
分析 https://github.com/owner/private-repo 的缓存机制。
```

## 私有仓库权限

GitHub 私有仓库如果没有 Token，API 可能返回 `404 Not Found`，这不一定表示仓库不存在，也可能是没有权限。

建议使用 fine-grained token：

- 选择目标仓库。
- 权限给 `Contents: Read-only`。

如果使用 classic token：

- 通常需要 `repo` 权限。

将 token 放入：

```powershell
$env:CODEPATH_GITHUB_TOKEN="your-github-token"
```

或 OpenClaw MCP 配置的 `env.CODEPATH_GITHUB_TOKEN`。

## 常见错误

### `Could not read package.json`

原因：没有在项目目录启动。

解决：

```powershell
cd "C:\path\to\codepath-extension"
npm.cmd run mcp
```

OpenClaw 配置里也要设置正确的 `cwd`。

### `请先在 Settings 中填写 Qwen API Key`

原因：MCP Server 没有读取到模型 API Key。

解决：设置 `CODEPATH_API_KEY` 或 `OPENAI_API_KEY`。

### `GitHub API 404: Not Found`

可能原因：

- 仓库地址写错。
- 仓库是私有的。
- GitHub Token 没有权限。

解决：确认 URL，并配置有仓库读取权限的 `CODEPATH_GITHUB_TOKEN`。

### 模型接口报错

检查：

- `CODEPATH_BASE_URL` 是否正确。
- `CODEPATH_MODEL` 是否存在。
- API Key 是否有额度和权限。

## 安全注意事项

- 不要把 API Key 或 GitHub Token 写进仓库。
- 不要把真实密钥放进 README、issue、PR 或聊天记录。
- 私有仓库分析结果可能包含项目结构和业务信息，分享前需要确认内容可公开。
- 如果密钥曾经暴露，建议立即去服务商控制台轮换。
