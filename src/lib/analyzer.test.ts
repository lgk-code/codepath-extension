import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  ANALYZER_VERSION,
  PROMPT_VERSION,
  analyzeProject,
  answerQuestion,
  clearAnalysisCaches,
  deletePersistentCacheRepo,
  explainFile,
  generateSuggestedQuestions,
  getAnalysisCacheStats
} from "./analyzer";
import type { AnalysisBasis, RepoRef, Settings, TreeFile } from "../types";
import { sha256Digest } from "./digest";

const originalFetch = globalThis.fetch;

const repo: RepoRef = {
  owner: "acme",
  repo: "demo",
  branch: "main",
  pageType: "repo"
};

const settings: Settings = {
  provider: "openai",
  apiKey: "sk-test",
  baseUrl: "https://models.example/v1",
  model: "guide-model"
};

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  await clearAnalysisCaches("all");
});

test("analyzeProject prompts direct analysis without AI or CodePath self-introduction", async () => {
  let body: ChatRequestBody | undefined;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 24 }],
    files: { "README.md": "# Demo\n\nSmall project guide." },
    onModelRequest: (requestBody) => {
      body = requestBody;
    }
  });

  await analyzeProject(repo, settings);

  const messages = JSON.stringify(body?.messages ?? []);
  assert.doesNotMatch(messages, /You are CodePath/);
  assert.match(messages, /不要介绍自己/);
  assert.match(messages, /不要说明.*AI/);
});

test("analyzeProject defaults to focused important snippets", async () => {
  let body: ChatRequestBody | undefined;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [
      { path: "README.md", type: "blob", size: 16 },
      { path: "package.json", type: "blob", size: 18 },
      { path: "src/deep/hidden.ts", type: "blob", size: 31 }
    ],
    files: {
      "README.md": "# Demo",
      "package.json": "{\"scripts\":{\"dev\":\"vite\"}}",
      "src/deep/hidden.ts": "export const hidden = 'not focused';"
    },
    onModelRequest: (requestBody) => {
      body = requestBody;
    }
  });

  await analyzeProject(repo, settings);

  const messages = JSON.stringify(body?.messages ?? []);
  assert.match(messages, /README\.md/);
  assert.match(messages, /package\.json/);
  assert.doesNotMatch(messages, /not focused/);
});

test("analyzeProject includes the resolved default branch in results", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16 }],
    files: { "README.md": "# Demo" }
  });

  const result = await analyzeProject({ owner: "acme", repo: "demo", pageType: "repo" }, settings);

  assert.equal(result.branch, "main");
});

test("analyzeProject revalidates the branch snapshot before returning cached overview", async () => {
  let modelCalls = 0;
  let revision = 1;
  globalThis.fetch = mockAnalyzeProjectFetch({
    get tree() {
      return [{ path: "README.md", type: "blob" as const, size: 16, sha: `blob-${revision}` }];
    },
    get files() {
      return { "README.md": `# Demo ${revision}` };
    },
    get headSha() {
      return `head-${revision}`;
    },
    get treeSha() {
      return `tree-${revision}`;
    },
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => `源码确认\n- 第 ${revision} 次分析。`
  });

  const first = await analyzeProject(repo, settings);
  revision = 2;
  const second = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 2);
  assert.match(first.summary, /第 1 次分析/);
  assert.match(second.summary, /第 2 次分析/);
  assert.equal(second.timing?.resultCacheHit, undefined);
  assert.equal(second.timing?.cacheStatus, "fresh");
  assert.equal(second.basis?.snapshot.headSha, "head-2");
});

test("analyzeProject reuses cached overview when head changes but tree stays the same", async () => {
  let modelCalls = 0;
  let headSha = "head-one";
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-same" }],
    files: { "README.md": "# Demo" },
    get headSha() {
      return headSha;
    },
    treeSha: "tree-same",
    onModelRequest: () => {
      modelCalls += 1;
    }
  });

  await analyzeProject(repo, settings);
  headSha = "head-two";
  const second = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 1);
  assert.equal(second.timing?.resultCacheHit, true);
  assert.equal(second.timing?.cacheStatus, "same-tree-new-head");
  assert.equal(second.timing?.headSha, "head-one");
  assert.equal(second.timing?.lastValidatedAt !== undefined, true);
});

test("analyzeProject does not reuse model results across colliding legacy FNV model ids", async () => {
  const firstModel = "m-w3i1gfipcz";
  const secondModel = "m-exsvehk3q5";
  assert.equal(legacyModelFingerprint(firstModel), legacyModelFingerprint(secondModel), "fixture must collide under the legacy fingerprint");
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Demo" },
    onModelRequest: () => {
      modelCalls += 1;
    }
  });

  await analyzeProject(repo, { ...settings, model: firstModel });
  await analyzeProject(repo, { ...settings, model: secondModel });

  assert.equal(modelCalls, 2);
});

test("analyzeProject isolates model result caches by API credential fingerprint", async () => {
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Demo" },
    onModelRequest: () => {
      modelCalls += 1;
    }
  });

  await analyzeProject(repo, { ...settings, apiKey: "tenant-one-key" });
  await analyzeProject(repo, { ...settings, apiKey: "tenant-two-key" });

  assert.equal(modelCalls, 2);
});

test("analyzeProject ignores legacy raw persistent overview cache entries", async () => {
  const oldKey = "codepath-cache:acme/demo@main:overview";
  installChromeStorageMock({
    [oldKey]: {
      summary: "stale legacy overview",
      sources: [],
      branch: "main"
    }
  });
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => "源码确认\n- 当前分析结果。"
  });

  const result = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 1);
  assert.match(result.summary, /当前分析结果/);
  assert.equal(result.timing?.persistentCacheHit, undefined);
});

