import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { analyzeProject, clearAnalysisCaches, generateSuggestedQuestions } from "./analyzer";
import type { RepoRef, Settings, TreeFile } from "../types";

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

type ChatRequestBody = {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
};

function mockAnalyzeProjectFetch(input: {
  tree: TreeFile[];
  files: Record<string, string>;
  onModelRequest?: (body: ChatRequestBody) => void;
}): typeof fetch {
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url === "https://api.github.com/repos/acme/demo") {
      return jsonResponse({ default_branch: "main" });
    }

    if (url === "https://api.github.com/repos/acme/demo/git/trees/main?recursive=1") {
      return jsonResponse({ tree: input.tree });
    }

    if (url.startsWith("https://api.github.com/repos/acme/demo/contents/")) {
      const encodedPath = url.slice("https://api.github.com/repos/acme/demo/contents/".length).replace(/\?ref=main$/, "");
      const path = decodeURIComponent(encodedPath);
      const content = input.files[path];
      if (content === undefined) return new Response("not found", { status: 404 });
      return jsonResponse({
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64")
      });
    }

    if (url === "https://models.example/v1/chat/completions") {
      const body = JSON.parse(String(init?.body)) as ChatRequestBody;
      input.onModelRequest?.(body);
      return jsonResponse({
        choices: [{ message: { content: "源码确认\n- 测试分析结果。\n\n谨慎推断\n- 无。\n\n建议继续验证\n- 无。" } }]
      });
    }

    return new Response(`unexpected URL: ${url}`, { status: 500 });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
