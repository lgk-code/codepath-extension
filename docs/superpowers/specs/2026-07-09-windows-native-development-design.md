# CodePath Windows Native Development Design

## Goal

Move the authoritative CodePath checkout from WSL to `E:\projects\CodePath`, preserve all Git history and current reviewed work, and make Windows the documented and verified local development environment.

## Migration Strategy

The migration uses Git as the source of truth instead of copying a working directory. The current self-reload changes are committed on `codex/windows-native-development`, a Git bundle is created as a lossless local transfer artifact, and Git for Windows clones that bundle into `E:\projects\CodePath`. The Windows clone then points `origin` back to `https://github.com/lgk-code/codepath-extension.git`.

The existing WSL checkout remains temporarily as a backup. It is not deleted or treated as the active development location after the Windows clone passes verification.

## Windows Development Contract

- Active project root: `E:\projects\CodePath`.
- Git, Node.js, npm, tests, builds, and commits run with Windows-native tools.
- Node.js dependencies and generated output are recreated on Windows; Linux `node_modules`, `.wxt`, `.output`, and reports are never copied.
- Repository text files use LF through `.gitattributes`, avoiding platform-dependent line-ending churn.
- The unpacked Edge extension remains a separate deploy target. `CODEPATH_EDGE_EXTENSION_DIR` can override its location and `CODEPATH_EDGE_EXTENSION_ROOT` defines the allowed safety boundary; the current default remains `D:\edge下载\CodePath` because that is browser state, not the source checkout.

## Git Workflow

- `main` remains the stable branch.
- Development occurs on a topic branch and is committed in reviewable units.
- Every commit is preceded by focused tests; the final branch is gated by `npm run quality` and `git diff --check` on Windows.
- The migrated clone keeps `origin`, branch history, tags, and the current topic branch.
- The branch is pushed only after the Windows verification and independent review pass.

## Documentation And Path Cleanup

Project instructions become Windows-first. Hard-coded references to `/home/lgk/projects/CodePath`, WSL-only npm invocation, and UNC-based project execution are removed from the primary workflow. WSL notes may remain only as portable fallback guidance and must not imply that the active checkout is still in WSL.

The repository gains a concise Windows development guide covering setup, Git branches, quality gates, extension deployment, and migration boundaries. Existing release and CI behavior remains Linux-compatible.

## Refactoring Boundary

Refactoring is limited to code touched by the migration. The deploy script may be simplified or made more testable when that improves cross-platform behavior, but product analysis logic, UI architecture, and unrelated modules are outside scope. This keeps the migration auditable and avoids mixing environmental changes with a broad product rewrite.

## Verification

The Windows checkout must prove all of the following:

1. Git reports the expected branch, remote, history, tags, and a clean index after commits.
2. `npm ci` installs from the lockfile using Windows Node.js.
3. `npm run quality` passes from `E:\projects\CodePath`.
4. `git diff --check` passes.
5. `npm run deploy:edge` builds and synchronizes the extension from Windows.
6. Searches find no stale project-root references to the old WSL checkout.
7. An independent subagent reviews the complete branch diff and explicitly approves both requirement compliance and code quality.

## Failure Handling

The source WSL checkout and the local Git bundle are retained until the Windows clone has passed verification. Migration stops before deleting or replacing data if a commit, clone, dependency install, test, or deploy step fails. Secrets, browser profiles, dependencies, and generated artifacts are never added to Git.