test("analyzeProject does not return an old cached overview when GitHub snapshot validation fails", async () => {
  let modelCalls = 0;
  let failSnapshot = false;
  const baseFetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    }
  });
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (failSnapshot && url === "https://api.github.com/repos/acme/demo/branches/main") {
      return new Response("branch unavailable", { status: 503 });
    }
    return baseFetch(request, init);
  }) as typeof fetch;

  await analyzeProject(repo, settings);
  failSnapshot = true;

  await assert.rejects(() => analyzeProject(repo, settings), /缓存无法校验/);
  assert.equal(modelCalls, 1);
});

test("analyzeProject resolves slash branch names through Git refs", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    branchName: "feature/cache-fix",
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-feature",
    treeSha: "tree-feature"
  });

  const result = await analyzeProject({ ...repo, branch: "feature/cache-fix" }, settings);

  assert.equal(result.branch, "feature/cache-fix");
  assert.equal(result.basis?.snapshot.headSha, "head-feature");
  assert.equal(result.basis?.snapshot.treeSha, "tree-feature");
});

test("analyzeProject resolves slash branches through heads ref before commits endpoint", async () => {
  const baseFetch = mockAnalyzeProjectFetch({
    branchName: "feature/cache-fix",
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-feature",
    treeSha: "tree-feature"
  });
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url === "https://api.github.com/repos/acme/demo/commits/feature%2Fcache-fix") {
      return jsonResponse({
        sha: "shadow-commit",
        commit: {
          tree: {
            sha: "shadow-tree"
          }
        }
      });
    }
    return baseFetch(request, init);
  }) as typeof fetch;

  const result = await analyzeProject({ ...repo, branch: "feature/cache-fix" }, settings);

  assert.equal(result.basis?.snapshot.headSha, "head-feature");
  assert.equal(result.basis?.snapshot.treeSha, "tree-feature");
});

test("explainFile validates slash ref candidates before selecting the file", async () => {
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url === "https://api.github.com/repos/acme/demo") return jsonResponse({ default_branch: "main" });
    if (url === "https://api.github.com/repos/acme/demo/git/ref/heads/release/v2") {
      return jsonResponse({ object: { type: "commit", sha: "head-v2" } });
    }
    if (url === "https://api.github.com/repos/acme/demo/git/commits/head-v2") {
      return jsonResponse({ tree: { sha: "tree-v2" } });
    }
    if (url === "https://api.github.com/repos/acme/demo/git/trees/tree-v2?recursive=1") {
      return jsonResponse({ tree: [{ path: "src/app.ts", type: "blob", sha: "blob-app", size: 24 }], truncated: false });
    }
    if (url === "https://api.github.com/repos/acme/demo/contents/src/app.ts?ref=release%2Fv2") {
      return jsonResponse({ type: "file" });
    }
    if (url === "https://api.github.com/repos/acme/demo/contents/src/app.ts?ref=head-v2") {
      return jsonResponse({ type: "file", encoding: "base64", content: Buffer.from("export const app = true;").toString("base64") });
    }
    if (url === "https://models.example/v1/chat/completions") {
      return jsonResponse({ choices: [{ message: { content: "源码确认\n- 已解析目标文件。" } }] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await explainFile(
    {
      owner: "acme",
      repo: "demo",
      branch: "release/v2",
      path: "src/app.ts",
      pageType: "file",
      refCandidates: [
        { refName: "release", path: "v2/src/app.ts" },
        { refName: "release/v2", path: "src/app.ts" }
      ]
    },
    settings
  );

  assert.equal(result.branch, "release/v2");
  assert.equal(result.path, "src/app.ts");
  assert.equal(result.basis?.snapshot.headSha, "head-v2");
});

test("analyzeProject resolves commit permalink refs through commits endpoint", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    branchName: "1234567890abcdef1234567890abcdef12345678",
    branchStatus: 404,
    headRefStatus: 404,
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-commit" }],
    files: { "README.md": "# Commit" },
    headSha: "1234567890abcdef1234567890abcdef12345678",
    treeSha: "tree-commit"
  });

  const result = await analyzeProject({ ...repo, branch: "1234567890abcdef1234567890abcdef12345678" }, settings);

  assert.equal(result.basis?.snapshot.headSha, "1234567890abcdef1234567890abcdef12345678");
  assert.equal(result.basis?.snapshot.treeSha, "tree-commit");
});

test("analyzeProject resolves tag refs through git refs", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    branchName: "v1.0.0",
    branchStatus: 404,
    headRefStatus: 404,
    tagRef: { type: "commit", sha: "tag-commit" },
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-tag" }],
    files: { "README.md": "# Tag" },
    headSha: "tag-commit",
    treeSha: "tree-tag"
  });

  const result = await analyzeProject({ ...repo, branch: "v1.0.0" }, settings);

  assert.equal(result.basis?.snapshot.headSha, "tag-commit");
  assert.equal(result.basis?.snapshot.treeSha, "tree-tag");
});

test("analyzeProject dereferences annotated tags before resolving tree snapshots", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    branchName: "v1.0.0",
    branchStatus: 404,
    headRefStatus: 404,
    tagRef: { type: "tag", sha: "tag-object", tagObjectSha: "annotated-commit" },
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-tag" }],
    files: { "README.md": "# Tag" },
    headSha: "annotated-commit",
    treeSha: "tree-tag"
  });

  const result = await analyzeProject({ ...repo, branch: "v1.0.0" }, settings);

  assert.equal(result.basis?.snapshot.headSha, "annotated-commit");
  assert.equal(result.basis?.snapshot.treeSha, "tree-tag");
});

test("analyzeProject rejects truncated Git trees instead of caching partial context", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    treeTruncated: true,
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current"
  });

  await assert.rejects(() => analyzeProject(repo, settings), /truncated repository tree/);
});

