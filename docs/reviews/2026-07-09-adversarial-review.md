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

## Initial Positive Findings

- GitHub API snapshots pin trees/files to immutable identities and reject truncated trees.
- Authenticated private-repository analysis is excluded from persistent result/source caching.
- Direct Markdown HTML/script injection is blocked by the renderer defaults.
- ZIP content is never written to disk, preventing classic ZIP-slip writes.
- Self reload is development-gated and protected against overlapping checks.
- Git history, LF policy, local Windows quality gates, and the extension deploy marker were clean at the review baseline.
