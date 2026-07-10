# CodePath Adversarial Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every confirmed Critical and Important invariant in the adversarial report while preserving CodePath's current browser, MCP, cache, and Windows deployment workflows.

**Architecture:** Security-sensitive decisions move into small pure helpers with focused tests. Existing orchestration remains in place, but provider tuples, repository authorization, stream framing, cache identity, source fallback, deployment promotion, and release provenance become explicit enforceable boundaries.

**Tech Stack:** TypeScript, Node.js 24, WXT MV3, React 18, Chrome extension APIs, GitHub REST/codeload, fflate, Node test runner, GitHub Actions.

## Global Constraints

- Work only on `codex/adversarial-hardening-v2` based on `8c5e9e37130955ac98c4f7da608f7e514c0d2314`.
- Preserve the DeepSeek browser default and all documented `CODEPATH_*` MCP settings.
- Never send an `OPENAI_*` credential to a CodePath/DeepSeek default endpoint.
- Repository-bearing extension requests must match their sender GitHub tab before network access.
- Do not replay a request after it has been dispatched through a runtime port.
- Raw stream, JSON tree, ZIP, cache-entry, and deployment filesystem operations remain bounded.
- Do not add broad host permissions or persist plaintext credential fingerprints.
- Every confirmed failure follows red-green TDD before production edits.
- Bump `UI_VERSION`, `CONTENT_BUILD`, and `BACKGROUND_BUILD` together for this user-visible hardening release.
- Final completion requires two fresh independent reviewer approvals with no open Critical or Important findings.

---

### Task 1: Provider Tuples, Secret Editor, And Scanner

**Files:**
- Create: `src/lib/settingsResolution.ts`
- Create: `src/lib/settingsResolution.test.ts`
- Create: `scripts/secret-patterns.mjs`
- Create: `scripts/secret-patterns.test.mjs`
- Modify: `scripts/codepath-mcp.ts`
- Modify: `src/lib/aiClient.ts`
- Modify: `src/lib/aiClient.test.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `public/secret-input.js`
- Modify: `wxt.config.ts`
- Modify: `scripts/scan-secrets.mjs`

**Interfaces:**
- Produces: `resolveMcpSettings(env): Settings`, `resolveProvider(settings): Provider`, `scanSensitiveText(text): SecretMatch[]`.
- Consumers: MCP startup, browser normalization, AI request/list/stream selection, scanner CLI.

- [ ] **Step 1: Write failing provider and secret tests**

Cover these exact cases:

```ts
assert.equal(resolveMcpSettings({ OPENAI_API_KEY: "sk-openai" }).baseUrl, "https://api.openai.com/v1");
assert.throws(() => resolveMcpSettings({ OPENAI_API_KEY: "sk-openai", CODEPATH_BASE_URL: "https://api.deepseek.com" }), /mixed credential namespaces/i);
assert.equal(resolveProvider({ ...settings, provider: "anthropic", baseUrl: "https://proxy.example/v1" }), "anthropic");
```

Add behavioral scanner fixtures assembled at runtime, such as `"AS" + "IA" + "A".repeat(16)` and a lowercase Windows user path, plus GitHub tokens and safe text. Add a hygiene assertion that `public/secret-input.js` uses exactly `codepath-settings` and the manifest exposes only `secret-input.html`, JS, and CSS to `https://github.com/*`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --import tsx --test src/lib/settingsResolution.test.ts src/lib/aiClient.test.ts scripts/secret-patterns.test.mjs scripts/security-hygiene.test.mjs
```

Expected: failures for missing tuple resolver, ignored provider override, missing scanner behavior, and wrong secret key/resource declaration.

- [ ] **Step 3: Implement the minimal boundaries**

`resolveMcpSettings` selects one namespace: explicit `CODEPATH_API_KEY` uses CodePath URL/model defaults; otherwise `OPENAI_API_KEY` uses `OPENAI_BASE_URL || https://api.openai.com/v1` and `OPENAI_MODEL || gpt-4.1-mini`. Explicit `CODEPATH_PROVIDER` remains authoritative. Browser normalization preserves a valid explicit provider and infers only for migrated/unknown values.

