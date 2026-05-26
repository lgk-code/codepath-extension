import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { listModels, normalizeBaseUrl } from "./aiClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("normalizeBaseUrl accepts base and full OpenAI-compatible endpoint URLs", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1/"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1/chat/completions"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1/models"), "https://example.com/v1");
});

test("listModels calls the normalized models endpoint and returns valid model ids", async () => {
  let requestedUrl = "";
  let authorization = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(
      JSON.stringify({
        data: [{ id: "qwen-plus" }, { id: "gpt-4.1-mini" }, { id: "" }, { object: "model" }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const models = await listModels({
    apiKey: "sk-test",
    baseUrl: "https://example.com/v1/chat/completions"
  });

  assert.equal(requestedUrl, "https://example.com/v1/models");
  assert.equal(authorization, "Bearer sk-test");
  assert.deepEqual(models, [{ id: "qwen-plus" }, { id: "gpt-4.1-mini" }]);
});
