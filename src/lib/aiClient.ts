import type { ModelOption, Settings, StreamingMode } from "../types";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 4096;

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type ChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type StreamProbeResult = {
  supported: boolean;
  message: string;
  mode: StreamingMode;
  firstDeltaMs?: number;
  deltaCount?: number;
};

type StreamResult = {
  content: string;
  firstDeltaMs?: number;
  deltaCount: number;
};

type ModelsResponse = {
  data?: Array<{
    id?: unknown;
  }>;
};

type AnthropicMessageResponse = {
  content?: Array<{
    type?: unknown;
    text?: unknown;
  }>;
};

class StreamingUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingUnsupportedError";
  }
}

export async function chat(settings: Settings, messages: ChatMessage[]): Promise<string> {
  const provider = normalizeProvider(settings.provider);
  return provider === "anthropic" ? chatAnthropic(settings, messages) : chatOpenAi(settings, messages);
}

export function normalizeProvider(value: unknown): Settings["provider"] {
  return value === "anthropic" ? "anthropic" : "openai";
}

async function chatOpenAi(settings: Settings, messages: ChatMessage[]): Promise<string> {
  if (!settings.apiKey) {
    throw new Error("请先在 Settings 中填写模型 API Key。");
  }

  const endpoint = `${requireBaseUrl(settings.baseUrl)}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.2
      })
    });
  } catch (error) {
    throw new Error(`Unable to reach model base URL ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`模型接口 ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型没有返回内容。");
  return content;
}

async function chatAnthropic(settings: Settings, messages: ChatMessage[]): Promise<string> {
  if (!settings.apiKey) {
    throw new Error("请先在 Settings 中填写模型 API Key。");
  }

  const endpoint = `${requireBaseUrl(settings.baseUrl)}/messages`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: anthropicHeaders(settings.apiKey),
      body: JSON.stringify(anthropicBody(settings, messages))
    });
  } catch (error) {
    throw new Error(`Unable to reach model base URL ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`模型接口 ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as AnthropicMessageResponse;
  const content = (data.content ?? [])
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
  if (!content) throw new Error("模型没有返回内容。");
  return content;
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.replace(/\/(?:chat\/completions|messages|models)$/i, "");
}

export async function listModels(settings: Pick<Settings, "provider" | "apiKey" | "baseUrl">): Promise<ModelOption[]> {
  if (!settings.apiKey) {
    throw new Error("请先填写模型 API Key。");
  }

  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!baseUrl) {
    throw new Error("请先填写模型 Base URL。");
  }

  const endpoint = `${baseUrl}/models`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: normalizeProvider(settings.provider) === "anthropic" ? anthropicHeaders(settings.apiKey) : openAiHeaders(settings.apiKey)
    });
  } catch (error) {
    throw new Error(`Unable to reach model list URL ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`模型列表接口 ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ModelsResponse;
  return (data.data ?? [])
    .map((item) => (typeof item.id === "string" ? item.id.trim() : ""))
    .filter(Boolean)
    .map((id) => ({ id }));
}

export async function chatAuto(
  settings: Settings,
  messages: ChatMessage[],
  onDelta?: (text: string) => void,
  onFallback?: (reason: string) => void
): Promise<string> {
  if (!onDelta || settings.supportsStreaming !== true) {
    return chat(settings, messages);
  }

  try {
    return await chatStream(settings, messages, onDelta);
  } catch (error) {
    if (isAuthOrConfigError(error)) throw error;
    onFallback?.(formatStreamingProbeError(error));
    return chat(settings, messages);
  }
}

export async function probeStreamingSupport(settings: Settings): Promise<StreamProbeResult> {
  if (!settings.apiKey) {
    return { supported: false, mode: "untested", message: "流式输出未测试：未填写 API Key。" };
  }

  try {
    const result = await chatStreamDetailed(
      settings,
      [
        { role: "system", content: "You are a streaming connection test. Reply with OK." },
        { role: "user", content: "Reply only: OK" }
      ],
      () => {}
    );
    const mode: StreamingMode = result.deltaCount > 1 ? "realtime" : "buffered";
    if (!result.content.trim()) {
      return { supported: false, mode: "unsupported", message: "流式输出不支持：接口没有返回有效增量内容，将使用普通一次性返回。" };
    }
    return {
      supported: true,
      mode,
      firstDeltaMs: result.firstDeltaMs,
      deltaCount: result.deltaCount,
      message:
        mode === "realtime"
          ? `流式输出支持：检测到 ${result.deltaCount} 个增量片段，首段约 ${formatMs(result.firstDeltaMs)} 到达。`
          : `接口支持 stream=true，但只检测到 1 个增量片段，疑似服务端或代理缓冲；首段约 ${formatMs(result.firstDeltaMs)} 到达。`
    };
  } catch (error) {
    return { supported: false, mode: "unsupported", message: `流式输出不支持：${formatStreamingProbeError(error)}。将使用普通一次性返回。` };
  }
}

async function chatStream(settings: Settings, messages: ChatMessage[], onDelta: (text: string) => void): Promise<string> {
  return (await chatStreamDetailed(settings, messages, onDelta)).content;
}

async function chatStreamDetailed(settings: Settings, messages: ChatMessage[], onDelta: (text: string) => void): Promise<StreamResult> {
  const provider = normalizeProvider(settings.provider);
  if (!settings.apiKey) {
    throw new Error("请先在 Settings 中填写模型 API Key。");
  }

  const endpoint = `${requireBaseUrl(settings.baseUrl)}/${provider === "anthropic" ? "messages" : "chat/completions"}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: provider === "anthropic" ? anthropicHeaders(settings.apiKey) : openAiHeaders(settings.apiKey),
      body: JSON.stringify(provider === "anthropic" ? anthropicBody(settings, messages, true) : openAiBody(settings, messages, true))
    });
  } catch (error) {
    throw new Error(`Unable to reach model base URL ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`模型接口 ${response.status}: ${await response.text()}`);
  }

  if (!response.body) {
    throw new StreamingUnsupportedError("response body is not readable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let firstDeltaMs: number | undefined;
  let deltaCount = 0;
  const startedAt = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const delta = parseSseLine(line, provider);
      if (!delta) continue;
      content += delta;
      deltaCount += 1;
      firstDeltaMs ??= Date.now() - startedAt;
      onDelta(delta);
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) {
    const delta = parseSseLine(line, provider);
    if (!delta) continue;
    content += delta;
    deltaCount += 1;
    firstDeltaMs ??= Date.now() - startedAt;
    onDelta(delta);
  }

  if (!content) throw new StreamingUnsupportedError("no streaming delta content");
  return { content, firstDeltaMs, deltaCount };
}

function parseSseLine(line: string, provider: Settings["provider"]): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return "";
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return "";
  try {
    if (provider === "anthropic") {
      const parsed = JSON.parse(data) as {
        type?: string;
        delta?: {
          type?: string;
          text?: string;
        };
      };
      if (parsed.type !== "content_block_delta" || parsed.delta?.type !== "text_delta") return "";
      return parsed.delta.text ?? "";
    }

    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: { content?: string };
      }>;
    };
    return parsed.choices?.map((choice) => choice.delta?.content ?? "").join("") ?? "";
  } catch {
    throw new StreamingUnsupportedError("invalid SSE data");
  }
}

function requireBaseUrl(input: string): string {
  const baseUrl = normalizeBaseUrl(input);
  if (!baseUrl) throw new Error("请先填写模型 Base URL。");
  return baseUrl;
}

function openAiHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json"
  };
}

function openAiBody(settings: Settings, messages: ChatMessage[], stream = false): Record<string, unknown> {
  return {
    model: settings.model,
    messages,
    temperature: 0.2,
    ...(stream ? { stream: true } : {})
  };
}

function anthropicBody(settings: Settings, messages: ChatMessage[], stream = false): Record<string, unknown> {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const userMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: "user",
      content: message.content
    }));

  return {
    model: settings.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    temperature: 0.2,
    ...(system ? { system } : {}),
    messages: userMessages,
    ...(stream ? { stream: true } : {})
  };
}

function isAuthOrConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403)\b/.test(message);
}

function formatStreamingProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("400")) return "接口拒绝 stream=true 参数";
  if (message.includes("404")) return "Base URL 或模型名称不支持该流式接口";
  if (message.includes("401") || message.includes("403")) return "API Key、模型权限或账户权限不足";
  if (message.includes("Unable to reach")) return "无法连接 Base URL";
  if (message.includes("invalid SSE") || message.includes("no streaming delta") || message.includes("not readable")) {
    return "接口没有返回可识别的 SSE 增量数据";
  }
  return message;
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return "未知时间";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