`scanSensitiveText` resets patterns per call and uses case-insensitive Windows-path patterns plus `A(?:KI|SI)A[0-9A-Z]{16}`. The CLI imports the pure matcher. The secret page writes `codepath-settings`; WXT exposes only the three secret editor resources to GitHub matches.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused command above plus `npm.cmd run compile`, then commit:

```powershell
git add src/lib/settingsResolution.ts src/lib/settingsResolution.test.ts src/lib/aiClient.ts src/lib/aiClient.test.ts scripts/codepath-mcp.ts scripts/secret-patterns.mjs scripts/secret-patterns.test.mjs scripts/scan-secrets.mjs scripts/security-hygiene.test.mjs public/secret-input.js wxt.config.ts entrypoints/background.ts src/components/Sidebar.tsx
git commit -m "fix: bind credentials to explicit providers"
```

### Task 2: Runtime Authorization And At-Most-Once Transport

**Files:**
- Create: `src/lib/runtimeBoundary.ts`
- Create: `src/lib/runtimeBoundary.test.ts`
- Create: `src/lib/streamBatcher.ts`
- Create: `src/lib/streamBatcher.test.ts`
- Modify: `entrypoints/content.tsx`
- Modify: `entrypoints/background.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/types.ts`
- Modify: `src/chrome.d.ts`

**Interfaces:**
- Produces: `repoStateKey(repo)`, `validateRepoRequestScope(request, senderUrl)`, `createStreamBatcher(flush, intervalMs)`.
- Protocol: `PortMessage` gains `heartbeat`; background emits one every 20 seconds while a request is active.

- [ ] **Step 1: Write failing boundary tests**

```ts
assert.notEqual(repoStateKey(firstCollisionRepo), repoStateKey(secondCollisionRepo));
assert.equal(validateRepoRequestScope({ type: "analyze-project", repo: otherRepo }, "https://github.com/owner/current"), false);
assert.equal(validateRepoRequestScope({ type: "get-settings" }, "chrome-extension://id/secret-input.html"), true);
```

Test 1,000 deltas through a fake timer batcher and assert exact concatenated text with no more than 30 flushes. Add source guards proving content navigation reparses `location.href`, background passes sender URLs, and non-settings transport does not call `sendViaMessage` after a port attempt.

- [ ] **Step 2: Verify RED**

Run `node --import tsx --test src/lib/runtimeBoundary.test.ts src/lib/streamBatcher.test.ts scripts/security-hygiene.test.mjs` and expect the new invariants to fail.

- [ ] **Step 3: Implement authorization, heartbeat, and batching**

Serialize repo identity with `JSON.stringify([owner, repo, branch ?? "", pageType, path ?? ""])`. Background derives `sender.tab.url` from messages and `port.sender.tab.url` from ports and rejects mismatches before `getSettings` or any analyzer call. Content events are navigation signals only; Sidebar reparses `location.href`.

Background wraps each port request in a 20-second heartbeat interval cleared in `finally`. Sidebar ignores heartbeat except as liveness, never replays repository analysis through `sendMessage`, and uses `createStreamBatcher` to flush accumulated text every 40 ms plus completion.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and `npm.cmd run compile`, then commit as `fix: authorize extension requests by sender tab`.

### Task 3: Bounded And Terminal-Aware Streaming

**Files:**
- Create: `src/lib/sse.ts`
- Create: `src/lib/sse.test.ts`
- Modify: `src/lib/aiClient.ts`
- Modify: `src/lib/aiClient.test.ts`
- Modify: `src/lib/fetchUtils.ts`
- Modify: `src/lib/fetchUtils.test.ts`

**Interfaces:**
- Produces: `parseSseLine(line, provider): { kind: "delta"; text: string } | { kind: "terminal" } | { kind: "ignore" }`.
- Enforces: raw stream <= 2 MiB, pending line <= 256 KiB, model content <= 500,000 characters.

- [ ] **Step 1: Write failing stream tests**

Test a stream that emits content plus `[DONE]` and never closes; assert immediate completion and one network request. Test Anthropic `message_stop`. Test a no-newline stream above 256 KiB and malformed JSON; assert `reader.cancel()` and no fallback request after valid terminal content.

- [ ] **Step 2: Verify RED**

Run `node --import tsx --test src/lib/sse.test.ts src/lib/aiClient.test.ts src/lib/fetchUtils.test.ts`; expect timeout/cancellation/bound failures.

