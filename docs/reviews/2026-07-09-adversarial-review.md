# CodePath Adversarial Review Report

## Review Baseline

- Repository: `E:\projects\CodePath`
- Reviewed commit: `8c5e9e37130955ac98c4f7da608f7e514c0d2314`
- Source branch: `codex/windows-native-development`
- Remediation branch: `codex/adversarial-hardening-v2`
- Review method: four independent read-only subagents, each reasoning from explicit invariants and attacker/failure models.
- Baseline quality: 79 tests passed. Imported-module coverage was 76.24% lines / 72.81% branches; browser entrypoints and the 1,800-line Sidebar were not executed by coverage.

## Independent Review Domains

1. Browser-extension trust boundaries, secrets, model output, hostile repositories, and MCP authority.
2. Cache freshness, snapshot identity, persistent storage, scope isolation, and concurrency.
3. MV3 lifecycle, transport semantics, streaming, GitHub/ZIP fallback, and UI performance.
4. Deployment safety, Windows portability, CI/release provenance, dependencies, and test strategy.

The agents reviewed the same immutable commit and did not share conclusions. Findings below are the main agent's cross-validated disposition, not a raw concatenation of agent output.

## Confirmed Critical Findings

### CP-ADV-001: Provider credential tuple can cross vendor boundaries

- Severity: Critical
- Evidence: `scripts/codepath-mcp.ts` independently falls back from `CODEPATH_API_KEY` to `OPENAI_API_KEY` while independently defaulting the URL to DeepSeek.
- Failure: with only `OPENAI_API_KEY` set, the MCP server can send an OpenAI credential to `api.deepseek.com`.
- Required fix: resolve provider, credential, base URL, and model as one coherent tuple. An `OPENAI_*` credential may use OpenAI defaults only; CodePath defaults may use DeepSeek.

### CP-ADV-002: Deploy target guard is lexical and case-sensitive

- Severity: Critical
- Evidence: `scripts/deploy-edge.mjs` compares normalized strings, but Windows paths are case-insensitive and may traverse reparse points.
- Failure: a case-variant path matching the project root can pass the guard and reach recursive deletion. Lexical containment also cannot prove junction containment.
- Required fix: move safety logic into a testable helper, canonicalize existing paths/nearest existing parents, use platform-aware containment, reject the project tree and reparse-point escapes, then replace atomically.

## Confirmed Important Findings

| ID | Area | Confirmed failure | Required remediation |
| --- | --- | --- | --- |
| CP-ADV-003 | Secret editor | `public/secret-input.js` writes `codepath.settings` while runtime reads `codepath-settings`; clear/save can report success without changing active credentials. | Share or verify the storage key and make the extension page reachable only through the intended GitHub match. |
| CP-ADV-004 | Provider override | `chat` and streaming infer provider from URL and ignore explicit `settings.provider`; neutral Anthropic proxies use OpenAI headers/endpoints. | Honor explicit normalized provider and infer only when no explicit provider exists. |
| CP-ADV-005 | Runtime authorization | Background accepts page-derived `RepoRef` without comparing it to the sender tab. A forged DOM event can request another repository with stored credentials. | Reparse `location.href` in the content UI and authorize every repo-bearing request against `sender.tab.url`/`port.sender`. |
| CP-ADV-006 | Repository state identity | Slash-joined repo keys are not injective, allowing distinct branch/path tuples to collide during navigation. | Use a structured tuple serialization in a shared helper and test collisions. |
| CP-ADV-007 | Streaming parser | Raw SSE buffer has no byte/line bound; `[DONE]` and `message_stop` do not terminate reads; abnormal exits do not cancel readers. | Add raw-byte and pending-line limits, explicit terminal events, and cancellation in every exit path. |
| CP-ADV-008 | Transport semantics | Port timeout replays the same request through `sendMessage` while the original work continues, violating at-most-once execution. | Do not replay a dispatched request. Add heartbeat/progress messages so a legitimate slow MV3 request remains active. |
| CP-ADV-009 | Git tree bounds | GitHub supports recursive tree responses up to 7 MB, but the generic JSON reader rejects above 2 MB. | Give the tree endpoint an explicit bounded limit above 7 MB while retaining the generic default elsewhere. |
| CP-ADV-010 | API-to-ZIP fallback | Source creation probes `getRepo`, then snapshot resolution calls it again. The second request can exhaust the final API allowance with no fallback. | Memoize probed repository metadata in the selected source client. |
| CP-ADV-011 | ZIP default ref | Unspecified ZIP analysis guesses `main`/`master`, failing or reading stale source for `develop`/`trunk` repositories. | Use GitHub codeload `HEAD` for the canonical default archive; keep explicit branches exact. |
| CP-ADV-012 | ZIP identity/resources | FNV framing is collision-prone; rejected responses retain body timeouts. | Use collision-resistant length-framed digest identity and cancel rejected response bodies/timeouts. |
| CP-ADV-013 | Cache identity | Model identity uses a 32-bit hash and omits credential identity, permitting collision/cross-tenant reuse. | Use SHA-256 over length-framed provider, endpoint, model, limits, and a non-plaintext API-key digest. |
| CP-ADV-014 | Follow-up scope | Snapshot freshness compares only SHAs; another owner/repo/ref with identical SHAs can be accepted. | Require owner, repo, and refName equality before SHA freshness checks. |
| CP-ADV-015 | Cache clearing | Active analyses can repopulate caches after clear; persistent deletion errors are converted to success; oversized pending records can evict valid entries. | Add cache generations, propagate clear failures, and reject oversized pending records before pruning. |
| CP-ADV-016 | Deploy replacement | Target is deleted before replacement is complete, so interruption can leave Edge with an incomplete extension. | Stage and validate a sibling copy, promote by rename with rollback, then remove backup. |
| CP-ADV-017 | Dependencies | The lockfile contains Vite 8.0.11 and esbuild below patched Windows dev-server releases. | Update patched transitive/direct versions and add a deterministic lockfile policy test. |
| CP-ADV-018 | Release provenance | Any `v*` tag can publish from an unmerged commit; write-capable workflow actions use mutable major tags. | Verify tag/package version and main ancestry, pin actions to immutable SHAs, and test workflow policy. |
| CP-ADV-019 | Secret scanner | Scanner misses `ASIA` temporary AWS keys and case-variant Windows private paths; tests inspect source text rather than behavior. | Extract pure scanning logic, add behavioral fixtures, and make path patterns case-insensitive. |
| CP-ADV-020 | Stream rendering | Every token delta copies accumulated text and rerenders Markdown, creating quadratic work. | Buffer deltas and flush on a bounded interval plus final completion. |

## Confirmed Ambiguity Requiring Conservative Behavior

### CP-ADV-021: GitHub slash-branch URLs are not self-delimiting

`/blob/<ref>/<path>` cannot be uniquely split when both refs and paths contain slashes. The current heuristic invents branch boundaries for ordinary paths and custom branch prefixes. Pure parsing cannot solve this correctly.

