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

test("GithubClient encodes owner and repository as individual API path segments", async () => {
  let requestedUrl = "";
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    requestedUrl = String(request);
    return jsonResponse({ default_branch: "main" });
  }) as typeof fetch;

  await new GithubClient({ githubToken: "" }).getRepo("visible", "../secret-owner/secret-repo");

  assert.equal(requestedUrl, "https://api.github.com/repos/visible/..%2Fsecret-owner%2Fsecret-repo");
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

function candidateFetch(candidates: Record<string, { headSha: string; treeSha: string; path: string }>): typeof fetch {
  return (async (request: RequestInfo | URL) => {
    const url = String(request);
    for (const [branch, candidate] of Object.entries(candidates)) {
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