- [ ] **Step 3: Implement bounded reader**

Count incoming `Uint8Array.byteLength` before decoding, check pending buffer after each append, stop on terminal events, and always cancel/release the reader on non-normal exit. Clear the response timeout in `finally`.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and compile, then commit as `fix: bound and terminate model streams`.

### Task 4: GitHub And ZIP Source Correctness

**Files:**
- Create: `src/lib/sourceIdentity.ts`
- Create: `src/lib/sourceIdentity.test.ts`
- Modify: `src/lib/githubClient.ts`
- Modify: `src/lib/githubUrl.ts`
- Modify: `src/lib/githubUrl.test.ts`
- Modify: `src/lib/zipGithubClient.ts`
- Modify: `src/lib/zipGithubClient.test.ts`
- Modify: `src/lib/analyzer.ts`
- Modify: `src/lib/analyzer.test.ts`
- Modify: `src/lib/fetchUtils.ts`

**Interfaces:**
- Produces: `digestZipEntries(entries): Promise<string>`, `discardResponse(response): Promise<void>`, and candidate ref/path metadata for ambiguous GitHub URLs.
- `GithubClient.getTree` uses an 8 MiB JSON limit.

- [ ] **Step 1: Write failing source tests**

Cover a 3-7 MiB non-truncated tree, `200` probe followed by no second metadata request, ZIP fallback where only `HEAD` works, the framing-collision pair from CP-ADV-012, rejected response cancellation, and ambiguous custom slash branches. Assert no guessed result is returned when candidate validation cannot establish a unique ref/path.

- [ ] **Step 2: Verify RED**

Run focused GitHub, URL, ZIP, fetch, and analyzer tests. Expected failures: 2 MiB tree rejection, duplicate metadata call, `main/master` guessing, hash collision, uncancelled response, and ambiguous URL guess.

- [ ] **Step 3: Implement source boundaries**

Pass `8 * 1024 * 1024` only to tree JSON reads. Memoize successful `getRepo` data in the API client wrapper. Use codeload `/zip/HEAD` when no explicit branch is present. Hash sorted entries with Web Crypto SHA-256 over length-prefixed UTF-8 path bytes and content bytes. Cancel and clear every rejected response.

For ambiguous URLs, retain all branch/path splits and validate longest viable candidates against GitHub snapshot plus file/tree contents. If validation is unavailable or non-unique, return an actionable ambiguity error rather than a guessed analysis.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and compile, then commit as `fix: resolve repository sources without guessing`.

### Task 5: Collision-Resistant And Linearizable Cache Policy

**Files:**
- Create: `src/lib/digest.ts`
- Create: `src/lib/digest.test.ts`
- Modify: `src/lib/analyzer.ts`
- Modify: `src/lib/analyzer.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `sha256Digest(parts: Array<string | Uint8Array>): Promise<string>` and per-scope cache generation guards.
- Cache status requires exact owner, repo, and refName before SHA comparison.

- [ ] **Step 1: Write failing cache tests**

Use the published FNV-collision model IDs and two API keys; assert distinct digests and second model calls. Pass a basis from another ref/repo with identical SHAs and assert rejection. Defer a model response, clear the repo, resolve it, and assert no cache write. Inject storage remove failure and assert visible rejection. Attempt a 1.6 MiB pending record and assert existing records remain.

- [ ] **Step 2: Verify RED**

Run `node --import tsx --test src/lib/digest.test.ts src/lib/analyzer.test.ts`; expect every new case to fail for the stated invariant.

- [ ] **Step 3: Implement cache guards**

Use Web Crypto SHA-256 with explicit length framing. Include provider, normalized endpoint, model, output limit, and SHA-256 API-key fingerprint in model identity. Capture global/repository generation at analysis start and permit memory/persistent writes only while unchanged. Increment relevant generations before clearing. Propagate `storage.remove` errors. Reject a pending record larger than either per-repo or global byte policy before pruning.

- [ ] **Step 4: Verify GREEN and commit**

Run analyzer/digest tests and compile, then commit as `fix: make analysis cache identity collision resistant`.

### Task 6: Canonical Atomic Deployment

**Files:**
- Create: `scripts/deploy-target.mjs`
- Create: `scripts/deploy-target.test.mjs`
- Modify: `scripts/deploy-edge.mjs`
- Modify: `scripts/deploy-edge-flow.mjs`
- Modify: `scripts/deploy-edge-flow.test.mjs`

**Interfaces:**
- Produces: `validateDeployTarget({ projectRoot, allowedRoot, targetDir, platform })` and `replaceDirectoryAtomic({ sourceDir, targetDir, fsOps })`.

- [ ] **Step 1: Write failing filesystem tests**

Test case-variant project equality, target descendants of the project, root targets, sibling-prefix escapes, and a Windows directory junction. Test injected copy/promotion failure preserves sentinel bytes in the original target and removes staging.

- [ ] **Step 2: Verify RED**

Run `node --test scripts/deploy-target.test.mjs scripts/deploy-edge-flow.test.mjs`; expect missing helper/failing containment and rollback cases.

- [ ] **Step 3: Implement canonical validation and promotion**

Resolve real existing paths and nearest existing parents, compare case-folded Windows identities, reject reparse-point escapes, and use `path.relative` containment. Copy output to `<target>.staging-<pid>`, verify manifest and marker, rename target to backup, promote staging, restore backup on failure, then remove backup.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and a deployment to a temporary allowed root before the real target, then commit as `fix: make Edge deployment canonical and atomic`.

### Task 7: Dependency And Release Supply-Chain Gates

**Files:**
- Create: `scripts/verify-release.mjs`
- Create: `scripts/verify-release.test.mjs`
- Create: `scripts/workflow-policy.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Produces: `verifyRelease({ tag, packageVersion, taggedSha, mainSha, isAncestor })`.
- Policy: every `uses:` reference is a full 40-character commit SHA.