test("explainFile does not reuse a file explanation when the file blob changes", async () => {
  let modelCalls = 0;
  let revision = 1;
  globalThis.fetch = mockAnalyzeProjectFetch({
    get tree() {
      return [{ path: "src/app.ts", type: "blob" as const, size: 32, sha: `blob-${revision}` }];
    },
    get files() {
      return { "src/app.ts": `export const revision = ${revision};` };
    },
    get headSha() {
      return `head-${revision}`;
    },
    get treeSha() {
      return `tree-${revision}`;
    },
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => `源码确认\n- 文件第 ${revision} 次分析。`
  });

  const fileRepo: RepoRef = { ...repo, pageType: "file", path: "src/app.ts" };
  const first = await explainFile(fileRepo, settings);
  revision = 2;
  const second = await explainFile(fileRepo, settings);

  assert.equal(modelCalls, 2);
  assert.match(first.summary, /第 1 次分析/);
  assert.match(second.summary, /第 2 次分析/);
  assert.equal(second.timing?.resultCacheHit, undefined);
  assert.equal(second.basis?.files[0]?.blobSha, "blob-2");
});

test("explainFile uses git tree blob identity for files filtered out of project snippets", async () => {
  let revision = 1;
  const modelPrompts: string[] = [];
  globalThis.fetch = mockAnalyzeProjectFetch({
    get tree() {
      return [{ path: "assets/logo.svg", type: "blob" as const, size: 32, sha: `svg-blob-${revision}` }];
    },
    get files() {
      return { "assets/logo.svg": `<svg>revision-${revision}</svg>` };
    },
    get headSha() {
      return `head-${revision}`;
    },
    get treeSha() {
      return `tree-${revision}`;
    },
    onModelRequest: (body) => {
      modelPrompts.push(JSON.stringify(body.messages ?? []));
    }
  });

  const fileRepo: RepoRef = { ...repo, pageType: "file", path: "assets/logo.svg" };
  await explainFile(fileRepo, settings);
  revision = 2;
  const second = await explainFile(fileRepo, settings);

  assert.equal(second.basis?.files[0]?.blobSha, "svg-blob-2");
  assert.match(modelPrompts.at(-1) ?? "", /revision-2/);
  assert.doesNotMatch(modelPrompts.at(-1) ?? "", /revision-1/);
});

test("analyzeProject ignores v2 persistent overview records whose basis does not match the current request", async () => {
  const tree = [{ path: "README.md", type: "blob" as const, size: 16, sha: "blob-current" }];
  const key = await persistentOverviewTestKey(repo, "main", "tree-current", "focused", tree, settings);
  installChromeStorageMock({
    [key]: {
      schemaVersion: 2,
      kind: "overview",
      value: {
        summary: "stale injected overview",
        sources: [{ path: "README.md", blobSha: "blob-stale" }],
        branch: "main"
      },
      basis: {
        snapshot: snapshotForTest("stale-head", "stale-tree"),
        files: [{ path: "README.md", blobSha: "blob-stale", size: 16 }],
        inputDigest: "wrong-digest",
        promptVersion: PROMPT_VERSION,
        analyzerVersion: ANALYZER_VERSION
      }
    }
  });
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree,
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => "源码确认\n- 当前分析结果。"
  });

  const result = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 1);
  assert.match(result.summary, /当前分析结果/);
});

test("analyzeProject treats corrupt v2 CacheRecord snapshots as cache misses", async () => {
  const tree = [{ path: "README.md", type: "blob" as const, size: 16, sha: "blob-current" }];
  const key = await persistentOverviewTestKey(repo, "main", "tree-current", "focused", tree, settings);
  installChromeStorageMock({
    [key]: {
      schemaVersion: 2,
      kind: "overview",
      value: {
        summary: "corrupt cached overview",
        sources: [{ path: "README.md", blobSha: "blob-current" }],
        branch: "main"
      },
      basis: {
        snapshot: { ...snapshotForTest("head-current", "tree-current"), headSha: 123 },
        files: [{ path: "README.md", blobSha: "blob-current", size: 16 }],
        inputDigest: await persistentOverviewInputDigestForTest("tree-current", "focused", tree, settings),
        promptVersion: PROMPT_VERSION,
        analyzerVersion: ANALYZER_VERSION
      }
    }
  });
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree,
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => "源码确认\n- 当前分析结果。"
  });

  const result = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 1);
  assert.match(result.summary, /当前分析结果/);
});

test("analyzeProject does not reuse v2 CacheRecords from another repository scope", async () => {
  const tree = [{ path: "README.md", type: "blob" as const, size: 16, sha: "blob-current" }];
  const key = await persistentOverviewTestKey(repo, "main", "tree-current", "focused", tree, settings);
  installChromeStorageMock({
    [key]: {
      schemaVersion: 2,
      kind: "overview",
      value: {
        summary: "wrong repo cached overview",
        sources: [{ path: "README.md", blobSha: "blob-current" }],
        branch: "main"
      },
      basis: {
        snapshot: { ...snapshotForTest("head-current", "tree-current"), owner: "other" },
        files: [{ path: "README.md", blobSha: "blob-current", size: 16 }],
        inputDigest: await persistentOverviewInputDigestForTest("tree-current", "focused", tree, settings),
        promptVersion: PROMPT_VERSION,
        analyzerVersion: ANALYZER_VERSION
      }
    }
  });
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree,
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => "源码确认\n- 当前分析结果。"
  });

  const result = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 1);
  assert.match(result.summary, /当前分析结果/);
});

