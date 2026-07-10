# CodePath Adversarial Hardening Design

## Goal

Close the confirmed security, correctness, reliability, and release-supply-chain defects recorded in `docs/reviews/2026-07-09-adversarial-review.md` without a wholesale rewrite of the product.

## Security Boundaries

1. Provider settings form one credential tuple. No environment alias may redirect a credential to another vendor default.
2. Repository-bearing extension requests are authorized against the actual sender tab before stored GitHub credentials are used.
3. Model/API/archive responses are untrusted byte streams with transport-level limits, explicit terminal states, and guaranteed cancellation.
4. Destructive deployment operates only on canonical targets outside the source tree and preserves a last-known-good target until promotion succeeds.
5. Cache identities are collision-resistant and scoped to repository, ref, model endpoint, model, and credential identity without storing plaintext secrets.
6. Release publication is allowed only from `main`, with tag/package agreement and immutable third-party action references.

## Component Boundaries

### Settings Resolution

A focused settings helper resolves explicit provider choice and environment tuples. Browser settings preserve an explicit provider; MCP environment resolution treats `CODEPATH_*` and `OPENAI_*` as separate namespaces and rejects incomplete mixed configurations.

### Runtime Repository Authorization

A pure helper serializes `RepoRef` tuples and validates repo-bearing requests against a parsed sender URL. Content navigation events carry no trusted repository payload; the Sidebar reparses current `location.href`.

### Stream Reader

The AI client retains provider-specific payload parsing but uses bounded raw bytes and pending-line size. SSE parsing returns data, terminal, or ignore outcomes. The reader exits on terminal events and cancels/releases resources on overflow, parse failure, or fallback.

The UI transport sends one request at most once. Port heartbeat messages keep the worker active; timeout/disconnect returns an error rather than replaying the request through another transport. Stream deltas are buffered and flushed periodically.

### Source Resolution

GitHub tree calls receive an endpoint-specific JSON bound. Repository metadata from the API probe is memoized. ZIP fallback uses `HEAD` for an unspecified ref, exact refs for explicit branches, collision-resistant entry framing, and explicit response cancellation on rejected archives.

Ambiguous slash-branch URLs retain candidate boundaries and are resolved with repository data. Lack of validation yields an actionable error instead of a guessed analysis.

### Cache Policy

Cache digests use SHA-256 and include a digest of the API key. Snapshot comparison first checks owner/repo/ref scope. Cache-clear operations increment a scope generation; writes from older generations are discarded. Persistent deletion errors propagate, and records larger than policy are skipped before pruning.

### Deployment And Release

Deployment safety and atomic replacement move into testable filesystem helpers. Canonical/case-aware containment is checked before any destructive operation. Staging and backup siblings are used for promotion and rollback.

Release verification checks `v${package.version}` and commit ancestry. CI/release action references are pinned to full SHAs. Secret scanning moves to a pure matcher with behavioral fixtures.

## Compatibility

- Existing DeepSeek browser defaults remain unchanged.
- Existing `CODEPATH_*` MCP configuration remains supported.
- `OPENAI_API_KEY` alone selects official OpenAI defaults rather than DeepSeek.
- Explicit branch URLs remain exact. Unspecified ZIP fallback uses repository `HEAD`.
- Existing persistent cache schema is invalidated by a schema/analyzer version bump where identity semantics change.
- No new broad host permissions are added. The secret editor is exposed only to the existing GitHub match pattern if a web-accessible resource is required.

## Error Handling

- Security-boundary mismatches fail before network access.
- Stream/resource limits produce concise user-facing errors and cancel readers.
- Cache deletion failure is shown as failure, never as zero successful deletions.
- Deploy failure restores the previous target and retains diagnostic staging only when rollback itself fails.
- Ambiguous source refs fail with a prompt to open a canonical commit URL or reconnect GitHub validation.

## Testing

- Every confirmed failure receives a focused red-green regression test.
- Pure helpers cover settings tuples, repo authorization/identity, SSE states, cache digests/generations, deploy path containment/promotion, release provenance, and secret patterns.
- Integration tests cover one metadata API request before ZIP fallback, terminal non-closing SSE, port at-most-once behavior, and cache clear during a deferred model response.
- The final Windows gates remain `npm.cmd run quality`, `git diff --check`, and `npm.cmd run deploy:edge`.
- Two independent final reviewers receive the full branch diff and this spec; both must approve with no open Critical or Important findings.

## Scope Exclusions

- No wholesale rewrite of `analyzer.ts` or `Sidebar.tsx`.
- No mandatory MCP repository allowlist; the configured local MCP host remains trusted.
- No custom ZIP parser for a compromised GitHub transport.
- No automatic inference of arbitrary local branch ancestry for build-version bumps.
