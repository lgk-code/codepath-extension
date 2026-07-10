import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { ZipGithubClient } from "./zipGithubClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("ZipGithubClient does not fall back to main when an explicit branch zip is unavailable", async () => {
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("/zip/feature%2Fmissing")) return new Response("not found", { status: 404 });
    if (url.includes("/zip/main")) return zipResponse({ "demo-main/README.md": "# Wrong branch" });
    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;

  const client = new ZipGithubClient("acme", "demo", "feature/missing");

  await assert.rejects(() => client.getRepo(), /Unable to download public repository zip/);
});

test("ZipGithubClient uses a stable unchecked snapshot identity for unchanged zip contents", async () => {
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("/zip/main")) return zipResponse({ "demo-main/README.md": "# Demo" });
    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;

  const client = new ZipGithubClient("acme", "demo", "main");
  const first = await client.getBranchSnapshot("acme", "demo", "main");
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await client.getBranchSnapshot("acme", "demo", "main");

  assert.equal(first.headSha, second.headSha);
  assert.equal(first.treeSha, second.treeSha);
});

test("ZipGithubClient requests an exact tag through the generic codeload ref route", async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    requestedUrls.push(url);
    return zipResponse({ "demo-v1/README.md": "# Tagged" });
  }) as typeof fetch;

  await new ZipGithubClient("acme", "demo", "v1.2.3").getRepo();

  assert.deepEqual(requestedUrls, ["https://codeload.github.com/acme/demo/zip/v1.2.3"]);
});

test("ZipGithubClient requests an exact commit through the generic codeload ref route", async () => {
  const commit = "a".repeat(40);
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    requestedUrls.push(url);
    return zipResponse({ "demo-commit/README.md": "# Commit" });
  }) as typeof fetch;

  await new ZipGithubClient("acme", "demo", commit).getRepo();

  assert.deepEqual(requestedUrls, [`https://codeload.github.com/acme/demo/zip/${commit}`]);
});

test("ZipGithubClient uses codeload HEAD when no branch was supplied", async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    requestedUrls.push(url);
    if (url === "https://codeload.github.com/acme/demo/zip/HEAD") {
      return zipResponse({ "demo-trunk/README.md": "# Demo" });
    }
    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;

  const client = new ZipGithubClient("acme", "demo");
  const info = await client.getRepo();

  assert.deepEqual(requestedUrls, ["https://codeload.github.com/acme/demo/zip/HEAD"]);
  assert.equal(info.default_branch, "HEAD");
});

test("ZipGithubClient rejects invalid owner and repository identities before fetching", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  await assert.rejects(() => new ZipGithubClient("visible", "../secret-owner/secret-repo").getRepo(), /invalid GitHub repository/i);
  assert.equal(fetchCalls, 0);
});

test("ZipGithubClient cancels rejected archive responses", async () => {
  let cancelled = false;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("not found"));
        },
        cancel() {
          cancelled = true;
        }
      }),
      { status: 404 }
    )) as typeof fetch;

  await assert.rejects(() => new ZipGithubClient("acme", "demo").getRepo(), /Unable to download public repository zip/);
  assert.equal(cancelled, true);
});

test("ZipGithubClient resolves an ordinary file candidate after API rate limiting", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    requested.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "HEAD" && url.endsWith("/zip/main")) return new Response(null, { status: 200 });
    if (init?.method === "HEAD" && url.endsWith("/zip/main%2Fsrc")) return new Response(null, { status: 404 });
    if (url.endsWith("/zip/main")) return zipResponse({ "demo-main/src/app.ts": "export const app = true;" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const client = new ZipGithubClient("acme", "demo", "main");

  const resolved = await client.resolveRepoRef({
    owner: "acme",
    repo: "demo",
    branch: "main",
    path: "src/app.ts",
    pageType: "file",
    refCandidates: [
      { refName: "main", path: "src/app.ts" },
      { refName: "main/src", path: "app.ts" }
    ]
  });

  assert.equal(resolved.branch, "main");
  assert.equal(resolved.path, "src/app.ts");
  assert.deepEqual(requested, [
    "HEAD https://codeload.github.com/acme/demo/zip/main",
    "HEAD https://codeload.github.com/acme/demo/zip/main%2Fsrc",
    "GET https://codeload.github.com/acme/demo/zip/main"
  ]);
});

test("ZipGithubClient retains a filtered current file separately from project snippets", async () => {
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (init?.method === "HEAD" && url.endsWith("/zip/main")) return new Response(null, { status: 200 });
    if (init?.method === "HEAD" && url.endsWith("/zip/main%2Fassets")) return new Response(null, { status: 404 });
    if (url.endsWith("/zip/main")) return zipResponse({ "demo-main/assets/logo.svg": "<svg>logo</svg>" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const client = new ZipGithubClient("acme", "demo", "main");
  const repo = await client.resolveRepoRef({
    owner: "acme",
    repo: "demo",
    branch: "main",
    path: "assets/logo.svg",
    pageType: "file",
    refCandidates: [
      { refName: "main", path: "assets/logo.svg" },
      { refName: "main/assets", path: "logo.svg" }
    ]
  });

  assert.equal(await client.getFile("acme", "demo", repo.path ?? "", repo.branch ?? ""), "<svg>logo</svg>");
});

test("ZipGithubClient uses archive paths to disambiguate multiple existing refs", async () => {
  let zipGets = 0;
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (init?.method === "HEAD" && (url.endsWith("/zip/feature") || url.endsWith("/zip/feature%2Fsidebar"))) {
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/zip/feature")) {
      zipGets += 1;
      return zipResponse({ "demo-feature/README.md": "# Feature" });
    }
    if (url.endsWith("/zip/feature%2Fsidebar")) {
      zipGets += 1;
      return zipResponse({ "demo-sidebar/src/app.ts": "export const app = true;" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const client = new ZipGithubClient("acme", "demo", "feature/sidebar");

  const resolved = await client.resolveRepoRef({
    owner: "acme",
    repo: "demo",
    branch: "feature/sidebar",
    path: "src/app.ts",
    pageType: "file",
    refCandidates: [
      { refName: "feature", path: "sidebar/src/app.ts" },
      { refName: "feature/sidebar", path: "src/app.ts" }
    ]
  });

  assert.equal(resolved.branch, "feature/sidebar");
  assert.equal(resolved.path, "src/app.ts");
  assert.equal(zipGets, 2);
});

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
