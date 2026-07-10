import assert from "node:assert/strict";
import { test } from "node:test";
import { createStreamBatcher } from "./streamBatcher";

test("createStreamBatcher preserves all deltas while bounding flushes", () => {
  const scheduled: Array<() => void> = [];
  const chunks: string[] = [];
  const batcher = createStreamBatcher((text) => chunks.push(text), 40, {
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout() {}
  });

  for (let index = 0; index < 1_000; index += 1) batcher.push(String(index % 10));
  while (scheduled.length > 0) scheduled.shift()?.();
  batcher.flush();

  assert.equal(chunks.join(""), Array.from({ length: 1_000 }, (_, index) => String(index % 10)).join(""));
  assert.ok(chunks.length <= 30, `expected at most 30 flushes, got ${chunks.length}`);
});

test("createStreamBatcher flushes pending text synchronously on completion", () => {
  const chunks: string[] = [];
  const batcher = createStreamBatcher((text) => chunks.push(text), 40);

  batcher.push("first");
  batcher.push("second");
  batcher.flush();

  assert.deepEqual(chunks, ["firstsecond"]);
});