Required behavior: preserve candidate boundaries, then resolve them against GitHub ref/file data. If validation is unavailable, fail clearly instead of silently analyzing a guessed ref.

## Findings Not Treated As Blocking Defects

- MCP stdio caller allowlist: the configured MCP host is inside the documented local trust boundary. Repository allowlisting can be added later as an optional policy, but it is not required for intended operation.
- Forged ZIP central-directory metadata: codeload archives are generated by GitHub over HTTPS, not supplied byte-for-byte by repository contents. Existing compressed, entry, per-entry, and aggregate limits remain required; transport compromise is outside this threat model.
- Automatic proof that every user-visible change bumps the build ID: branch ancestry is not uniquely knowable in all local workflows. This iteration will bump all three IDs and keep equality enforcement; CI-level change detection remains future process work.
- External model links: ReactMarkdown blocks script URLs and raw HTML. External-link labeling is a useful Minor hardening item, not a release blocker.

## Structural Weaknesses

- `src/lib/analyzer.ts`: approximately 2,087 lines, mixing orchestration, cache policy, persistence, prompts, and parsing.
- `src/components/Sidebar.tsx`: approximately 1,800 lines, mixing UI rendering, runtime transport, settings storage, stream buffering, and repository identity.

This iteration extracts only security-sensitive helpers touched by fixes. A wholesale rewrite would increase regression risk and is not justified by a concrete failure.

## Remediation Strategy

Three options were considered:

1. Risk-first targeted hardening (selected): fix every confirmed Critical and Important invariant with regression tests, extracting only reusable security boundaries.
2. Large architecture rewrite: split Sidebar/analyzer first, then fix defects. Rejected because it expands the blast radius before correctness is restored.
3. Report-only: rejected because the requested goal requires the main agent to iterate the implementation.

## Completion Gate

- Every confirmed Critical and Important item is fixed or disproven with stronger evidence in this report.
- New tests reproduce each fixed failure before implementation and pass afterward.
- `npm.cmd run quality`, `git diff --check`, dependency policy, and `npm.cmd run deploy:edge` pass on Windows.
- Two fresh independent subagents review the complete remediation diff adversarially. Both must report no open Critical or Important findings and approve specification compliance and code quality.

## Remediation Closure

Implementation baseline: `8c5e9e37130955ac98c4f7da608f7e514c0d2314`. The following dispositions were verified on `codex/adversarial-hardening-v2` before the final two independent reviews.

| ID | Disposition | Fix evidence | Regression evidence |
| --- | --- | --- | --- |
| CP-ADV-001 | Fixed | `e528ebc` resolves one coherent `CODEPATH_*` or `OPENAI_*` tuple and rejects mixing. | `settingsResolution.test.ts` covers OpenAI defaults, CodePath defaults, mixed namespaces, and explicit Anthropic. |
| CP-ADV-002 | Fixed | `e70453d` canonicalizes real paths; `28b2f05` adds the reverse containment invariant so a deploy target may neither be inside nor contain the project, including after junction resolution. | `deploy-target.test.mjs` covers case variants, both containment directions, roots, sibling-prefix escapes, junction resolution, and a valid target. |
| CP-ADV-003 | Fixed | `e528ebc` writes `codepath-settings` and limits secret editor web resources to GitHub matches. | `security-hygiene.test.mjs` verifies the exact key and resource declaration. |
| CP-ADV-004 | Fixed | `e528ebc` makes valid explicit provider metadata authoritative for chat, model listing, and streaming. | `aiClient.test.ts` covers an Anthropic provider on a neutral proxy. |
| CP-ADV-005 | Fixed | `c0b8af6` reparses browser location and compares repo-bearing requests with the runtime sender. | `runtimeBoundary.test.ts` and hygiene guards cover same-repo acceptance and cross-repo rejection. |
| CP-ADV-006 | Fixed | `c0b8af6` serializes repository UI identity as a structured tuple. | `runtimeBoundary.test.ts` reproduces the slash boundary collision. |
| CP-ADV-007 | Fixed | `5fbbeaa` bounds raw SSE and pending lines, handles terminal records, and cancels abnormal reads. | `sse.test.ts` and `aiClient.test.ts` cover terminal, malformed, raw-byte, line, and cancellation paths. |
| CP-ADV-008 | Fixed | `c0b8af6` removes repository replay and adds heartbeat events; `28b2f05` removes `sendMessage` replay entirely and permits local model-list fallback only before successful port dispatch. | Runtime boundary and hygiene tests cover pre/post-dispatch policy, normal disconnect, stale navigation, and absence of the replay transport. |
| CP-ADV-009 | Fixed | `c40c5eb` gives recursive Git trees an explicit 8 MiB JSON bound while retaining the 2 MiB default elsewhere. | `githubClient.test.ts` accepts a bounded response above 2 MiB; truncated-tree regression remains green. |
| CP-ADV-010 | Fixed | `c40c5eb` memoizes successful repository metadata within each API client. | Direct client and analyzer tests assert one repository metadata request. |
| CP-ADV-011 | Fixed | `c40c5eb` uses codeload `/zip/HEAD` for an unspecified ref; `28b2f05` uses the generic exact-ref route for explicit branches, tags, and commits. | `zipGithubClient.test.ts` covers HEAD, slash branch failure, tag, and 40-character commit routes. |
| CP-ADV-012 | Fixed | `c40c5eb` replaces FNV entry identity with length-framed SHA-256 and discards rejected responses. | `sourceIdentity.test.ts`, ZIP rejection tests, and `discardResponse` tests cover collisions and cancellation. |
| CP-ADV-013 | Fixed | `c20cbcd` uses length-framed SHA-256 over provider, endpoint, model, output limit, and a SHA-256 credential fingerprint. | Analyzer tests reproduce a legacy FNV collision and cross-credential cache reuse. |
| CP-ADV-014 | Fixed | `c20cbcd` checks owner, repo, and ref before SHA freshness. | Follow-up test rejects another repository with identical SHAs. |
| CP-ADV-015 | Fixed | `c20cbcd` adds generations and pending-size preflight; `28b2f05` serializes persistent reads with deletion, canonicalizes case-insensitive repository identity, clears legacy case variants, and counts UTF-8 bytes. | Deferred delete/read, case-variant reuse/clear, remove failure, ASCII oversize, and multibyte oversize regressions pass. |
| CP-ADV-016 | Fixed | `e70453d` adds staging/rollback; `dffd11c` adds cross-runtime leases; `42a5867` adds immutable lock/heartbeat and unique backups; `f26c100` atomically publishes complete lock bytes and validates backup markers; `71d84ce` writes the rollback marker before target rename; `4bfc916` adds the Windows/WSL system Mutex; `8a704e3` covers verify/build/publish; `7c7ee1b` makes the lease recoverable within the wait window and preserves markers until backup rename succeeds. | Atomic tests cover full-pipeline serialization, long waits, marker-preserving rename failure, copy/promotion failure, separate processes, owner exit, cross-runtime/PID reuse, expired/empty locks, heartbeat publication, lease loss, unrelated backup-like directories, and a real Windows deployment. |
| CP-ADV-017 | Fixed | `f9dfc83` upgrades Vite; `28b2f05` removes Babel 8; `dffd11c` raises Node to 22.13; `42a5867` pins esbuild 0.27.2, which satisfies WXT/tsx while staying outside the reviewed `>=0.27.3 <0.28.1` advisory range. | Policy validates all installed Node engines, Babel/plugin semver, esbuild/WXT/tsx semver, and advisory bounds; `npm ci` and `npm audit` report zero vulnerabilities. |
| CP-ADV-018 | Fixed | `f9dfc83` pins Actions; `28b2f05` adds annotated-tag checks; `7c7ee1b` moves orchestration to the trusted default-branch `repository_dispatch`, validates tag/main/package before candidate checkout, builds with read-only permissions, and isolates the only write permission behind the `release` environment. | Release tests reject lightweight/mismatched/unmerged tags, require immutable Actions, default-branch orchestration, read-only build, one environment-bound write job, and full main history. |
| CP-ADV-019 | Fixed | `e528ebc` extracts a behavioral scanner with `ASIA` and case-insensitive private-path patterns. | `secret-patterns.test.mjs` covers AWS, GitHub, Windows, and safe input. |
| CP-ADV-020 | Fixed | `c0b8af6` batches stream deltas at a bounded interval and flushes on completion. | `streamBatcher.test.ts` preserves 1,000 deltas with bounded flushes. |
| CP-ADV-021 | Fixed conservatively | `c40c5eb` preserves boundaries; `f26c100` retains tag-like candidates; `7352c75` bounds matching refs; `4bfc916` adds body-free checks/memoization; `8a704e3` adds ZIP codeload-HEAD validation; `7c7ee1b` retries the complete operation through ZIP after any later API rate limit and keeps a full archive path index plus the requested filtered file. | URL, API, ZIP, and analyzer tests cover slash refs, tags, commits, deep/large/filtered files, early and late rate-limit fallback, unique/multiple resolution, oversized URLs, memoization, and request bounds. |

