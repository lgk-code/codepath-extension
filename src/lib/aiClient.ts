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
  const response = await fetch(endpoint, {
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

  if (!response.ok) {
    throw new Error(`模型接口 ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型没有返回内容。");
  return content;
}
