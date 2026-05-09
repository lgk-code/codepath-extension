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

export async function chat(settings: Settings, messages: ChatMessage[]): Promise<string> {
  if (!settings.apiKey) {
    throw new Error("请先在 Settings 中填写 Qwen API Key。");
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