No confirmed Critical or Important finding remains open. The non-blocking trust-boundary decisions and structural debt listed above remain unchanged.

## First Remediation Re-review

Two independent read-only reviewers examined commit `2da6cafcc30738fd88462c680e3f10ee3061dc7f`. Both returned `CHANGES REQUIRED`. The main agent reproduced every Critical/Important counterexample before changing production code; commit `28b2f0588111b4ab8330ac574a66704e73e69fc4` closes them.

| ID | Severity | Re-review finding | Closure in `28b2f05` |
| --- | --- | --- | --- |
| CP-ADV-022 | Critical | A target that was an ancestor of the project passed deploy validation. | Canonical containment is now rejected in both directions, with direct and junction regressions. |
| CP-ADV-023 | Important | An analysis started while persistent deletion was pending could read and return the record being cleared. | Persistent reads participate in the mutation queue; a deterministic deferred-remove test proves deletion linearization. |
| CP-ADV-024 | Important | GitHub owner/repo cache identity was case-sensitive, so clear/reuse could diverge across casing. | All cache keys, memory prefixes, grouping, scope checks, stats, and deletion matching use a lower-cased repository identity. |
| CP-ADV-025 | Important | Persistent size policy counted UTF-16 code units rather than stored UTF-8 bytes. | Key and value JSON sizes use `TextEncoder`; a 520,000-character CJK result is rejected without evicting valid records. |
| CP-ADV-026 | Important | ZIP fallback forced every explicit ref through `refs/heads`, excluding tags and commits. | Explicit refs use codeload's generic exact-ref path; branch, tag, and commit tests pass. |
| CP-ADV-027 | Important | A forced Babel 8 override violated plugin-react's Babel 7 range and the project's Node 20 floor. | The override is removed; lockfile policy now checks semver and Node engine compatibility. |
| CP-ADV-028 | Important | Concurrent deploys shared one backup path, allowing a successful deployment to be overwritten by another rollback. | Same-target promotion is guarded by a cross-process owner-token lock; concurrency and dead-owner recovery tests pass. |
| CP-ADV-029 | Important | A dispatched `list-models` request could be replayed through two fallback transports. | No dispatched request changes transport; only a pre-dispatch model-list failure may execute locally. |
| CP-ADV-030 | Important | Release verification accepted a named tag without proving tag type or binding it to checkout `HEAD`. | Exact annotated-tag peeling and `HEAD` equality are mandatory before ancestry validation. |
| CP-ADV-031 | Minor | A normal port disconnect without `runtime.lastError` waited for the timeout. | Every unsettled disconnect rejects immediately with a stable fallback message. |
| CP-ADV-032 | Minor | The 800 ms SPA polling window could send a request for the previous GitHub path. | Every repo-bearing request is reparsed against `location.href` immediately before dispatch. |

Post-fix evidence on Windows: 149 tests passed; compile, Vite 8.0.16 build, three-way build-version verification, MCP tool verification, secret scan, `git diff --check`, and `npm audit` all passed. `npm.cmd run deploy:edge` atomically installed build `dev-2026-07-10-adversarial-review-fixes-v1` to the configured Edge directory; the installed marker and MV3 manifest were read back successfully with no backup or lock artifact remaining.

## Second Remediation Re-review

Two fresh independent read-only reviewers examined commit `28b2f0588111b4ab8330ac574a66704e73e69fc4`. Both returned `CHANGES REQUIRED`. Commit `dffd11c1eab89da3ceb29ad4b4fbd9ab7df8d367` closes all six independently reproduced Important findings.

| ID | Severity | Re-review finding | Closure in `dffd11c` |
| --- | --- | --- | --- |
| CP-ADV-033 | Important | Decoded `/` or `\\` in owner/repo could pass sender scope and normalize an API URL to another repository. | GitHub URL parsing enforces legal single-segment owner/repo grammar, while API and codeload clients encode each identity segment independently. |
| CP-ADV-034 | Important | A legal ref containing `@` broke persistent-key parsing and prevented repository clear. | Branch components are percent-encoded in new keys; legacy keys split on the first repository delimiter and decode safely. A `feature@x` clear/reanalyze regression passes. |
| CP-ADV-035 | Important | PID liveness is namespace-local, so WSL could reclaim an active Windows deployment lock. | Lease ownership no longer uses PID liveness. A fresh foreign-runtime lock times out, while heartbeat keeps an active short lease from being reclaimed. |
| CP-ADV-036 | Important | A crash between exclusive lock creation and metadata write left a permanent empty lock. | Empty or malformed lock state ages by filesystem mtime, is confirmed unchanged, then is atomically quarantined and removed after lease expiry. |
| CP-ADV-037 | Important | `engines.node >=20.19` admitted runtimes below installed `listr2 >=22.13.0`. | Project and documentation now require Node 22.13; policy checks that the declared floor satisfies every installed package engine. |
| CP-ADV-038 | Important | A response completed during the 800 ms GitHub SPA polling window could render results for the previous path. | Stream delta, fallback, success, error, and final cleanup now compare their structured run key directly with the current parsed `location.href`. |

