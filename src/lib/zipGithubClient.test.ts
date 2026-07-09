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
    if (url.includes("/zip/refs/heads/feature%2Fmissing")) return new Response("not found", { status: 404 });
    if (url.includes("/zip/refs/heads/main")) return zipResponse({ "demo-main/README.md": "# Wrong branch" });
    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;

  const client = new ZipGithubClient("acme", "demo", "feature/missing");

  await assert.rejects(() => client.getRepo(), /Unable to download public repository zip/);
});

test("ZipGithubClient uses a stable unchecked snapshot identity for unchanged zip contents", async () => {
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("/zip/refs/heads/main")) return zipResponse({ "demo-main/README.md": "# Demo" });
    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;

  const client = new ZipGithubClient("acme", "demo", "main");
  const first = await client.getBranchSnapshot("acme", "demo", "main");
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await client.getBranchSnapshot("acme", "demo", "main");

  assert.equal(first.headSha, second.headSha);
  assert.equal(first.treeSha, second.treeSha);
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
