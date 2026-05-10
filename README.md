# CodePath Extension

CodePath is a browser extension for reading GitHub source code without cloning, deploying, or running a project. It helps learners and secondary developers understand a repository's project structure, feature implementation path, and follow-up questions directly on GitHub pages.

## Current MVP

- Injects a resizable CodePath sidebar on GitHub repository pages
- Analyzes project overview, technology stack, directory roles, entry points, and reading route
- Analyzes a requested feature path, such as login, upload, search, or training flow
- Explains the current GitHub file page
- Supports global follow-up questions from Overview, Feature, File, and History views
- Keeps follow-up answers in a conversation history view
- Renders AI output as Markdown, including tables, lists, code, and bold text
- Links source references back to GitHub files
- Detects Python ML / research repositories and uses a more specific analysis template
- Uses Qwen/OpenAI-compatible chat completions
- Supports optional GitHub Token for higher API limits

## Tech Stack

- WXT
- React
- TypeScript
- Manifest V3
- React Markdown
- GitHub REST API
- Qwen/OpenAI-compatible API

## Development

Install dependencies:

```bash
npm install
```

Run development mode:

```bash
npm run dev
```

Build the extension:

```bash
npm run build
```

Type-check:

```bash
npm run compile
```

The Chrome/Edge MV3 build output is generated at:

```text
.output/chrome-mv3
```

Load this directory as an unpacked extension in Chrome or Edge.

## Configuration

Open the CodePath Settings tab in the sidebar and configure:

- API Key: your Qwen or OpenAI-compatible API key
- Base URL: default is `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Model: default is `qwen-plus`
- GitHub Token: optional, used to avoid anonymous GitHub API rate limits

Do not commit API keys or tokens. Use the minimum required GitHub token permissions.

## MCP / OpenClaw

CodePath can also run as an MCP server for OpenClaw-compatible agents. This lets an agent analyze a GitHub repository directly without opening the browser extension.

Start the MCP server:

```bash
npm run mcp
```

Available tools:

- `analyze_github_project`
- `analyze_github_feature`
- `generate_openclaw_skill`
- `generate_project_blueprint`

See [CodePath MCP 使用教程](docs/MCP_USAGE.md) for setup, environment variables, OpenClaw configuration, tool examples, and troubleshooting.

For the integration design, see [OpenClaw 集成方案](OPENCLAW_INTEGRATION.md).

## Roadmap

- Improve background messaging stability and reduce content-script fallbacks
- Cache repository analysis by owner/repo/branch/commit
- Add human-friendly error messages for rate limits and model errors
- Add local project analysis mode
- Build import graph and file relationship navigation
- Add richer project-type templates for backend, CLI, and library repositories

## Security Notes

CodePath stores user-provided API keys and tokens in browser-local storage for the active extension environment. These values are not stored in the repository. Revoke test tokens after local development sessions.