Second post-fix evidence on Windows: 157 tests passed; compile, Vite 8.0.16 build, build-version verification, MCP tool verification, secret scan, `git diff --check`, and zero-vulnerability `npm audit` passed. `npm.cmd run deploy:edge` installed and read back build `dev-2026-07-10-adversarial-review-fixes-v2`; the MV3 manifest was valid and no backup or lease artifact remained.

## Third Remediation Re-review

Two fresh independent read-only reviewers examined commit `dffd11c1eab89da3ceb29ad4b4fbd9ab7df8d367`. Both returned `CHANGES REQUIRED`. Commit `42a5867d8a2b1bc67cfe5deacb86cfaa183b8034` closes the Critical and six Important findings.

| ID | Severity | Re-review finding | Closure in `42a5867` |
| --- | --- | --- | --- |
| CP-ADV-039 | Critical | Encoded separators in a file path produced `..` components that normalized an authenticated contents request into another repository. | URL parsing rejects decoded separators/dot components in every path segment, and `GithubClient` independently rejects unsafe content paths before fetch. |
| CP-ADV-040 | Important | An old task's fallback callback could modify a newer same-target task because it lacked runId scope. | `run` supplies a closure bound to runId/repoKey/target; fallback state updates require the exact active run and current URL. |
| CP-ADV-041 | Important | New encoded refs shared the raw v2 namespace, so legacy `release%2Fx` collided with new `release/x`. | Encoded records use explicit `codepath-cache-v2:e:` keys; parsers decode only that subnamespace and keep legacy refs raw. Group/delete isolation is tested. |
| CP-ADV-042 | Important | In-place heartbeat truncation temporarily exposed an empty lock that a short lease could reclaim. | The lock file is immutable; renewal touches a token-specific heartbeat sidecar without rewriting lock metadata. A delayed-renewal test proves the lock stays parseable. |
| CP-ADV-043 | Important | A deployment that lost its lease after promotion could delete another transaction's rollback backup. | Backups are transaction-unique, ownership is rechecked after promotion and before cleanup, and a lost owner leaves its rollback artifact for the next lease holder to reconcile. |
| CP-ADV-044 | Important | esbuild 0.28.1 was outside WXT/tsx dependency ranges. | esbuild 0.27.2 satisfies both upstream ranges and lies outside the current Windows dev-server advisory range; lockfile policy enforces both facts. |
| CP-ADV-045 | Important | Existing lightweight `v0.1.2` prevented a normal annotated release of the hardened code. | Package/lock version is now 0.1.3, no `v0.1.3` tag exists, and release documentation requires creating it as an annotated tag only after merge to main. |

Third post-fix evidence on Windows: clean `npm ci`; 163 tests; compile; Vite 8.0.16 build; build-version, MCP tool, secret and whitespace checks; and zero-vulnerability `npm audit` all passed. `npm.cmd run deploy:edge` installed build `dev-2026-07-10-adversarial-review-fixes-v3`; marker and MV3 manifest were read back, with no backup, lock, or heartbeat artifact remaining.

## Fourth Remediation Re-review

Two fresh independent read-only reviewers examined commit `42a5867d8a2b1bc67cfe5deacb86cfaa183b8034`. Both returned `CHANGES REQUIRED`. Commits `f26c100c2d18989a0f85fcc17bcc7a337682219c` and `71d84ce9b420a861b5f52569a590290c4b85c8a0` close all four Important findings and the final pre-rename crash window.

| ID | Severity | Re-review finding | Closure in `f26c100` |
| --- | --- | --- | --- |
| CP-ADV-046 | Important | Direct API/ZIP client calls could bypass URL parsing and pass `..` as owner/repo; `encodeURIComponent("..")` is still `..`. | URL parser and both clients now share one strict GitHub identity validator; invalid direct calls reject before any authenticated fetch. |
| CP-ADV-047 | Important | Commit/tag-like first segments discarded later ref/path candidates, so a legal `v1.2.3/hotfix` ref was never validated. | Heuristic initial selection remains for display, but all possible boundaries are retained and resolved through GitHub data. |
| CP-ADV-048 | Important | Recovery deleted any sibling named `CodePath.backup-*`, including unrelated user directories. | Only strict transaction-shaped names with a matching internal CodePath marker are eligible for restore or deletion; an unrelated sentinel regression passes. |
| CP-ADV-049 | Important | Exclusive lock creation exposed a zero-byte lock before token bytes were written. | A complete candidate file is fsynced first, then hard-linked to the lock path as the atomic exclusive publication operation; concurrent observation sees either ENOENT or complete metadata. |

Fourth post-fix evidence on Windows: 166 tests, compile, Vite 8.0.16 build, build-version/MCP/secret/whitespace checks, and zero-vulnerability audit passed. Build `dev-2026-07-10-adversarial-review-fixes-v4` was deployed and read back with a valid MV3 manifest and no lock, heartbeat, candidate, backup, or journal artifact.

## Fifth Remediation Re-review

Two fresh independent read-only reviewers examined commit `71d84ce9b420a861b5f52569a590290c4b85c8a0`. Both returned `CHANGES REQUIRED`. Commit `6c065266b62ca1f8e741b6be77fcb09cdf6c5d77` addressed both findings, but the next review found that its first request bound rejected normal deep paths and that lease checks still did not protect the target mutation itself. Those follow-on failures are closed in the sixth round below.

| ID | Severity | Re-review finding | Closure in `6c06526` |
| --- | --- | --- | --- |
| CP-ADV-050 | Important | An ambiguous URL with twenty ref/path boundaries could trigger up to sixty-one GitHub requests because every candidate resolved a snapshot and recursive tree. | `6c06526` removed recursive-tree-per-candidate amplification; `7352c75` completes the fix with two bounded matching-ref queries and at most eight Contents checks without rejecting on path depth. |
| CP-ADV-051 | Important | Stale-lock recovery used a read/read/rename sequence, so an owner could refresh between the final read and claimant rename and still be displaced. | `6c06526` atomically fences the token heartbeat; `7352c75` additionally forbids takeover while the recorded same-runtime process is still alive. |

Fifth post-fix evidence on Windows: 168 tests passed; compile, Vite 8.0.16 build, three-way build-version verification, MCP tool verification, secret scan, `git diff --check`, and zero-vulnerability `npm audit` passed. `npm.cmd run deploy:edge` installed build `dev-2026-07-10-adversarial-review-fixes-v5` to `D:\\edge下载\\CodePath`; the installed marker reported that exact build, the manifest reported MV3/version 0.1.3, and no lock or backup artifact remained.

## Sixth Remediation Re-review

