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

test("ZipGithubClient encodes owner and repository as individual codeload path segments", async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    requestedUrls.push(String(request));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  await assert.rejects(() => new ZipGithubClient("visible", "../secret-owner/secret-repo").getRepo(), /Unable to download/);

  assert.deepEqual(requestedUrls, ["https://codeload.github.com/visible/..%2Fsecret-owner%2Fsecret-repo/zip/HEAD"]);
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
