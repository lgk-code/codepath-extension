# CodePath Windows Native Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current CodePath work in Git, migrate the authoritative checkout to `E:\projects\CodePath`, and prove that Windows-native development, testing, and Edge deployment work end to end.

**Architecture:** Git commits and a local bundle carry source history across the WSL/Windows boundary; generated files and dependencies are recreated on Windows. Windows-first repository guidance and line-ending policy make the migrated checkout stable, while the existing cross-platform build and CI behavior remain intact.

**Tech Stack:** Git, Git for Windows, PowerShell, Node.js 24, npm, WXT, React, TypeScript, Node test runner.

## Global Constraints

- The authoritative project root after migration is exactly `E:\projects\CodePath`.
- Preserve the complete Git history, tags, `origin`, current topic branch, and all reviewed source changes.
- Keep the original WSL checkout as a temporary backup; do not delete it during this plan.
- Never transfer or commit `node_modules`, `.wxt`, `.output`, reports, secrets, browser profiles, or the Edge unpacked-extension directory.
- Keep CI and release workflows compatible with `ubuntu-latest`.
- The Edge deploy target remains separate from the source checkout and can be overridden with `CODEPATH_EDGE_EXTENSION_DIR`.
- Do not perform unrelated product or UI refactors.
- Do not push the branch until Windows verification and the independent final review pass.

---

### Task 1: Preserve Current Work In Git

**Files:**
- Modify: current self-reload files already present in the WSL working tree
- Create: `docs/superpowers/plans/2026-07-09-windows-native-development.md`

**Interfaces:**
- Consumes: current `codex/windows-native-development` branch and the verified self-reload working tree
- Produces: commits containing the migration plan and the complete self-reload change set

- [ ] **Step 1: Confirm the branch and real diff**

Run:

```bash
git branch --show-current
git diff --name-only
git ls-files --others --exclude-standard
```

Expected: branch is `codex/windows-native-development`; only the self-reload files and this plan remain uncommitted.

- [ ] **Step 2: Run the self-reload quality gates in WSL**

Run:

```bash
npm run quality
git diff --check
```

Expected: all tests, type checks, build checks, version checks, MCP checks, and secret scans pass with no whitespace errors.

- [ ] **Step 3: Commit the plan separately**

```bash
git add docs/superpowers/plans/2026-07-09-windows-native-development.md
git commit -m "docs: add Windows migration plan"
```

- [ ] **Step 4: Commit only the reviewed self-reload files**

Stage the ten modified and four new self-reload files listed by `git diff --name-only` and `git ls-files --others --exclude-standard`, inspect `git diff --cached --stat`, then commit:

```bash
git commit -m "feat: add dev-only extension self reload"
```

Expected: no unrelated files are staged; the branch contains reviewable commits and the working tree is clean after index refresh.

### Task 2: Create The Windows-Native Checkout

**Files:**
- Create outside repository: `E:\projects\CodePath-migration.bundle`
- Create checkout: `E:\projects\CodePath`

**Interfaces:**
- Consumes: committed `codex/windows-native-development` branch
- Produces: Windows-native Git clone with the same commit identity and an `origin` GitHub remote

- [ ] **Step 1: Create and verify a complete local Git bundle**

From WSL:

```bash
git bundle create /mnt/e/projects/CodePath-migration.bundle --all
git bundle verify /mnt/e/projects/CodePath-migration.bundle
```

Expected: bundle verification reports all refs and a complete history.

- [ ] **Step 2: Clone with Git for Windows**

From PowerShell:

```powershell
git clone E:\projects\CodePath-migration.bundle E:\projects\CodePath
git -C E:\projects\CodePath switch codex/windows-native-development
git -C E:\projects\CodePath remote set-url origin https://github.com/lgk-code/codepath-extension.git
```

Expected: `E:\projects\CodePath` is a standalone Windows checkout on the topic branch.

- [ ] **Step 3: Compare source identity**

Run `git rev-parse HEAD`, `git log -1 --format=%H`, `git tag --list`, and `git remote -v` in both checkouts. Expected: HEAD and tags match; the Windows clone's `origin` points to GitHub.

### Task 3: Establish Windows Development Conventions