Two fresh independent read-only reviewers examined commit `6c065266b62ca1f8e741b6be77fcb09cdf6c5d77`. Both returned `CHANGES REQUIRED`. Commit `7352c750417732adcfca466184f620e3dd05f67b` addressed all three findings, but the next review found two request-budget follow-ons and showed that PID-based crash recovery was not portable across Windows/WSL. Those follow-ons are closed in the seventh round below.

| ID | Severity | Re-review finding | Closure in `7352c75` |
| --- | --- | --- | --- |
| CP-ADV-052 | Important | A live deployment paused after `assertOwned()` could be timed out and replaced; when resumed, its unchecked target rename could move the new owner's successfully published directory. | Complete lock metadata now records PID and host/runtime identity. A stale complete-token lock is reclaimable only when that exact runtime can positively confirm the process exited; unknown or live owners time out conservatively. `assertOwned()` renews a still-owned stale heartbeat before mutation. A deterministic pause-at-marker regression proves the claimant cannot enter and the target remains intact. |
| CP-ADV-053 | Important | The eight-candidate cap rejected ordinary deep monorepo/Java paths, including immutable commit URLs, before any GitHub request. | Path depth no longer determines request count. Two bounded `matching-refs` calls discover real head/tag names sharing the URL prefix; only actual refs, capped at eight, receive a bounded Contents check. Full and abbreviated commit permalinks retain direct commit resolution. |
| CP-ADV-054 | Important | `possibleRefCandidates()` materialized repeated `slice().join()` strings before any limit, causing quadratic CPU and memory growth for thousands of URL segments. | Parsing rejects paths over 8,192 characters or 128 segments before decoding and candidate construction. The 1,200-segment regression now returns `null` without materializing candidates. |

Sixth post-fix evidence on Windows: 172 tests passed; compile, Vite 8.0.16 build, build-version/MCP/secret/whitespace checks, and zero-vulnerability `npm audit` passed. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v6`; the manifest reported MV3/version 0.1.3 and no staging, backup, lock, heartbeat, or candidate artifact remained.

## Seventh Remediation Re-review

Two fresh independent read-only reviewers examined commit `7352c750417732adcfca466184f620e3dd05f67b`. Both returned `CHANGES REQUIRED`. Commit `4bfc91686b09cd4757fea6cbf2bacee89a936a4b` addressed all three findings, but the next review exposed three source-fallback edge cases and two whole-deployment locking gaps. Those follow-ons are closed in the eighth round below.

| ID | Severity | Re-review finding | Closure in `4bfc916` |
| --- | --- | --- | --- |
| CP-ADV-055 | Important | Contents metadata validation buffered the normal Base64 body under a 512 KiB limit, rejecting legal large files and large directory responses. | Candidate validation now sends `HEAD` with GitHub's raw media type and classifies the response Content-Type. It reads no body; a synthetic 600,000-byte content-length regression and live file/directory header probes confirm the distinction. |
| CP-ADV-056 | Important | A source-backed follow-up resolved the same ref/path once for context freshness and again for source loading, doubling matching-ref and Contents requests. | `GithubClient.resolveRepoRef()` memoizes the structured repository/page/candidate tuple for the client's lifetime. A repeated disambiguation regression performs exactly one two-ref-plus-one-path request set. |
| CP-ADV-057 | Important | PID liveness could neither recover a WSL-created stale lock from Windows nor distinguish PID reuse, potentially leaving a missing target unrecoverable. | Target mutation now holds a named Windows system Mutex derived from a canonical Windows/WSL target identity. A hidden PowerShell helper owns the Mutex and releases it automatically when the Node owner's stdin pipe closes. File leases are recovered only after the Mutex is held and no longer rely on PID identity. Tests cover separate Node processes, owner termination, cross-runtime stale metadata, PID reuse, and the pause-before-mutation race. |

Seventh post-fix evidence on Windows: 178 tests passed; compile, Vite 8.0.16 build, build-version/MCP/secret/whitespace checks, and zero-vulnerability `npm audit` passed. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v7`; the manifest reported MV3/version 0.1.3 and no staging, backup, lock, heartbeat, or candidate artifact remained.

## Eighth Remediation Re-review

One fresh independent reviewer examined GitHub/ref/cache behavior and returned `CHANGES REQUIRED`. The first deployment reviewer was rejected by the review service before producing a verdict; a fresh replacement independently reviewed deployment, release, and runtime behavior and also returned `CHANGES REQUIRED`. Commit `8a704e3732475c1292244725d2f7bd5988324e5a` addressed all five findings, but the next review identified two later-fallback gaps and three release/crash-recovery gaps. Those follow-ons are closed in the ninth round below.

| ID | Severity | Re-review finding | Closure in `8a704e3` |
| --- | --- | --- | --- |
| CP-ADV-058 | Important | API rate limiting selected ZIP fallback, but the wrapper omitted `resolveRepoRef`, so normal file URLs with more than one syntactic boundary failed before archive analysis. | ZIP fallback now issues bounded codeload HEAD requests for exact candidate refs. It downloads one archive only when exactly one candidate ref exists, verifies the requested file/directory path inside that archive, and otherwise rejects conservatively. |
| CP-ADV-059 | Important | `matching-refs` response length was checked before filtering to URL candidates; repositories with many unrelated refs sharing a prefix rejected a valid unique branch. | The 512 KiB response remains bounded, but names are filtered against the finite URL candidate set before the eight-existing-candidate budget is applied. Live `microsoft/vscode` `release/1.100/README.md` resolution succeeded. |
| CP-ADV-060 | Important | HEAD validation accepted a 1-100 MiB file, while `getFile()` used JSON media and interpreted GitHub's empty `encoding: none` body as empty source. | API file reads now request raw media and stream at most 2 MiB; JSON fallback rejects missing/`none` content instead of returning an empty string. Live reading of a 1,377,561-byte VS Code source fixture returned the full content. |
| CP-ADV-061 | Important | The system Mutex covered target replacement but not `npm run build`, so two deploy commands could concurrently write `.output/chrome-mv3`. | `runVerifiedDeployment()` now accepts one target-scoped Mutex wrapper around version verification, build, and sync. `replaceDirectoryAtomic()` reuses and validates that same Mutex identity. A concurrent full-pipeline regression observes one active build. |
| CP-ADV-062 | Important | A fixed 10-second helper-start timer remained active during `WaitOne`, truncating the configured 30-second Mutex wait. | The helper emits `READY` before `WaitOne`; Node clears the startup timer and starts a separate configured wait watchdog. A Windows regression holds the Mutex beyond the helper startup timeout and still acquires before the lock timeout. |

Eighth post-fix evidence on Windows: 183 tests passed; compile, Vite 8.0.16 build, build-version/MCP/secret/whitespace checks, and zero-vulnerability `npm audit` passed. Live GitHub probes confirmed the noisy-prefix branch and 1.38 MB raw file cases. `npm.cmd run deploy:edge` serialized verify/build/publish and installed `dev-2026-07-10-adversarial-review-fixes-v8`; the marker and MV3/version 0.1.3 manifest were read back with no deployment artifact remaining.