test("analyzeProject does not cache overview results when selected snippets fail to load", async () => {
  let modelCalls = 0;
  let packageAvailable = false;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [
      { path: "README.md", type: "blob", size: 16, sha: "readme-blob" },
      { path: "package.json", type: "blob", size: 18, sha: "package-blob" }
    ],
    get files() {
      const files: Record<string, string> = { "README.md": "# Demo" };
      if (packageAvailable) files["package.json"] = "{\"scripts\":{\"dev\":\"vite\"}}";
      return files;
    },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => (packageAvailable ? "源码确认\n- 完整分析结果。" : "源码确认\n- 不完整分析结果。")
  });

  const first = await analyzeProject(repo, settings);
  packageAvailable = true;
  const second = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 2);
  assert.equal(first.timing?.sourceIncomplete, true);
  assert.deepEqual(first.timing?.skippedSourcePaths, ["package.json"]);
  assert.match(second.summary, /完整分析结果/);
  assert.equal(second.timing?.resultCacheHit, undefined);
});

test("persistent v2 cache prunes old per-repository entries", async () => {
  const initial = Object.fromEntries(
    Array.from({ length: 90 }, (_item, index) => [
      `codepath-cache-v2:acme/demo@main:overview:old-tree-${index}:focused:old-digest-${index}`,
      cacheRecordForTest("overview", `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`)
    ])
  );
  const store = installChromeStorageMock(initial);
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current"
  });

  await analyzeProject(repo, settings);

  const v2RepoKeys = Object.keys(store).filter(
    (key) => key.startsWith("codepath-cache-v2:acme/demo@main:") || key.startsWith("codepath-cache-v2:e:acme/demo@main:")
  );
  assert.equal(v2RepoKeys.length <= 80, true);
  assert.equal(Object.prototype.hasOwnProperty.call(store, "codepath-cache-v2:acme/demo@main:overview:old-tree-0:focused:old-digest-0"), false);
});

test("persistent v2 cache prunes and retries when storage write initially hits quota", async () => {
  const initial = Object.fromEntries(
    Array.from({ length: 90 }, (_item, index) => [
      `codepath-cache-v2:acme/demo@main:overview:quota-old-tree-${index}:focused:quota-old-digest-${index}`,
      cacheRecordForTest("overview", `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`)
    ])
  );
  const store = installChromeStorageMock(initial, { failSetCount: 1 });
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current"
  });

  await analyzeProject(repo, settings);

  const keys = Object.keys(store);
  assert.equal(keys.some((key) => key.startsWith("codepath-cache-v2:e:acme/demo@main:overview:tree-current:focused:")), true);
  assert.equal(
    keys.filter((key) => key.startsWith("codepath-cache-v2:acme/demo@main:") || key.startsWith("codepath-cache-v2:e:acme/demo@main:")).length <= 80,
    true
  );
});

test("persistent v2 cache accounts for the pending record size before writing", async () => {
  const initial = Object.fromEntries(
    Array.from({ length: 4 }, (_item, index) => [
      `codepath-cache-v2:acme/demo@main:overview:large-old-tree-${index}:focused:large-old-digest-${index}`,
      cacheRecordForTest("overview", `2026-02-0${index + 1}T00:00:00.000Z`, "x".repeat(500_000))
    ])
  );
  const store = installChromeStorageMock(initial, { maxSerializedBytes: 1_800_000 });
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    modelContent: () => `源码确认\n- ${"y".repeat(900_000)}`
  });

  await analyzeProject(repo, settings);

  const keys = Object.keys(store);
  assert.equal(keys.some((key) => key.startsWith("codepath-cache-v2:e:acme/demo@main:overview:tree-current:focused:")), true);
  assert.equal(keys.some((key) => key.includes("large-old-tree-0")), false);
});

test("oversized pending cache records do not evict valid existing records", async () => {
  const existingKey = "codepath-cache-v2:acme/demo@main:overview:existing-tree:focused:existing-digest";
  const store = installChromeStorageMock({ [existingKey]: cacheRecordForTest("overview", "2026-07-01T00:00:00.000Z") });
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    modelContent: () => `源码确认\n- ${"z".repeat(1_600_000)}`
  });

  await analyzeProject(repo, settings);

  assert.equal(Object.prototype.hasOwnProperty.call(store, existingKey), true);
  assert.equal(Object.keys(store).some((key) => key.startsWith("codepath-cache-v2:e:acme/demo@main:overview:tree-current:")), false);
});

test("persistent cache limits count UTF-8 bytes instead of UTF-16 code units", async () => {
  const existingKey = "codepath-cache-v2:acme/demo@main:overview:existing-tree:focused:existing-digest";
  const store = installChromeStorageMock({ [existingKey]: cacheRecordForTest("overview", "2026-07-01T00:00:00.000Z") });
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    modelContent: () => `源码确认\n- ${"中".repeat(520_000)}`
  });

  await analyzeProject(repo, settings);

  assert.equal(Object.prototype.hasOwnProperty.call(store, existingKey), true);
  assert.equal(Object.keys(store).some((key) => key.startsWith("codepath-cache-v2:e:acme/demo@main:overview:tree-current:")), false);
});

test("repository cache identity and repository clearing are case-insensitive", async () => {
  const store = installChromeStorageMock({});
  let modelCalls = 0;
  const sourceFetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => `源码确认\n- 第 ${modelCalls} 次。`
  });
  globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
    const normalized = String(request).replace("/repos/Acme/Demo", "/repos/acme/demo");
    return sourceFetch(normalized, init);
  }) as typeof fetch;
  const mixedCaseRepo: RepoRef = { owner: "Acme", repo: "Demo", branch: "main", pageType: "repo" };

  await analyzeProject(mixedCaseRepo, settings);
  const reused = await analyzeProject(repo, settings);

  assert.equal(modelCalls, 1);
  assert.equal(reused.timing?.resultCacheHit, true);
  assert.equal(Object.keys(store).some((key) => key.startsWith("codepath-cache-v2:e:acme/demo@")), true);

  await clearAnalysisCaches("repo", repo);
  await analyzeProject(mixedCaseRepo, settings);

  assert.equal(modelCalls, 2);
});

