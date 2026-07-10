import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Digest } from "./digest";

test("sha256Digest length-frames input parts", async () => {
  const first = await sha256Digest(["a", ":b"]);
  const second = await sha256Digest(["a:", "b"]);

  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("sha256Digest accepts binary parts deterministically", async () => {
  const first = await sha256Digest(["model", new Uint8Array([0, 1, 2])]);
  const second = await sha256Digest(["model", new Uint8Array([0, 1, 2])]);

  assert.equal(first, second);
});