## Ninth Remediation Re-review

Two fresh independent read-only reviewers examined commit `8a704e3732475c1292244725d2f7bd5988324e5a`. Both returned `CHANGES REQUIRED`. Commit `7c7ee1bd2fb599749a4f8dd7dc888b8dc5dc56d3` addressed all five findings, but the next review found two fallback paths that still bypassed unique retry behavior and one tag-movement approval race. Those follow-ons are closed in the tenth round below.

| ID | Severity | Re-review finding | Closure in `7c7ee1b` |
| --- | --- | --- | --- |
| CP-ADV-063 | Important | ZIP fallback occurred only when the initial repository probe failed; a later snapshot/tree/file 403 failed the operation after partial API work. | Every source-backed public analysis function now runs through one rate-limit retry boundary. A GitHub 403/429 after the probe discards the failed attempt and reruns the complete operation with a forced ZIP client, so API and ZIP snapshots are never mixed. |
| CP-ADV-064 | Important | ZIP extraction discarded non-`isUsefulPath` files before current-file validation/read, so valid SVG/CSS/HTML pages failed only under fallback. | ZIP keeps a bounded full archive path index while decompressing only useful snippets plus the explicitly requested path. Ref/path validation uses the full index, and the requested filtered file remains available to `getFile()`. |
| CP-ADV-065 | Important | A tag-push workflow was loaded from the tag commit, allowing candidate-controlled verifier/workflow code to run with `contents: write`. | Release now uses `repository_dispatch`, which loads the default-branch workflow. Trusted main validates annotated tag, package version, and main ancestry before checkout. Candidate code builds in a read-only job; a separate `release` environment job owns the sole write permission. |
| CP-ADV-066 | Important | Default file lease was 120 seconds while lock wait was 30 seconds, so immediate retry after a post-backup crash could not reach reconciliation. | Exported defaults now enforce a 5-second lease inside a 30-second wait. The system Mutex still prevents live-owner takeover; after owner exit, stale file state becomes recoverable within the same retry. |
| CP-ADV-067 | Important | Recovery deleted the only backup marker before rename; another crash or rename failure made the valid backup permanently undiscoverable. | Recovery and rollback now rename the marked backup first, then remove the marker from the restored target. A forced rename-failure regression proves the backup retains provenance. |

Ninth post-fix evidence on Windows: 188 tests passed; compile, Vite 8.0.16 build, build-version/MCP/secret/whitespace checks, zero-vulnerability `npm audit`, and YAML lint passed. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v9`; the manifest reported MV3/version 0.1.3 with no deployment artifact remaining.

## Tenth Remediation Re-review

Two fresh independent read-only reviewers examined commit `7c7ee1bd2fb599749a4f8dd7dc888b8dc5dc56d3`. Both returned `CHANGES REQUIRED`. Commit `66802165499fe8911ca830ee78376f0d7c5384ed` closes all three Important findings.

| ID | Severity | Re-review finding | Closure in `6680216` |
| --- | --- | --- | --- |
| CP-ADV-068 | Important | Focused snippet loading caught every file error, so a GitHub 403/429 was converted into an incomplete empty-source model run instead of reaching the whole-operation ZIP retry. | The tolerant file loop now rethrows GitHub rate-limit errors and only skips ordinary per-file failures. A file-stage 403 regression confirms one codeload retry, unchecked status, and a real source entry. |
| CP-ADV-069 | Important | ZIP resolution rejected as soon as two candidate refs existed, even when only one archive contained the candidate's complete path. | ZIP fallback may now inspect at most three bounded candidate archives, using each full path index to select exactly one viable ref/path pair. Zero or multiple path matches still fail conservatively. |
| CP-ADV-070 | Important | The tag could move while the write job waited for `release` environment approval, leaving the verified artifact SHA different from the tag used by the Release. | After approval and before asset download/publication, the write job checks out trusted main, refetches the remote annotated tag, peels it, compares it byte-for-byte with the build job's expected commit, and rechecks main ancestry. Any movement fails publication. |

Tenth post-fix evidence on Windows: 190 tests passed; compile, Vite 8.0.16 build, build-version/MCP/secret/whitespace checks, YAML lint, and zero-vulnerability `npm audit` passed. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v10`; the manifest reported MV3/version 0.1.3 with no deployment artifact remaining.

## Eleventh Remediation Re-review

Two fresh independent read-only reviewers examined commit `66802165499fe8911ca830ee78376f0d7c5384ed`. Both returned `CHANGES REQUIRED`. Commit `9098b7177b8d34383b43ca0a128e9528cfac86f0` closes all four Important findings.

| ID | Severity | Re-review finding | Closure in `9098b71` |
| --- | --- | --- | --- |
| CP-ADV-071 | Important | GitHub's Contents API resolves valid symbolic links to target content, but the source cache used the stable symlink blob SHA; a target-only change could therefore feed old target bytes into a new tree analysis. | Git tree mode is retained, mode `120000` content identity includes the immutable fetch snapshot, analyzer version is bumped, and a target-v1/target-v2 regression proves the second model request receives only v2. |
| CP-ADV-072 | Important | API and ZIP attempts captured separate cache generations, so clearing during a blocked API request could be followed by a fallback attempt that repopulated memory caches under a fresh generation. | Every source-backed public operation captures one guard before the retry boundary and passes it through both API and ZIP attempts. A deterministic clear-during-403 regression proves the fallback cannot repopulate source cache state. |
| CP-ADV-073 | Important | Reading a 403/429 response body could itself fail and replace the GitHub status-bearing error, preventing rate-limit classification and the ZIP retry. | All GitHub non-success paths use one error constructor that preserves status even when the body stream fails. An errored 429 body now completes through ZIP with `unchecked` provenance. |
| CP-ADV-074 | Important | Revalidating an annotated tag after environment approval still left a small check-to-publication window in which a mutable tag could move. | The public repository now has active ruleset `Immutable release tags` (ID `18772779`) targeting `refs/tags/v*`, restricting update and deletion with no bypass actor. The write job queries the Rulesets API and requires that its publishing identity cannot bypass the matching rules before revalidating and publishing. |