test("repository cache parsing preserves an at-sign inside a legal branch name", async () => {
  const store = installChromeStorageMock({});
  let modelCalls = 0;
  const atBranchRepo: RepoRef = { ...repo, branch: "feature@x" };
  globalThis.fetch = mockAnalyzeProjectFetch({
    branchName: "feature@x",
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    }
  });

  await analyzeProject(atBranchRepo, settings);
  const cleared = await clearAnalysisCaches("repo", atBranchRepo);
  await analyzeProject(atBranchRepo, settings);

  assert.equal(cleared.persistentKeysCleared > 0, true);
  assert.equal(modelCalls, 2);
  assert.equal(Object.keys(store).some((key) => key.includes("@feature%40x:")), true);
});

test("encoded cache keys cannot collide with legacy percent-containing refs", async () => {
  const legacyKey = "codepath-cache-v2:acme/demo@release%2Fx:overview:legacy-tree:focused:legacy-digest";
  const encodedKey = "codepath-cache-v2:e:acme/demo@release%2Fx:overview:encoded-tree:focused:encoded-digest";
  const store = installChromeStorageMock({
    [legacyKey]: cacheRecordForTest("overview", "2026-07-01T00:00:00.000Z"),
    [encodedKey]: cacheRecordForTest("overview", "2026-07-02T00:00:00.000Z")
  });

  const stats = await getAnalysisCacheStats();

  assert.deepEqual(
    stats.repositories.map((item) => item.repoKey).sort(),
    ["acme/demo@release%2Fx", "acme/demo@release/x"]
  );
  await deletePersistentCacheRepo("acme/demo@release/x");
  assert.equal(Object.prototype.hasOwnProperty.call(store, encodedKey), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store, legacyKey), true);
});

test("clearing a repository prevents an in-flight analysis from repopulating caches", async () => {
  let modelCalls = 0;
  let releaseFirstModel: (() => void) | undefined;
  let markFirstModelStarted: (() => void) | undefined;
  const firstModelStarted = new Promise<void>((resolve) => {
    markFirstModelStarted = resolve;
  });
  const firstModelGate = new Promise<void>((resolve) => {
    releaseFirstModel = resolve;
  });
  const sourceFetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current"
  });
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    if (String(request) === "https://models.example/v1/chat/completions") {
      modelCalls += 1;
      if (modelCalls === 1) {
        markFirstModelStarted?.();
        await firstModelGate;
      }
      return jsonResponse({ choices: [{ message: { content: `源码确认\n- 第 ${modelCalls} 次。` } }] });
    }
    return sourceFetch(request, init);
  }) as typeof fetch;

  const pending = analyzeProject(repo, settings);
  await firstModelStarted;
  await clearAnalysisCaches("repo", repo);
  releaseFirstModel?.();
  await pending;
  await analyzeProject(repo, settings);

  assert.equal(modelCalls, 2);
});

test("analysis started during persistent repository deletion cannot reuse records being cleared", async () => {
  let releaseRemove: (() => void) | undefined;
  let markRemoveStarted: (() => void) | undefined;
  const removeStarted = new Promise<void>((resolve) => {
    markRemoveStarted = resolve;
  });
  const removeGate = new Promise<void>((resolve) => {
    releaseRemove = resolve;
  });
  installChromeStorageMock(
    {},
    {
      beforeRemove: async () => {
        markRemoveStarted?.();
        await removeGate;
      }
    }
  );
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current",
    onModelRequest: () => {
      modelCalls += 1;
    },
    modelContent: () => `源码确认\n- 第 ${modelCalls} 次。`
  });

  await analyzeProject(repo, settings);
  const clearing = clearAnalysisCaches("repo", repo);
  await removeStarted;
  let analysisResolved = false;
  const analysis = analyzeProject(repo, settings).then((result) => {
    analysisResolved = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  const resolvedBeforeDeletionCompleted = analysisResolved;
  releaseRemove?.();
  await clearing;
  const result = await analysis;

  assert.equal(resolvedBeforeDeletionCompleted, false);
  assert.equal(modelCalls, 2);
  assert.match(result.summary, /第 2 次/);
});

test("cache clearing propagates persistent storage removal failures", async () => {
  installChromeStorageMock(
    { "codepath-cache-v2:acme/demo@main:overview:tree:focused:digest": cacheRecordForTest("overview", "2026-07-01T00:00:00.000Z") },
    { failRemoveCount: 1 }
  );

  await assert.rejects(() => clearAnalysisCaches("all"), /storage remove failed/i);
});

test("analyzeProject marks zip fallback snapshots as unchecked and does not reuse result cache", async () => {
  let modelCalls = 0;
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url === "https://api.github.com/repos/acme/demo") {
      return new Response("rate limited", { status: 403 });
    }
    if (url === "https://codeload.github.com/acme/demo/zip/HEAD") {
      return zipResponse({ "demo-main/README.md": "# Demo" });
    }
    if (url === "https://models.example/v1/chat/completions") {
      modelCalls += 1;
      return jsonResponse({
        choices: [
          {
            message: {
              content: `源码确认\n- zip 第 ${modelCalls} 次分析。`
            }
          }
        ]
      });
    }
    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;

  const first = await analyzeProject({ owner: "acme", repo: "demo", pageType: "repo" }, settings);
  const second = await analyzeProject({ owner: "acme", repo: "demo", pageType: "repo" }, settings);

  assert.equal(modelCalls, 2);
  assert.equal(first.timing?.cacheStatus, "unchecked");
  assert.equal(second.timing?.cacheStatus, "unchecked");
  assert.equal(second.timing?.resultCacheHit, undefined);
  assert.match(first.timing?.headSha ?? "", /^unchecked:/);
});

