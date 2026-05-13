# CodePath Extension

[中文](README.md) | [English](README.en.md)

[![CI](https://github.com/lgk-code/codepath-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/lgk-code/codepath-extension/actions/workflows/ci.yml)

CodePath is a browser extension for reading GitHub source code without cloning, deploying, or running a project. It helps learners, secondary developers, and OpenClaw-compatible agents understand project structure, feature implementation paths, source references, and reusable engineering patterns directly from GitHub repositories.

## Current Capabilities

- Injects a resizable CodePath sidebar on GitHub repository pages.
- Analyzes project overview, technology stack, directory roles, entry points, and reading route.
- Analyzes requested feature paths, such as login, upload, search, training flow, MCP, or cache management.
- Explains the current GitHub file page.
- Supports global follow-up questions from Overview, Feature, File, and History views.
- Generates contextual follow-up questions from the current analysis and source references.
- Generates and exports OpenClaw Skill, new-project blueprint, or human-readable technical analysis Markdown.
- Shows answer timing, cache hits, cache status, cache item management, and connection diagnostics.
- Renders AI output as Markdown and links source references back to GitHub files.
- Detects streaming support for OpenAI-compatible APIs and falls back to one-shot responses when needed.
- Provides an MCP Server so OpenClaw-compatible tools can call the same GitHub analysis capabilities.

## Tech Stack

- WXT
- React
- TypeScript
- Manifest V3
- React Markdown
- GitHub REST API
- Qwen / OpenAI-compatible Chat Completions API

## Quick Start

Install dependencies:

```bash
npm install
```

Build and copy the unpacked extension to the local Edge test directory:

```bash
npm run deploy:edge
```

Then open `edge://extensions`, enable developer mode, reload CodePath, and refresh the GitHub repository page.

Configure CodePath in the Settings tab:

- API Key: your Qwen or OpenAI-compatible API key.
- Base URL: default is `https://dashscope.aliyuncs.com/compatible-mode/v1`.
- Model: default is `qwen-plus`.
- GitHub Token: optional, used for higher GitHub API limits and private repositories.

Click Save and Test. CodePath checks the model connection and whether the current API supports streaming output.

## Development

```bash
npm run dev
npm run compile
npm run build
npm run deploy:edge
npm run quality
```

`quality` runs type-checking, extension build, MCP tool-name verification, and tracked-file secret/private-path scanning. Run individual scripts when you need to isolate a failing step:

```bash
npm run compile
npm run build
npm run verify:mcp-tools
npm run scan:secrets
```

The Chrome/Edge MV3 build output is generated at:

```text
.output/chrome-mv3
```

## MCP / OpenClaw

CodePath can run as an MCP Server for OpenClaw-compatible agents:

```bash
npm run mcp
```

Available tools:

- `analyze_github_project`
- `analyze_github_feature`
- `generate_openclaw_skill`
- `generate_project_blueprint`

MCP responses include structured JSON fields such as `repo`, `feature`, `summary`, `sources`, `timing`, `confirmedFacts`, `inferredNotes`, and `nextActions`.

See [CodePath MCP Usage Guide](docs/MCP_USAGE.md) and [OpenClaw Integration Design](OPENCLAW_INTEGRATION.md).

## Demo Website

The static demo website lives in [docs/index.html](docs/index.html) and is ready for GitHub Pages when Pages is configured to publish from the `docs` directory. Manual demo regression cases are tracked in [docs/TEST_CASES.md](docs/TEST_CASES.md).

## Quality Gate and CI

CodePath uses three gates:

- Local gate: `npm run quality`.
- GitHub Actions CI: runs on `push` to `main` and pull requests. It installs dependencies, type-checks, builds the extension, verifies the four MCP tool names, scans tracked files, and uploads a Chrome/Edge MV3 artifact.
- Manual browser gate: visible extension changes still require `npm run deploy:edge`, reloading CodePath in `edge://extensions`, refreshing GitHub, and checking the green build version.

To try a CI-built package:

1. Open the repository Actions page and select the latest successful CI run.
2. Download the `codepath-chrome-mv3-<commit>` artifact.
3. Unzip the artifact, then unzip the extension package inside it.
4. Load the unzipped extension directory in Chrome or Edge with developer mode enabled.

The CI artifact is a convenience package for manual verification. It is not a signed browser-store release.

## Troubleshooting

- Browser did not update: confirm the Settings tab shows the latest green build version, then reload CodePath in `edge://extensions` and refresh the GitHub page.
- GitHub 404 or private repository: add a GitHub Token with Contents read permission.
- GitHub rate limit: add a GitHub Token and retry.
- Model 401/403: check API Key, model access, and provider account status.
- Model 404: check that Base URL is an OpenAI-compatible `/v1` endpoint and the model name is correct.
- Slow answers: check the timing line in each result.
- Streaming looks like a one-shot response: some providers or proxies buffer SSE; CodePath will show realtime, buffered, unsupported, or fallback mode in diagnostics.

## Roadmap

- Stabilize the real-use loop: streaming diagnostics, regression checks, docs, demo cases, and release workflow.
- Keep CI/CD lightweight: CI quality gate and artifact packaging first, release automation later.
- Improve project understanding with richer project-type templates, relative import mapping, better feature-file ranking, and clearer confirmed/inferred labels.
- Continue validating OpenClaw Skill / blueprint output with real projects.
- Add local project analysis mode after GitHub analysis is stable.
- Build structured knowledge views such as file responsibility maps and feature call chains.

See [ROADMAP.md](ROADMAP.md) for the full plan.

## Security Notes

CodePath stores user-provided API keys and tokens in browser-local storage for the active extension environment. These values are not stored in the repository. Do not paste real secrets into README, issues, pull requests, or chat logs. Revoke temporary test tokens after local development sessions.
