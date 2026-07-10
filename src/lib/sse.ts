import type { Provider } from "../types";

export type ParsedSseLine =
  | { kind: "delta"; text: string }
  | { kind: "terminal" }
  | { kind: "ignore" };

export function parseSseLine(line: string, provider: Provider): ParsedSseLine {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return { kind: "ignore" };
  if (!trimmed.startsWith("data:")) return { kind: "ignore" };

  const data = trimmed.slice(5).trim();
  if (!data) return { kind: "ignore" };
  if (data === "[DONE]") return { kind: "terminal" };

  try {
    if (provider === "anthropic") {
      const parsed = JSON.parse(data) as {
        type?: string;
        delta?: {
          type?: string;
          text?: string;
        };
      };
      if (parsed.type === "message_stop") return { kind: "terminal" };
      if (parsed.type !== "content_block_delta" || parsed.delta?.type !== "text_delta") return { kind: "ignore" };
      return parsed.delta.text ? { kind: "delta", text: parsed.delta.text } : { kind: "ignore" };
    }

    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: { content?: string };
      }>;
    };
    const text = parsed.choices?.map((choice) => choice.delta?.content ?? "").join("") ?? "";
    return text ? { kind: "delta", text } : { kind: "ignore" };
  } catch {
    throw new Error("invalid SSE data");
  }
}