test("analyzeProject reuses the successful API repository probe", async () => {
  let repoRequests = 0;
  const baseFetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-main" }],
    files: { "README.md": "# Demo" }
  });
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    if (String(request) === "https://api.github.com/repos/acme/demo") repoRequests += 1;
    return baseFetch(request, init);
  }) as typeof fetch;

  await analyzeProject(repo, settings);

  assert.equal(repoRequests, 1);
});

test("answerQuestion refuses context-only answers when the previous analysis basis is stale", async () => {
  let revision = 1;
  globalThis.fetch = mockAnalyzeProjectFetch({
    get tree() {
      return [{ path: "README.md", type: "blob" as const, size: 16, sha: `blob-${revision}` }];
    },
    get files() {
      return { "README.md": `# Demo ${revision}` };
    },
    get headSha() {
      return `head-${revision}`;
    },
    get treeSha() {
      return `tree-${revision}`;
    }
  });
  const staleBasis: AnalysisBasis = {
    snapshot: snapshotForTest("head-1", "tree-1"),
    files: [{ path: "README.md", blobSha: "blob-1", size: 16 }],
    inputDigest: "old-context",
    promptVersion: PROMPT_VERSION,
    analyzerVersion: ANALYZER_VERSION
  };
  revision = 2;

  await assert.rejects(
    () => answerQuestion(repo, settings, "这个项目主要做什么？", "旧分析上下文。".repeat(80), {}, staleBasis),
    /旧分析上下文已过期/
  );
});

test("answerQuestion refuses context-only answers from older prompt versions", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob" as const, size: 16, sha: "blob-current" }],
    files: { "README.md": "# Demo" },
    headSha: "head-current",
    treeSha: "tree-current"
  });
  const oldBasis: AnalysisBasis = {
    snapshot: snapshotForTest("head-current", "tree-current"),
    files: [{ path: "README.md", blobSha: "blob-current", size: 16 }],
    inputDigest: "old-context",
    promptVersion: "old-prompt",
    analyzerVersion: ANALYZER_VERSION
  };

  await assert.rejects(
    () => answerQuestion(repo, settings, "这个项目主要做什么？", "旧分析上下文。".repeat(80), {}, oldBasis),
    /上下文版本已过期/
  );
});

test("answerQuestion rejects a basis from another repository even when SHAs match", async () => {
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "README.md", type: "blob", size: 16, sha: "blob-current" }],
    files: { "README.md": "# Current" },
    headSha: "head-current",
    treeSha: "tree-current"
  });
  const otherRepoBasis: AnalysisBasis = {
    snapshot: { ...snapshotForTest("head-current", "tree-current"), owner: "other" },
    files: [{ path: "README.md", blobSha: "blob-current", size: 16 }],
    inputDigest: "other-context",
    promptVersion: PROMPT_VERSION,
    analyzerVersion: ANALYZER_VERSION
  };

  await assert.rejects(
    () => answerQuestion(repo, settings, "这个项目主要做什么？", "旧分析上下文。".repeat(80), {}, otherRepoBasis),
    /旧分析上下文已过期/
  );
});

test("analyzeProject full-source mode sends every useful source file without truncation", async () => {
  let body: ChatRequestBody | undefined;
  const longSource = `export const marker = "${"x".repeat(7600)}";`;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [
      { path: "README.md", type: "blob", size: 16 },
      { path: "package.json", type: "blob", size: 18 },
      { path: "src/deep/hidden.ts", type: "blob", size: longSource.length }
    ],
    files: {
      "README.md": "# Demo",
      "package.json": "{\"scripts\":{\"dev\":\"vite\"}}",
      "src/deep/hidden.ts": longSource
    },
    onModelRequest: (requestBody) => {
      body = requestBody;
    }
  });

  await analyzeProject(repo, settings, { mode: "full-source" });

  const messages = JSON.stringify(body?.messages ?? []);
  assert.match(messages, /src\/deep\/hidden\.ts/);
  assert.match(messages, /export const marker/);
  assert.doesNotMatch(messages, /content truncated/);
});

test("analyzeProject full-source mode rejects oversized repositories before model calls", async () => {
  let modelCalls = 0;
  globalThis.fetch = mockAnalyzeProjectFetch({
    tree: [{ path: "src/large.ts", type: "blob", size: 120_001 }],
    files: { "src/large.ts": "export const large = true;" },
    onModelRequest: () => {
      modelCalls += 1;
    }
  });

  await assert.rejects(() => analyzeProject(repo, settings, { mode: "full-source" }), /全部源码分析.*超过限制/);
  assert.equal(modelCalls, 0);
});

test("generateSuggestedQuestions calls the current OpenAI-compatible chat endpoint and parses a JSON array", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: Record<string, unknown> = {};

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify([
                "侧边栏分析完成后，content script 和 background 的通信边界在哪里？",
                "如果要修改模型调用链路，应该先读哪些文件？",
                "当前缓存命中时，分析结果和推荐追问会怎样更新？",
                "这个多余问题应该被截断。"
              ])
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await generateSuggestedQuestions(repo, settings, {
    kind: "overview",
    summary: "分析指出 entrypoints/content.tsx 注入侧边栏，entrypoints/background.ts 处理 runtime 消息。",
    sources: ["entrypoints/content.tsx", "entrypoints/background.ts"]
  });

  assert.equal(requestedUrl, "https://models.example/v1/chat/completions");
  assert.equal(authorization, "Bearer sk-test");
  assert.equal(body.model, "guide-model");
  assert.match(JSON.stringify(body.messages), /acme\/demo/);
  assert.deepEqual(result.questions, [
    "侧边栏分析完成后，content script 和 background 的通信边界在哪里？",
    "如果要修改模型调用链路，应该先读哪些文件？",
    "当前缓存命中时，分析结果和推荐追问会怎样更新？"
  ]);
  assert.equal(typeof result.timing?.modelMs, "number");
});

