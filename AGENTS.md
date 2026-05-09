# AGENTS.md

## Project Overview

CodePath is a WXT React browser extension for reading GitHub repositories without cloning or running them. It injects a sidebar on GitHub pages and uses a Qwen/OpenAI-compatible chat endpoint plus GitHub source metadata to explain projects, features, files, and follow-up questions.

## Development Commands

- Install dependencies with `npm install`.
- Type-check with `npm.cmd run compile` on Windows.
- Build the Chrome/Edge MV3 extension with `npm.cmd run build`.
- The build output is generated in `.output/chrome-mv3`.

## Extension Reload Workflow

After changing source code:

1. Run `npm.cmd run build`.
2. Copy the contents of `.output/chrome-mv3` into the unpacked extension directory used by the browser.
3. Reload the unpacked CodePath extension from `edge://extensions`.
4. Refresh the GitHub tab under test.

Do not commit generated build output, browser profiles, local extension install directories, API keys, or tokens.

## Code Guidelines

- Keep changes scoped to the extension behavior being modified.
- Prefer existing local helpers in `src/lib` before adding new abstractions.
- Keep user-facing Chinese copy clear and concise.
- Update the visible CodePath build/version string when changing sidebar behavior so manual browser testing can confirm the loaded build.
- Never hard-code API keys, GitHub tokens, machine-specific absolute paths, or personal browser profile paths.

## Validation

Before publishing changes, run:

```bash
npm.cmd run compile
npm.cmd run build
```

Also scan for secrets or local paths before pushing.
