import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chat, chatAuto, inferProviderFromBaseUrl, listModels, normalizeBaseUrl, normalizeProvider, resolveProvider } from "./aiClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("normalizeBaseUrl accepts base and full OpenAI-compatible endpoint URLs", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1/"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1/chat/completions"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1/models"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1/messages"), "https://example.com/v1");
});

test("normalizeProvider migrates legacy provider values to openai", () => {
  assert.equal(normalizeProvider("openai"), "openai");
  assert.equal(normalizeProvider("anthropic"), "anthropic");
  assert.equal(normalizeProvider("qwen"), "openai");
  assert.equal(normalizeProvider("custom"), "openai");
  assert.equal(normalizeProvider("unexpected"), "openai");
});

test("inferProviderFromBaseUrl selects the API format from the endpoint", () => {
  assert.equal(inferProviderFromBaseUrl("https://api.deepseek.com"), "openai");
  assert.equal(inferProviderFromBaseUrl("https://api.deepseek.com/anthropic"), "anthropic");
  assert.equal(inferProviderFromBaseUrl("https://api.deepseek.com/anthropic/messages"), "anthropic");
  assert.equal(inferProviderFromBaseUrl("https://api.anthropic.com/v1"), "anthropic");
  assert.equal(inferProviderFromBaseUrl("https://example.com/v1/chat/completions"), "openai");
});

test("resolveProvider preserves an explicit provider and infers migrated values", () => {
  assert.equal(resolveProvider({ provider: "anthropic", baseUrl: "https://models.example/v1" }), "anthropic");
  assert.equal(resolveProvider({ provider: "legacy", baseUrl: "https://api.anthropic.com/v1" }), "anthropic");
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
    provider: "openai",
    apiKey: "sk-test",
    baseUrl: "https://example.com/v1/chat/completions"
  });

  assert.equal(requestedUrl, "https://example.com/v1/models");
  assert.equal(authorization, "Bearer sk-test");
  assert.deepEqual(models, [{ id: "qwen-plus" }, { id: "gpt-4.1-mini" }]);
});