test("generateSuggestedQuestions parses numbered list responses", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [
                "1. 为什么 entrypoints/background.ts 是模型请求的集中入口？",
                "2. src/lib/analyzer.ts 里的分析上下文是怎么限制源码范围的？",
                "3. 修改 Sidebar.tsx 的推荐追问 UI 时有哪些状态要同步？"
              ].join("\n")
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  const result = await generateSuggestedQuestions(repo, settings, {
    kind: "feature",
    label: "推荐追问",
    summary: "功能路径分析指出推荐追问当前由 Sidebar.tsx 本地规则生成。",
    sources: ["entrypoints/background.ts", "src/components/Sidebar.tsx", "src/lib/analyzer.ts"]
  });

  assert.deepEqual(result.questions, [
    "为什么 entrypoints/background.ts 是模型请求的集中入口？",
    "src/lib/analyzer.ts 里的分析上下文是怎么限制源码范围的？",
    "修改 Sidebar.tsx 的推荐追问 UI 时有哪些状态要同步？"
  ]);
});

test("generateSuggestedQuestions trims numbered, long, and multi-sentence responses to 3 short questions", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify([
                "1. 下一步应该先看哪个入口？第二句不应该保留，因为界面只需要一句话。",
                "2. 修改缓存逻辑的主要风险是什么？这句也应该被去掉。",
                "3. 哪个文件负责发送模型请求？后面还有很长的解释文本，用来模拟模型没有遵守短问题要求时的输出。",
                "4. 这个多余问题不应该出现？"
              ])
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  const result = await generateSuggestedQuestions(repo, settings, {
    kind: "overview",
    summary: "分析指出 entrypoints/background.ts 发送模型请求，缓存逻辑集中在 src/lib/analyzer.ts。",
    sources: ["entrypoints/background.ts", "src/lib/analyzer.ts"]
  });

  assert.deepEqual(result.questions, [
    "下一步应该先看哪个入口？",
    "修改缓存逻辑的主要风险是什么？",
    "哪个文件负责发送模型请求？"
  ]);
});

test("generateSuggestedQuestions marks answer follow-up requests in the model prompt", async () => {
  let body: ChatRequestBody | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as ChatRequestBody;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(["还要看哪个调用链？", "这个改动风险在哪？", "下一步怎么验证？"])
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  await generateSuggestedQuestions(repo, settings, {
    kind: "answer",
    label: "用户问题：缓存怎么更新？",
    summary: "本次回答说明缓存命中来自 src/lib/analyzer.ts，刷新按钮会重新调用模型。",
    sources: ["src/lib/analyzer.ts", "src/components/Sidebar.tsx"]
  });

  const messages = JSON.stringify(body?.messages ?? []);
  assert.match(messages, /追问回答/);
  assert.match(messages, /用户问题：缓存怎么更新/);
});

test("generateSuggestedQuestions rejects empty or invalid model responses", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "[]" } }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  await assert.rejects(
    () =>
      generateSuggestedQuestions(repo, settings, {
        kind: "file",
        label: "src/components/Sidebar.tsx",
        summary: "当前文件分析。",
        sources: ["src/components/Sidebar.tsx"]
      }),
    /推荐追问/
  );
});

type ChatRequestBody = {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
};