Eleventh post-fix evidence on Windows: 197 tests passed; compile, Vite 8.0.16 build, synchronized build-version verification, MCP tool verification, secret and whitespace checks, YAML parsing, and zero-vulnerability `npm audit` passed. The live GitHub Rulesets API returned active tag ruleset `18772779` with `update`, `deletion`, empty bypass actors, and `current_user_can_bypass: never`. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v11`; the marker reported that exact build and the installed manifest reported MV3/version 0.1.3.

## Twelfth Remediation Re-review

Two fresh independent read-only reviewers examined commit `9098b7177b8d34383b43ca0a128e9528cfac86f0`. Both returned `CHANGES REQUIRED`. Commit `90178b506e8a3848fba1c70bf42843e5a74eaeea` closes every Critical/Important finding and the two Minor robustness gaps they reported.

| ID | Severity | Re-review finding | Closure in `90178b5` |
| --- | --- | --- | --- |
| CP-ADV-075 | Important | GitHub fallback classified errors by message text, so a model 429 whose body mentioned GitHub could replay the model request through ZIP fallback. | GitHub 403/429 responses now use a dedicated typed error; source fallback catches only that type. A model-429 regression performs one model request and zero codeload requests. |
| CP-ADV-076 | Important | The prompt cache fingerprint omitted the five `*Attempt` functions that contain the actual inline analysis instructions. | `PROMPT_VERSION` now fingerprints all five attempt functions, with a structural policy test preventing their removal. |
| CP-ADV-077 | Important | Unchecked ZIP analysis linked sources through a mutable branch, making displayed provenance stronger than the validated basis. | Source links are emitted only for a full 40-character analyzed commit SHA. Unchecked results render source paths as inert text. |
| CP-ADV-078 | Important | Model Markdown could emit active external links and images, creating unreviewed navigation and network requests from analysis output. | The Markdown tree now permits only same-repository blob links at the exact immutable commit; external links and all images are converted to inert text nodes. |
| CP-ADV-079 | Important | The environment-approved write job checked out floating `main`, so later default-branch code could execute with `contents: write`. | Both verifier checkouts are pinned to the triggering `github.workflow_sha`; the write job cannot execute verifier code added after dispatch. |
| CP-ADV-080 | Important | Post-approval release validation compared only the peeled commit, not the exact annotated tag object selected by the read-only build. | The build exports both tag-object SHA and commit SHA; the write job refetches and compares both identities before publication. |
| CP-ADV-081 | Important | The secret editor was web-accessible and frameable from GitHub, weakening the extension-origin input boundary. | Secret assets were removed from `web_accessible_resources`, extension CSP sets `frame-ancestors 'none'`, and only background opens the extension popup and accepts allowlisted single-field updates. |
| CP-ADV-082 | Important | Independent settings, secret, and stream-probe writes used read/merge/write races that could restore a revoked key or overwrite another concurrent change. | One background-owned serialized settings store preserves current secrets on non-secret saves and conditionally applies probe metadata only when the tested connection identity is still current. |
| CP-ADV-083 | Important | A stream parse/read failure after visible deltas could fall back to non-streaming chat and send the same model request twice. | Automatic fallback is allowed only for an explicit streaming-unsupported error before the first delta; any later failure is surfaced without replay. |
| CP-ADV-084 | Important | Deployments to different Edge targets used different target mutexes while concurrently building the same `.output/chrome-mv3`. | The full pipeline acquires an output-scoped Mutex before the target-scoped Mutex. A concurrent different-target regression observes at most one active build. |
| CP-ADV-085 | Minor | Malformed persistent file records with missing `basis.files` or a non-string payload could reach unchecked property/content use. | Cache-record validation now checks the complete basis shape and file payload type; corrupt records become cache misses. |
| CP-ADV-086 | Minor | Background dispatch compared only repository identity and did not reject an already stale same-repository branch/path request. | Runtime dispatch now validates the full owner/repo/branch/page/path tuple from the sender URL before starting work. |

Twelfth post-fix evidence on Windows: 209 tests passed; compile, Vite 8.0.16 build, synchronized build-version verification, MCP tool verification, secret and whitespace checks, YAML parsing, and zero-vulnerability `npm audit` passed. The live tag-ruleset verifier again confirmed active ruleset `18772779`. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v12`; the installed MV3/version 0.1.3 manifest had `frame-ancestors 'none'`, no web-accessible secret resources, and no deployment artifact remained.

## Thirteenth Remediation Re-review

Two fresh independent read-only reviewers examined commit `90178b506e8a3848fba1c70bf42843e5a74eaeea`. Both returned `CHANGES REQUIRED`. Commit `edffba6f52062db07fff48af170aca69f680c4d0` closes all five Important findings and the remaining prompt-fingerprint Minor.

| ID | Severity | Re-review finding | Closure in `edffba6` |
| --- | --- | --- | --- |
| CP-ADV-087 | Important | A stream that emitted valid deltas and then reached EOF without `[DONE]`/`message_stop` was accepted and cached as a complete model result. | Stream completion now requires the provider terminal event. Premature EOF rejects, performs one request, and cannot populate a result cache. |
| CP-ADV-088 | Important | A 200 streaming response that failed before its first delta could still trigger a second non-streaming POST, duplicating accepted inference and cost. | `chatAuto` no longer automatically replays any dispatched streaming POST. Size, parse, protocol, transport, and terminal failures are surfaced after exactly one model request. |
| CP-ADV-089 | Important | A cache record with valid basis metadata but an invalid result payload such as `value: 42` was treated as a hit and later crashed result rendering. | Cache admission now validates value shape per kind, including tree context, source references, overview/question, feature, blueprint, file explanation, and raw file-content records. |
| CP-ADV-090 | Important | The repository had no protected `release` environment, so its name alone did not enforce the report's approval boundary. | Both release jobs now require `github.actor == github.repository_owner`; a non-owner collaborator cannot turn `repository_dispatch` into the sole `contents: write` job. Environment reviewers remain an optional additional control when independent reviewers exist. |
| CP-ADV-091 | Important | The ruleset matcher ignored unsupported exclusion globs and could accept a tag that the live ruleset actually excluded. | Rulesets with any ref exclusion are rejected fail-closed. The live required policy has an empty exclusion set and continues to verify. |
| CP-ADV-092 | Minor | Prompt fingerprinting used a 32-bit hash and omitted helper bodies that decide prompt structure and source-lookup paths. | The fingerprint now uses a 64-bit digest and covers prompt attempts, source-lookup decisions, project detection, structural-context construction, formatting, and prompt builders; analyzer version advanced to v5. |

Thirteenth post-fix evidence on Windows: 212 tests passed; compile, Vite 8.0.16 build, synchronized build-version verification, MCP tool verification, secret and whitespace checks, YAML parsing, and zero-vulnerability `npm audit` passed. Live checks confirmed the authenticated actor equals repository owner `lgk-code` and tag ruleset `18772779` remains valid. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v13`; the installed MV3/version 0.1.3 manifest retained the hardened CSP and no deployment artifact remained.

## Fourteenth Remediation Re-review

Two fresh independent read-only reviewers examined commit `edffba6f52062db07fff48af170aca69f680c4d0`. Both returned `CHANGES REQUIRED`. Commit `5c1aecb090fe05327ae95a5e34199bc8848313ac` closes both Important findings.

| ID | Severity | Re-review finding | Closure in `5c1aecb` |
| --- | --- | --- | --- |
| CP-ADV-093 | Important | Every GitHub 403 was typed as a rate limit, so private-repository permission failures could be hidden behind an unauthenticated public ZIP fallback. | 429 remains an unconditional limit; 403 is typed only with `x-ratelimit-remaining: 0`, `retry-after`, or an explicit rate-limit/abuse body. A permission 403 with remaining quota now propagates and performs zero codeload requests. |
| CP-ADV-094 | Important | Secret-status polling replaced the complete settings object every second, and the settings effect repeatedly overwrote unsaved Base URL/provider/model edits. | Settings drafts now track dirty state. Secret refreshes still update masked credentials, but saved settings synchronize into non-secret inputs only while the local draft is clean; save clears the dirty guard intentionally. |

Fourteenth post-fix evidence on Windows: 213 tests passed; compile, Vite 8.0.16 build, synchronized build-version verification, MCP tool verification, secret and whitespace checks, YAML parsing, live ruleset verification, and zero-vulnerability `npm audit` passed. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v14`; the installed MV3/version 0.1.3 manifest retained the hardened CSP and no deployment artifact remained.