**Files:**
- Create: `.gitattributes`
- Create: `docs/DEVELOPMENT.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `AGENTS.md`
- Modify: `docs/MCP_USAGE.md`
- Modify: `docs/TEST_CASES.md`
- Modify if required by tests: `scripts/deploy-edge.mjs`
- Test if script behavior changes: `scripts/dev-reload-marker.test.mjs` or a focused deploy helper test

**Interfaces:**
- Consumes: Windows project root and existing npm scripts
- Produces: Windows-first setup/Git/deploy instructions with portable CI behavior

- [ ] **Step 1: Add deterministic line-ending policy**

Create `.gitattributes` with:

```gitattributes
* text=auto eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.mp4 binary
*.zip binary
```

- [ ] **Step 2: Add the Windows development guide**

Document `E:\projects\CodePath`, `npm ci`, topic branches, conventional commit examples, `npm run quality`, `git diff --check`, `npm run deploy:edge`, `CODEPATH_EDGE_EXTENSION_DIR`, CI/release boundaries, and the rule that the WSL checkout is backup-only.

- [ ] **Step 3: Correct stale project-path guidance**

Make `README.md`, `README.en.md`, `AGENTS.md`, `docs/MCP_USAGE.md`, and `docs/TEST_CASES.md` Windows-first. Remove the hard-coded active path `/home/lgk/projects/CodePath` and instructions that require running this checkout through WSL or a `\\wsl$` UNC working directory. Keep generic WSL guidance only where it describes a supported alternative rather than the current source location.

- [ ] **Step 4: Check deploy portability**

Run the deploy marker and security tests before changing the deploy script. Only refactor `scripts/deploy-edge.mjs` if Windows execution exposes a real failure; add a failing focused test first and keep the existing environment override and safe-target guard.

- [ ] **Step 5: Commit repository conventions and path corrections**

Run focused tests and `git diff --check`, inspect the staged diff, then commit:

```powershell
git commit -m "chore: make Windows the primary development environment"
```

### Task 4: Verify The Windows Workflow End To End

**Files:**
- Generated and ignored: `node_modules`, `.wxt`, `.output`
- External deploy target: value of `CODEPATH_EDGE_EXTENSION_DIR` or `D:\edge下载\CodePath`

**Interfaces:**
- Consumes: migrated Windows checkout and lockfile
- Produces: evidence that Windows is the functional development environment

- [ ] **Step 1: Install from the lockfile**

From `E:\projects\CodePath`:

```powershell
npm.cmd ci
```

Expected: dependencies install successfully without using WSL artifacts.

- [ ] **Step 2: Run the complete Windows quality gate**

```powershell
npm.cmd run quality
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Deploy from Windows**

```powershell
npm.cmd run deploy:edge
```

Expected: the extension builds, safely replaces only the configured unpacked-extension target, writes `codepath-dev-reload.json`, and reports the current build identifier.

- [ ] **Step 4: Audit stale paths and Git state**

Search tracked text for `/home/lgk/projects/CodePath`, `/mnt/e/projects/CodePath`, and active-checkout instructions using `\\wsl$`. Verify `git status --short`, `git remote -v`, branch name, and recent commits. Expected: no stale active project paths, correct GitHub remote, and no generated artifacts tracked.

### Task 5: Independent Review And Publication

**Files:**
- Review: complete branch diff from merge base with `main`

**Interfaces:**
- Consumes: verified Windows branch
- Produces: explicit independent approval, final clean commit state, and pushed remote branch

- [ ] **Step 1: Dispatch a fresh independent subagent**

Ask one reviewer that did not implement the changes to inspect the complete branch diff for requirement coverage, migration safety, Git correctness, Windows portability, path accuracy, secrets, generated artifacts, and test adequacy. Require separate verdicts for spec compliance and code quality, and require file/line evidence for findings.

- [ ] **Step 2: Resolve all Critical and Important findings**

Apply fixes with focused tests, rerun the reviewer, and continue until both verdicts are approved. Minor findings must be either fixed or explicitly recorded with rationale.

- [ ] **Step 3: Re-run final evidence checks**

Run `npm.cmd run quality`, `git diff --check`, `git status --short --branch`, and verify `origin` from `E:\projects\CodePath` after the final reviewed commit.

- [ ] **Step 4: Push the topic branch**

```powershell
git push -u origin codex/windows-native-development
```

Expected: the remote branch points at the locally reviewed HEAD. Keep `main` unchanged pending a later merge decision.
