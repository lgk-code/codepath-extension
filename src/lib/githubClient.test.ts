import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { RepoRef } from "../types";
import { GithubClient } from "./githubClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("GithubClient accepts bounded recursive tree responses above the generic JSON limit", async () => {
  const padding = "x".repeat(3 * 1024 * 1024);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ tree: [{ path: "README.md", type: "blob", sha: "blob-1", padding }], truncated: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

  const files = await new GithubClient({ githubToken: "" }).getTree("acme", "demo", "tree-1");

  assert.deepEqual(files, [{ path: "README.md", type: "blob", sha: "blob-1", size: undefined }]);
});

test("GithubClient memoizes successful repository metadata", async () => {
  let repoRequests = 0;
  globalThis.fetch = (async () => {
    repoRequests += 1;
    return new Response(JSON.stringify({ default_branch: "main" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  const client = new GithubClient({ githubToken: "" });
  await client.getRepo("acme", "demo");
  await client.getRepo("acme", "demo");

  assert.equal(repoRequests, 1);
});

test("GithubClient rejects invalid owner and repository identities before fetching", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return jsonResponse({ default_branch: "main" });
  }) as typeof fetch;

  const client = new GithubClient({ githubToken: "secret" });
  await assert.rejects(() => client.getRepo("..", "demo"), /invalid GitHub repository/i);
  await assert.rejects(() => client.getRepo("visible", "../secret-owner/secret-repo"), /invalid GitHub repository/i);
  assert.equal(fetchCalls, 0);
});

test("GithubClient rejects relative traversal in content paths before fetching", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  await assert.rejects(
    () => new GithubClient({ githubToken: "secret" }).getFile("visible", "repo", "../../../secret-owner/secret-repo/contents/secret.txt", "main"),
    /unsafe GitHub path/i
  );
  assert.equal(fetchCalls, 0);
});

test("GithubClient rejects non-unique slash-branch candidates", async () => {
  globalThis.fetch = candidateFetch({
    "release": { headSha: "head-release", treeSha: "tree-release", path: "v2/src/app.ts" },
    "release/v2": { headSha: "head-v2", treeSha: "tree-v2", path: "src/app.ts" }
  });
  const candidateRepo = {
    owner: "acme",
    repo: "demo",
    branch: "release/v2",
    path: "src/app.ts",
    pageType: "file",
    refCandidates: [
      { refName: "release", path: "v2/src/app.ts" },
      { refName: "release/v2", path: "src/app.ts" }
    ]
  } as RepoRef & { refCandidates: Array<{ refName: string; path: string }> };
  const client = new GithubClient({ githubToken: "" }) as GithubClient & { resolveRepoRef(repo: RepoRef): Promise<RepoRef> };

  await assert.rejects(() => client.resolveRepoRef(candidateRepo), /ambiguous GitHub ref\/path/i);
});

test("GithubClient bounds aggregate requests for adversarial ref candidate lists", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    fetchCalls += 1;
    const url = String(request);
    if (url.includes("/git/ref/heads/")) return jsonResponse({ object: { type: "commit", sha: `head-${fetchCalls}` } });
    if (url.includes("/git/commits/")) return jsonResponse({ tree: { sha: `tree-${fetchCalls}` } });
    if (url.includes("/git/trees/")) return jsonResponse({ tree: [], truncated: false });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const candidateRepo = {
    owner: "acme",
    repo: "demo",
    branch: "r0",
    path: "app.ts",
    pageType: "file",
    refCandidates: Array.from({ length: 20 }, (_item, index) => ({ refName: `r${index}`, path: `p${index}/app.ts` }))
  } as RepoRef & { refCandidates: Array<{ refName: string; path: string }> };
  const client = new GithubClient({ githubToken: "" }) as GithubClient & { resolveRepoRef(repo: RepoRef): Promise<RepoRef> };

  await assert.rejects(() => client.resolveRepoRef(candidateRepo), /too many candidate boundaries|no candidate matched/i);
  assert.equal(fetchCalls <= 8, true);
});

function candidateFetch(candidates: Record<string, { headSha: string; treeSha: string; path: string }>): typeof fetch {
  return (async (request: RequestInfo | URL) => {
    const url = String(request);
    for (const [branch, candidate] of Object.entries(candidates)) {
      const parsed = new URL(url);
      if (parsed.pathname.includes(`/contents/${candidate.path}`) && parsed.searchParams.get("ref") === branch) {
        return jsonResponse({ type: "file" });
      }
      const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
      if (url.endsWith(`/git/ref/heads/${encodedBranch}`)) {
        return jsonResponse({ object: { type: "commit", sha: candidate.headSha } });
      }
      if (url.endsWith(`/git/commits/${candidate.headSha}`)) {
        return jsonResponse({ tree: { sha: candidate.treeSha } });
      }
      if (url.endsWith(`/git/trees/${candidate.treeSha}?recursive=1`)) {
        return jsonResponse({ tree: [{ path: candidate.path, type: "blob", sha: `blob-${branch}` }], truncated: false });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