function mockAnalyzeProjectFetch(input: {
  tree: TreeFile[];
  treeTruncated?: boolean;
  files: Record<string, string>;
  branchName?: string;
  branchStatus?: number;
  headRefStatus?: number;
  tagRef?: { type: "commit" | "tag"; sha: string; tagObjectSha?: string };
  headSha?: string;
  treeSha?: string;
  modelContent?: string | (() => string);
  onModelRequest?: (body: ChatRequestBody) => void;
}): typeof fetch {
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    const branchName = input.branchName ?? "main";
    const headSha = input.headSha ?? "head-main";
    const treeSha = input.treeSha ?? "tree-main";
    if (url === "https://api.github.com/repos/acme/demo") {
      return jsonResponse({ default_branch: "main" });
    }

    if (!branchName.includes("/") && url === `https://api.github.com/repos/acme/demo/branches/${encodeURIComponent(branchName)}`) {
      if (input.branchStatus && input.branchStatus >= 400) return new Response("branch unavailable", { status: input.branchStatus });
      return jsonResponse({
        name: branchName,
        commit: {
          sha: headSha,
          commit: {
            tree: {
              sha: treeSha
            }
          }
        }
      });
    }

    if (url === `https://api.github.com/repos/acme/demo/git/ref/heads/${branchName.split("/").map(encodeURIComponent).join("/")}`) {
      if (input.headRefStatus && input.headRefStatus >= 400) return new Response("head ref unavailable", { status: input.headRefStatus });
      return jsonResponse({
        ref: `refs/heads/${branchName}`,
        object: {
          type: "commit",
          sha: headSha
        }
      });
    }

    if (url === `https://api.github.com/repos/acme/demo/commits/${encodeURIComponent(branchName)}`) {
      if (branchName === headSha) {
        return jsonResponse({
          sha: headSha,
          commit: {
            tree: {
              sha: treeSha
            }
          }
        });
      }
      return new Response("commit unavailable", { status: 404 });
    }

    if (url === `https://api.github.com/repos/acme/demo/git/ref/tags/${branchName.split("/").map(encodeURIComponent).join("/")}` && input.tagRef) {
      return jsonResponse({
        ref: `refs/tags/${branchName}`,
        object: {
          type: input.tagRef.type,
          sha: input.tagRef.sha
        }
      });
    }

    if (input.tagRef?.type === "tag" && url === `https://api.github.com/repos/acme/demo/git/tags/${input.tagRef.sha}`) {
      return jsonResponse({
        object: {
          type: "commit",
          sha: input.tagRef.tagObjectSha ?? headSha
        }
      });
    }

    if (url === `https://api.github.com/repos/acme/demo/git/commits/${headSha}`) {
      return jsonResponse({
        sha: headSha,
        tree: {
          sha: treeSha
        }
      });
    }

    if (url === `https://api.github.com/repos/acme/demo/git/trees/${treeSha}?recursive=1`) {
      return jsonResponse({ tree: input.tree, truncated: input.treeTruncated });
    }

    if (url.startsWith("https://api.github.com/repos/acme/demo/contents/")) {
      const encodedPath = url.slice("https://api.github.com/repos/acme/demo/contents/".length).replace(/\?ref=.*/, "");
      const path = decodeURIComponent(encodedPath);
      const content = input.files[path];
      if (content === undefined) return new Response("not found", { status: 404 });
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64")
      });
    }

    if (url === "https://models.example/v1/chat/completions") {
      const body = JSON.parse(String(init?.body)) as ChatRequestBody;
      input.onModelRequest?.(body);
      return jsonResponse({
        choices: [
          {
            message: {
              content:
                typeof input.modelContent === "function"
                  ? input.modelContent()
                  : input.modelContent ?? "源码确认\n- 测试分析结果。\n\n谨慎推断\n- 无。\n\n建议继续验证\n- 无。"
            }
          }
        ]
      });
    }

    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installChromeStorageMock(
  initial: Record<string, unknown>,
  options: { failSetCount?: number; failRemoveCount?: number; maxSerializedBytes?: number; beforeRemove?: () => Promise<void> } = {}
): Record<string, unknown> {
  const store = { ...initial };
  const runtime: { lastError?: { message?: string } } = {};
  let failSetCount = options.failSetCount ?? 0;
  let failRemoveCount = options.failRemoveCount ?? 0;
  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get(key: string | null, callback: (items: Record<string, unknown>) => void) {
          if (key === null) callback({ ...store });
          else callback(Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {});
        },
        set(items: Record<string, unknown>, callback: () => void) {
          if (failSetCount > 0) {
            failSetCount -= 1;
            runtime.lastError = { message: "QUOTA_BYTES quota exceeded" };
            callback();
            delete runtime.lastError;
            return;
          }
          const nextStore = { ...store, ...items };
          if (options.maxSerializedBytes !== undefined && new TextEncoder().encode(JSON.stringify(nextStore)).byteLength > options.maxSerializedBytes) {
            runtime.lastError = { message: "QUOTA_BYTES quota exceeded" };
            callback();
            delete runtime.lastError;
            return;
          }
          Object.assign(store, items);
          callback();
        },
        remove(keys: string[], callback: () => void) {
          const complete = () => {
            if (failRemoveCount > 0) {
              failRemoveCount -= 1;
              runtime.lastError = { message: "storage remove failed" };
              callback();
              delete runtime.lastError;
              return;
            }
            for (const key of keys) delete store[key];
            callback();
          };
          if (options.beforeRemove) {
            void options.beforeRemove().then(complete);
            return;
          }
          complete();
        }
      }
    },
    runtime
  };
  return store;
}

function snapshotForTest(headSha: string, treeSha: string) {
  const capturedAt = "2026-07-08T00:00:00.000Z";
  return {
    owner: "acme",
    repo: "demo",
    refName: "main",
    headSha,
    treeSha,
    capturedAt,
    lastValidatedAt: capturedAt
  };
}

async function persistentOverviewTestKey(repoRef: RepoRef, branch: string, treeSha: string, mode: string, files: TreeFile[], testSettings: Settings): Promise<string> {
  const inputDigest = await persistentOverviewInputDigestForTest(treeSha, mode, files, testSettings);
  return `codepath-cache-v2:e:${repoRef.owner}/${repoRef.repo}@${encodeURIComponent(branch)}:overview:${treeSha}:${mode}:${inputDigest}`;
}

async function persistentOverviewInputDigestForTest(treeSha: string, mode: string, files: TreeFile[], testSettings: Settings): Promise<string> {
  return sha256Digest([
    "overview",
    JSON.stringify(mode),
    treeSha,
    JSON.stringify(files.map((file) => ({ path: file.path, blobSha: file.sha, size: file.size })).sort((left, right) => left.path.localeCompare(right.path))),
    await modelFingerprintForTest(testSettings),
    PROMPT_VERSION,
    ANALYZER_VERSION
  ]);
}

function cacheRecordForTest(kind: "overview", capturedAt: string, summary = "old") {
  return {
    schemaVersion: 2,
    kind,
    value: { summary, sources: [], branch: "main" },
    basis: {
      snapshot: {
        owner: "acme",
        repo: "demo",
        refName: "main",
        headSha: `old-head-${capturedAt}`,
        treeSha: `old-tree-${capturedAt}`,
        capturedAt,
        lastValidatedAt: capturedAt
      },
      files: [],
      inputDigest: "old",
      promptVersion: PROMPT_VERSION,
      analyzerVersion: ANALYZER_VERSION
    }
  };
}

async function modelFingerprintForTest(testSettings: Settings): Promise<string> {
  return sha256Digest([
    testSettings.provider,
    testSettings.baseUrl.replace(/\/+$/, ""),
    testSettings.model,
    String(testSettings.maxOutputTokens ?? ""),
    await sha256Digest([testSettings.apiKey])
  ]);
}

function stringHashForTest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function legacyModelFingerprint(model: string): string {
  return stringHashForTest(
    JSON.stringify({
      provider: "openai",
      baseUrl: "https://models.example/v1",
      model,
      maxOutputTokens: null
    })
  );
}

function zipResponse(files: Record<string, string>): Response {
  const entries = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)]));
  const bytes = zipSync(entries);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.byteLength)
    }
  });
}