## Fifteenth Remediation Re-review

Two fresh independent read-only reviewers examined commit `5c1aecb090fe05327ae95a5e34199bc8848313ac`. Both returned `CHANGES REQUIRED`. Commit `956958a5ba3684fd7c01d856e78c8702453aad5f` closes all five Important findings and the model-list draft Minor.

| ID | Severity | Re-review finding | Closure in `956958a` |
| --- | --- | --- | --- |
| CP-ADV-095 | Important | Release required a repository dispatch command documented only in the developer guide and offered no standard Actions UI trigger. | Owner-only `workflow_dispatch` now accepts the already-pushed annotated tag while the secured `repository_dispatch` route remains available; both converge on the same trusted workflow and provenance checks. |
| CP-ADV-096 | Important | Automatic model replay had been removed, but dead fallback callbacks, events, UI text, and public documentation still promised successful ordinary-response fallback. | The fallback callback/event/state contract is removed end-to-end. README and UI now distinguish pre-probed ordinary mode from dispatched stream failure and explicitly require a deliberate manual retry. |
| CP-ADV-097 | Important | Ref/path disambiguation and full-source reads wrapped typed GitHub limits in ordinary errors, bypassing the whole-operation ZIP retry. | Both wrappers now rethrow `GithubRateLimitError` unchanged. Direct ref-validation and full-source integration regressions confirm typed propagation and one complete ZIP retry. |
| CP-ADV-098 | Important | `runModel` emitted `stream-done` in `finally`, so a failed stream produced a success terminal before the eventual error response. | Success alone emits `stream-done`; failures emit `stream-error` and rethrow. A partial stream without its provider terminal records `start`, `delta`, `error` and never `done`. |
| CP-ADV-099 | Important | Markdown path linkification required an immutable commit but did not require the path to be one of the result's analyzed sources. | Explicit, same-commit, relative, and plain-text paths become links only after unique exact membership in `sources`; model-invented paths remain inert text. |
| CP-ADV-100 | Minor | A model-list response could overwrite edits made after the request started by applying its captured draft snapshot. | Draft revisions fence asynchronous list responses. Stale responses may refresh options/status but cannot modify the current form draft. |

Fifteenth post-fix evidence on Windows: 218 tests passed; compile, Vite 8.0.16 build, synchronized build-version verification, MCP tool verification, secret and whitespace checks, YAML parsing, live ruleset verification, and zero-vulnerability `npm audit` passed. `npm.cmd run deploy:edge` installed and read back `dev-2026-07-10-adversarial-review-fixes-v15`; the installed MV3/version 0.1.3 manifest retained the hardened CSP and no deployment artifact remained.

## Sixteenth Remediation Re-review

Two fresh independent read-only reviewers examined commit `956958a5ba3684fd7c01d856e78c8702453aad5f`. The cache/model/runtime reviewer returned `APPROVED` with one non-blocking port-interleaving integration-test gap. The release reviewer returned `CHANGES REQUIRED`; commit `fd84bc0597072ff8599ea696705dfa0ed41cf09a` closes its Important finding.

| ID | Severity | Re-review finding | Closure in `fd84bc0` |
| --- | --- | --- | --- |
| CP-ADV-101 | Important | A non-owner collaborator could re-run an owner-triggered Actions run because `github.actor` remains the original actor while `github.triggering_actor` identifies the user who clicked re-run. | Both read and write release jobs now require the initial actor and triggering actor to equal repository owner. Workflow policy asserts both guards appear on both jobs. |

Sixteenth targeted evidence: workflow policy tests, YAML parsing, and whitespace checks passed. The extension build remains `dev-2026-07-10-adversarial-review-fixes-v15` because this closure changes only release authorization and documentation.

## Seventeenth Remediation Re-review

Two fresh independent read-only reviewers examined commit `fd84bc0597072ff8599ea696705dfa0ed41cf09a`. The cache/model/runtime reviewer returned `APPROVED`. The release/deploy/documentation reviewer returned `CHANGES REQUIRED`; commit `5ff740bd2a4c0099fd2885e2ca7c3ed081026504` closes its Important finding.

| ID | Severity | Re-review finding | Closure in `5ff740b` |
| --- | --- | --- | --- |
| CP-ADV-102 | Important | The browser manual-test gate still named the pre-review v2 build while the three runtime constants and deployed extension were v15. | The documented expected build is now v15, and `verify:build-version` compares that manual gate with all three runtime build constants so a future stale expectation fails quality automatically. |

Seventeenth targeted evidence: the strengthened four-way build-version verifier and whitespace checks passed.

## Final Independent Reviews

Two fresh independent read-only reviewers examined the complete code diff from `8c5e9e37130955ac98c4f7da608f7e514c0d2314` through exact commit `5ff740bd2a4c0099fd2885e2ca7c3ed081026504`.

| Reviewer focus | Verdict | Residual non-blocking note |
| --- | --- | --- |
| Cache snapshots and payloads, GitHub API/ZIP fallback, stream at-most-once/terminal/error behavior, source-link provenance, settings concurrency and drafts | `APPROVED` | SSE parsing is line-oriented and does not combine specification-level multi-line `data:` fields used by some uncommon custom endpoints. |
| Release actor/triggering-actor and immutable verifier boundaries, tag/ruleset identity, permissions, secret/CSP/deploy controls, four-way build-version gate | `APPROVED` | The early release overview in `docs/TEST_CASES.md` names the repository-dispatch route only; the complete owner-only dual-entry contract is documented later in the same file and in `docs/DEVELOPMENT.md`. |

Final disposition: no Critical or Important finding remains open. Both required independent reviewers approved the exact final code commit. The two Minor notes above are documented follow-up opportunities and do not weaken the cache-freshness, authorization, at-most-once, or release-provenance invariants established by this review.

## Initial Positive Findings

- GitHub API snapshots pin trees/files to immutable identities and reject truncated trees.
- Authenticated private-repository analysis is excluded from persistent result/source caching.
- Direct Markdown HTML/script injection is blocked by the renderer defaults.
- ZIP content is never written to disk, preventing classic ZIP-slip writes.
- Self reload is development-gated and protected against overlapping checks.
- Git history, LF policy, local Windows quality gates, and the extension deploy marker were clean at the review baseline.