test("listModels uses Anthropic model headers and endpoint", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let anthropicVersion = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    const headers = init?.headers as Record<string, string>;
    apiKey = String(headers?.["x-api-key"] ?? "");
    anthropicVersion = String(headers?.["anthropic-version"] ?? "");
    return new Response(
      JSON.stringify({
        data: [{ id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }, { id: "" }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const models = await listModels({
    provider: "anthropic",
    apiKey: "sk-ant-test",
    baseUrl: "https://api.anthropic.com/v1/messages"
  });

  assert.equal(requestedUrl, "https://api.anthropic.com/v1/models");
  assert.equal(apiKey, "sk-ant-test");
  assert.equal(anthropicVersion, "2023-06-01");
  assert.deepEqual(models, [{ id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }]);
});

test("chat sends Anthropic messages requests with system prompt and joins text blocks", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let anthropicVersion = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    const headers = init?.headers as Record<string, string>;
    apiKey = String(headers?.["x-api-key"] ?? "");
    anthropicVersion = String(headers?.["anthropic-version"] ?? "");
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const content = await chat(
    {
      provider: "anthropic",
      apiKey: "sk-ant-test",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
      githubToken: ""
    },
    [
      { role: "system", content: "只用中文回答。" },
      { role: "user", content: "解释这个项目。" }
    ]
  );

  assert.equal(requestedUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(apiKey, "sk-ant-test");
  assert.equal(anthropicVersion, "2023-06-01");
  assert.equal(body.model, "claude-sonnet-4-5");
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.system, "只用中文回答。");
  assert.deepEqual(body.messages, [{ role: "user", content: "解释这个项目。" }]);
  assert.equal(content, "第一段第二段");
});

test("chat honors an explicit Anthropic provider on a neutral proxy", async () => {
  let requestedUrl = "";
  let apiKey = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    const headers = init?.headers as Record<string, string>;
    apiKey = String(headers?.["x-api-key"] ?? "");
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  const content = await chat(
    {
      provider: "anthropic",
      apiKey: "anthropic-test-key",
      baseUrl: "https://models.example/v1",
      model: "claude-example",
      githubToken: ""
    },
    [{ role: "user", content: "Say OK." }]
  );

  assert.equal(requestedUrl, "https://models.example/v1/messages");
  assert.equal(apiKey, "anthropic-test-key");
  assert.equal(content, "ok");
});

test("chat sends OpenAI-compatible requests with a bounded output token limit", async () => {
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  await chat(
    {
      provider: "openai",
      apiKey: "sk-test",
      baseUrl: "https://models.example/v1",
      model: "guide-model",
      githubToken: ""
    },
    [{ role: "user", content: "Say OK." }]
  );

  assert.equal(body.max_tokens, 4096);
});

test("chatAuto streams Anthropic text_delta events", async () => {
  globalThis.fetch = (async () => {
    const chunks = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ];
    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  const deltas: string[] = [];
  const content = await chatAuto(
    {
      provider: "anthropic",
      apiKey: "sk-ant-test",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
      githubToken: "",
      supportsStreaming: true
    },
    [{ role: "user", content: "Say hello." }],
    (text) => deltas.push(text)
  );

  assert.equal(content, "你好");
  assert.deepEqual(deltas, ["你", "好"]);
});

test("chatAuto stops at a terminal event without waiting for the connection to close", async () => {
  let fetchCount = 0;
  let cancelled = false;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\ndata: {broken\n\n'
            )
          );
          closeTimer = setTimeout(() => controller.close(), 150);
        },
        cancel() {
          cancelled = true;
          if (closeTimer) clearTimeout(closeTimer);
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  const startedAt = Date.now();
  const content = await chatAuto(streamingSettings(), [{ role: "user", content: "Say done." }], () => {});

  assert.equal(content, "done");
  assert.equal(fetchCount, 1);
  assert.equal(cancelled, true);
  assert.ok(Date.now() - startedAt < 100, "terminal event should end the request immediately");
});

test("chatAuto bounds an unterminated SSE line without replaying the model request", async () => {
  let fetchCount = 0;
  let cancelled = false;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(256 * 1024 + 1)));
          closeTimer = setTimeout(() => controller.close(), 150);
        },
        cancel() {
          cancelled = true;
          if (closeTimer) clearTimeout(closeTimer);
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  await assert.rejects(
    () => chatAuto(streamingSettings(), [{ role: "user", content: "Say done." }], () => {}),
    /pending SSE line is too large/
  );

  assert.equal(fetchCount, 1);
  assert.equal(cancelled, true);
});

test("chatAuto bounds total raw stream bytes even when lines stay small", async () => {
  let fetchCount = 0;
  let cancelled = false;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    const keepAliveLines = (": " + "x".repeat(1_020) + "\n").repeat(2_060);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(keepAliveLines));
        },
        cancel() {
          cancelled = true;
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  await assert.rejects(
    () => chatAuto(streamingSettings(), [{ role: "user", content: "Say done." }], () => {}),
    /raw streaming response is too large/
  );

  assert.equal(fetchCount, 1);
  assert.equal(cancelled, true);
});

test("chatAuto rejects a stream that closes without a terminal event", async () => {
  let fetchCount = 0;
  const deltas: string[] = [];
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  }) as typeof fetch;

  await assert.rejects(
    () => chatAuto(streamingSettings(), [{ role: "user", content: "Say done." }], (delta) => deltas.push(delta)),
    /without a terminal event/
  );

  assert.deepEqual(deltas, ["partial"]);
  assert.equal(fetchCount, 1);
});

test("chatAuto never replays a model request after emitting a stream delta", async () => {
  let fetchCount = 0;
  const deltas: string[] = [];
  globalThis.fetch = (async () => {
    fetchCount += 1;
    if (fetchCount > 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "replayed" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {broken\n\n')
          );
          controller.close();
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  await assert.rejects(
    () => chatAuto(streamingSettings(), [{ role: "user", content: "Say done." }], (delta) => deltas.push(delta)),
    /invalid SSE data/
  );

  assert.deepEqual(deltas, ["partial"]);
  assert.equal(fetchCount, 1);
});

function streamingSettings() {
  return {
    provider: "openai" as const,
    apiKey: "stream-test-key",
    baseUrl: "https://models.example/v1",
    model: "stream-model",
    githubToken: "",
    supportsStreaming: true
  };
}