- [ ] **Step 1: Write failing release and lockfile tests**

Assert Vite >= 8.0.16 and esbuild >= 0.28.1 from the lockfile. Assert `v0.1.2` matches package `0.1.2`, mismatched tags fail, and a tag commit not contained in `origin/main` fails. Assert no workflow contains `uses: owner/action@vN`.

- [ ] **Step 2: Verify RED**

Run release/workflow policy tests; expect vulnerable lockfile, absent provenance verifier, and mutable actions to fail.

- [ ] **Step 3: Upgrade and pin**

Update lockfile within existing semver compatibility or add narrow overrides for patched Vite/esbuild/Hono. Pin checkout, setup-node, upload-artifact, and release actions to verified full SHAs. Release checkout uses full history, then runs the provenance verifier before installing/publishing.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests, `npm.cmd audit --omit=dev`, and full quality. Document any remaining transitive advisory without a compatible fix. Commit as `chore: harden release supply chain`.

### Task 8: Version, Report Closure, Full Verification, And Reviews

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `entrypoints/content.tsx`
- Modify: `entrypoints/background.ts`
- Modify: `docs/reviews/2026-07-09-adversarial-review.md`
- Modify: `docs/TEST_CASES.md`

**Interfaces:**
- Produces: one new shared build string in all three required constants and a report disposition for every finding.

- [ ] **Step 1: Bump the three build IDs**

Use one exact value such as `dev-2026-07-09-adversarial-hardening-v2` in `UI_VERSION`, `CONTENT_BUILD`, and `BACKGROUND_BUILD`.

- [ ] **Step 2: Mark report outcomes**

For each CP-ADV ID record fixed commit/tests, accepted trust-boundary rationale, or remaining non-blocking debt. No Critical or Important item may remain open.

- [ ] **Step 3: Run Windows gates**

```powershell
npm.cmd ci
npm.cmd run quality
git diff --check
npm.cmd run deploy:edge
git status --short --branch
```

Expected: all exit 0, real Edge target receives the new marker, and only intentional tracked changes remain before the final commit.

- [ ] **Step 4: Dispatch two fresh adversarial reviewers**

Reviewer A owns security/trust/cache correctness. Reviewer B owns runtime/deployment/release/test quality. Both read the full branch diff from `8c5e9e3` through HEAD and this plan/report. Both must return `APPROVED` for spec and code quality with no Critical or Important findings.

- [ ] **Step 5: Close review findings and finish Git state**

Fix all blocking findings with focused tests, regenerate review packages, and repeat both reviews. Commit report closure as `docs: close adversarial hardening review`. Leave the reviewed branch clean and ready for an explicit push/PR decision.
