# CodePath Extension

CodePath is a browser extension for reading GitHub source code without cloning, deploying, or running a project. It helps learners and secondary developers understand a repository's project structure, feature implementation path, and follow-up questions directly on GitHub pages.

## Current MVP

- Injects a resizable CodePath sidebar on GitHub repository pages
- Analyzes project overview, technology stack, directory roles, entry points, and reading route
- Analyzes a requested feature path, such as login, upload, search, or training flow
- Explains the current GitHub file page
- Supports global follow-up questions from Overview, Feature, File, and History views
- Generates contextual follow-up questions from the current analysis and source references
- Supports refreshing local follow-up suggestions without an extra model call
- Generates and exports Skill / blueprint Markdown from the browser sidebar
- Shows answer timing, cache hits, cache status, cache item management, and connection diagnostics
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

Build and copy the Edge unpacked extension to the local test directory:

```bash
npm run deploy:edge
```

Then reload CodePath in `edge://extensions` and refresh the GitHub page.

Type-check:

```bash
npm run compile
```

The Chrome/Edge MV3 build output is generated at:

```text
.output/chrome-mv3
```

Load this directory as an unpacked extension in Chrome or Edge.

## Quick Start

1. Build and deploy the unpacked Edge extension:

```bash
npm run deploy:edge
```

2. Open `edge://extensions`, enable developer mode, reload CodePath, then refresh a GitHub repository page.
3. Open the CodePath sidebar Settings tab and configure API Key, Base URL, model, and optional GitHub Token.
4. Click Save and Test in Settings. CodePath checks the model connection and whether the current API supports streaming output.
5. Run Project Overview on a repository page, then try Feature Path, File Explanation, follow-up questions, and Skill / blueprint export.
6. If you use OpenClaw-compatible tools, start the MCP server with `npm run mcp` and configure the same model environment variables.

## Configuration

Open the CodePath Settings tab in the sidebar and configure:

- API Key: your Qwen or OpenAI-compatible API key
- Base URL: default is `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Model: default is `qwen-plus`
- GitHub Token: optional, used to avoid anonymous GitHub API rate limits
- Streaming output: detected automatically after Save and Test. CodePath distinguishes realtime streaming, buffered streaming, unsupported streaming, and one-shot fallback.

Do not commit API keys or tokens. Use the minimum required GitHub token permissions.

## Troubleshooting

- Browser did not update: confirm the Settings tab shows the latest green build version, then reload CodePath in `edge://extensions` and refresh the GitHub page.
- GitHub 404 or private repository: add a GitHub Token with Contents read permission.
- GitHub rate limit: add a GitHub Token and retry.
- Model 401/403: check API Key, model access, and provider account status.
- Model 404: check that Base URL is an OpenAI-compatible `/v1` endpoint and the model name is correct.
- Slow answers: check the timing line in each result to see whether time is spent on GitHub, file reads, context construction, or the model request.

## Demo Website

The static demo website lives in `docs/index.html` and is ready for GitHub Pages when Pages is configured to publish from the `docs` directory. Manual demo regression cases are tracked in [docs/TEST_CASES.md](docs/TEST_CASES.md).

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

MCP responses include structured JSON fields such as `repo`, `feature`, `summary`, `sources`, `timing`, `confirmedFacts`, `inferredNotes`, and `nextActions`.

See [CodePath MCP 使用教程](docs/MCP_USAGE.md) for setup, environment variables, OpenClaw configuration, tool examples, and troubleshooting.

For the integration design, see [OpenClaw 集成方案](OPENCLAW_INTEGRATION.md).

## Roadmap

- Stabilize the real-use loop: streaming diagnostics, regression checks, docs, demo cases, and release workflow
- Improve project understanding with richer project-type templates, lightweight import graphs, and clearer confirmed/inferred labels
- Continue validating OpenClaw Skill / blueprint output with real projects
- Add local project analysis mode after GitHub analysis is stable
- Build structured knowledge views such as file responsibility maps and feature call chains

See [ROADMAP.md](ROADMAP.md) for the full plan.

## Security Notes

CodePath stores user-provided API keys and tokens in browser-local storage for the active extension environment. These values are not stored in the repository. Revoke test tokens after local development sessions.
