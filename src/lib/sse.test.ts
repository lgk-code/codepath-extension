import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSseLine } from "./sse";

test("parseSseLine recognizes OpenAI and Anthropic terminal events", () => {
  assert.deepEqual(parseSseLine("data: [DONE]", "openai"), { kind: "terminal" });
  assert.deepEqual(parseSseLine('data: {"type":"message_stop"}', "anthropic"), { kind: "terminal" });
});

test("parseSseLine extracts provider deltas", () => {
  assert.deepEqual(parseSseLine('data: {"choices":[{"delta":{"content":"hello"}}]}', "openai"), {
    kind: "delta",
    text: "hello"
  });
  assert.deepEqual(
    parseSseLine('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', "anthropic"),
    { kind: "delta", text: "hi" }
  );
});

test("parseSseLine rejects malformed data records", () => {
  assert.throws(() => parseSseLine("data: {broken", "openai"), /invalid SSE data/);
});
