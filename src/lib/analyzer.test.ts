import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { generateSuggestedQuestions } from "./analyzer";
import type { RepoRef, Settings } from "../types";

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

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    sources: ["src/components/Sidebar.tsx", "src/lib/analyzer.ts"]
  });

  assert.deepEqual(result.questions, [
    "为什么 entrypoints/background.ts 是模型请求的集中入口？",
    "src/lib/analyzer.ts 里的分析上下文是怎么限制源码范围的？",
    "修改 Sidebar.tsx 的推荐追问 UI 时有哪些状态要同步？"
  ]);
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
