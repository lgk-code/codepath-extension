import type { Settings } from "../types";

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
};

class StreamingUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingUnsupportedError";
  }
}

export async function chat(settings: Settings, messages: ChatMessage[]): Promise<string> {
  if (!settings.apiKey) {
    throw new Error("请先在 Settings 中填写模型 API Key。");
  }

  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
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

export async function chatAuto(settings: Settings, messages: ChatMessage[], onDelta?: (text: string) => void): Promise<string> {
  if (!onDelta || settings.supportsStreaming !== true) {
    return chat(settings, messages);
  }

  try {
    return await chatStream(settings, messages, onDelta);
  } catch (error) {
    if (isAuthOrConfigError(error)) throw error;
    return chat(settings, messages);
  }
}

export async function probeStreamingSupport(settings: Settings): Promise<StreamProbeResult> {
  if (!settings.apiKey) {
    return { supported: false, message: "流式输出未测试：未填写 API Key。" };
  }

  try {
    const content = await chatStream(
      settings,
      [
        { role: "system", content: "You are a streaming connection test. Reply with OK." },
        { role: "user", content: "Reply only: OK" }
      ],
      () => {}
    );
    return content.trim()
      ? { supported: true, message: "流式输出支持：当前 API 可使用增量返回。" }
      : { supported: false, message: "流式输出不支持：接口没有返回有效增量内容，将使用普通一次性返回。" };
  } catch (error) {
    return { supported: false, message: `流式输出不支持：${formatStreamingProbeError(error)}。将使用普通一次性返回。` };
  }
}

async function chatStream(settings: Settings, messages: ChatMessage[], onDelta: (text: string) => void): Promise<string> {
  if (!settings.apiKey) {
    throw new Error("请先在 Settings 中填写模型 API Key。");
  }

  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
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
        temperature: 0.2,
        stream: true
      })
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const delta = parseSseLine(line);
      if (!delta) continue;
      content += delta;
      onDelta(delta);
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) {
    const delta = parseSseLine(line);
    if (!delta) continue;
    content += delta;
    onDelta(delta);
  }

  if (!content) throw new StreamingUnsupportedError("no streaming delta content");
  return content;
}

function parseSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return "";
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return "";
  try {
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
    return "接口没有返回 OpenAI-compatible SSE 数据";
  }
  return message;
}
